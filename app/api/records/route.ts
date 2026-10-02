import { queryRecords, type RecordSource } from "@/lib/records";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const source = params.get("source") ?? "all";
  if (!["local", "imported", "all"].includes(source)) return Response.json({ error: "记录来源无效" }, { status: 400 });
  const rows = await queryRecords({ source: source as RecordSource, q: (params.get("q") ?? "").slice(0, 200), status: params.get("status") ?? undefined });
  const pages = Math.max(1, Math.ceil(rows.length / 50));
  const page = Math.min(pages, Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1));
  return Response.json({ records: rows.slice((page - 1) * 50, page * 50), total: rows.length, page, pages }, { headers: { "Cache-Control": "no-store" } });
}
