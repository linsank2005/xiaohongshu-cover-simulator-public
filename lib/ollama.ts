import { spawn } from "node:child_process";
import { normalizeModelUrl, readModelSettings } from "./model-settings";

export type OllamaModel = { name: string; size: number; vision: boolean; local: boolean; message: string };
export function ollamaAddress(value?: string) {
  return normalizeModelUrl(value ?? readModelSettings().ollama.baseUrl, true);
}
async function metadataRequest(baseUrl: string, endpoint: string, body?: unknown) {
  let response: Response;
  try {
    response = await fetch(`${ollamaAddress(baseUrl)}${endpoint}`, {
      method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000), cache: "no-store", redirect: "error"
    });
  } catch { throw new Error("无法连接本机 Ollama，请先启动服务并检查地址"); }
  if (!response.ok) throw new Error(response.status === 404 ? "模型尚未安装，请先下载该模型" : `Ollama 检测失败（HTTP ${response.status}）`);
  return response.json();
}
export async function inspectOllamaModel(baseUrl: string, model: string) {
  const info = await metadataRequest(baseUrl, "/api/show", { model });
  const local = !info.remote_model && !info.remote_host && !model.endsWith(":cloud");
  const vision = Array.isArray(info.capabilities) && info.capabilities.includes("vision");
  return { vision, local };
}
export async function listOllamaModels(value?: string) {
  const baseUrl = ollamaAddress(value);
  const list = await metadataRequest(baseUrl, "/api/tags");
  const raw: Array<{ name?: unknown; size?: number; remote_model?: unknown }> = Array.isArray(list.models) ? list.models.slice(0, 100) : [];
  const models: OllamaModel[] = [];
  for (let offset = 0; offset < raw.length; offset += 4) {
    models.push(...await Promise.all(raw.slice(offset, offset + 4).map(async item => {
      const name = typeof item.name === "string" ? item.name : "";
      if (!name) return { name: "", size: 0, vision: false, local: false, message: "模型名称无效" };
      try {
        const info = await inspectOllamaModel(baseUrl, name);
        return { name, size: item.size ?? 0, ...info, message: !info.local ? "云端模型，不属于本机推理" : info.vision ? "支持图片识别" : "不支持图片识别" };
      } catch (error) { return { name, size: item.size ?? 0, vision: false, local: true, message: error instanceof Error ? error.message : "无法检测模型" }; }
    })));
  }
  return { connected: true, baseUrl, models: models.filter(model => model.name) };
}
export async function assertOllamaReady(baseUrl: string, model: string) {
  const info = await inspectOllamaModel(baseUrl, model);
  if (!info.local) throw new Error("此入口只使用本机模型权重，请选择已下载的本地模型");
  if (!info.vision) throw new Error("所选模型不支持图片识别，无法用于封面测试");
}
export async function startLocalOllama(value?: string) {
  const baseUrl = ollamaAddress(value);
  try { await metadataRequest(baseUrl, "/api/version"); return { connected: true, alreadyRunning: true }; } catch { /* Start only if the selected loopback endpoint is unavailable. */ }
  const child = spawn("ollama", ["serve"], {
    windowsHide: true, detached: true, stdio: "ignore",
    env: { ...process.env, OLLAMA_HOST: new URL(baseUrl).host }
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(new Error("未找到 Ollama，请先安装，再重新打开本工具")));
  });
  child.unref();
  for (let index = 0; index < 30; index++) {
    try { await metadataRequest(baseUrl, "/api/version"); return { connected: true, alreadyRunning: false }; } catch { await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  throw new Error("Ollama 启动后仍未就绪，请打开 Ollama 应用或运行 ollama serve");
}

const globalPulls = globalThis as typeof globalThis & { coverModelPulls?: Set<string> };
const pulls = globalPulls.coverModelPulls ??= new Set<string>();
export async function pullOllamaModel(value: string | undefined, model: string, signal: AbortSignal) {
  if (!/^[A-Za-z0-9_.:/-]{1,120}$/.test(model) || model.endsWith(":cloud")) throw new Error("请输入有效的本地模型名称");
  const baseUrl = ollamaAddress(value);
  const key = `${baseUrl}/${model}`;
  if (pulls.has(key)) throw new Error("这个模型正在下载，请等待当前下载完成");
  pulls.add(key);
  try {
    const response = await fetch(`${baseUrl}/api/pull`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, stream: true }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60 * 60 * 1000)]), redirect: "error"
    });
    if (!response.ok || !response.body) throw new Error(`模型下载无法开始（HTTP ${response.status}）`);
    const upstream = response.body.getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await upstream.read();
          if (next.done) { pulls.delete(key); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { pulls.delete(key); controller.error(error); }
      },
      async cancel() { pulls.delete(key); await upstream.cancel(); }
    });
  } catch (error) { pulls.delete(key); throw error; }
}
