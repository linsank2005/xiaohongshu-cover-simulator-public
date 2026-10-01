import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
export { createReferenceFixtures } from "./reference-fixtures.mjs";
import { closeDatabases } from "../lib/storage.ts";
import { createTest } from "../lib/db.ts";
export function isolated(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cover-tests-"));
  process.env.SIMULATOR_DATA_DIR = dir;
  process.env.ZHIPU_API_KEY = "test-only-not-a-real-key";
  t.after(() => {
    closeDatabases();
    if (!dir.startsWith(path.join(os.tmpdir(), "cover-tests-"))) throw Error("unsafe cleanup");
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.SIMULATOR_DATA_DIR;
    delete process.env.ZHIPU_API_KEY;
    delete process.env.SIMULATOR_REFERENCE_DIR;
  });
  return dir;
}
export async function fixture(overrides = {}) {
  const id = randomUUID();
  const input = { id, uploadedPath: "a.jpg", candidates: [{ key: "A", label: "A", path: "a.jpg" }, { key: "B", label: "B", path: "b.jpg" }], title: "测试", referenceIds: [], randomSeed: id, testMode: "grid", ...overrides };
  await createTest(input);
  return input;
}
export const response = (choice = "A", usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }) => Response.json({ choices: [{ message: { content: JSON.stringify({ choice }) }, finish_reason: "stop" }], usage });
export const fastImages = {
  prepareImages: async paths => paths.map(() => Buffer.from("image")),
  renderFeed: async () => "data:image/jpeg;base64,eA==",
  exportResult: async () => {}
};
export const references = n => Array.from({ length: n }, (_, i) => ({ id: `ref-${i}`, fileName: "unused.webp", title: "参考", label: "参考" }));
export const trial = (id, i, variant = "A") => ({ testId: id, variantKey: variant, agentId: `agent-${i}`, repetition: 1, targetCard: "A", cardOrder: ["A","B","C","D"], chosenCard: "A", model: "mock", promptVersion: "test", retryCount: 0 });
