const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function checkLocalRequest(request: Request): Response | null {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  // Next may normalize the internal URL hostname to localhost. Validate the actual
  // HTTP Host separately, and compare Origin to that externally requested origin.
  let target: URL;
  try { target = new URL(`${url.protocol}//${host ?? url.host}`); }
  catch { return Response.json({ error: "无效的本地主机" }, { status: 403 }); }
  if (!localHosts.has(target.hostname) || target.host.toLowerCase() !== (host ?? url.host).toLowerCase()) {
    return Response.json({ error: "此服务仅允许本机访问" }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if ((origin && origin !== target.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "拒绝跨站请求" }, { status: 403 });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.get("x-simulator-client") !== "local") {
    return Response.json({ error: "缺少本地客户端请求标记" }, { status: 403 });
  }
  return null;
}

export async function limitedRequest(request: Request, limit: number) {
  if (Number(request.headers.get("content-length")) > limit) throw new Error("请求内容过大");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) { await reader.cancel(); throw new Error("请求内容过大"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request.url, { method: request.method, headers: request.headers, body });
}
