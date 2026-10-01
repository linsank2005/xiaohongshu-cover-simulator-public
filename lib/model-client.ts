import type { ModelProvider } from "./model-options";
import type { ModelChoice, TestMode } from "./types";
import { cardNamesForMode, isValidChoice } from "./result-rules";
import { beginModelRequest, finishModelRequest, MAX_MODEL_ATTEMPTS, type ProviderUsage } from "./api-usage";
import { fetchModel, modelRequestPolicy, networkFailure } from "./model-transport";
import type { RequestDiagnostic } from "./api-usage";

const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";
const ZHIPU_BASE_URL = process.env.ZHIPU_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";
const ZHIPU_MODEL = process.env.ZHIPU_MODEL || "glm-5.3-flash";
const ZHIPU_GLM_46V_MODEL = process.env.ZHIPU_GLM_46V_MODEL || "glm-4.6v";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3.5:4b";

export function ollamaBaseUrl() {
  const url = new URL(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434");
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.search || url.hash) {
    throw new Error("OLLAMA_BASE_URL 必须是本机 HTTP 回环地址");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname && pathname !== "/v1") throw new Error("OLLAMA_BASE_URL 路径必须为空或 /v1");
  return url.origin;
}

export class InvalidModelChoiceError extends Error {}
export class TestCancelledError extends Error {}
export class ConnectionFailureError extends Error {}
export function parseModelChoice(content: string, mode: TestMode = "grid"): ModelChoice {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let parsed: unknown;
  try { parsed = JSON.parse(normalized); } catch { throw new InvalidModelChoiceError("模型返回的内容不是有效 JSON"); }
  if (!parsed || typeof parsed !== "object" || !("choice" in parsed) || !isValidChoice(parsed.choice, mode)) {
    throw new InvalidModelChoiceError("模型没有返回当前场景的有效位置或 NONE");
  }
  return parsed.choice as ModelChoice;
}

export class SimulationControl {
  error: Error | null = null;
  controllers = new Set<AbortController>();
  stop(error: Error) {
    if (!this.error) this.error = error;
    for (const controller of this.controllers) controller.abort();
  }
  check() { if (this.error) throw this.error; }
}

function modelContentToText(content: unknown) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
    return "";
  }).join("").trim();
}

export function modelNameForProvider(provider: ModelProvider) {
  if (provider === "ollama") return OLLAMA_MODEL;
  if (provider === "deepseek") return MODEL;
  if (provider === "zhipu") return ZHIPU_MODEL;
  return ZHIPU_GLM_46V_MODEL;
}

function providerLabel(provider: ModelProvider) {
  if (provider === "ollama") return "本机 Qwen3.5 4B";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "zhipu") return "GLM-5.3-Flash";
  return "GLM-4.6V";
}

function providerConfig(provider: ModelProvider) {
  if (provider === "ollama") {
    return {
      label: providerLabel(provider), apiKey: "ollama", apiEnvName: null,
      url: `${ollamaBaseUrl()}/api/chat`, model: OLLAMA_MODEL,
      responseFormat: false, nativeOllama: true, extraBody: {}
    };
  }
  if (provider === "deepseek") {
    return {
      label: providerLabel(provider),
      apiKey: process.env.DEEPSEEK_API_KEY,
      apiEnvName: "DEEPSEEK_API_KEY",
      url: `${BASE_URL.replace(/\/+$/, "")}/chat/completions`,
      model: MODEL,
      responseFormat: true, nativeOllama: false,
      extraBody: { thinking: { type: "disabled" } }
    };
  }
  if (provider === "zhipu") {
    return {
      label: providerLabel(provider),
      apiKey: process.env.ZHIPU_API_KEY,
      apiEnvName: "ZHIPU_API_KEY",
      url: `${ZHIPU_BASE_URL.replace(/\/+$/, "")}/chat/completions`,
      model: ZHIPU_MODEL,
      responseFormat: true, nativeOllama: false,
      extraBody: { temperature: 1, top_p: 0.95, reasoning_effort: "low", thinking: { type: "enabled" } }
    };
  }
  return {
    label: providerLabel(provider),
    apiKey: process.env.ZHIPU_API_KEY,
    apiEnvName: "ZHIPU_API_KEY",
    url: `${ZHIPU_BASE_URL.replace(/\/+$/, "")}/chat/completions`,
    model: ZHIPU_GLM_46V_MODEL,
    responseFormat: false, nativeOllama: false,
    extraBody: { thinking: { type: "disabled" } }
  };
}


export type ModelCall = {
  testId: string; variantKey: string; agentId: string; provider: ModelProvider;
  prompt: string; feedDataUrl: string; testMode: TestMode; control: SimulationControl;
  transport?: typeof fetch; timeoutMs?: number; retryDelayMs?: number;
};

