import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";

test("five reference-matched samples are intact, individually referenced, and isolated from the active library", async () => {
  const directory = path.join(process.cwd(), "previews", "reference-matched-samples");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "pending-user-review");
  assert.equal(manifest.tool, "builtin-imagegen");
  assert.equal(manifest.generationStrategy, "one-original-per-call");
  assert.equal(manifest.activeLibrary, false);
  assert.equal(manifest.originalReferenceAssetsIncluded, false);
  assert.equal(manifest.samples.length, 5);
  assert.deepEqual(manifest.samples.map((sample) => sample.referenceKey), [
    "ref-001", "ref-007", "ref-008", "ref-018", "ref-019",
  ]);
  assert.deepEqual(manifest.samples.map((sample) => sample.track), [
    "好物", "自媒体", "健身", "职场", "美食",
  ]);

  const hashes = new Set();
  for (const sample of manifest.samples) {
    assert.equal(sample.referencedImageCount, 1);
    assert.match(sample.fileName, /^0[1-5]-[a-z]+\.png$/);
    const bytes = fs.readFileSync(path.join(directory, sample.fileName));
    const metadata = await sharp(bytes).metadata();
    await sharp(bytes).raw().toBuffer();
    assert.equal(metadata.format, "png");
    assert.ok(metadata.width >= 720 && metadata.height >= 960);
    assert.ok(Math.abs(metadata.width / metadata.height - 0.75) < 0.005);
    assert.equal(metadata.width, sample.width);
    assert.equal(metadata.height, sample.height);
    const hash = createHash("sha256").update(bytes).digest("hex");
    assert.equal(hash, sample.sha256);
    assert.equal(hashes.has(hash), false);
    hashes.add(hash);
    assert.ok(sample.prompt.length > 100);
    assert.equal(Object.hasOwn(sample, "sourcePath"), false);
    assert.equal(Object.hasOwn(sample, "noteId"), false);
  }

  assert.doesNotMatch(JSON.stringify(manifest), /xsec_token=|xiaohongshu\.com|[A-Z]:\\/);
  const imageNames = fs.readdirSync(directory).filter((fileName) => /\.(png|webp|jpg)$/i.test(fileName));
  assert.deepEqual(imageNames.sort(), manifest.samples.map((sample) => sample.fileName).sort());
  assert.deepEqual(JSON.parse(fs.readFileSync("data/reference-covers.json", "utf8")), []);
});
