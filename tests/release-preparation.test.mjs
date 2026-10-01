import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedReferenceCovers } from "../scripts/seed-reference-covers.mjs";
import { loadReferenceLibrary } from "../lib/reference-library.ts";

function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synthetic-seed-"));
  t.after(() => {
    if (!root.startsWith(path.join(os.tmpdir(), "synthetic-seed-"))) throw new Error("unsafe cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function libraryFor(root) {
  return Array.from({ length: 100 }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    const fileName = `sim-${n}.png`;
    fs.writeFileSync(path.join(root, "public", "reference-covers", fileName), "test-only");
    return { id: `ref-${n}`, fileName, title: "原创模拟图", category: "生活方式", track: "家居", label: "生活方式 / 家居", weight: 1, source: "imagegen", noteId: "", license: "AI 生成模拟素材" };
  });
}

test("empty staging library builds without restoring or removing assets", t => {
  const root = rootFor(t);
  fs.mkdirSync(path.join(root, "public", "reference-covers"), { recursive: true });
  const sentinel = path.join(root, "public", "reference-covers", "keep-me.txt");
  fs.writeFileSync(sentinel, "preserve");
  assert.deepEqual(seedReferenceCovers(root), { count: 0, ready: false });
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "data", "reference-covers.json"))), []);
});

test("runtime refuses an empty library before a cover simulation", t => {
  const root = rootFor(t);
  seedReferenceCovers(root);
  const previous = process.env.SIMULATOR_REFERENCE_DIR;
  process.env.SIMULATOR_REFERENCE_DIR = path.join(root, "data");
  t.after(() => {
    if (previous === undefined) delete process.env.SIMULATOR_REFERENCE_DIR;
    else process.env.SIMULATOR_REFERENCE_DIR = previous;
  });
  assert.throws(() => loadReferenceLibrary(), /模拟参考图库尚未完成/);
});

test("seed accepts only a complete synthetic manifest with local neutral filenames", t => {
  const root = rootFor(t);
  seedReferenceCovers(root);
  const library = libraryFor(root);
  const manifest = path.join(root, "data", "reference-covers.json");
  const save = () => fs.writeFileSync(manifest, JSON.stringify(library));
  save();
  assert.deepEqual(seedReferenceCovers(root), { count: 100, ready: true });
  library[0].source = "https://www.xiaohongshu.com/explore/test";
  save(); assert.throws(() => seedReferenceCovers(root), /仅接受 imagegen/);
  library[0].source = "imagegen";
  library[0].noteId = "old-note";
  save(); assert.throws(() => seedReferenceCovers(root), /原笔记 ID/);
  library[0].noteId = "";
  library[0].fileName = "../outside.png";
  save(); assert.throws(() => seedReferenceCovers(root), /文件名无效/);
});

test("review samples cannot silently become the active competition pool", t => {
  const root = rootFor(t);
  seedReferenceCovers(root);
  fs.writeFileSync(path.join(root, "data", "reference-covers.json"), JSON.stringify(libraryFor(root).slice(0, 3)));
  assert.throws(() => seedReferenceCovers(root), /完整模拟参考图库必须包含 100/);
});