async function askModel(call: ModelCall, attempt: number): Promise<ModelChoice> {
  const config = providerConfig(call.provider);
  if (!config.apiKey) throw new Error(`未配置 ${config.apiEnvName}，真实测试无法开始`);
  call.control.check();
  const controller = new AbortController();
  const body = JSON.stringify(config.nativeOllama ? {
    model: config.model,
    messages: [{ role: "user", content: call.prompt, images: [call.feedDataUrl.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "")] }],
    stream: false, think: false, keep_alive: "10m",
    format: {
      type: "object",
      properties: { choice: { type: "string", enum: [...cardNamesForMode(call.testMode), "NONE"] } },
      required: ["choice"], additionalProperties: false
    },
    options: { num_ctx: 8192, num_predict: 256, temperature: 0.2, top_p: 0.9 }
  } : {
    model: config.model,
    messages: [{ role: "user", content: [
      { type: "text", text: call.prompt },
      { type: "image_url", image_url: { url: call.feedDataUrl, detail: "high" } }
    ] }],
    ...(config.responseFormat ? { response_format: { type: "json_object" } } : {}),
    max_tokens: 256, ...config.extraBody
  });
  let status = "network_error";
  let usage: ProviderUsage | undefined;
  let receivedHeaders = false;
  const started = Date.now();
  const diagnostic: RequestDiagnostic = { requestBytes: Buffer.byteLength(body) };
  // The reservation also checks persistent cancellation and execution ownership.
  const requestId = beginModelRequest(call.testId, call.variantKey, call.agentId, attempt);
  call.control.controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), call.timeoutMs ?? modelRequestPolicy(call.provider, call.testMode).timeoutMs);
  try {
    const response = await (call.transport ?? fetchModel)(config.url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body, signal: controller.signal
    });
    receivedHeaders = true;
    diagnostic.httpStatus = response.status;
    if (!response.ok) {
      status = "http_error";
      diagnostic.errorCode = `HTTP_${response.status}`;
      const details = await response.json().catch(() => null);
      const code = String(details?.error?.code ?? details?.code ?? "");
      if (/^[A-Za-z0-9_.-]{1,64}$/.test(code)) diagnostic.providerCode = code;
      throw new Error(`${config.label} HTTP ${response.status}${diagnostic.providerCode ? `（业务码 ${diagnostic.providerCode}）` : ""}；不自动重试`);
    }
    const responseBody = await response.json() as {
      usage?: ProviderUsage; choices?: Array<{ message?: { content?: unknown }; finish_reason?: string | null }>;
      message?: { content?: unknown }; done_reason?: string; prompt_eval_count?: number; eval_count?: number;
    };
    usage = config.nativeOllama ? {
      prompt_tokens: responseBody.prompt_eval_count,
      completion_tokens: responseBody.eval_count,
      total_tokens: typeof responseBody.prompt_eval_count === "number" && typeof responseBody.eval_count === "number"
        ? responseBody.prompt_eval_count + responseBody.eval_count : undefined
    } : responseBody.usage;
    call.control.check();
    const result = config.nativeOllama ? { message: responseBody.message, finish_reason: responseBody.done_reason } : responseBody.choices?.[0];
    // Repeating the same exhausted output budget cannot fix a configuration problem.
    if (result?.finish_reason === "length") {
      status = "output_limit";
      throw new Error(`${config.label} 输出预算耗尽，请检查模型配置；不会原样重试`);
    }
    status = "invalid_response";
    const choice = parseModelChoice(modelContentToText(result?.message?.content), call.testMode);
    status = "succeeded";
    return choice;
  } catch (error) {
    if (controller.signal.aborted || call.control.error) {
      status = controller.signal.aborted && !call.control.error ? "timeout" : "aborted";
      diagnostic.errorCode = status === "timeout" ? "REQUEST_TIMEOUT" : "TASK_STOPPED";
      diagnostic.errorMessage = status === "timeout" ? `${config.label} 请求超时；为避免重复计费，不自动重试` : "任务已停止，请求已中止";
      throw call.control.error ?? new Error(diagnostic.errorMessage);
    }
    if (status === "network_error") {
      const failure = networkFailure(error);
      diagnostic.errorCode = failure.code;
      const safe = !receivedHeaders && failure.retryable;
      status = safe ? "connection_error" : "network_error";
      diagnostic.errorMessage = safe
        ? `${config.label} 连接失败（${failure.code}），请求尚未发送；最多重试一次`
        : `${config.label} 网络或响应读取失败（${failure.code}）；计费未知，不自动重发`;
      throw safe ? new ConnectionFailureError(diagnostic.errorMessage) : new Error(diagnostic.errorMessage);
    }
    diagnostic.errorCode ??= status.toUpperCase();
    diagnostic.errorMessage = error instanceof Error ? error.message : "模型响应无效";
    throw error;
  } finally {
    clearTimeout(timeout);
    call.control.controllers.delete(controller);
    finishModelRequest(requestId, status, usage, { ...diagnostic, elapsedMs: Date.now() - started });
  }
}

export async function callWithRetry(call: ModelCall) {
  for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt++) {
    call.control.check();
    try { return { choice: await askModel(call, attempt), retryCount: attempt }; }
    catch (error) {
      if (!(error instanceof InvalidModelChoiceError || error instanceof ConnectionFailureError) || attempt === MAX_MODEL_ATTEMPTS - 1) {
        call.control.stop(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      if (error instanceof ConnectionFailureError) {
        call.control.check();
        const controller = new AbortController();
        call.control.controllers.add(controller);
        try {
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, call.retryDelayMs ?? 750);
            controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        } finally { call.control.controllers.delete(controller); }
        call.control.check();
      }
    }
  }
  throw new Error("模型重试预算耗尽");
}
