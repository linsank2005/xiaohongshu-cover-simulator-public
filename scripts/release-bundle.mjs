import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootFiles = new Set(["README.md", "CHANGELOG.md", "AGENTS.md", "LICENSE", "ASSETS.md", "THIRD_PARTY_NOTICES.md", ".env.example", ".gitignore", "package.json", "package-lock.json", "tsconfig.json", "next.config.mjs", "next-env.d.ts", "middleware.ts", "start-windows.cmd"]);
export function isReleaseFile(name) {
  if (name.includes("\\") || name.split("/").some(part => part === "..") || name.startsWith("/") || /(^|\/)(node_modules|\.git|\.next|dist|uploads|results|tmp|imported-covers)(\/|$)/.test(name) || /\.db(?:-wal|-shm)?$/.test(name) || /(^|\/)\.env(?!\.example$)/.test(name)) return false;
  return rootFiles.has(name) || ["data/agents.json", "data/reference-covers.json"].includes(name) || /^(app|lib|config|scripts|tests|docs|previews)\//.test(name) || /^public\/reference-covers\/(?:\.gitkeep|sim-\d{3}\.png)$/.test(name);
}
export async function collectReleaseFiles(directory = root) {
  // Tracked files are reviewable. Do not silently package a local draft or secret.
  const tracked = execFileSync("git", ["-C", directory, "ls-files", "-z"], { encoding: "utf8", windowsHide: true }).split("\0").filter(Boolean);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "data/reference-covers.json"), "utf8"));
  if (manifest.length !== 100 || new Set(manifest.map(r => r.fileName)).size !== 100 || manifest.some(r => r.source !== "imagegen" || r.noteId || !/^sim-\d{3}\.png$/.test(r.fileName))) throw Error("分发前必须有 100 张已确认的模拟封面及纯模拟清单");
  const files = tracked.filter(isReleaseFile).sort();
  for (const name of ["start-windows.cmd", "scripts/launch.mjs", "config/agent-prompt.md", "LICENSE", "ASSETS.md", ...manifest.map(r => `public/reference-covers/${r.fileName}`)]) if (!files.includes(name)) throw Error(`分发文件尚未纳入 Git：${name}`);
  return files;
}
export async function buildBundle(directory = root) {
  const pkg = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8")); const names = await collectReleaseFiles(directory); const files = {};
  for (const name of names) { const bytes = new Uint8Array(await fs.readFile(path.join(directory, name))); files[`xiaohongshu-cover-simulator/${name}`] = [bytes, { level: /\.(png|jpg|webp)$/.test(name) ? 0 : 6 }]; }
  const outputDir = path.join(directory, "dist"); await fs.mkdir(outputDir, { recursive: true });
  const name = `xiaohongshu-cover-simulator-${pkg.version}.zip`; const output = path.join(outputDir, name); const bytes = zipSync(files); const hash = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(output, bytes); await fs.writeFile(`${output}.sha256`, `${hash}  ${name}\n`);
  return { output, files: names.length, bytes: bytes.length, sha256: hash };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildBundle().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
