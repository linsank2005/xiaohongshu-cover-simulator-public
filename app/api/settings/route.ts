import { limitedRequest } from "@/lib/api-boundary";
import { publicModelSettings, saveModelSettings, SettingsBusyError } from "@/lib/model-settings";
import { recoverInterruptedTests } from "@/lib/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { return Response.json(publicModelSettings(), { headers: { "Cache-Control": "no-store" } }); }
export async function PATCH(request: Request) {
  try {
    request = await limitedRequest(request, 16_384);
    recoverInterruptedTests();
    return Response.json(saveModelSettings(await request.json()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "保存设置失败" }, { status: error instanceof SettingsBusyError ? 409 : 400 }); }
}
