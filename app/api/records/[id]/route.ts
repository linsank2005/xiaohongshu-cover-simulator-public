import { limitedRequest } from "@/lib/api-boundary";
import { saveRecordNotes, deleteRecord } from "@/lib/records";
export const runtime = "nodejs";
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { id } = await context.params; const data = await (await limitedRequest(request, 32 * 1024)).json(); saveRecordNotes(id, data.notes); return Response.json({ saved: true }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "备注保存失败" }, { status: 400 }); }
}
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { id } = await context.params; return Response.json({ deleted: true, ...await deleteRecord(id) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "记录删除失败" }, { status: 400 }); }
}
