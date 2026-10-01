import { limitedRequest } from "@/lib/api-boundary";
import { calculateValidationStats, parseValidationImport, serializeValidationCsv, type ValidationRecord } from "@/lib/validation";
import { hydrateFromSimulation } from "@/lib/validation-service";
import { mergeValidationRecords, readValidationRecords } from "@/lib/validation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const records = await readValidationRecords();
    const params = new URL(request.url).searchParams;
    if (params.get("format") === "csv") {
      return new Response(serializeValidationCsv(params.get("template") === "1" ? [] : records), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="xhs-validation-template.csv"`,
          "Cache-Control": "no-store"
        }
      });
    }
    return Response.json({ records, stats: calculateValidationStats(records) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取验证记录失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    request = await limitedRequest(request, 2097152);
    const contentType = request.headers.get("content-type") ?? "";
    let text = "";
    let format: "json" | "csv" = "json";
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) return Response.json({ error: "请上传 CSV 或 JSON 文件" }, { status: 400 });
      text = await file.text();
      format = file.name.toLowerCase().endsWith(".csv") ? "csv" : "json";
    } else {
      const body = await request.json() as { text?: unknown; format?: unknown; records?: unknown };
      if (typeof body.text === "string") {
        text = body.text;
        format = body.format === "csv" ? "csv" : "json";
      } else if (body.records !== undefined) {
        text = JSON.stringify(body.records);
      } else {
        return Response.json({ error: "请求中没有验证记录" }, { status: 400 });
      }
    }
    const parsed = parseValidationImport(text, format);
    const hydrated = await Promise.all(parsed.records.map((record) => hydrateFromSimulation(record)));
    const merged = await mergeValidationRecords(hydrated.map((item) => item.record));
    const warnings = hydrated.map((item) => item.warning).filter((warning): warning is string => Boolean(warning));
    return Response.json({ imported: parsed.records.length, created: merged.created, updated: merged.updated, warnings, records: merged.records, stats: calculateValidationStats(merged.records) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "导入验证记录失败" }, { status: 400 });
  }
}
