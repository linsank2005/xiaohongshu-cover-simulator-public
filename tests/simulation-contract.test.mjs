import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { isolated, fixture, response, fastImages, references, createReferenceFixtures } from "./helpers.mjs";
import { getTest, getChoiceStats, startTest, requestTestCancellation } from "../lib/db.ts";
import { getApiUsage } from "../lib/api-usage.ts";
import { runSimulation, cancelActiveSimulation, createBalancedCardOrders } from "../lib/simulation.ts";
import { parseModelChoice, InvalidModelChoiceError, SimulationControl, callWithRetry } from "../lib/model-client.ts";
import { deriveSimulatedWinner } from "../lib/validation-service.ts";

const run = (f, deps = {}, mode = "grid") => runSimulation(f.id, f.candidates, references(mode === "grid" ? 3 : 9), f.title, "zhipu", f.randomSeed, mode, { ...fastImages, ...deps });

test("choice validation rejects null and grid E-J; vertical accepts J", () => {
  for (const content of ['null','[]','{}','bad','{"choice":"E"}','{"choice":"J"}']) assert.throws(() => parseModelChoice(content, "grid"), InvalidModelChoiceError);
  assert.equal(parseModelChoice('{"choice":"J"}', "vertical"), "J");
  assert.equal(parseModelChoice('```json\n{"choice":"NONE"}\n```'), "NONE");
});

test("paired plans are deterministic and position-balanced in both modes", () => {
  for (const mode of ["grid", "vertical"]) {
    const orders = createBalancedCardOrders("seed", 100, mode);
    assert.deepEqual(orders, createBalancedCardOrders("seed", 100, mode));
    const names = mode === "grid" ? 4 : 10;
    assert.equal(new Set(orders.flat()).size, names);
    for (const label of new Set(orders.flat())) assert.equal(orders.filter(o => o[0] === label).length, 100 / names);
  }
});

test("normal test + simultaneous duplicate dispatch = exactly 200 requests, 200 unique trials", async t => {
  isolated(t); const f = await fixture(); let calls = 0;
  const deps = { transport: async () => { calls++; return response(); } };
  await Promise.all([run(f, deps), run(f, deps)]);
  assert.equal(calls, 200);
  assert.equal((await getTest(f.id)).status, "completed");
  const stats = await getChoiceStats(f.id);
  assert.equal(stats.totalTrials, 200);
  assert.deepEqual(stats.variants.map(v => v.coverSelectedCount), [25,25]);
  assert.equal(deriveSimulatedWinner(await getTest(f.id), stats).winner, "tie");
  const usage = getApiUsage(f.id);
  assert.equal(usage.requestCount, 200); assert.equal(usage.retryCount, 0);
  assert.equal(usage.totalTokens, 22000); assert.equal(usage.unknownUsageRequests, 0);
  await run(f, deps); assert.equal(calls, 200);
});

test("vertical full trial flow accepts J and produces 10/100 per cover", async t => {
  isolated(t); const f = await fixture({testMode: "vertical"});
  await run(f, {transport: async () => response("J")}, "vertical");
  assert.equal((await getTest(f.id)).status, "completed");
  assert.deepEqual((await getChoiceStats(f.id)).variants.map(v => v.coverSelectedCount), [10,10]);
});

test("first fatal failure stops dispatch and aborts other in-flight requests", async t => {
  isolated(t); const f = await fixture(); let calls = 0; let aborted = 0;
  await run(f, { transport: async (_url, init) => {
    calls++;
    if (calls === 1) return new Response("", {status: 429});
    return await new Promise((resolve, reject) => init.signal.addEventListener("abort", () => { aborted++; reject(new DOMException("abort", "AbortError")); }, {once:true}));
  }});
  assert.ok(calls <= 5); assert.equal(aborted, calls - 1);
  assert.equal((await getTest(f.id)).status, "failed");
  assert.ok((await getTest(f.id)).model);
  assert.ok((await getTest(f.id)).promptVersion);
  assert.equal(getApiUsage(f.id).requestCount, calls);
  assert.equal(getApiUsage(f.id).retryCount, 0);
});

test("cancel during rendering sends no requests", async t => {
  isolated(t); const f = await fixture(); let calls = 0;
  await run(f, { renderFeed: async () => { await requestTestCancellation(f.id); cancelActiveSimulation(f.id); return "image"; }, transport: async () => {calls++; return response();} });
  assert.equal(calls, 0); assert.equal((await getTest(f.id)).status, "cancelled");
});

test("cancel in-flight aborts waiting requests and schedules no later calls", async t => {
  isolated(t); const f = await fixture(); let calls = 0;
  await run(f, {transport: async (_url, init) => {
    calls++;
    queueMicrotask(async () => { await requestTestCancellation(f.id); cancelActiveSimulation(f.id); });
    return await new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("abort", "AbortError")), {once:true}));
  }});
  assert.ok(calls > 0 && calls <= 5); assert.equal((await getTest(f.id)).status, "cancelled");
  assert.equal(getApiUsage(f.id).requestCount, calls);
  assert.equal(getApiUsage(f.id).unknownUsageRequests, calls);
});

