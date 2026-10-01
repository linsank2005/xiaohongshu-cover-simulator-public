import fs from "node:fs/promises";
import path from "node:path";
import { getTest, getTestCandidate } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const contentTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const test = await getTest(id);
  if (!test) return Response.json({ error: "测试不存在" }, { status: 404 });
  const variantKey = new URL(request.url).searchParams.get("variant") ?? "A";
  const candidate = await getTestCandidate(id, variantKey);
  if (!candidate) return Response.json({ error: "候选封面不存在" }, { status: 404 });

  try {
    const image = await fs.readFile(candidate.path);
    const contentType = contentTypes[path.extname(candidate.path).toLowerCase()] ?? "application/octet-stream";
    return new Response(image, { headers: { "Content-Type": contentType, "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "测试封面文件不存在" }, { status: 404 });
  }
}
