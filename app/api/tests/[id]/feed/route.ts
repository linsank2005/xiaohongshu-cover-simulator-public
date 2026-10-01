import { dataDirectory } from "@/lib/storage";
import fs from "node:fs/promises";
import path from "node:path";
import { getTest } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const test = await getTest(id);
  if (!test) return Response.json({ error: "测试不存在" }, { status: 404 });
  if (test.status !== "completed") return Response.json({ error: "AI 测试预览尚未生成" }, { status: 404 });
  const variantKey = new URL(request.url).searchParams.get("variant") ?? "A";
  if (!test.candidates.some((candidate) => candidate.key === variantKey)) {
    return Response.json({ error: "候选封面不存在" }, { status: 404 });
  }

  try {
    const fileName = variantKey === "A" ? "feed-preview.jpg" : "feed-preview-" + variantKey + ".jpg";
    const image = await fs.readFile(path.join(dataDirectory(), "results", id, fileName));
    return new Response(image, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store"
      }
    });
  } catch {
    return Response.json({ error: "AI 测试预览尚未生成" }, { status: 404 });
  }
}
