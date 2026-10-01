import { Agent, fetch as undiciFetch } from "undici";
import type { ModelProvider } from "./model-options";
import type { TestMode } from "./types";

// Use a dedicated client instead of Next's patched fetch/default 10-second
// connection deadline. Keep TLS verification and reuse established connections.
const state = globalThis as typeof globalThis & { coverModelAgent?: Agent };
export function modelRequestPolicy(provider: ModelProvider, mode: TestMode) {
  if (provider === "ollama") return { concurrency: 1, timeoutMs: 180_000 };
  const largeVisionRequest = provider === "glm-4.6v" && mode === "vertical";
  return { concurrency: largeVisionRequest ? 2 : 5, timeoutMs: largeVisionRequest ? 90_000 : 60_000 };
}

export async function fetchModel(url: string, init: {
  method: string; headers: Record<string, string>; body: string; signal: AbortSignal;
}): Promise<Response> {
  const dispatcher = state.coverModelAgent ??= new Agent({
    connections: 5, pipelining: 1, connect: { timeout: 30_000 },
    autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250,
    // The local 4B vision model can need over 90 seconds for its first cold load.
    // Per-request AbortControllers still enforce the lower remote-provider limits.
    headersTimeout: 180_000, bodyTimeout: 180_000
  });
  return await undiciFetch(url, { ...init, dispatcher, redirect: "error" }) as unknown as Response;
}

export async function closeModelTransport() {
  await state.coverModelAgent?.close();
  delete state.coverModelAgent;
}

const safeConnectCodes = new Set(["UND_ERR_CONNECT_TIMEOUT", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);
export function networkFailure(error: unknown): { code: string; retryable: boolean } {
  function leaves(value: unknown, depth = 0): Array<{ code: string; safe: boolean }> {
    if (!value || typeof value !== "object" || depth > 5) return [];
    const node = value as { code?: unknown; syscall?: unknown; cause?: unknown; errors?: unknown[] };
    if (Array.isArray(node.errors) && node.errors.length) {
      return node.errors.flatMap(child => {
        const found = leaves(child, depth + 1);
        return found.length ? found : [{ code: "UNKNOWN_NETWORK_ERROR", safe: false }];
      });
    }
    const nested = leaves(node.cause, depth + 1);
    if (nested.length) return nested;
    if (typeof node.code !== "string" || !/^[A-Z0-9_]{1,64}$/.test(node.code)) return [];
    return [{ code: node.code, safe: safeConnectCodes.has(node.code) || (node.code === "ETIMEDOUT" && node.syscall === "connect") }];
  }
  const reasons = leaves(error);
  return { code: [...new Set(reasons.map(item => item.code))].join(",") || "UNKNOWN_NETWORK_ERROR", retryable: reasons.length > 0 && reasons.every(item => item.safe) };
}
