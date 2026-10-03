import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { Unzip, UnzipInflate, zipSync, type Zippable } from "fflate";
import { getAllDualCoverTests, getChoiceStats, getTest, deleteTest } from "./db";
import { getApiUsage } from "./api-usage";
import { dataDirectory, getDatabase, transaction } from "./storage";
import { drainFileCleanup } from "./test-files";
import { testDurationMs } from "./test-duration";
import { isModelProvider, type ModelProvider } from "./model-options";
import { validateUploadedImage, MAX_IMAGE_BYTES } from "./upload-image";
import type { ModelConfigSnapshot } from "./model-settings";
import type { TestStatus, TestMode } from "./types";

export const RECORDS_FORMAT = "xhs-cover-simulator-records";
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 5000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const idPattern = /^[A-Za-z0-9_-]{1,120}$/;
const statuses: TestStatus[] = ["pending", "running", "cancelling", "completed", "failed", "cancelled"];
export type RecordSource = "local" | "imported" | "all";
export type PortableRecord = {
  originId: string; testId: string; title: string; status: TestStatus; testMode: TestMode;
  createdAt: string | null; completedAt: string | null; durationMs: number | null;
  provider: ModelProvider | null; model: string | null; promptVersion: string | null;
  modelConfig: ModelConfigSnapshot | null; notes: string; randomSeed: string; referenceIds: string[];
  candidates: Array<{ key: "A" | "B"; label: string; fileName?: string; sha256?: string }>;
  variants: Array<{ key: "A" | "B"; selectedCount: number; totalTrials: number; selectionRate: number; noneSelectedCount: number }>;
  apiUsage: { requestCount: number; retryCount: number; totalTokens: number; unknownUsageRequests: number };
  realResult: { winner: "A" | "B" | "tie" | "unknown"; status: string; date: string | null; notes: string } | null;
};
export type RecordView = PortableRecord & { id: string; source: "local" | "imported"; importedAt?: string; imageUrls: Record<string, string> };
export type RecordsEnvelope = { format: typeof RECORDS_FORMAT; version: 1; exportedAt: string; records: PortableRecord[] };
export type RecordFilter = { source?: RecordSource; q?: string; status?: string; ids?: string[] };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("记录格式无效");
  return value as Record<string, unknown>;
};
function string(value: unknown, max: number, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > max) throw new Error("记录文字过长或格式无效");
  return value;
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error("记录数值无效");
  return value;
}
function date(value: unknown) {
  if (value == null) return null;
  const result = string(value, 40);
  if (!/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,3})?Z?$/.test(result) || !Number.isFinite(Date.parse(result.replace(" ", "T") + (result.endsWith("Z") ? "" : "Z")))) throw new Error("记录时间无效");
  return result;
}
function candidateFile(originId: string, testId: string, key: string) { return `covers/${originId}-${testId}-${key}.png`; }
function safeModelConfig(value: unknown): ModelConfigSnapshot | null {
  if (value == null) return null;
  const input = object(value);
  if (!isModelProvider(input.provider)) throw new Error("记录模型配置无效");
  return { provider: input.provider, model: string(input.model, 120), timeoutMs: number(input.timeoutMs, 600_000), maxTokens: number(input.maxTokens, 32768), contextLength: number(input.contextLength, 65536), concurrency: number(input.concurrency, 10) };
}
// Explicit field selection also strips unknown fields from files received from others.
export function normalizePortableRecord(value: unknown): PortableRecord {
  const input = object(value);
  const originId = string(input.originId, 36).toLowerCase();
  const testId = string(input.testId, 120);
  if (!uuidPattern.test(originId) || !idPattern.test(testId) || !statuses.includes(input.status as TestStatus) || !["grid", "vertical"].includes(String(input.testMode))) throw new Error("记录标识或状态无效");
  if (!Array.isArray(input.candidates) || input.candidates.length !== 2 || !Array.isArray(input.variants) || input.variants.length !== 2) throw new Error("记录必须包含 A、B 两个版本");
  const candidates = input.candidates.map(value => {
    const item = object(value); const key = item.key as "A" | "B";
    if (!["A", "B"].includes(key)) throw new Error("候选版本无效");
    const fileName = item.fileName == null ? undefined : string(item.fileName, 220);
    const hash = item.sha256 == null ? undefined : string(item.sha256, 64);
    if (fileName && (fileName !== candidateFile(originId, testId, key) || !hash || !/^[0-9a-f]{64}$/.test(hash))) throw new Error("封面文件路径或校验值无效");
    return { key, label: string(item.label, 100), ...(fileName ? { fileName, sha256: hash } : {}) };
  });
  const variants = input.variants.map(value => {
    const item = object(value); const key = item.key as "A" | "B";
    const totalTrials = number(item.totalTrials, 100); const selectedCount = number(item.selectedCount, totalTrials); const noneSelectedCount = number(item.noneSelectedCount, totalTrials);
    if (!["A", "B"].includes(key) || selectedCount + noneSelectedCount > totalTrials) throw new Error("记录判断次数无效");
    if (input.status === "completed" && totalTrials !== 100) throw new Error("已完成记录的判断次数不完整");
    return { key, selectedCount, totalTrials, noneSelectedCount, selectionRate: totalTrials ? Math.round(selectedCount / totalTrials * 100) : 0 };
  });
  if (new Set(candidates.map(c => c.key)).size !== 2 || new Set(variants.map(v => v.key)).size !== 2) throw new Error("记录版本重复");
  const usage = object(input.apiUsage); const real = input.realResult == null ? null : object(input.realResult);
  if (real && !["A", "B", "tie", "unknown"].includes(String(real.winner))) throw new Error("真实结果记录无效");
  if (!Array.isArray(input.referenceIds) || input.referenceIds.length > 100) throw new Error("参考图记录无效");
  return {
    originId, testId, title: string(input.title, 200), status: input.status as TestStatus, testMode: input.testMode as TestMode,
    createdAt: date(input.createdAt), completedAt: date(input.completedAt), durationMs: input.durationMs == null ? null : number(input.durationMs),
    provider: isModelProvider(input.provider) ? input.provider : null, model: input.model == null ? null : string(input.model, 120), promptVersion: input.promptVersion == null ? null : string(input.promptVersion, 120),
    modelConfig: safeModelConfig(input.modelConfig), notes: string(input.notes, 4000), randomSeed: string(input.randomSeed, 160), referenceIds: input.referenceIds.map(value => string(value, 120)), candidates, variants,
    apiUsage: { requestCount: number(usage.requestCount), retryCount: number(usage.retryCount), totalTokens: number(usage.totalTokens), unknownUsageRequests: number(usage.unknownUsageRequests) },
    realResult: real ? { winner: real.winner as "A" | "B" | "tie" | "unknown", status: string(real.status, 40), date: date(real.date), notes: string(real.notes, 4000) } : null
  };
}
export function normalizeEnvelope(value: unknown): RecordsEnvelope {
  const input = object(value);
  if (input.format !== RECORDS_FORMAT || input.version !== 1 || !Array.isArray(input.records) || input.records.length > MAX_RECORDS) throw new Error("请导入本工具导出的 JSON / ZIP 记录文件（版本 1）");
  const records = input.records.map(normalizePortableRecord);
  if (new Set(records.map(r => `${r.originId}:${r.testId}`)).size !== records.length) throw new Error("文件包含重复记录");
  return { format: RECORDS_FORMAT, version: 1, exportedAt: date(input.exportedAt) ?? new Date().toISOString(), records };
}
export function installationId() {
  const db = getDatabase();
  return transaction(db, () => {
    const row = db.prepare("SELECT value FROM local_settings WHERE name = 'installation-id'").get();
    if (row) return String(row.value);
    const id = randomUUID(); db.prepare("INSERT INTO local_settings VALUES ('installation-id', ?)").run(id); return id;
  });
}
async function localRecords(): Promise<RecordView[]> {
  const originId = installationId(); const tests = await getAllDualCoverTests();
  const validations = new Map(getDatabase().prepare("SELECT * FROM validation_records").all().map(row => [String(row.simulation_test_id), JSON.parse(String(row.record_json))]));
  return Promise.all(tests.map(async test => {
    const stats = await getChoiceStats(test.id); const usage = getApiUsage(test.id); const real = validations.get(test.id);
    const record: PortableRecord = {
      originId, testId: test.id, title: test.title, status: test.status, testMode: test.testMode,
      createdAt: test.createdAt, completedAt: test.completedAt, durationMs: testDurationMs(test.createdAt, test.completedAt), provider: test.provider, model: test.model, promptVersion: test.promptVersion,
      modelConfig: test.modelConfig, notes: test.notes, randomSeed: test.randomSeed, referenceIds: test.referenceIds,
      candidates: test.candidates.map(c => ({ key: c.key as "A" | "B", label: c.label })),
      variants: test.candidates.map(c => { const stat = stats.variants.find(s => s.variantKey === c.key); const totalTrials = stat?.totalTrials ?? 0; const selectedCount = stat?.coverSelectedCount ?? 0; return { key: c.key as "A" | "B", selectedCount, totalTrials, noneSelectedCount: stat?.noneCount ?? 0, selectionRate: totalTrials ? Math.round(selectedCount / totalTrials * 100) : 0 }; }),
      apiUsage: { requestCount: usage.requestCount, retryCount: usage.retryCount, totalTokens: usage.totalTokens, unknownUsageRequests: usage.unknownUsageRequests },
      realResult: real?.realWinner ? { winner: real.realWinner, status: real.validationStatus, date: real.realPkDate ? `${real.realPkDate}T00:00:00Z` : null, notes: real.notes ?? "" } : null
    };
    return { ...record, id: `local:${test.id}`, source: "local", imageUrls: Object.fromEntries(test.candidates.map(c => [c.key, `/api/tests/${encodeURIComponent(test.id)}/cover?variant=${c.key}`])) };
  }));
}
function importedRecords(): RecordView[] {
  return getDatabase().prepare("SELECT * FROM imported_records ORDER BY imported_at DESC").all().map(row => {
    const record = normalizePortableRecord(JSON.parse(String(row.record_json))); const paths = object(JSON.parse(String(row.cover_paths)));
    const id = `import:${record.originId}:${record.testId}`;
    return { ...record, notes: row.notes == null ? record.notes : String(row.notes), id, source: "imported", importedAt: String(row.imported_at), imageUrls: Object.fromEntries(record.candidates.filter(c => paths[c.key]).map(c => [c.key, `/api/records/${encodeURIComponent(id)}/cover?key=${c.key}`])) };
  });
}
export async function queryRecords(filter: RecordFilter = {}) {
  const source = filter.source ?? "all";
  const rows = [...(source !== "imported" ? await localRecords() : []), ...(source !== "local" ? importedRecords() : [])];
  const query = (filter.q ?? "").trim().toLowerCase(); const ids = filter.ids ? new Set(filter.ids) : null;
  return rows.filter(row => (!ids || ids.has(row.id)) && (!filter.status || row.status === filter.status) && (!query || `${row.title} ${row.model ?? ""} ${row.notes}`.toLowerCase().includes(query)))
    .sort((a, b) => (b.importedAt ?? b.createdAt ?? "").localeCompare(a.importedAt ?? a.createdAt ?? ""));
}
function parseId(id: string) {
  const parts = id.split(":");
  if (parts[0] === "local" && parts.length === 2 && idPattern.test(parts[1])) return { local: true, testId: parts[1], originId: "" };
  if (parts[0] === "import" && parts.length === 3 && uuidPattern.test(parts[1]) && idPattern.test(parts[2])) return { local: false, originId: parts[1], testId: parts[2] };
  throw new Error("记录标识无效");
}
export function saveRecordNotes(id: string, notes: unknown) {
  const parsed = parseId(id); const text = string(notes, 4000); const db = getDatabase();
  const result = parsed.local ? db.prepare("UPDATE tests SET notes = ? WHERE id = ?").run(text, parsed.testId) : db.prepare("UPDATE imported_records SET notes = ? WHERE origin_id = ? AND test_id = ?").run(text, parsed.originId, parsed.testId);
  if (!result.changes) throw new Error("记录不存在");
}
function importedPath(file: string) {
  if (!/^[0-9a-f]{64}\.png$/.test(file)) throw new Error("封面文件无效");
  return path.join(dataDirectory(), "imported-covers", file);
}
function unreferenced(file: string) { return !getDatabase().prepare("SELECT cover_paths FROM imported_records").all().some(row => Object.values(JSON.parse(String(row.cover_paths))).includes(file)); }
export async function recordCoverPath(id: string, key: string) {
  const parsed = parseId(id); if (!["A", "B"].includes(key)) throw new Error("封面版本无效");
  if (parsed.local) return (await getTest(parsed.testId))?.candidates.find(c => c.key === key)?.path ?? null;
  const row = getDatabase().prepare("SELECT cover_paths FROM imported_records WHERE origin_id = ? AND test_id = ?").get(parsed.originId, parsed.testId);
  const file = row ? JSON.parse(String(row.cover_paths))[key] : null;
  return file ? importedPath(file) : null;
}
export async function deleteRecord(id: string) {
  const parsed = parseId(id);
  if (parsed.local) {
    const test = await getTest(parsed.testId);
    if (!test) throw new Error("记录不存在");
    if (!["completed", "failed", "cancelled"].includes(test.status)) throw new Error("请先取消正在执行的测试");
    await deleteTest(parsed.testId); return { cleanupPending: await drainFileCleanup(parsed.testId) > 0 };
  }
  const db = getDatabase();
  const paths = transaction(db, () => {
    const row = db.prepare("SELECT cover_paths FROM imported_records WHERE origin_id = ? AND test_id = ?").get(parsed.originId, parsed.testId);
    if (!row) throw new Error("记录不存在");
    db.prepare("DELETE FROM imported_records WHERE origin_id = ? AND test_id = ?").run(parsed.originId, parsed.testId); return Object.values(JSON.parse(String(row.cover_paths))) as string[];
  });
  let cleanupPending = false;
  for (const file of paths) if (unreferenced(file)) { try { await fs.rm(importedPath(file), { force: true }); } catch { cleanupPending = true; } }
  return { cleanupPending };
}
export async function exportRecords(filter: RecordFilter = {}, includeCovers = false) {
  const rows = await queryRecords(filter);
  if (rows.length > MAX_RECORDS) throw new Error("单次最多导出 5000 条记录，请通过筛选分批导出");
  const files: Zippable = {}; const records: PortableRecord[] = []; let size = 0; let missingCovers = 0;
  for (const row of rows) {
    const record = normalizePortableRecord(row);
    // JSON deliberately has no dependency on a cover filename from a previous ZIP.
    record.candidates = record.candidates.map(c => ({ key: c.key, label: c.label }));
    if (includeCovers) for (const candidate of record.candidates) {
      const filePath = await recordCoverPath(row.id, candidate.key);
      if (!filePath) { missingCovers++; continue; }
      let bytes: Buffer;
      try { bytes = await sharp(filePath, { limitInputPixels: 20_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png().toBuffer(); }
      catch { missingCovers++; continue; }
      if (bytes.length > MAX_IMAGE_BYTES || (size += bytes.length) > MAX_ARCHIVE_BYTES) throw new Error("封面包超过 64MB，请少选几条分批导出");
      candidate.fileName = candidateFile(record.originId, record.testId, candidate.key); candidate.sha256 = sha256(bytes); files[candidate.fileName] = [bytes, { level: 0 }];
    }
    records.push(record);
  }
  const envelope: RecordsEnvelope = { format: RECORDS_FORMAT, version: 1, exportedAt: new Date().toISOString(), records };
  const json = Buffer.from(JSON.stringify(envelope, null, 2));
  if (json.length > MAX_JSON_BYTES || json.length + size > MAX_ARCHIVE_BYTES) throw new Error("记录文件过大，请分批导出");
  files["records.json"] = json;
  const bytes = includeCovers ? Buffer.from(zipSync(files, { level: 6 })) : json;
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("封面包超过 64MB，请分批导出");
  return { bytes, count: records.length, missingCovers };
}
// Inflate incrementally and enforce actual decompressed size, including ZIPs with
// false or absent size headers. Never extract arbitrary archive paths to disk.
export function readRecordZip(bytes: Uint8Array) {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("封面包超过 64MB");
  const entries = new Map<string, Buffer>(); let total = 0; let count = 0; let failure: Error | null = null;
  const unzip = new Unzip(file => {
    if (++count > MAX_RECORDS * 2 + 1 || entries.has(file.name) || (file.name !== "records.json" && !/^covers\/[A-Za-z0-9_-]+\.png$/.test(file.name))) throw new Error("ZIP 文件名无效或重复");
    entries.set(file.name, Buffer.alloc(0));
    const limit = file.name === "records.json" ? MAX_JSON_BYTES : MAX_IMAGE_BYTES;
    if (file.originalSize !== undefined && file.originalSize > limit) throw new Error("ZIP 解压后的文件过大");
    let length = 0; const chunks: Uint8Array[] = [];
    file.ondata = (error, data, final) => {
      if (failure) return;
      if (error) { failure = new Error("ZIP 文件损坏"); return; }
      length += data.length; total += data.length;
      if (length > limit || total > MAX_ARCHIVE_BYTES) { failure = new Error("ZIP 解压内容超过大小限制"); file.terminate(); return; }
      chunks.push(data);
      if (final) entries.set(file.name, Buffer.concat(chunks));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try { for (let offset = 0; offset < bytes.length; offset += 64 * 1024) { unzip.push(bytes.subarray(offset, offset + 64 * 1024), offset + 64 * 1024 >= bytes.length); if (failure) throw failure; } }
  catch (error) { throw failure ?? (error instanceof Error ? error : new Error("ZIP 文件损坏")); }
  if (!entries.get("records.json")?.length) throw new Error("ZIP 缺少 records.json");
  return entries;
}
export async function importRecords(bytes: Buffer, zip = false) {
  if (!zip && bytes.length > MAX_JSON_BYTES) throw new Error("JSON 文件超过 16MB");
  const entries = zip ? readRecordZip(bytes) : new Map([["records.json", bytes]]);
  let parsed: unknown; try { parsed = JSON.parse(entries.get("records.json")!.toString("utf8")); } catch { throw new Error("记录 JSON 无法解析"); }
  const envelope = normalizeEnvelope(parsed); const expected = new Set(["records.json"]);
  const prepared: Array<{ record: PortableRecord; covers: Record<string, string>; images: Array<{ name: string; bytes: Buffer }> }> = [];
  const ownOrigin = installationId(); let skipped = 0;
  for (const record of envelope.records) {
    const covers: Record<string, string> = {}; const images: Array<{ name: string; bytes: Buffer }> = [];
    for (const candidate of record.candidates) if (candidate.fileName) {
      if (!zip) { delete candidate.fileName; delete candidate.sha256; continue; }
      expected.add(candidate.fileName); const cover = entries.get(candidate.fileName);
      if (!cover || sha256(cover) !== candidate.sha256) throw new Error("封面文件缺失或校验失败");
      if (await validateUploadedImage(cover) !== "png") throw new Error("封面包必须使用 PNG 图片");
      const name = `${sha256(cover)}.png`; covers[candidate.key] = name; images.push({ name, bytes: cover });
    }
    if (record.originId === ownOrigin && await getTest(record.testId)) skipped++;
    else prepared.push({ record, covers, images });
  }
  if ([...entries.keys()].some(name => !expected.has(name))) throw new Error("ZIP 包含不属于记录的文件");
  const written = new Set<string>(); const obsolete = new Set<string>();
  try {
    if (prepared.some(p => p.images.length)) await fs.mkdir(path.join(dataDirectory(), "imported-covers"), { recursive: true });
    for (const item of prepared) for (const image of item.images) {
      try { await fs.writeFile(importedPath(image.name), image.bytes, { flag: "wx" }); written.add(image.name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const db = getDatabase();
    const result = transaction(db, () => {
      let created = 0; let updated = 0;
      for (const item of prepared) {
        const r = item.record;
        const old = db.prepare("SELECT cover_paths FROM imported_records WHERE origin_id = ? AND test_id = ?").get(r.originId, r.testId);
        if (old) { updated++; for (const file of Object.values(JSON.parse(String(old.cover_paths)))) obsolete.add(String(file)); }
        else created++;
        // JSON updates preserve covers already imported from a ZIP and collector notes.
        const covers = { ...(old ? JSON.parse(String(old.cover_paths)) : {}), ...item.covers };
        db.prepare("INSERT INTO imported_records (origin_id,test_id,record_json,cover_paths) VALUES (?,?,?,?) ON CONFLICT(origin_id,test_id) DO UPDATE SET record_json = excluded.record_json, cover_paths = excluded.cover_paths, imported_at = CURRENT_TIMESTAMP")
          .run(r.originId, r.testId, JSON.stringify(r), JSON.stringify(covers));
      }
      return { imported: prepared.length, created, updated, skipped };
    });
    for (const file of obsolete) if (unreferenced(file)) await fs.rm(importedPath(file), { force: true }).catch(() => {});
    return result;
  } catch (error) {
    for (const file of written) if (unreferenced(file)) await fs.rm(importedPath(file), { force: true }).catch(() => {});
    throw error;
  }
}
