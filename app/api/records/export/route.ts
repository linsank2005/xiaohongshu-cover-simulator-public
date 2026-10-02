import { exportRecords, type RecordSource } from "@/lib/records";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const source = params.get("source") ?? "local";
  if (!["local", "imported", "all"].includes(source)) return Response.json({ error: "记录来源无效" }, { status: 400 });
  const includeCovers = params.get("includeCovers") === "1";
  try {
    const result = await exportRecords({ source: source as RecordSource, q: params.get("q") ?? undefined, status: params.get("status") ?? undefined, ids: params.getAll("id").length ? params.getAll("id") : undefined }, includeCovers);
    return new Response(new Uint8Array(result.bytes), { headers: {
      "Content-Type": includeCovers ? "application/zip" : "application/json; charset=utf-8", "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="xhs-records-${new Date().toISOString().slice(0, 10)}.${includeCovers ? "zip" : "json"}"`,
      "X-Record-Count": String(result.count), "X-Missing-Covers": String(result.missingCovers)
    } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "导出失败，请缩小记录范围后重试" }, { status: 400 }); }
}
