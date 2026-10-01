import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

// Temporary plain-color fixtures verify rendering without distributing real cover assets.
export async function createReferenceFixtures(directory, count = 9) {
  const imageDir = path.join(directory, "reference-fixtures");
  fs.mkdirSync(imageDir, { recursive: true });
  const library = [];
  for (let index = 0; index < count; index++) {
    const fileName = `fixture-${index}.png`;
    await sharp({ create: { width: 540, height: 720, channels: 3, background: { r: 160 + index, g: 190, b: 210 } } }).png().toFile(path.join(imageDir, fileName));
    library.push({ id: `fixture-${index}`, fileName, label: "测试参考图", title: `渲染测试 ${index + 1}`, category: "测试", track: "测试", noteId: "", weight: 1, source: "test-fixture", license: "仅自动测试临时使用" });
  }
  fs.writeFileSync(path.join(imageDir, "reference-covers.json"), JSON.stringify(library));
  return { imageDir, library };
}
