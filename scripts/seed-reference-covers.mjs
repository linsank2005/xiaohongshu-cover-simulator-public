import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The release checkout owns its own manifest. Never restore the old scraped library.
export function seedReferenceCovers(root = process.cwd()) {
  const imageDir = path.join(root, "public", "reference-covers");
  const dataDir = path.join(root, "data");
  const manifestPath = path.join(dataDir, "reference-covers.json");
  fs.mkdirSync(imageDir, { recursive: true });
  for (const directory of ["uploads", "tmp"]) fs.mkdirSync(path.join(dataDir, directory), { recursive: true });
  if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, "[]\n", "utf8");
  const references = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(references)) throw new Error("模拟参考封面清单必须是数组");
  if (references.length === 0) {
    console.log("发布准备中：模拟参考图库尚未生成。程序可以构建，封面测试需等待完整图库接入。");
    return { count: 0, ready: false };
  }
  if (references.length !== 100) throw new Error("完整模拟参考图库必须包含 100 张封面；待确认样图请保存在 previews 中");
  const ids = new Set();
  const files = new Set();
  for (const reference of references) {
    if (!reference || reference.source !== "imagegen" || reference.noteId !== "") throw new Error("仅接受 imagegen 生成且不含原笔记 ID 的模拟封面");
    if (typeof reference.id !== "string" || !/^ref-\d{3}$/.test(reference.id) || ids.has(reference.id)) throw new Error("模拟封面 ID 无效或重复");
    if (typeof reference.fileName !== "string" || !/^sim-\d{3}\.(webp|png|jpg)$/.test(reference.fileName) || files.has(reference.fileName)) throw new Error("模拟封面文件名无效或重复");
    for (const field of ["title", "category", "track", "label", "license"]) {
      if (typeof reference[field] !== "string" || !reference[field].trim()) throw new Error("模拟封面缺少 " + field);
    }
    if (!Number.isFinite(reference.weight) || reference.weight <= 0) throw new Error("模拟封面权重必须为正数");
    if (!fs.existsSync(path.join(imageDir, reference.fileName))) throw new Error("缺少模拟参考封面：" + reference.fileName);
    ids.add(reference.id);
    files.add(reference.fileName);
  }
  console.log("Synthetic reference library ready: " + references.length + " covers");
  return { count: references.length, ready: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) seedReferenceCovers();
