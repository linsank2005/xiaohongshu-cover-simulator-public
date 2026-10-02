import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { zipSync } from "fflate";
import { isolated, fixture, trial } from "./helpers.mjs";
import { getDatabase } from "../lib/storage.ts";
import { startTest, saveTrial, completeTest, requestTestCancellation, recoverInterruptedTests, getTest } from "../lib/db.ts";
import { mergeValidationRecords } from "../lib/validation-store.ts";
import { normalizeValidationRecord } from "../lib/validation.ts";
import { queryRecords, saveRecordNotes, exportRecords, importRecords, normalizeEnvelope, readRecordZip, deleteRecord, recordCoverPath, MAX_JSON_BYTES } from "../lib/records.ts";

async function makeComplete(dir) {
  fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
  const a = path.join(dir, "uploads", "a.png"); const b = path.join(dir, "uploads", "b.png");
  await sharp({ create: { width: 40, height: 50, channels: 3, background: "red" } }).png().toFile(a);
  await sharp({ create: { width: 40, height: 50, channels: 3, background: "blue" } }).png().toFile(b);
  const f = await fixture({ uploadedPath: a, candidates: [{ key: "A", label: "A", path: a }, { key: "B", label: "B", path: b }] });
  await startTest(f.id, { model: "custom-vision", provider: "ollama", promptVersion: "test" });
  for (const v of ["A", "B"]) for (let i = 0; i < 100; i++) await saveTrial(trial(f.id, i, v));
  await completeTest(f.id, { model: "custom-vision", promptVersion: "test" });
  return f;
}

test("portable JSON and ZIP preserve results on another installation without keys, paths or local IDs", async t => {
  const dir = isolated(t); const f = await makeComplete(dir);
  saveRecordNotes(`local:${f.id}`, "发布前测试，等待真实结果");
  await mergeValidationRecords([normalizeValidationRecord({ simulationTestId: f.id, validationId: "one", realWinner: "B", simulatedWinner: "A", validationStatus: "valid", validationType: "prospective", realPkDate: "2026-10-02" })]);
  getDatabase().prepare("INSERT INTO local_settings VALUES ('model-settings', ?)").run(JSON.stringify({ ollama: { apiKey: "SENSITIVE-KEY", baseUrl: "http://127.0.0.1:11434" } }));
  const json = await exportRecords({ source: "local" }); const zip = await exportRecords({ source: "local" }, true);
  assert.equal(json.count, 1); assert.equal(zip.missingCovers, 0);
  const text = json.bytes.toString(); assert(!text.includes("SENSITIVE-KEY")); assert(!text.includes(dir)); assert(!text.includes("baseUrl")); assert(!text.includes("apiKey"));
  const envelope = JSON.parse(text); assert.equal(envelope.records[0].variants[0].totalTrials, 100); assert.equal(envelope.records[0].realResult.winner, "B");
  assert.equal((await importRecords(json.bytes)).skipped, 1, "reimporting own records does not duplicate local history");
  const other = path.join(dir, "other-installation"); fs.mkdirSync(other); process.env.SIMULATOR_DATA_DIR = other;
  const first = await importRecords(json.bytes); assert.equal(first.created, 1); assert.equal(await getTest(f.id), null);
  let rows = await queryRecords(); assert.equal(rows.length, 1); assert.equal(rows[0].realResult.winner, "B"); assert.equal(rows[0].notes, "发布前测试，等待真实结果"); assert.deepEqual(rows[0].imageUrls, {});
  saveRecordNotes(rows[0].id, "收集者的复核备注");
  const second = await importRecords(zip.bytes, true); assert.equal(second.updated, 1); assert.equal(second.created, 0);
  rows = await queryRecords({ q: "复核" }); assert.equal(rows.length, 1); assert.equal(rows[0].notes, "收集者的复核备注");
  const coverPath = await recordCoverPath(rows[0].id, "A"); assert(fs.existsSync(coverPath)); assert.equal((await sharp(coverPath).metadata()).format, "png");
  assert.equal((await importRecords(json.bytes)).updated, 1); assert(fs.existsSync(await recordCoverPath(rows[0].id, "A")), "JSON updates preserve imported covers");
  const reexport = await exportRecords({ source: "imported" }, true); assert.equal(reexport.count, 1); assert.equal(reexport.missingCovers, 0);
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM validation_records").get().n, 0, "foreign records do not enter local prediction calibration");
  await deleteRecord(rows[0].id); assert.equal((await queryRecords()).length, 0); assert(!fs.existsSync(coverPath));
});

