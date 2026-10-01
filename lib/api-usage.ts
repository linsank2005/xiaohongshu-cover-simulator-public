import { randomUUID } from "node:crypto";
import { assertTestRunning } from "./db";
import { getDatabase, transaction } from "./storage";

export const MAX_MODEL_ATTEMPTS = 2;
export const MAX_TEST_REQUESTS = 400;
export type ProviderUsage = {
  prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_cache_hit_tokens?: number;
};
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

// Synchronous reservation immediately before fetch: no await gap between check and dispatch.
export function beginModelRequest(testId: string, variantKey: string, agentId: string, attempt: number) {
  const db = getDatabase();
  return transaction(db, () => {
    assertTestRunning(testId);
    if (!Number.isInteger(attempt) || attempt < 0 || attempt >= MAX_MODEL_ATTEMPTS) throw new Error("超出单个 Agent 重试预算");
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM api_requests WHERE test_id = ?").get(testId)!.n);
    if (total >= MAX_TEST_REQUESTS) throw new Error("超出单次测试请求预算");
    const id = randomUUID();
    db.prepare("INSERT INTO api_requests (id, test_id, variant_key, agent_id, attempt) VALUES (?, ?, ?, ?, ?)").run(id, testId, variantKey, agentId, attempt);
    db.prepare("UPDATE tests SET request_count = request_count + 1 WHERE id = ?").run(testId);
    return id;
  });
}

export type RequestDiagnostic = { errorCode?: string; errorMessage?: string; httpStatus?: number; providerCode?: string; elapsedMs?: number; requestBytes?: number };
export function finishModelRequest(id: string, status: string, usage?: ProviderUsage, diagnostic: RequestDiagnostic = {}) {
  const prompt = count(usage?.prompt_tokens);
  const completion = count(usage?.completion_tokens);
  const total = count(usage?.total_tokens) ?? (prompt !== null && completion !== null ? prompt + completion : null);
  getDatabase().prepare("UPDATE api_requests SET status = ?, prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, cached_tokens = ?, reasoning_tokens = ?, error_code = ?, error_message = ?, http_status = ?, provider_code = ?, elapsed_ms = ?, request_bytes = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'started'")
    .run(status, prompt, completion, total, count(usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens), count(usage?.completion_tokens_details?.reasoning_tokens), diagnostic.errorCode ?? null, diagnostic.errorMessage ?? null, diagnostic.httpStatus ?? null, diagnostic.providerCode ?? null, diagnostic.elapsedMs ?? null, diagnostic.requestBytes ?? null, id);
}

export function getApiUsage(testId: string) {
  const db = getDatabase();
  const tracked = db.prepare("SELECT usage_tracked, request_count FROM tests WHERE id = ?").get(testId);
  const rows = db.prepare("SELECT * FROM api_requests WHERE test_id = ?").all(testId);
  const sum = (field: string) => rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
  const reported = rows.filter(row => row.total_tokens !== null).length;
  const notSent = rows.filter(row => row.status === "connection_error").length;
  return {
    tracked: Boolean(tracked?.usage_tracked), requestCount: rows.length || Number(tracked?.request_count ?? 0),
    retryCount: rows.filter(row => Number(row.attempt) > 0).length,
    succeededRequests: rows.filter(row => row.status === "succeeded").length,
    usageReportedRequests: reported, notSentRequests: notSent, unknownUsageRequests: rows.length - reported - notSent,
    lastError: rows.filter(row => row.error_code && row.status !== "aborted").sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at))).map(row => ({ code: row.error_code, message: row.error_message, httpStatus: row.http_status, providerCode: row.provider_code, elapsedMs: row.elapsed_ms }))[0] ?? null,
    promptTokens: sum("prompt_tokens"), completionTokens: sum("completion_tokens"), totalTokens: sum("total_tokens"),
    cachedTokens: sum("cached_tokens"), reasoningTokens: sum("reasoning_tokens"),
    statuses: Object.fromEntries([...new Set(rows.map(row => String(row.status)))].map(status => [status, rows.filter(row => row.status === status).length]))
  };
}
