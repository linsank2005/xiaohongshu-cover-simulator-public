import { dataDirectory, getDatabase } from "./storage";
import fs from "node:fs/promises";
import path from "node:path";
import type { StoredTest } from "./types";

function isWithinDirectory(filePath: string, directory: string) {
  const resolvedFile = path.resolve(filePath);
  const resolvedDirectory = path.resolve(directory);
  return resolvedFile.startsWith(resolvedDirectory + path.sep);
}

export async function removeTestFiles(test: StoredTest) {
  const dataDir = dataDirectory();
  const uploadDir = path.join(dataDir, "uploads");
  const resultsDir = path.join(dataDir, "results");
  const candidatePaths = new Set([test.uploadedPath, ...test.candidates.map((candidate) => candidate.path)]);
  await Promise.all([...candidatePaths].filter((filePath) => isWithinDirectory(filePath, uploadDir)).map((filePath) => fs.rm(filePath, { force: true })));
  const resultPath = path.join(resultsDir, test.id);
  if (isWithinDirectory(resultPath, resultsDir)) await fs.rm(resultPath, { recursive: true, force: true });
}

// Database deletion commits first. Failed filesystem cleanup remains retryable,
// so a locked file cannot leave a half-deleted test counted in calibration.
export async function drainFileCleanup(id?: string) {
  const database = getDatabase();
  const rows = id
    ? database.prepare("SELECT * FROM file_cleanup WHERE test_id = ?").all(id)
    : database.prepare("SELECT * FROM file_cleanup").all();
  let pending = 0;
  for (const row of rows) {
    try {
      await removeTestFiles(JSON.parse(String(row.test_json)) as StoredTest);
      database.prepare("DELETE FROM file_cleanup WHERE test_id = ?").run(row.test_id);
    } catch { pending++; }
  }
  return pending;
}
