import { listOllamaModels } from "@/lib/ollama";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return Response.json(await listOllamaModels(new URL(request.url).searchParams.get("baseUrl") ?? undefined), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return Response.json({ connected: false, models: [], error: error instanceof Error ? error.message : "无法连接 Ollama" }, { status: 400 }); }
}
