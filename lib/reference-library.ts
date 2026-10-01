import fs from "node:fs";
import path from "node:path";
import type { ReferenceCover } from "./types";

export function referenceImageDirectory() {
  return process.env.SIMULATOR_REFERENCE_DIR || path.join(process.cwd(), "public", "reference-covers");
}

function referenceManifestPath() {
  return process.env.SIMULATOR_REFERENCE_DIR
    ? path.join(process.env.SIMULATOR_REFERENCE_DIR, "reference-covers.json")
    : path.join(process.cwd(), "data", "reference-covers.json");
}

export function loadReferenceLibrary(minimumCount = 3): ReferenceCover[] {
  const libraryPath = referenceManifestPath();
  if (!fs.existsSync(libraryPath)) throw new Error("对照封面库不存在，请先运行 npm run seed");
  const references = JSON.parse(fs.readFileSync(libraryPath, "utf8")) as ReferenceCover[];
  if (references.length === 0) throw new Error("模拟参考图库尚未完成；请先确认样图并接入完整图库");
  if (references.length < minimumCount) throw new Error(`对照封面库至少需要 ${minimumCount} 张封面`);
  return references;
}

export function chooseRandomReferences(references: ReferenceCover[], count = 3): ReferenceCover[] {
  if (!Number.isInteger(count) || count < 0) throw new Error("抽取数量必须是非负整数");
  if (count > references.length) throw new Error("抽取数量不能超过对照封面库数量");

  const pool = [...references];
  const selected: ReferenceCover[] = [];

  while (selected.length < count) {
    const weightedPool = pool.map((reference) => ({
      reference,
      weight: Number.isFinite(reference.weight) && reference.weight > 0 ? reference.weight : 0
    }));
    const totalWeight = weightedPool.reduce((sum, item) => sum + item.weight, 0);

    if (totalWeight <= 0) {
      const randomIndex = Math.floor(Math.random() * pool.length);
      selected.push(pool.splice(randomIndex, 1)[0]);
      continue;
    }

    let cursor = Math.random() * totalWeight;
    let selectedIndex = weightedPool.length - 1;
    for (let index = 0; index < weightedPool.length; index += 1) {
      cursor -= weightedPool[index].weight;
      if (cursor <= 0) {
        selectedIndex = index;
        break;
      }
    }
    selected.push(pool.splice(selectedIndex, 1)[0]);
  }

  return selected;
}
