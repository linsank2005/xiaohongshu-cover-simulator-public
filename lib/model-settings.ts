import { getDatabase, transaction } from "./storage";
import { isModelProvider, MODEL_OPTIONS, type ModelProvider } from "./model-options";
import type { TestMode } from "./types";

export type ModelSettings = {
  baseUrl: string; model: string; apiKey: string;
  timeoutSeconds: number; maxTokens: number; contextLength: number;
};
export type PublicModelSettings = Omit<ModelSettings, "apiKey"> & { apiKeyConfigured: boolean };
export type ModelSettingsResponse = { providers: Record<ModelProvider, PublicModelSettings> };
export type RuntimeModelConfig = Readonly<ModelSettings & {
  provider: ModelProvider; label: string; url: string; nativeOllama: boolean;
  responseFormat: boolean; concurrency: number; timeoutMs: number;
}>;
export type ModelConfigSnapshot = Pick<RuntimeModelConfig,
  "provider" | "model" | "timeoutMs" | "maxTokens" | "contextLength" | "concurrency">;

export function normalizeModelUrl(value: string, local = false) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("模型地址不是有效 URL"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) throw new Error("模型地址不能包含密钥、查询参数或用户名");
  if (local) {
    if (url.protocol !== "http:" || !loopback) throw new Error("Ollama 地址必须是本机 HTTP 回环地址");
    if (!["", "/v1"].includes(url.pathname.replace(/\/+$/, ""))) throw new Error("Ollama 地址路径必须为空或 /v1");
    return url.origin;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("云模型地址必须使用 HTTPS；本机调试可使用 HTTP");
  return url.toString().replace(/\/+$/, "");
}

function defaults(): Record<ModelProvider, ModelSettings> {
  const zhipuUrl = process.env.ZHIPU_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";
  const zhipuKey = process.env.ZHIPU_API_KEY || "";
  return {
    ollama: { baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434", model: process.env.OLLAMA_MODEL || "qwen3.5:4b", apiKey: "", timeoutSeconds: 180, maxTokens: 256, contextLength: 8192 },
    zhipu: { baseUrl: zhipuUrl, model: process.env.ZHIPU_MODEL || "glm-5.3-flash", apiKey: zhipuKey, timeoutSeconds: 120, maxTokens: 4096, contextLength: 8192 },
    "glm-4.6v": { baseUrl: zhipuUrl, model: process.env.ZHIPU_GLM_46V_MODEL || "glm-4.6v", apiKey: zhipuKey, timeoutSeconds: 90, maxTokens: 256, contextLength: 8192 },
    deepseek: { baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", model: process.env.DEEPSEEK_MODEL || "deepseek-flash", apiKey: process.env.DEEPSEEK_API_KEY || "", timeoutSeconds: 90, maxTokens: 256, contextLength: 8192 }
  };
}

export function readModelSettings() {
  const base = defaults();
  const row = getDatabase().prepare("SELECT value FROM local_settings WHERE name = 'model-settings'").get();
  const saved = row ? JSON.parse(String(row.value)) as Partial<Record<ModelProvider, ModelSettings>> : {};
  for (const provider of MODEL_OPTIONS) Object.assign(base[provider.id], saved[provider.id]);
  return base;
}

export function publicModelSettings(settings = readModelSettings()): ModelSettingsResponse {
  return { providers: Object.fromEntries(MODEL_OPTIONS.map(({ id }) => {
    const { apiKey, ...visible } = settings[id];
    return [id, { ...visible, apiKeyConfigured: Boolean(apiKey) }];
  })) as Record<ModelProvider, PublicModelSettings> };
}

export function applyModelSettingsPatch(settings: ReturnType<typeof readModelSettings>, input: unknown) {
  if (!input || typeof input !== "object" || !("provider" in input) || !isModelProvider(input.provider)) throw new Error("请选择有效的模型服务");
  const provider = input.provider;
  const patch = input as Record<string, unknown>;
  const updated = structuredClone(settings);
  const current = updated[provider];
  for (const field of ["baseUrl", "model", "apiKey"] as const) {
    if (patch[field] !== undefined) {
      if (typeof patch[field] !== "string") throw new Error(`${field} 必须是文本`);
      current[field] = patch[field].trim();
    }
  }
  current.baseUrl = normalizeModelUrl(current.baseUrl, provider === "ollama");
  if (!/^[A-Za-z0-9_.:/-]{1,120}$/.test(current.model)) throw new Error("模型名称无效");
  if (current.apiKey.length > 2048 || /[\r\n]/.test(current.apiKey)) throw new Error("API Key 格式无效");
  for (const [field, minimum, maximum] of [["timeoutSeconds", 30, 600], ["maxTokens", 128, 32768], ["contextLength", 4096, 65536]] as const) {
    if (patch[field] !== undefined) {
      const value = patch[field];
      if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${field} 必须在 ${minimum} 到 ${maximum} 之间`);
      current[field] = value;
    }
  }
  if (provider === "ollama") current.apiKey = "";
  // Both Zhipu choices use the same account key; model and timeouts remain separate.
  if (["zhipu", "glm-4.6v"].includes(provider) && patch.apiKey !== undefined) {
    updated[provider === "zhipu" ? "glm-4.6v" : "zhipu"].apiKey = current.apiKey;
  }
  return updated;
}

export class SettingsBusyError extends Error {}
export function saveModelSettings(input: unknown) {
  const db = getDatabase();
  return transaction(db, () => {
    if (db.prepare("SELECT 1 FROM tests WHERE status IN ('pending','running','cancelling')").get()) throw new SettingsBusyError("测试进行中，完成或取消后再修改模型设置");
    const settings = applyModelSettingsPatch(readModelSettings(), input);
    db.prepare("INSERT INTO local_settings VALUES ('model-settings', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(JSON.stringify(settings));
    return publicModelSettings(settings);
  });
}

export function runtimeModelConfig(provider: ModelProvider, mode: TestMode = "grid", settings = readModelSettings()): RuntimeModelConfig {
  const values = settings[provider];
  const baseUrl = normalizeModelUrl(values.baseUrl, provider === "ollama");
  return Object.freeze({ ...values, baseUrl, provider,
    apiKey: provider === "ollama" ? "ollama" : values.apiKey,
    label: `${provider === "ollama" ? "本机 Ollama" : provider === "deepseek" ? "DeepSeek" : "智谱"} · ${values.model}`,
    url: `${baseUrl}${provider === "ollama" ? "/api/chat" : "/chat/completions"}`,
    nativeOllama: provider === "ollama", responseFormat: provider !== "ollama" && provider !== "glm-4.6v",
    timeoutMs: values.timeoutSeconds * 1000,
    concurrency: provider === "ollama" ? 1 : provider === "glm-4.6v" && mode === "vertical" ? 2 : 5
  });
}

export function modelConfigSnapshot(config: RuntimeModelConfig): ModelConfigSnapshot {
  const { provider, model, timeoutMs, maxTokens, contextLength, concurrency } = config;
  return { provider, model, timeoutMs, maxTokens, contextLength, concurrency };
}
