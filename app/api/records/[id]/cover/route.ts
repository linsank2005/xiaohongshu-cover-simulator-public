import fs from "node:fs/promises";
import { recordCoverPath } from "@/lib/records";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { id } = await context.params; const file = await recordCoverPath(id, new URL(request.url).searchParams.get("key") ?? "A"); if (!file) throw new Error("missing"); return new Response(new Uint8Array(await fs.readFile(file)), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "封面图片不存在；JSON 记录不包含图片，可另行导入封面 ZIP" }, { status: 404 }); }
}
