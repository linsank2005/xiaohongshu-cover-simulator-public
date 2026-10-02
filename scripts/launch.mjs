import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function supportsNode(version) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || major === 22 && minor >= 13;
}
export function launcherFingerprint(directory, dataDir = path.join(directory, "data")) {
  return createHash("sha256").update(`${path.resolve(directory)}\n${path.resolve(dataDir)}`).digest("hex").slice(0, 32);
}
export async function sourceFingerprint(directory) {
  const files = ["package.json", "package-lock.json", "next.config.mjs", "tsconfig.json", "middleware.ts", "scripts/seed-reference-covers.mjs", "data/reference-covers.json"];
  async function walk(relative) { for (const item of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) { const name = `${relative}/${item.name}`; if (item.isDirectory()) await walk(name); else if (item.isFile()) files.push(name); } }
  await walk("app"); await walk("lib"); await walk("config");
  const hash = createHash("sha256");
  for (const file of files.sort()) { hash.update(file); hash.update(await fs.readFile(path.join(directory, file))); }
  return hash.digest("hex");
}
export async function isOurService(port, fingerprint) {
  try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000), redirect: "error" }); if (!response.ok) return false; const data = await response.json(); return data.app === "xhs-cover-simulator" && data.workspace === fingerprint; }
  catch { return false; }
}
export async function portFree(port) {
  return new Promise(resolve => { const server = net.createServer(); server.once("error", () => resolve(false)); server.listen(port, "127.0.0.1", () => server.close(() => resolve(true))); });
}
function openBrowser(url) {
  if (process.env.SIMULATOR_NO_BROWSER === "1") return;
  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/c", "start", "", url] : [url];
  const child = spawn(command, args, { windowsHide: true, detached: true, stdio: "ignore" }); child.on("error", () => console.log(`请在浏览器打开 ${url}`)); child.unref();
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function ownerAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } }
async function command(args) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "inherit", windowsHide: true });
  return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(Error("依赖安装或构建失败。请关闭正在运行本项目的测试或旧服务，检查网络和上方提示后重新双击启动"))); });
}
async function npmCli() {
  const options = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")].filter(Boolean);
  for (const option of options) if (option.endsWith(".js") && await exists(option)) return option;
  throw Error("未找到 npm，请安装官网提供的完整 Node.js 后重新启动");
}
export async function launch() {
  if (!supportsNode(process.versions.node)) throw Error("需要 Node.js 22.13 或更高版本。下载：https://nodejs.org/en/download");
  process.chdir(root);
  const dataDir = path.resolve(process.env.SIMULATOR_DATA_DIR || path.join(root, "data")); await fs.mkdir(dataDir, { recursive: true });
  const fingerprint = launcherFingerprint(root, dataDir); const lockFile = path.join(dataDir, "launcher.lock");
  let lock; let server; let stopping = false;
  async function writeLock(port = null) { await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, port, workspace: fingerprint })); }
  async function unlock() { try { const state = JSON.parse(await fs.readFile(lockFile, "utf8")); if (state.pid === process.pid) await fs.unlink(lockFile); } catch { /* Only delete our own lock. */ } }
  for (let attempt = 0; attempt < 2; attempt++) {
    try { lock = await fs.open(lockFile, "wx"); await lock.writeFile(JSON.stringify({ pid: process.pid, port: null, workspace: fingerprint })); await lock.close(); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing; try { existing = JSON.parse(await fs.readFile(lockFile, "utf8")); } catch { throw Error("启动状态文件无法读取，请关闭启动窗口后重试"); }
      if (!ownerAlive(existing.pid)) { await fs.unlink(lockFile); continue; }
      console.log("已有启动窗口，正在打开同一份本机服务…");
      for (let index = 0; index < 240; index++) { const state = JSON.parse(await fs.readFile(lockFile, "utf8").catch(() => "{}")); if (state.port && await isOurService(state.port, fingerprint)) { const url = `http://127.0.0.1:${state.port}`; console.log(`已复用服务：${url}`); openBrowser(url); return; } if (!ownerAlive(state.pid)) break; await delay(250); }
      throw Error("原启动窗口仍在准备依赖或构建，请等待完成后再打开");
    }
  }
  if (!lock) throw Error("启动状态冲突，请重新双击启动");
  try {
    let port = null;
    for (let candidate = 3001; candidate <= 3010; candidate++) {
      if (await isOurService(candidate, fingerprint)) { const url = `http://127.0.0.1:${candidate}`; console.log(`已复用服务：${url}`); openBrowser(url); return; }
      if (port === null && await portFree(candidate)) port = candidate;
    }
    if (port === null) throw Error("3001–3010 端口均被占用，请关闭不用的本地服务后重试");
    const dependencyHash = createHash("sha256").update(await fs.readFile(path.join(root, "package-lock.json"))).digest("hex");
    const dependencyStamp = path.join(root, "node_modules/.launcher-lock.sha256");
    if (!await exists(path.join(root, "node_modules/next/dist/bin/next")) || !await exists(path.join(root, "node_modules/fflate/package.json")) || await fs.readFile(dependencyStamp, "utf8").catch(() => "") !== dependencyHash) { console.log("正在安装锁定版本的依赖，需要联网，请保留此窗口…"); await command([await npmCli(), "ci", "--no-audit", "--no-fund"]); await fs.writeFile(dependencyStamp, dependencyHash); }
    const stamp = path.join(root, ".next/launcher-inputs.sha256"); const inputs = await sourceFingerprint(root);
    if (!await exists(path.join(root, ".next/BUILD_ID")) || await fs.readFile(stamp, "utf8").catch(() => "") !== inputs) { console.log("正在准备页面，首次启动或更新后需要构建…"); await command([await npmCli(), "run", "build"]); await fs.writeFile(stamp, inputs); }
    console.log("正在启动本机服务…");
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "inherit", windowsHide: true });
    const exited = new Promise(resolve => server.once("exit", resolve));
    let startError; server.once("error", error => { startError = error; });
    const stop = async () => { if (stopping) return; stopping = true; server?.kill(); await unlock(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop); process.once("exit", () => server?.kill());
    let ready = false;
    for (let attempt = 0; attempt < 240; attempt++) { if (startError || server.exitCode !== null) throw Error("服务启动失败，请检查上方的端口或权限提示"); if (await isOurService(port, fingerprint)) { ready = true; break; } await delay(250); }
    if (!ready) throw Error("页面启动超时，请检查当前窗口提示后重试");
    await writeLock(port); const url = `http://127.0.0.1:${port}`; console.log(`已就绪：${url}\n保留此窗口；按 Ctrl+C 停止服务。`); openBrowser(url);
    await exited; process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  } finally { server?.kill(); await unlock(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) launch().catch(error => { console.error(error.message); process.exitCode = 1; });
