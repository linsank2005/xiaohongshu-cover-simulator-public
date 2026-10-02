import { limitedRequest } from "@/lib/api-boundary";
import { applyModelSettingsPatch, readModelSettings, runtimeModelConfig } from "@/lib/model-settings";
import { checkModelConnection } from "@/lib/model-check";
import { isModelProvider } from "@/lib/model-options";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    request = await limitedRequest(request, 16_384);
    const input = await request.json();
    if (!isModelProvider(input.provider)) throw new Error("请选择有效的模型服务");
    const config = runtimeModelConfig(input.provider, "grid", applyModelSettingsPatch(readModelSettings(), input));
    return Response.json(await checkModelConnection(config), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: error instanceof Error && /API Key|HTTP|模型|连接|图片|地址|timeoutSeconds|maxTokens|contextLength/.test(error.message) ? error.message : "连接检测失败，请检查服务、模型和超时设置" }, { status: 400 }); }
}
