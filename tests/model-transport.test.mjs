import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { isolated, fixture, response, fastImages, references } from "./helpers.mjs";
import { startTest, getTest } from "../lib/db.ts";
import { getApiUsage } from "../lib/api-usage.ts";
import { callWithRetry, SimulationControl, modelNameForProvider, ollamaBaseUrl } from "../lib/model-client.ts";
import { isModelProvider, MODEL_OPTIONS } from "../lib/model-options.ts";
import { networkFailure, modelRequestPolicy, fetchModel, closeModelTransport } from "../lib/model-transport.ts";
import { runSimulation } from "../lib/simulation.ts";

const failure = code => new TypeError("fetch failed", { cause: Object.assign(new Error("private URL must not leak"), { code }) });
const call = (id, transport, extra = {}) => callWithRetry({ testId: id, variantKey: "A", agentId: "one", provider: "glm-4.6v", prompt: "test", feedDataUrl: "image", testMode: "vertical", control: new SimulationControl(), retryDelayMs: 1, transport, ...extra });
const ollamaResponse = (choice = "A") => Response.json({ message: { content: JSON.stringify({ choice }) }, done_reason: "stop", prompt_eval_count: 321, eval_count: 5 });

test("real transport sends a single POST and refuses redirects without replay", async () => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    calls++; let body = ""; for await (const chunk of req) body += chunk;
    assert.equal(req.method, "POST"); assert.equal(body, "payload");
    if (req.url === "/redirect") { res.writeHead(307, { Location: "/unexpected" }); res.end(); return; }
    res.setHeader("Content-Type", "application/json"); res.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: "payload", signal: AbortSignal.timeout(5000) };
  try {
    assert.deepEqual(await (await fetchModel(base, init)).json(), { ok: true });
    await assert.rejects(fetchModel(base + "/redirect", init), error => !networkFailure(error).retryable);
    assert.equal(calls, 2);
  } finally { await closeModelTransport(); await new Promise(resolve => server.close(resolve)); }
});

test("only confirmed pre-send failures are retryable, including nested aggregate errors", () => {
  assert.equal(networkFailure(failure("UND_ERR_CONNECT_TIMEOUT")).retryable, true);
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "CERT_HAS_EXPIRED"]) assert.equal(networkFailure(failure(code)).retryable, false);
  assert.equal(networkFailure(new AggregateError([failure("ECONNREFUSED"), failure("ENETUNREACH")])).retryable, true);
  assert.equal(networkFailure(new AggregateError([failure("ECONNREFUSED"), new Error("unknown")])).retryable, false);
  assert.equal(networkFailure(Object.assign(new Error(), { code: "ETIMEDOUT", syscall: "connect" })).retryable, true);
  assert.equal(networkFailure(Object.assign(new Error(), { code: "ETIMEDOUT", syscall: "read" })).retryable, false);
});

test("connection failure retries once and is not counted as unknown billable usage", async t => {
  isolated(t); const f = await fixture(); await startTest(f.id); let calls = 0;
  const result = await call(f.id, async () => { if (++calls === 1) throw failure("UND_ERR_CONNECT_TIMEOUT"); return response(); });
  assert.equal(result.retryCount, 1); assert.equal(calls, 2);
  const usage = getApiUsage(f.id);
  assert.equal(usage.notSentRequests, 1); assert.equal(usage.unknownUsageRequests, 0);
  assert.equal(usage.totalTokens, 110); assert.equal(usage.lastError.code, "UND_ERR_CONNECT_TIMEOUT");
  assert.ok(usage.lastError.elapsedMs >= 0); assert.ok(!JSON.stringify(usage).includes("private URL"));
});

test("repeated connection failure stops after two attempts; ambiguous disconnect never retries", async t => {
  isolated(t);
  for (const code of ["ECONNREFUSED", "ECONNRESET"]) {
    const f = await fixture(); await startTest(f.id); let calls = 0;
    await assert.rejects(call(f.id, async () => { calls++; throw failure(code); }), new RegExp(code));
    assert.equal(calls, code === "ECONNREFUSED" ? 2 : 1);
    assert.equal(getApiUsage(f.id).unknownUsageRequests, code === "ECONNREFUSED" ? 0 : 1);
  }
});

test("cancellation interrupts connection backoff without a second model call", async t => {
  isolated(t); const f = await fixture(); await startTest(f.id); let calls = 0;
  const control = new SimulationControl();
  await assert.rejects(call(f.id, async () => {
    calls++; setTimeout(() => control.stop(new Error("cancelled")), 10); throw failure("EAI_AGAIN");
  }, { control, retryDelayMs: 5000 }), /cancelled/);
  assert.equal(calls, 1); assert.equal(control.controllers.size, 0);
});

