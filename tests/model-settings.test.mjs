import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { isolated, fixture, fastImages, response } from "./helpers.mjs";
import { publicModelSettings, readModelSettings, saveModelSettings, runtimeModelConfig, modelConfigSnapshot } from "../lib/model-settings.ts";
import { getDatabase, retryDatabaseBusy } from "../lib/storage.ts";
import { getTest, requestTestCancellation } from "../lib/db.ts";
import { runSimulation } from "../lib/simulation.ts";
import { listOllamaModels, assertOllamaReady, pullOllamaModel, startLocalOllama } from "../lib/ollama.ts";
import { checkModelConnection } from "../lib/model-check.ts";

test("local settings preserve masked keys across reads and share Zhipu credentials", t => {
  isolated(t);
  saveModelSettings({ provider: "zhipu", apiKey: "private-settings-key", model: "glm-5.3-flash" });
  assert.equal(readModelSettings().zhipu.apiKey, "private-settings-key");
  assert.equal(readModelSettings()["glm-4.6v"].apiKey, "private-settings-key");
  saveModelSettings({ provider: "zhipu", model: "another-vision-model" });
  assert.equal(readModelSettings().zhipu.apiKey, "private-settings-key");
  const visible = publicModelSettings();
  assert.equal(visible.providers.zhipu.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(visible).includes("private-settings-key"));
  assert.ok(!Object.hasOwn(visible.providers.zhipu, "apiKey"));
  saveModelSettings({ provider: "zhipu", apiKey: "" });
  assert.equal(publicModelSettings().providers.zhipu.apiKeyConfigured, false);
});

test("settings validate addresses, limits and running-task ownership", async t => {
  isolated(t);
  for (const input of [
    {provider:"ollama",baseUrl:"http://example.com:11434"},
    {provider:"deepseek",baseUrl:"https://secret@api.deepseek.com"},
    {provider:"ollama",model:"../bad model"},
    {provider:"zhipu",maxTokens:1}, {provider:"unknown"}
  ]) assert.throws(() => saveModelSettings(input));
  const f = await fixture();
  assert.throws(() => saveModelSettings({provider:"ollama",model:"qwen3.5:9b"}), /测试进行中/);
  await requestTestCancellation(f.id);
  saveModelSettings({provider:"ollama",model:"qwen3.5:9b",timeoutSeconds:300});
  assert.equal(runtimeModelConfig("ollama").model, "qwen3.5:9b");
});

test("full paired run uses one immutable configuration and persists only safe metadata", async t => {
  isolated(t);
  const config = runtimeModelConfig("zhipu");
  const f = await fixture(); let exported; let calls = 0;
  await runSimulation(f.id, f.candidates, Array.from({length:3},(_,i)=>({id:"ref-"+i,fileName:"unused",title:"test"})), f.title, "zhipu", f.randomSeed, "grid", {
    ...fastImages, modelConfig: config,
    transport: async (_url, init) => {
      const input = JSON.parse(init.body);
      assert.equal(input.model, config.model);
      assert.equal(init.headers.Authorization, "Bearer " + config.apiKey);
      calls++;
      if (calls === 1) getDatabase().prepare("INSERT INTO local_settings VALUES ('model-settings', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(JSON.stringify({zhipu:{...readModelSettings().zhipu,model:"changed-mid-run",apiKey:"new-private-key"}}));
      return response();
    }, exportResult: async input => { exported = input; }
  });
  assert.equal(calls, 200);
  const saved = await getTest(f.id);
  assert.equal(saved.model, config.model);
  assert.deepEqual(saved.modelConfig, modelConfigSnapshot(config));
  assert.equal(exported.model, config.model);
  assert.ok(!JSON.stringify(saved).includes(config.apiKey));
  assert.ok(!JSON.stringify(exported).includes(config.apiKey));
});

test("lock retries are bounded and do not swallow other database errors", () => {
  let attempts = 0;
  assert.equal(retryDatabaseBusy(() => { if (++attempts < 3) throw Object.assign(Error("busy"), {errcode:5}); return "ready"; }, 500), "ready");
  assert.equal(attempts, 3);
  assert.throws(() => retryDatabaseBusy(() => { throw Object.assign(Error("schema broken"), {errcode:1}); }), /schema broken/);
  assert.throws(() => retryDatabaseBusy(() => { throw Object.assign(Error("locked"), {errcode:6}); }, 0), /locked/);
});

test("Ollama discovery excludes text-only and cloud models; pulls stream progress", async t => {
  isolated(t);
  const server = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const input = text ? JSON.parse(text) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags") res.end(JSON.stringify({models:[{name:"vision"},{name:"text"},{name:"remote:cloud"}]}));
    else if (req.url === "/api/show") res.end(JSON.stringify({capabilities: input.model === "text" ? ["completion"] : ["completion","vision"], ...(input.model === "remote:cloud" ? {remote_model:"remote",remote_host:"https://cloud.invalid"}: {})}));
    else if (req.url === "/api/pull") res.end('{"status":"downloading","total":100,"completed":50}\n{"status":"success"}\n');
    else if (req.url === "/api/version") res.end('{"version":"test"}');
    else {res.statusCode=404;res.end("{}");}
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(() => new Promise(resolve=>server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await startLocalOllama(base)).alreadyRunning, true, "reuse an existing service without spawning or replacing it");
  const result = await listOllamaModels(base);
  assert.deepEqual(result.models.filter(m=>m.vision&&m.local).map(m=>m.name), ["vision"]);
  await assert.rejects(assertOllamaReady(base,"text"), /不支持图片识别/);
  await assert.rejects(assertOllamaReady(base,"remote:cloud"), /本机模型权重/);
  const stream = await pullOllamaModel(base,"vision",new AbortController().signal);
  assert.match(await new Response(stream).text(), /success/);
  await assert.rejects(pullOllamaModel("http://evil.invalid","vision",new AbortController().signal), /本机/);
});

test("explicit connection check makes one vision request and returns no credentials", async t => {
  isolated(t); let calls=0;
  const config=runtimeModelConfig("zhipu");
  const result=await checkModelConnection(config,async(_url,init)=>{
    calls++; const body=JSON.parse(init.body);
    assert.equal(body.messages[0].content[1].type,"image_url");
    assert.equal(body.max_tokens,4096);
    return response();
  });
  assert.equal(result.connected,true);assert.equal(calls,1);
  assert.ok(!JSON.stringify(result).includes(config.apiKey));
});
