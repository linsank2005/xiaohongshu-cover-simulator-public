import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { zipSync, unzipSync } from "fflate";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cover-http-"));
const referenceLibrary = JSON.parse(fs.readFileSync("data/reference-covers.json", "utf8"));
assert.equal(referenceLibrary.length, 100);
const headers = { "x-simulator-client": "local" };
let mode = "normal", requests = 0, active = 0, peak = 0;
let child, base, logs = "";
const mock = http.createServer(async (req, res) => {
  try {
  if (req.url === "/api/tags") { res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({models:[{name:"qwen3.5:4b",size:3389983735}]})); return; }
  if (req.url === "/api/show") {
    let text=""; for await (const chunk of req) text+=chunk;
    const input=JSON.parse(text);res.setHeader("Content-Type","application/json");
    res.end(JSON.stringify({capabilities:input.model === "text-only" ? ["completion"] : ["completion","vision"]}));return;
  }
  requests++; active++; peak = Math.max(peak, active);
  res.on("close", () => active--);
  let body = ""; for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  assert.equal(payload.messages.length, 1);
  const ollamaRequest = req.url === "/api/chat";
  if (ollamaRequest) {assert.equal(payload.messages[0].images.length,1);assert.equal(payload.options.num_ctx,8192);assert.equal(payload.think,false);}
  else {assert.equal(payload.messages[0].content.filter(p=>p.type==="image_url").length, 1);assert.equal(payload.messages[0].content[1].image_url.detail, "high");}
  if (mode === "hold") return;
  if (mode === "failure") {res.writeHead(429);res.end();return;}
  if (ollamaRequest) await new Promise(resolve => setTimeout(resolve, 15));
  if (mode === "vertical") { assert.equal(payload.model, "glm-4.6v"); await new Promise(resolve => setTimeout(resolve, 15)); }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(ollamaRequest?{message:{content:'{"choice":"A"}'},done_reason:"stop",prompt_eval_count:100,eval_count:10}:{choices:[{message:{content:'{"choice":"A"}'},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}}));
  } catch (error) {
    // A cancellation / executor restart can close an image upload mid-stream.
    // This is the expected transport outcome for the mock, not a test failure.
    if (req.aborted && error?.code === "ECONNRESET") return;
    throw error;
  }
});
mock.listen(0, "127.0.0.1");await once(mock,"listening");
const mockUrl=`http://127.0.0.1:${mock.address().port}`;
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(check, timeout=60000) {
  const start=Date.now();
  while(Date.now()-start<timeout) {const value=await check();if(value)return value;await delay(100);}
  throw Error("regression timed out: "+logs.slice(-1500));
}
async function start() {
  const probe=http.createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const port=probe.address().port;await new Promise(r=>probe.close(r));
  base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{cwd:process.cwd(),windowsHide:true,env:{...process.env,SIMULATOR_DATA_DIR:directory,SIMULATOR_REFERENCE_DIR:"",OLLAMA_BASE_URL:mockUrl,OLLAMA_MODEL:"qwen3.5:4b",ZHIPU_API_KEY:"local-test-only",ZHIPU_BASE_URL:mockUrl,DEEPSEEK_API_KEY:"local-test-only",DEEPSEEK_BASE_URL:mockUrl,NEXT_TELEMETRY_DISABLED:"1"}});
  child.stdout.on("data",chunk=>logs+=chunk);child.stderr.on("data",chunk=>logs+=chunk);
  await until(async()=>{try{return(await fetch(base)).ok;}catch{return false;}});
}
async function stop() {if(child&&child.exitCode===null){const exited=once(child,"exit");child.kill();await exited;}child=null;}
const png=await sharp({create:{width:540,height:720,channels:3,background:"#eadecc"}}).png().toBuffer();
function form(key,bytes=png,provider=mode === "vertical" ? "glm-4.6v" : "zhipu") {const f=new FormData();f.append("requestKey",key);f.append("title","HTTP 回归测试");if(provider)f.append("provider",provider);f.append("testMode",mode === "vertical" ? "vertical" : "grid");for(const name of ["a","b"])f.append("cover",new Blob([bytes],{type:"image/png"}),name+".png");return f;}
async function create(key=randomUUID()) {const r=await fetch(base+"/api/tests",{method:"POST",headers,body:form(key)});assert.equal(r.status,202,await r.clone().text());return (await r.json()).id;}
async function createDefault(key=randomUUID()) {const r=await fetch(base+"/api/tests",{method:"POST",headers,body:form(key,png,"")});assert.equal(r.status,202,await r.clone().text());return (await r.json()).id;}
async function status(id) {const r=await fetch(base+"/api/tests/"+id);assert.equal(r.status,200,await r.clone().text());return r.json();}
async function terminal(id) {return until(async()=>{const t=await status(id);return ["completed","failed","cancelled"].includes(t.status)?t:null;});}
async function post(url,body) {return fetch(base+url,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(body)});}
async function verifyGeneratedReferences(id, count, height) {
  const resultDir = path.join(directory, "results", id);
  const exported = JSON.parse(fs.readFileSync(path.join(resultDir, "result.json"), "utf8"));
  assert.equal(exported.referenceCovers.length, count);
  const response = await fetch(base + "/api/tests/" + id + "/references");
  assert.equal(response.status, 200);
  const { references } = await response.json();
  assert.equal(references.length, count);
  assert.equal(new Set(references.map(r => r.id)).size, count);
  for (const reference of references) {
    const source = referenceLibrary.find(r => r.id === reference.id);
    assert.ok(source, "selected reference belongs to active generated library");
    assert.equal(reference.title, source.title);
    const image = await fetch(base + reference.url);
    assert.equal(image.status, 200);
    assert.equal(createHash("sha256").update(Buffer.from(await image.arrayBuffer())).digest("hex"), createHash("sha256").update(fs.readFileSync(path.join("public/reference-covers", source.fileName))).digest("hex"));
  }
  assert.equal(exported.feedPreviews.length, 2);
  assert.deepEqual(exported.feedPreviews[0].cardOrder, exported.feedPreviews[1].cardOrder);
  for (const preview of exported.feedPreviews) {
    const bytes = fs.readFileSync(path.join(resultDir, preview.fileName));
    const metadata = await sharp(bytes).metadata();
    await sharp(bytes).raw().toBuffer();
    assert.equal(metadata.width, 1080);
    assert.equal(metadata.height, height);
  }
}
try {
  await start();
  const page = await (await fetch(base)).text();
  assert.match(page, /<title>小红书封面 AI 对比测试<\/title>/);
  assert.match(page, /参考图库已接入 100 张模拟封面/);
  assert.match(page, /并非真实发布的封面/);
  assert.match(page, /我的记录/); assert.match(page, /模型设置/);
  const settings=await (await fetch(base+"/api/settings")).json();
  assert.equal(settings.providers.zhipu.apiKeyConfigured,true);assert.ok(!JSON.stringify(settings).includes("local-test-only"));
  const updateSettings=async body=>fetch(base+"/api/settings",{method:"PATCH",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await updateSettings({provider:"ollama",model:"text-only"})).status,200);
  const textOnly=await fetch(base+"/api/tests",{method:"POST",headers,body:form(randomUUID(),png,"")});
  assert.equal(textOnly.status,400);assert.match(await textOnly.text(),/不支持图片识别/);assert.equal(requests,0);
  assert.equal((await updateSettings({provider:"ollama",model:"qwen3.5:4b"})).status,200);
  const checked=await post("/api/settings/check",{provider:"zhipu"});assert.equal(checked.status,200);assert.equal((await checked.json()).connected,true);assert.equal(requests,1);requests=0;
  console.log("PASS masked settings / vision capability preflight / explicit single-call connection check");
  assert.equal((await fetch(base+"/api/tests",{method:"POST"})).status,403);
  assert.equal((await fetch(base+"/api/tests",{method:"POST",headers:{...headers,origin:"http://evil.invalid"}})).status,403);
  assert.equal(await new Promise((resolve,reject)=>{
    const req=http.get(base+"/api/tests/history",{headers:{host:"evil.invalid"}},res=>{res.resume();resolve(res.statusCode);});req.on("error",reject);
  }),403);
  assert.equal((await fetch(base+"/api/tests",{method:"POST",headers,body:form(randomUUID(),Buffer.from("GIF89a"))})).status,400);
  assert.equal(requests,0);
  console.log("PASS local API boundary and preflight image validation");
  const key=randomUUID();const id=await create(key);assert.equal(await create(key),id);
  const result=await terminal(id);assert.equal(result.status,"completed",JSON.stringify(result));
  assert.equal(requests,200);assert.equal(result.apiUsage.requestCount,200);assert.equal(result.apiUsage.totalTokens,22000);assert.equal(result.winnerKey,"tie");assert.equal(result.validTrials,200);assert.ok(Number.isInteger(result.durationMs)&&result.durationMs>=0);
  const historyAfterCompletion=await (await fetch(base+"/api/tests/history")).json();const historyResult=historyAfterCompletion.tests.find(test=>test.id===id);assert.ok(historyResult);assert.equal(historyResult.durationMs,result.durationMs);
  assert.equal((await fetch(base+result.feedPreviewUrl)).status,200);
  await verifyGeneratedReferences(id, 3, 1440);
  const exported=JSON.parse(fs.readFileSync(path.join(directory,"results",id,"result.json"),"utf8"));assert.equal(exported.comparison.winnerKey,result.winnerKey);
  let saved=await post("/api/validation/result",{simulationTestId:id,realWinner:"A"});assert.equal(saved.status,201,await saved.clone().text());
  saved=await post("/api/validation",{records:[{validationId:"different-id",simulationTestId:id,validationStatus:"valid",validationType:"prospective",realWinner:"B",model:"forged-model"}]});
  assert.equal(saved.status,201,await saved.clone().text());const calibration=await saved.json();assert.equal(calibration.records.length,1);assert.equal(calibration.stats.validCount,0);assert.notEqual(calibration.records[0].model,"forged-model");
  console.log("PASS full upload / 200 model calls / usage / export / calibration / duplicate submission");
  const recordId = `local:${id}`;
  const noteResponse = await fetch(base + "/api/records/" + encodeURIComponent(recordId), { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ notes: "HTTP 备注持久化" }) }); assert.equal(noteResponse.status, 200);
  const recordsResponse = await (await fetch(base + "/api/records?q=" + encodeURIComponent("备注持久化"))).json(); assert.equal(recordsResponse.total, 1); assert.equal(recordsResponse.records[0].notes, "HTTP 备注持久化");
  const jsonExport = await fetch(base + "/api/records/export?source=local"); assert.equal(jsonExport.status, 200); const portable = await jsonExport.json();
  assert.equal(portable.records.length, 1); assert.equal(portable.records[0].realResult.winner, "B"); assert.equal(portable.records[0].variants[0].totalTrials, 100);
  const portableText = JSON.stringify(portable); assert(!portableText.includes("local-test-only")); assert(!portableText.includes("apiKey")); assert(!portableText.includes(directory));
  const zipExport = await fetch(base + "/api/records/export?includeCovers=1"); assert.equal(zipExport.status, 200); assert.equal(zipExport.headers.get("X-Missing-Covers"), "0");
  const zipEntries = unzipSync(new Uint8Array(await zipExport.arrayBuffer())); const manifest = JSON.parse(Buffer.from(zipEntries["records.json"]).toString()); const foreignOrigin = randomUUID();
  for (const record of manifest.records) { const original = record.originId; record.originId = foreignOrigin; for (const candidate of record.candidates) { const old = candidate.fileName; candidate.fileName = old.replace(original, foreignOrigin); zipEntries[candidate.fileName] = zipEntries[old]; delete zipEntries[old]; } }
  zipEntries["records.json"] = Buffer.from(JSON.stringify(manifest));
  const importedForm = new FormData(); importedForm.append("file", new Blob([zipSync(zipEntries)], { type: "application/zip" }), "records.zip");
  const imported = await fetch(base + "/api/records/import", { method: "POST", headers, body: importedForm }); assert.equal(imported.status, 200, await imported.clone().text()); assert.equal((await imported.json()).created, 1);
  let external = await (await fetch(base + "/api/records?source=imported")).json(); assert.equal(external.total, 1); assert.equal(external.records[0].notes, "HTTP 备注持久化"); assert.equal((await fetch(base + external.records[0].imageUrls.A)).status, 200);
  assert.equal((await (await fetch(base + "/api/validation")).json()).records.length, 1, "file imports do not change calibration or simulation outcomes");
  const repeated = await fetch(base + "/api/records/import", { method: "POST", headers, body: importedForm }); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).updated, 1);
  const importedDelete = await fetch(base + "/api/records/" + encodeURIComponent(external.records[0].id), { method: "DELETE", headers }); assert.equal(importedDelete.status, 200); assert.equal((await (await fetch(base + "/api/records?source=imported")).json()).total, 0); assert.equal(requests, 200);
  console.log("PASS local notes / private JSON / portable cover ZIP / independent import / deduplication / delete");
  const deleted=await fetch(base+"/api/tests/"+id,{method:"DELETE",headers});assert.equal(deleted.status,200);assert.equal(fs.existsSync(path.join(directory,"results",id)),false);assert.equal((await (await fetch(base+"/api/validation")).json()).records.length,0);
  requests=0;peak=0;const localDefaultId=await createDefault();
  const liveProgress=await until(async()=>{const s=await status(localDefaultId);return s.status==="running"&&s.validTrials>0&&s.validTrials<200?s:null;});assert.ok(liveProgress.validTrials<=liveProgress.requestCount);
  const localDefault=await terminal(localDefaultId);assert.equal(localDefault.status,"completed",JSON.stringify(localDefault));assert.equal(localDefault.model,"qwen3.5:4b");assert.equal(requests,200);assert.equal(peak,1);assert.equal(localDefault.validTrials,200);assert.equal(localDefault.apiUsage.totalTokens,22000);assert.ok(Number.isInteger(localDefault.durationMs)&&localDefault.durationMs>=0);
  console.log("PASS default local Qwen / 200 model calls / serial execution / usage");
  mode="vertical";requests=0;peak=0;
  const vertical=await terminal(await create());
  assert.equal(vertical.status,"completed",JSON.stringify(vertical));assert.equal(requests,200);assert.ok(peak<=2);assert.equal(vertical.validTrials,200);assert.equal(vertical.apiUsage.totalTokens,22000);
  await verifyGeneratedReferences(vertical.id, 9, 3696);
  console.log(`PASS GLM vertical / real images / 200 requests / concurrency <= 2 (observed ${peak}) / usage`);
  mode="failure";requests=0;const failed=await terminal(await create());assert.equal(failed.status,"failed");const failureCalls=requests;await delay(300);assert.equal(requests,failureCalls);assert.ok(requests<=5);assert.ok(failed.apiUsage.requestCount>=requests && failed.apiUsage.requestCount<=5);
  console.log(`PASS failure stops requests (${requests} in-flight maximum observed)`);
  mode="hold";requests=0;const cancelledId=await create();await until(()=>requests>0);
  assert.equal((await updateSettings({provider:"ollama",model:"qwen3.5:9b"})).status,409);
  const cancel=await post("/api/tests/"+cancelledId+"/cancel",{});assert.equal(cancel.status,202);const cancelled=await terminal(cancelledId);assert.equal(cancelled.status,"cancelled");const cancelCalls=requests;await delay(300);assert.equal(requests,cancelCalls);assert.ok(requests<=5);assert.ok(cancelled.apiUsage.requestCount>=requests && cancelled.apiUsage.requestCount<=5);assert.equal(cancelled.apiUsage.unknownUsageRequests,cancelled.apiUsage.requestCount);
  console.log("PASS cancellation aborts in-flight waits and preserves unknown usage");
  assert.equal((await fetch(base + "/api/tests/" + failed.id, { method: "DELETE", headers })).status, 200);
  assert.equal((await fetch(base + "/api/records/" + encodeURIComponent(`local:${cancelledId}`), { method: "DELETE", headers })).status, 200);
  console.log("PASS failed and cancelled records cleanup");
  requests=0;const interruptedId=await create();await until(()=>requests>0);await stop();await start();const interrupted=await terminal(interruptedId);assert.equal(interrupted.status,"failed");assert.ok(interrupted.apiUsage.statuses.interrupted>=requests && interrupted.apiUsage.statuses.interrupted<=5);
  console.log("PASS server restart recovers interrupted task without replaying API calls");
  console.log("HTTP regression complete; all model requests were served by the local mock.");
} finally {
  await stop();mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));
  if(!directory.startsWith(path.join(os.tmpdir(),"cover-http-")))throw Error("unsafe cleanup");
  fs.rmSync(directory,{recursive:true,force:true});
}
