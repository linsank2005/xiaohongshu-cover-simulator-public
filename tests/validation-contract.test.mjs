import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DatabaseSync } from "node:sqlite";
import { isolated } from "./helpers.mjs";
import { closeDatabases, getDatabase } from "../lib/storage.ts";
import { readValidationRecords } from "../lib/validation-store.ts";
import { normalizeValidationRecord,parseValidationImport,serializeValidationCsv,calculateValidationStats } from "../lib/validation.ts";
import { checkLocalRequest,limitedRequest } from "../lib/api-boundary.ts";
import { validateUploadedImage } from "../lib/upload-image.ts";
import { determineWinner } from "../lib/result-rules.ts";
import { loadAgents } from "../lib/agents.ts";
import { buildAgentPrompt } from "../lib/agent-prompt.ts";

test("CSV roundtrip keeps quoted content and excludes inconclusive samples",()=>{
  const record=normalizeValidationRecord({validationId:"one",simulationTestId:"id",validationStatus:"valid",validationType:"prospective",simulatedWinner:"A",realWinner:"A",title:'a,"b"\nnext'});
  const parsed=parseValidationImport(serializeValidationCsv([record]),"csv");assert.equal(parsed.records[0].title,record.title);
  const stats=calculateValidationStats([record,{...record,validationId:"two",simulationTestId:"id2",validationStatus:"inconclusive"}]);assert.equal(stats.validCount,1);assert.equal(stats.agreementRate,100);
});

test("legacy database and JSON migration preserves data, deduplicates PK once and keeps original file",async t=>{
  const directory=isolated(t);const legacy=path.join(directory,"validation-records.json");
  const original=JSON.stringify(["A","B"].map((winner,i)=>normalizeValidationRecord({validationId:`old-${i}`,simulationTestId:"same",validationStatus:"valid",validationType:"prospective",simulatedWinner:"A",realWinner:winner,updatedAt:`2026-01-0${i+1}`})));
  fs.writeFileSync(legacy,original);
  const db=new DatabaseSync(path.join(directory,"simulator.db"));db.exec("CREATE TABLE tests(id TEXT PRIMARY KEY,uploaded_path TEXT NOT NULL,reference_ids TEXT NOT NULL,status TEXT NOT NULL,selected_count INTEGER,total_trials INTEGER,simulated_click_rate INTEGER,created_at TEXT,completed_at TEXT); INSERT INTO tests VALUES ('legacy','a','[]','completed',1,100,1,'2026-01-01',NULL)");db.close();
  let records=await readValidationRecords();assert.equal(records.length,1);assert.equal(records[0].realWinner,"B");assert.equal(fs.readFileSync(legacy,"utf8"),original);
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM tests").get().n,1);
  getDatabase().prepare("DELETE FROM validation_records").run();closeDatabases();records=await readValidationRecords();assert.equal(records.length,0);
});

test("local boundary blocks remote hosts, cross-origin writes, missing client header",()=>{
  assert.equal(checkLocalRequest(new Request("http://127.0.0.1:3000/api/tests")),null);
  assert.equal(checkLocalRequest(new Request("http://localhost:3000/api/tests",{method:"POST",headers:{"x-simulator-client":"local",origin:"http://localhost:3000"}})),null);
  for(const request of [new Request("http://evil.test/api/tests"),new Request("http://localhost/api/tests",{headers:{host:"evil.test"}}),new Request("http://localhost/api/tests",{method:"POST"}),new Request("http://localhost/api/tests",{method:"POST",headers:{origin:"http://evil.test","x-simulator-client":"local"}})])assert.equal(checkLocalRequest(request).status,403);
});

test("streamed uploads enforce limits even without Content-Length",async()=>{
  await assert.rejects(limitedRequest(new Request("http://localhost/api",{method:"POST",body:"123456"}),5),/过大/);
  assert.equal(await (await limitedRequest(new Request("http://localhost/api",{method:"POST",body:"12345"}),5)).text(),"12345");
});

test("image validation rejects MIME spoofing, corrupted files, over-sized pixels",async()=>{
  const png=await sharp({create:{width:20,height:30,channels:3,background:"white"}}).png().toBuffer();assert.equal(await validateUploadedImage(png),"png");
  await assert.rejects(validateUploadedImage(Buffer.from("GIF89a")),/实际图片格式/);
  await assert.rejects(validateUploadedImage(png.subarray(0,20)));
  const huge=await sharp({create:{width:5000,height:5000,channels:3,background:"white"}}).png().toBuffer();await assert.rejects(validateUploadedImage(huge));
});

test("winner rules distinguish ties and incomplete results",()=>{
  assert.equal(determineWinner([{key:"A",selectedCount:10,totalTrials:100},{key:"B",selectedCount:10,totalTrials:100}]),"tie");
  assert.equal(determineWinner([{key:"A",selectedCount:10,totalTrials:100},{key:"B",selectedCount:11,totalTrials:100}]),"B");
  assert.equal(determineWinner([{key:"A",selectedCount:10,totalTrials:99},{key:"B",selectedCount:11,totalTrials:100}]),null);
});

test("compact prompt preserves all behavioral fields and removes only audit metadata",()=>{
  const agent=loadAgents()[0];const prompt=buildAgentPrompt(agent,"vertical");
  const embedded=JSON.parse(prompt.slice(prompt.indexOf('{'),prompt.indexOf('}')+1));
  const {id,source,profileVersion,...behavior}=agent;assert.deepEqual(embedded,behavior);assert.match(prompt,/A、B、C、D、E、F、G、H、I、J/);
});