test("HTTP business code is retained without leaking response contents or retrying", async t => {
  isolated(t); const f = await fixture(); await startTest(f.id); let calls = 0;
  await assert.rejects(call(f.id, async () => { calls++; return Response.json({ error: { code: "1302", message: "private response" } }, { status: 429 }); }), /HTTP 429.*1302/);
  assert.equal(calls, 1);
  const usage = getApiUsage(f.id);
  assert.equal(usage.lastError.httpStatus, 429); assert.equal(usage.lastError.providerCode, "1302");
  assert.ok(!JSON.stringify(usage).includes("private response"));
});

test("GLM vertical runtime limits concurrency to two and preserves all 200 judgments", async t => {
  isolated(t); const f = await fixture({ testMode: "vertical" }); let active = 0; let peak = 0; let calls = 0;
  assert.deepEqual(modelRequestPolicy("glm-4.6v", "vertical"), { concurrency: 2, timeoutMs: 90000 });
  await runSimulation(f.id, f.candidates, references(9), f.title, "glm-4.6v", f.randomSeed, "vertical", { ...fastImages, transport: async () => {
    calls++; peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--; return response();
  } });
  assert.equal(peak, 2); assert.equal(calls, 200); assert.equal((await getTest(f.id)).status, "completed");
});

test("local Qwen is the first/default option and Ollama URL is restricted to loopback", t => {
  isolated(t);
  assert.equal(MODEL_OPTIONS[0].id, "ollama");
  assert.equal(isModelProvider("ollama"), true);
  assert.equal(modelNameForProvider("ollama"), "qwen3.5:4b");
  const original = process.env.OLLAMA_BASE_URL;
  try {
    for (const value of ["http://127.0.0.1:11434", "http://localhost:11434/v1", "http://[::1]:11434/v1/"]) {
      process.env.OLLAMA_BASE_URL = value;
      assert.match(ollamaBaseUrl(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):11434$/);
    }
    for (const value of ["https://127.0.0.1:11434/v1", "http://example.com/v1", "http://127.0.0.1:11434/api", "http://user:pass@127.0.0.1:11434/v1"]) {
      process.env.OLLAMA_BASE_URL = value;
      assert.throws(() => ollamaBaseUrl(), /本机 HTTP 回环地址|路径必须|不能包含密钥/);
    }
  } finally {
    if (original === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = original;
  }
});

test("local Qwen sends vision JSON requests with thinking disabled and records usage", async t => {
  isolated(t); const f = await fixture(); await startTest(f.id); let captured;
  const result = await callWithRetry({
    testId: f.id, variantKey: "A", agentId: "one", provider: "ollama", prompt: "test",
    feedDataUrl: "data:image/jpeg;base64,eA==", testMode: "grid", control: new SimulationControl(),
    transport: async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return ollamaResponse();
    }
  });
  assert.equal(result.choice, "A");
  assert.equal(captured.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(captured.headers.Authorization, "Bearer ollama");
  assert.equal(captured.body.model, "qwen3.5:4b");
  assert.equal(captured.body.think, false);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.options.num_ctx, 8192);
  assert.equal(captured.body.options.temperature, 0.2);
  assert.deepEqual(captured.body.format.properties.choice.enum, ["A", "B", "C", "D", "NONE"]);
  assert.deepEqual(captured.body.messages[0].images, ["eA=="]);
  assert.equal(getApiUsage(f.id).totalTokens, 326);
});

test("local Qwen serializes the full vertical test and keeps every judgment", async t => {
  isolated(t); const f = await fixture({ testMode: "vertical" }); let calls = 0; let active = 0; let peak = 0;
  assert.deepEqual(modelRequestPolicy("ollama", "grid"), { concurrency: 1, timeoutMs: 180000 });
  assert.deepEqual(modelRequestPolicy("ollama", "vertical"), { concurrency: 1, timeoutMs: 180000 });
  await runSimulation(f.id, f.candidates, references(9), f.title, "ollama", f.randomSeed, "vertical", { ...fastImages, transport: async () => {
    calls++; peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return ollamaResponse();
  } });
  assert.equal(calls, 200); assert.equal(peak, 1); assert.equal((await getTest(f.id)).status, "completed");
  assert.equal((await getTest(f.id)).model, "qwen3.5:4b"); assert.equal(getApiUsage(f.id).totalTokens, 65200);
});