test("invalid format retries once, usage includes both responses and cached/reasoning details", async t => {
  isolated(t); const f = await fixture(); await startTest(f.id); let calls = 0;
  const result = await callWithRetry({testId:f.id, variantKey:"A",agentId:"one",provider:"zhipu",prompt:"test",feedDataUrl:"image",testMode:"grid",control:new SimulationControl(),transport:async()=>{
    calls++; return response(calls === 1 ? "J" : "A", {prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:50},completion_tokens_details:{reasoning_tokens:10}});
  }});
  assert.equal(result.retryCount, 1); assert.equal(calls, 2);
  const usage = getApiUsage(f.id); assert.equal(usage.totalTokens,240);assert.equal(usage.cachedTokens,100);assert.equal(usage.reasoningTokens,20);assert.equal(usage.statuses.invalid_response,1);
});

test("second invalid response stops; timeout, HTTP and output-limit never retry", async t => {
  isolated(t);
  for (const kind of ["invalid","http","length","timeout"]) {
    const f=await fixture(); await startTest(f.id); let calls=0;
    await assert.rejects(callWithRetry({testId:f.id,variantKey:"A",agentId:"one",provider:"zhipu",prompt:"test",feedDataUrl:"image",testMode:"grid",control:new SimulationControl(),timeoutMs:5,transport:async(_url,init)=>{
      calls++;
      if(kind==="http") return new Response("",{status:500});
      if(kind==="length") return Response.json({choices:[{finish_reason:"length",message:{content:""}}],usage:{total_tokens:256}});
      if(kind==="timeout") return await new Promise((resolve,reject)=>init.signal.addEventListener("abort",()=>reject(new DOMException("abort","AbortError")),{once:true}));
      return response("J");
    }}));
    assert.equal(calls,kind==="invalid"?2:1);
    assert.equal(getApiUsage(f.id).requestCount,calls);
  }
});

test("cancel between invalid response and retry prevents second dispatch", async t => {
  isolated(t);const f=await fixture();await startTest(f.id);let calls=0;
  await assert.rejects(callWithRetry({testId:f.id,variantKey:"A",agentId:"one",provider:"zhipu",prompt:"test",feedDataUrl:"image",testMode:"grid",control:new SimulationControl(),transport:async()=>{
    calls++;await requestTestCancellation(f.id);return response("J");
  }}));
  assert.equal(calls,1);
});

test("real image composition, full paired run, export and calibration share tie result", async t => {
  const directory=isolated(t);
  const file=path.join(directory,"cover.png");await sharp({create:{width:540,height:720,channels:3,background:"#ecdecc"}}).png().toFile(file);
  const f=await fixture({uploadedPath:file,candidates:[{key:"A",label:"A",path:file},{key:"B",label:"B",path:file}]});
  const fixtureLibrary = await createReferenceFixtures(directory, 3);
  process.env.SIMULATOR_REFERENCE_DIR = fixtureLibrary.imageDir;
  const refs = fixtureLibrary.library;
  await runSimulation(f.id,f.candidates,refs,f.title,"zhipu",f.randomSeed,"grid",{transport:async()=>response()});
  assert.equal((await getTest(f.id)).status,"completed");
  const exported=JSON.parse(fs.readFileSync(path.join(directory,"results",f.id,"result.json"),"utf8"));
  assert.equal(exported.comparison.winnerKey,"tie");assert.equal(exported.apiUsage.requestCount,200);
  const preview=await sharp(path.join(directory,"results",f.id,"feed-preview.jpg")).metadata();
  assert.equal(preview.width,1080);assert.equal(preview.height,1440);
});


test("all 200 agents can retry once but total dispatch stays at the hard 400 cap", async t => {
  isolated(t);const f=await fixture();const seen=new Map();
  await run(f,{transport:async(_url,init)=>{
    const key=JSON.parse(init.body).messages[0].content[0].text;
    const n=(seen.get(key)??0)+1;seen.set(key,n);
    return response(n%2===1?"J":"A");
  }});
  assert.equal((await getTest(f.id)).status,"completed");
  assert.equal(getApiUsage(f.id).requestCount,400);
  assert.equal(getApiUsage(f.id).retryCount,200);
  assert.equal((await getChoiceStats(f.id)).totalTrials,200);
});

test("initialization failure reaches failed without model calls",async t=>{
  isolated(t);const f=await fixture();let calls=0;
  await runSimulation(f.id,f.candidates,[],f.title,"zhipu",f.randomSeed,"grid",{transport:async()=>{calls++;return response();}});
  assert.equal((await getTest(f.id)).status,"failed");assert.equal(calls,0);
});
