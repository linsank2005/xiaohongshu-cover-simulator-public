import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { supportsNode, sourceFingerprint, launcherFingerprint, isOurService, portFree } from "../scripts/launch.mjs";
import { isReleaseFile } from "../scripts/release-bundle.mjs";
test("launcher checks SQLite-capable Node versions and identifies its own service", async t => {
  assert(!supportsNode("20.19.0")); assert(!supportsNode("22.12.0")); assert(supportsNode("22.13.0")); assert(supportsNode("24.19.0"));
  const fingerprint = launcherFingerprint("D:/项目有空格 /source"); assert.equal(fingerprint.length, 32); assert.notEqual(fingerprint, launcherFingerprint("D:/项目有空格 /source", "D:/other"));
  const server = http.createServer((_request, response) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ app: "xhs-cover-simulator", workspace: fingerprint })); }); server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => new Promise(resolve => server.close(resolve)));
  assert(await isOurService(server.address().port, fingerprint)); assert(!await isOurService(server.address().port, "other-project")); assert(!await portFree(server.address().port));
});
test("launcher rebuild fingerprint changes with sources and ignores personal files", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cover-launch-")); t.after(async () => { assert(directory.startsWith(path.join(os.tmpdir(), "cover-launch-"))); await fs.rm(directory, { recursive: true, force: true }); });
  for (const dir of ["app", "lib", "config", "scripts", "data"]) await fs.mkdir(path.join(directory, dir));
  for (const file of ["package.json", "package-lock.json", "next.config.mjs", "tsconfig.json", "middleware.ts", "scripts/seed-reference-covers.mjs", "data/reference-covers.json", "app/page.tsx", "lib/db.ts"]) await fs.writeFile(path.join(directory, file), "one");
  const first = await sourceFingerprint(directory); await fs.writeFile(path.join(directory, "data/simulator.db"), "personal"); assert.equal(await sourceFingerprint(directory), first); await fs.writeFile(path.join(directory, "app/page.tsx"), "two"); assert.notEqual(await sourceFingerprint(directory), first);
});
test("release allowlist excludes databases, environment keys, user covers, history and builds", () => {
  for (const file of [".env", ".env.local", "data/simulator.db", "data/simulator.db-wal", "data/uploads/a.png", "data/results/test/result.json", "data/imported-covers/a.png", "data/launcher.lock", ".git/config", "node_modules/a", ".next/a", "../outside", "public/reference-covers/original.png", "private-draft.md"]) assert(!isReleaseFile(file), file);
  for (const file of [".env.example", "LICENSE", "ASSETS.md", "start-windows.cmd", "scripts/launch.mjs", "data/reference-covers.json", "public/reference-covers/sim-001.png", "app/page.tsx"]) assert(isReleaseFile(file), file);
});
