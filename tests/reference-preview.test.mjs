import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { previewDirectory, recordGeneratedSample, reviseGeneratedSample, renderReferencePreview } from "../scripts/reference-preview.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("完整样图库包含 100 个独立编号、有效图片与逐张参考记录", async () => {
  const directory = path.join(root, previewDirectory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.expectedCount, 100);
  assert.equal(manifest.completedCount, 100);
  assert.equal(manifest.samples.length, 100);
  assert.equal(manifest.status, "pending-user-review");
  assert.equal(manifest.activeLibrary, false);
  assert.equal(manifest.originalReferenceAssetsIncluded, false);
  assert.equal(manifest.generationStrategy, "one-original-per-call");
  assert.equal(new Set(manifest.samples.map(s => s.referenceKey)).size, 100);
  assert.equal(new Set(manifest.samples.map(s => s.fileName)).size, 100);
  for (const [index, sample] of manifest.samples.entries()) {
    assert.equal(sample.referenceKey, `ref-${String(index + 1).padStart(3, "0")}`);
    assert.equal(sample.fileName, `sim-${String(index + 1).padStart(3, "0")}.png`);
    assert.equal(sample.referencedImageCount, 1);
    assert.equal(sample.completionStatus, "generated");
    assert.ok(sample.prompt.length > 100);
    const bytes = fs.readFileSync(path.join(directory, sample.fileName));
    const metadata = await sharp(bytes).metadata();
    await sharp(bytes).raw().toBuffer();
    assert.equal(metadata.format, "png");
    assert.equal(sample.width, metadata.width);
    assert.equal(sample.height, metadata.height);
    assert.equal(sample.sha256, createHash("sha256").update(bytes).digest("hex"));
    const relativeRatioError = Math.abs((sample.width / sample.height) / (sample.originalWidth / sample.originalHeight) - 1);
    assert.ok(relativeRatioError < 0.025, `${sample.referenceKey}: aspect ratio changed`);
    if (sample.reusedFrom) {
      assert.deepEqual(bytes, fs.readFileSync(path.resolve(directory, sample.reusedFrom)));
      assert.equal(sample.reviewStatus, "approved-sample");
    }
  }
  const text = JSON.stringify(manifest);
  assert.doesNotMatch(text, /xsec_token|noteId|xiaohongshu\.com|[A-Z]:[\\/]|https?:\/\//i);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "data/reference-covers.json"), "utf8")), []);
});

test("统一预览嵌入完整清单并安全呈现可筛选和放大的图片", () => {
  const directory = path.join(root, previewDirectory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const html = fs.readFileSync(path.join(directory, "index.html"), "utf8");
  assert.equal(html, renderReferencePreview(manifest));
  const embedded = html.match(/<script id="preview-data" type="application\/json">(.*?)<\/script>/s)[1];
  assert.deepEqual(JSON.parse(embedded), manifest);
  for (const id of ["search", "category", "track", "lightbox", "large", "previous", "next"]) {
    assert.ok(html.includes(`id="${id}"`));
  }
  const hostile = renderReferencePreview({ samples: [], title: "</script><script>unsafe</script>" });
  assert.ok(hostile.includes("\\u003c/script>"));
  assert.doesNotMatch(hostile, /<script>unsafe/);
});

test("保存图片拒绝重复覆盖、未知编号、无效文件和越界文件名", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cover-preview-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, previewDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ samples: [{ referenceKey: "ref-001", fileName: "sim-001.png", completionStatus: "pending" }] }));
  const source = path.join(temporary, "generated.png");
  fs.writeFileSync(source, "broken");
  await assert.rejects(recordGeneratedSample("ref-001", source, temporary));
  assert.equal(JSON.parse(fs.readFileSync(manifestPath)).samples[0].completionStatus, "pending");
  await sharp({ create: { width: 12, height: 16, channels: 3, background: "#ffaabb" } }).png().toFile(source);
  await assert.rejects(recordGeneratedSample("ref-999", source, temporary), /Unknown sample/);
  const result = await recordGeneratedSample("ref-001", source, temporary);
  assert.equal(result.completedCount, 1);
  assert.deepEqual(fs.readFileSync(path.join(directory, "sim-001.png")), fs.readFileSync(source));
  const before = fs.readFileSync(manifestPath);
  await assert.rejects(recordGeneratedSample("ref-001", source, temporary), /already recorded/);
  assert.deepEqual(fs.readFileSync(manifestPath), before);
  fs.writeFileSync(manifestPath, JSON.stringify({ samples: [{ referenceKey: "ref-002", fileName: "../../outside.png", completionStatus: "pending" }] }));
  await assert.rejects(recordGeneratedSample("ref-002", source, temporary), /Unknown sample/);
  assert.equal(fs.existsSync(path.join(temporary, "outside.png")), false);
});

test("图片修订保存来源哈希且拒绝未记录变更和比例变化", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cover-revision-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, previewDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ samples: [{ referenceKey: "ref-001", fileName: "sim-001.png", completionStatus: "pending" }] }));
  const source = path.join(temporary, "generated.png");
  const revision = path.join(temporary, "revision.png");
  await sharp({ create: { width: 12, height: 16, channels: 3, background: "#ffaabb" } }).png().toFile(source);
  await recordGeneratedSample("ref-001", source, temporary);
  const before = fs.readFileSync(manifestPath);
  const destination = path.join(directory, "sim-001.png");
  const original = fs.readFileSync(destination);
  const prompt = "Remove the corner watermark and preserve all other content.";
  await sharp({ create: { width: 16, height: 16, channels: 3, background: "#ffeeaa" } }).png().toFile(revision);
  await assert.rejects(reviseGeneratedSample("ref-001", revision, prompt, temporary), /aspect ratio/);
  assert.deepEqual(fs.readFileSync(manifestPath), before);
  assert.deepEqual(fs.readFileSync(destination), original);
  fs.writeFileSync(destination, "unexpected change");
  await assert.rejects(reviseGeneratedSample("ref-001", revision, prompt, temporary), /Existing image changed/);
  fs.writeFileSync(destination, original);
  await sharp({ create: { width: 24, height: 32, channels: 3, background: "#ffeeaa" } }).png().toFile(revision);
  await assert.rejects(reviseGeneratedSample("ref-001", revision, "short", temporary), /prompt/);
  await reviseGeneratedSample("ref-001", revision, prompt, temporary);
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const sample = manifest.samples[0];
  assert.equal(manifest.completedCount, 1);
  assert.equal(manifest.status, "pending-user-review");
  assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(revision));
  assert.equal(sample.revisions[0].priorSha256, createHash("sha256").update(original).digest("hex"));
  assert.equal(sample.revisions[0].sha256, sample.sha256);
  assert.equal(sample.revisions[0].prompt, prompt);
  assert.equal(sample.revisions[0].referencedImageCount, 1);
});
