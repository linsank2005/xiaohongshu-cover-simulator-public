import sharp from "sharp";
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 20_000_000;
export async function validateUploadedImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("图片必须非空且不超过 10MB");
  const format = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "jpeg"
    : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
  if (!format) throw new Error("实际图片格式必须是 JPG、PNG 或 WEBP");
  const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning" });
  const meta = await image.metadata();
  if (meta.format !== format || (meta.pages ?? 1) !== 1 || !meta.width || !meta.height || meta.width > 10000 || meta.height > 10000 || meta.width * meta.height > MAX_IMAGE_PIXELS) throw new Error("不支持多帧图片或尺寸过大的图片");
  await image.stats();
  return format === "jpeg" ? "jpg" : format;
}
