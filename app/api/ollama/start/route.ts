import { limitedRequest } from "@/lib/api-boundary";
import { startLocalOllama } from "@/lib/ollama";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    request = await limitedRequest(request, 4096);
    const input = await request.json();
    return Response.json(await startLocalOllama(input.baseUrl));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "启动 Ollama 失败" }, { status: 400 }); }
}