test("all terminal statuses are searchable and removable while active tests are protected", async t => {
  isolated(t); const pending = await fixture(); const cancelled = await fixture(); const failed = await fixture();
  await requestTestCancellation(cancelled.id); await startTest(failed.id); recoverInterruptedTests(Date.now() + 60000);
  const rows = await queryRecords(); assert.equal(rows.length, 3); assert(rows.some(r => r.status === "cancelled")); assert(rows.some(r => r.status === "failed"));
  const active = await fixture(); await assert.rejects(deleteRecord(`local:${active.id}`), /先取消/);
  await deleteRecord(`local:${cancelled.id}`); await deleteRecord(`local:${failed.id}`); assert.equal(await getTest(cancelled.id), null); assert.equal(await getTest(failed.id), null);
  assert.equal((await queryRecords({ status: "pending" })).length, 1);
  assert.throws(() => saveRecordNotes(`local:${pending.id}`, "x".repeat(4001)), /文字过长/);
});

test("imports reject traversal, extra files, hash mismatch, duplicate records and oversized inflation atomically", async t => {
  const dir = isolated(t); await makeComplete(dir); const exported = await exportRecords({}, true); const entries = readRecordZip(exported.bytes);
  const valid = Object.fromEntries(entries); const json = JSON.parse(entries.get("records.json").toString());
  await assert.rejects(importRecords(Buffer.from(zipSync({ "../outside.txt": new Uint8Array([1]), "records.json": Buffer.from("{}") })), true), /文件名/);
  await assert.rejects(importRecords(Buffer.from(zipSync({ ...valid, "covers/extra.png": new Uint8Array([1]) })), true), /不属于/);
  const file = Object.keys(valid).find(n => n.endsWith("-A.png"));
  await assert.rejects(importRecords(Buffer.from(zipSync({ ...valid, [file]: new Uint8Array([1]) })), true), /校验失败/);
  const oversized = zipSync({ "records.json": new Uint8Array(MAX_JSON_BYTES + 1) }); assert.throws(() => readRecordZip(oversized), /过大|大小限制/);
  assert.throws(() => normalizeEnvelope({ ...json, records: [json.records[0], json.records[0]] }), /重复/);
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM imported_records").get().n, 0);
  assert(!fs.existsSync(path.join(dir, "imported-covers")), "invalid packages leave no covers behind");
});

test("same test ID from distinct installations remains distinct and unknown fields are stripped", async t => {
  const dir = isolated(t); await makeComplete(dir); const result = await exportRecords(); const envelope = JSON.parse(result.bytes.toString());
  const record = envelope.records[0]; record.originId = randomUUID(); record.apiKey = "hidden"; record.modelConfig = { provider: "ollama", model: "vision", timeoutMs: 100000, maxTokens: 256, contextLength: 8192, concurrency: 1, apiKey: "hidden", baseUrl: "hidden" };
  const second = { ...record, originId: randomUUID() }; envelope.records = [record, second];
  assert.equal((await importRecords(Buffer.from(JSON.stringify(envelope)))).created, 2);
  const reexport = (await exportRecords({ source: "imported" })).bytes.toString(); assert(!reexport.includes("hidden")); assert(!reexport.includes("apiKey"));
  assert.equal((await queryRecords({ source: "imported", q: "custom" })).length, 2);
});
