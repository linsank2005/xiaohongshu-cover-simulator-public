import { requestTestCancellation } from "@/lib/db";
import { cancelActiveSimulation } from "@/lib/simulation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const status = await requestTestCancellation(id);

  if (!status) {
    return Response.json({ error: "测试不存在" }, { status: 404 });
  }

  if (status === "cancelling") {
    cancelActiveSimulation(id);
  }

  return Response.json(
    { id, status },
    {
      status: status === "cancelling" ? 202 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
