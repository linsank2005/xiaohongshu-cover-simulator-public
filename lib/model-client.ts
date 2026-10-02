import type { ModelProvider } from "./model-options";
import type { ModelChoice, TestMode } from "./types";
import { cardNamesForMode, isValidChoice } from "./result-rules";
import { beginModelRequest, finishModelRequest, MAX_MODEL_ATTEMPTS, type ProviderUsage } from "./api-usage";
import { fetchModel, networkFailure } from "./model-transport";
import type { RequestDiagnostic } from "./api-usage";

import { runtimeModelConfig, readModelSettings, normalizeModelUrl, type RuntimeModelConfig } from "./model-settings";

export function ollamaBaseUrl() {
  return normalizeModelUrl(readModelSettings().ollama.baseUrl, true);
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
  return runtimeModelConfig(provider).model;
}

export function buildModelRequest(config: RuntimeModelConfig, prompt: string, feedDataUrl: string, testMode: TestMode) {
  return config.nativeOllama ? {
    model: config.model,
    messages: [{ role: "user", content: prompt, images: [feedDataUrl.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "")] }],
    stream: false, think: false, keep_alive: "10m",
    format: { type: "object", properties: { choice: { type: "string", enum: [...cardNamesForMode(testMode), "NONE"] } }, required: ["choice"], additionalProperties: false },
    options: { num_ctx: config.contextLength, num_predict: config.maxTokens, temperature: 0.2, top_p: 0.9 }
  } : {
    model: config.model,
    messages: [{ role: "user", content: [ { type: "text", text: prompt }, { type: "image_url", image_url: { url: feedDataUrl, detail: "high" } } ] }],
    ...(config.responseFormat ? { response_format: { type: "json_object" } } : {}),
    max_tokens: config.maxTokens,
    ...(config.provider === "zhipu" ? { temperature: 1, top_p: 0.95, reasoning_effort: "low", thinking: { type: "enabled" } } : { thinking: { type: "disabled" } })
  };
}

export type ModelCall = {
  testId: string; variantKey: string; agentId: string; provider: ModelProvider;
  prompt: string; feedDataUrl: string; testMode: TestMode; control: SimulationControl;
  transport?: typeof fetch; timeoutMs?: number; retryDelayMs?: number; config?: RuntimeModelConfig;
};

async function askModel(call: ModelCall, attempt: number): Promise<ModelChoice> {
  const config = call.config ?? runtimeModelConfig(call.provider, call.testMode);
  if (!config.apiKey) throw new Error("尚未配置 API Key，请打开页面右上角的模型设置");
  call.control.check();
  const controller = new AbortController();
  const body = JSON.stringify(buildModelRequest(config, call.prompt, call.feedDataUrl, call.testMode));
  let status = "network_error";
  let usage: ProviderUsage | undefined;
  let receivedHeaders = false;
  const started = Date.now();
  const diagnostic: RequestDiagnostic = { requestBytes: Buffer.byteLength(body) };
  // The reservation also checks persistent cancellation and execution ownership.
  const requestId = beginModelRequest(call.testId, call.variantKey, call.agentId, attempt);
  call.control.controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), call.timeoutMs ?? config.timeoutMs);
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

export async function callWithRetry(input: ModelCall) {
  const call = { ...input, config: input.config ?? runtimeModelConfig(input.provider, input.testMode) };
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
