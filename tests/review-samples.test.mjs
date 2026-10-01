import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";

test("three superseded samples decode, preserve their recorded bytes, and stay outside the active library", async () => {
  const directory = path.join(process.cwd(), "previews", "reference-cover-samples");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "superseded");
  assert.equal(manifest.tool, "builtin-imagegen");
  assert.equal(manifest.activeLibrary, false);
  assert.equal(manifest.originalReferenceAssetsIncluded, false);
  assert.equal(manifest.samples.length, 3);
  const hashes = new Set();
  for (const sample of manifest.samples) {
    assert.match(sample.fileName, /^0[1-3]-[a-z]+\.png$/);
    const bytes = fs.readFileSync(path.join(directory, sample.fileName));
    const metadata = await sharp(bytes).metadata();
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
    assert.doesNotMatch(sample.prompt, /xsec_token=|[A-Z]:\\/);
  }
  const runtime = JSON.parse(fs.readFileSync("data/reference-covers.json", "utf8"));
  for (const reference of runtime) {
    const hash = createHash("sha256").update(fs.readFileSync(path.join("public/reference-covers", reference.fileName))).digest("hex");
    assert.equal(hashes.has(hash), false, "superseded image entered active library");
  }
});
