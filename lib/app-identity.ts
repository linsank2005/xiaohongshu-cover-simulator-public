import path from "node:path";
import { createHash } from "node:crypto";
import pkg from "../package.json";
import { dataDirectory } from "./storage";
export const APP_ID = "xhs-cover-simulator";
export const APP_VERSION = pkg.version;
export function workspaceFingerprint() {
  return createHash("sha256").update(`${path.resolve(process.cwd())}\n${dataDirectory()}`).digest("hex").slice(0, 32);
}
