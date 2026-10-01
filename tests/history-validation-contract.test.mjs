import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { drainFileCleanup } from "../lib/test-files.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isolated, fixture, trial } from "./helpers.mjs";
import { createTest, startTest, getTest, saveTrial, getChoiceStats, completeTest, requestTestCancellation, recoverInterruptedTests, deleteTest } from "../lib/db.ts";
import { getDatabase } from "../lib/storage.ts";
import { mergeValidationRecords, readValidationRecords } from "../lib/validation-store.ts";
import { normalizeValidationRecord, calculateValidationStats } from "../lib/validation.ts";
import { beginModelRequest, finishModelRequest, getApiUsage } from "../lib/api-usage.ts";
const record=(id,winner="A")=>normalizeValidationRecord({validationId:randomUUID(),simulationTestId:id,validationStatus:"valid",validationType:"prospective",realWinner:winner,simulatedWinner:"A"});
async function completed(f) {
  await startTest(f.id);
  await Promise.all(["A","B"].flatMap(v=>Array.from({length:100},(_,i)=>saveTrial(trial(f.id,i,v)))));
  await completeTest(f.id,{model:"mock",promptVersion:"test"});
}

test("100 concurrent creates and 200 concurrent trial writes retain every row",async t=>{
  isolated(t);const fixtures=await Promise.all(Array.from({length:100},()=>fixture()));
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM tests").get().n,100);
  const f=fixtures[0];await startTest(f.id);
  await Promise.all(["A","B"].flatMap(v=>Array.from({length:100},(_,i)=>saveTrial(trial(f.id,i,v)))));
  assert.equal((await getChoiceStats(f.id)).totalTrials,200);
  await assert.rejects(saveTrial(trial(f.id,0)));
  assert.equal((await getChoiceStats(f.id)).totalTrials,200);
});

test("separate processes share SQLite transactions without lost writes",async t=>{
  isolated(t);
  const script=`import {createTest,startTest,saveTrial} from './lib/db.ts';
    for(let i=0;i<10;i++){const id=process.argv[1]+'-'+i;
    await createTest({id,uploadedPath:'a',candidates:[{key:'A',path:'a',label:'A'},{key:'B',path:'b',label:'B'}],title:'x',referenceIds:[],randomSeed:id,testMode:'grid'});
    await startTest(id);
    await saveTrial({testId:id,variantKey:'A',agentId:'one',repetition:1,targetCard:'A',cardOrder:['A','B','C','D'],chosenCard:'A',model:'mock',promptVersion:'test',retryCount:0});}`;
  await Promise.all(Array.from({length:4},(_,i)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script,String(i)],{env:process.env,windowsHide:true});
    let stderr="";child.stderr.on("data",x=>stderr+=x);child.on("error",reject);child.on("close",code=>code===0?resolve():reject(Error(stderr)));
  })));
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM tests").get().n,40);
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM trials").get().n,40);
});

test("claim and idempotency keys prevent duplicate jobs across submissions",async t=>{
  isolated(t);const f=await fixture();
  const claims=await Promise.all(Array.from({length:20},()=>startTest(f.id)));assert.equal(claims.filter(Boolean).length,1);
  await requestTestCancellation(f.id);recoverInterruptedTests(Date.now()+60000);
  const key=randomUUID();const base={...f,id:randomUUID(),requestKey:key};
  const submissions=await Promise.all(Array.from({length:10},()=>createTest({...base,id:randomUUID()})));
  assert.equal(submissions.filter(x=>x.created).length,1);assert.equal(new Set(submissions.map(x=>x.id)).size,1);
  await assert.rejects(createTest({...base,id:randomUUID(),requestKey:randomUUID()}),/已有测试/);
});

test("interrupted cancelling/running tasks recover and started usage becomes unknown",async t=>{
  isolated(t);const f=await fixture();await startTest(f.id);beginModelRequest(f.id,"A","one",0);await requestTestCancellation(f.id);
  recoverInterruptedTests(Date.now()+60000);
  assert.equal((await getTest(f.id)).status,"cancelled");assert.equal(getApiUsage(f.id).statuses.interrupted,1);
  const second=await fixture();await startTest(second.id);recoverInterruptedTests(Date.now()+60000);
  assert.equal((await getTest(second.id)).status,"failed");
  assert.throws(()=>beginModelRequest(second.id,"A","one",0));
});

test("concurrent calibration writes retain records; same simulation updates instead of duplicating",async t=>{
  isolated(t);const fixtures=await Promise.all(Array.from({length:12},()=>fixture()));
  for(const f of fixtures) await completed(f);
  await Promise.all(fixtures.map(f=>mergeValidationRecords([record(f.id)])));
  assert.equal((await readValidationRecords()).length,12);
  await mergeValidationRecords([record(fixtures[0].id,"B")]);
  const rows=await readValidationRecords();assert.equal(rows.length,12);
  assert.equal(calculateValidationStats(rows).validCount,12);
  assert.equal(rows.find(r=>r.simulationTestId===fixtures[0].id).realWinner,"B");
  await assert.rejects(mergeValidationRecords([record(fixtures[0].id),record(fixtures[0].id)]),/不能重复/);
});

test("delete commits test, trials, usage and calibration together",async t=>{
  isolated(t);const f=await fixture();await completed(f);await mergeValidationRecords([record(f.id)]);
  await deleteTest(f.id);assert.equal(await getTest(f.id),null);assert.equal((await getChoiceStats(f.id)).totalTrials,0);assert.equal((await readValidationRecords()).length,0);
  await assert.rejects(mergeValidationRecords([record(f.id)]));
});

test("usage completion is idempotent and request identity cannot be reused",async t=>{
  isolated(t);const f=await fixture();await startTest(f.id);const id=beginModelRequest(f.id,"A","one",0);
  finishModelRequest(id,"invalid_response",{prompt_tokens:12,completion_tokens:3});
  finishModelRequest(id,"succeeded",{total_tokens:999});
  assert.equal(getApiUsage(f.id).totalTokens,15);assert.throws(()=>beginModelRequest(f.id,"A","one",0));
  assert.throws(()=>beginModelRequest(f.id,"A","one",2));assert.equal(getApiUsage(f.id).requestCount,1);
});


test("filesystem cleanup failure is persisted and retried after transactional delete",async t=>{
  const dir=isolated(t);fs.mkdirSync(path.join(dir,"uploads"));const blocked=path.join(dir,"uploads","blocked.jpg");fs.mkdirSync(blocked);
  const f=await fixture({uploadedPath:blocked,candidates:[{key:"A",label:"A",path:blocked},{key:"B",label:"B",path:blocked}]});await completed(f);await deleteTest(f.id);
  assert.equal(await drainFileCleanup(f.id),1);assert.equal(await getTest(f.id),null);
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM file_cleanup").get().n,1);
  fs.rmdirSync(blocked);assert.equal(await drainFileCleanup(f.id),0);
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM file_cleanup").get().n,0);
});
