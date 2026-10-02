import { limitedRequest } from "@/lib/api-boundary";
import { pullOllamaModel } from "@/lib/ollama";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const signal = request.signal;
    request = await limitedRequest(request, 4096);
    const input = await request.json();
    return new Response(await pullOllamaModel(input.baseUrl, input.model, signal), { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "模型下载无法开始，请先启动 Ollama" }, { status: 400 }); }
}
