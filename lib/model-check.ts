import sharp from "sharp";
import { buildModelRequest, parseModelChoice } from "./model-client";
import { fetchModel } from "./model-transport";
import { assertOllamaReady } from "./ollama";
import type { RuntimeModelConfig } from "./model-settings";

// Invoked only by the user's explicit "test connection" action: one vision call,
// no automatic retries, no 200-agent simulation and no history record.
export async function checkModelConnection(config: RuntimeModelConfig, transport: typeof fetch = fetchModel as typeof fetch) {
  if (!config.apiKey) throw new Error("请先填写 API Key");
  if (config.nativeOllama) await assertOllamaReady(config.baseUrl, config.model);
  const image = await sharp({ create: { width: 96, height: 96, channels: 3, background: "#e9554c" } }).png().toBuffer();
  const started = Date.now();
  const response = await transport(config.url, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(buildModelRequest(config, '这是一次图片连接检测。若图片是红色，请仅返回 {"choice":"A"}；否则返回 {"choice":"NONE"}。', `data:image/png;base64,${image.toString("base64")}`, "grid")),
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403 ? "API Key 或账户权限无效" : response.status === 429 ? "账户额度或请求频率受限" : "模型或接口配置不匹配";
    throw new Error(`${message}（HTTP ${response.status}）`);
  }
  const result = await response.json();
  const content = config.nativeOllama ? result.message?.content : result.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("连接成功，但模型未返回可用的文本判断，请检查模型与输出预算");
  if (parseModelChoice(content, "grid") !== "A") throw new Error("模型未正确识别检测图片，请选择能识别图片的模型");
  return { connected: true, model: config.model, provider: config.provider, elapsedMs: Date.now() - started, message: "连接与图片识别检测通过，可以开始测试" };
}
