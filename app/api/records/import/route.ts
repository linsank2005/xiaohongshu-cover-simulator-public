import { limitedRequest } from "@/lib/api-boundary";
import { importRecords, MAX_ARCHIVE_BYTES, MAX_JSON_BYTES } from "@/lib/records";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const bounded = await limitedRequest(request, MAX_ARCHIVE_BYTES + 65536);
    const form = await bounded.formData(); const file = form.get("file");
    if (!(file instanceof File)) throw new Error("请选择记录 JSON 或 ZIP 文件");
    const zip = file.name.toLowerCase().endsWith(".zip");
    if ((!zip && !file.name.toLowerCase().endsWith(".json")) || file.size > (zip ? MAX_ARCHIVE_BYTES : MAX_JSON_BYTES)) throw new Error("请选择 JSON（16MB 内）或 ZIP（64MB 内）文件");
    return Response.json(await importRecords(Buffer.from(await file.arrayBuffer()), zip));
  } catch (error) { return Response.json({ error: error instanceof Error && !("code" in error) ? error.message : "导入失败，请检查文件格式或本地磁盘权限" }, { status: 400 }); }
}
