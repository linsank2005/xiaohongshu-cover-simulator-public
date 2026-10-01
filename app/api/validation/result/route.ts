import { limitedRequest } from "@/lib/api-boundary";
import { getTest } from "@/lib/db";
import { calculateValidationStats, normalizeValidationRecord, type ValidationWinner } from "@/lib/validation";
import { hydrateFromSimulation } from "@/lib/validation-service";
import { mergeValidationRecords, readValidationRecords } from "@/lib/validation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dateToday() {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  try {
    request = await limitedRequest(request, 16384);
    const body = await request.json() as { simulationTestId?: unknown; realWinner?: unknown; notes?: unknown; realPkDate?: unknown };
    const simulationTestId = typeof body.simulationTestId === "string" ? body.simulationTestId.trim() : "";
    const realWinner = typeof body.realWinner === "string" ? body.realWinner : "";
    if (!simulationTestId) return Response.json({ error: "缺少 simulationTestId" }, { status: 400 });
    if (!["A", "B", "unknown"].includes(realWinner)) return Response.json({ error: "真实赢家只能是 A、B 或 unknown" }, { status: 400 });
    const test = await getTest(simulationTestId);
    if (!test) return Response.json({ error: "对应的历史测试不存在，可能已被删除" }, { status: 404 });
    if (test.status !== "completed" || test.candidates.length !== 2) return Response.json({ error: "只有已完成的双封面测试可以记录真实 PK 结果" }, { status: 400 });
    const rawRecord = normalizeValidationRecord({
      validationId: "pk-" + simulationTestId,
      simulationTestId,
      source: "xiaohongshu-cover-pk",
      validationStatus: realWinner === "unknown" ? "inconclusive" : "valid",
      validationType: "prospective",
      title: "",
      coverA: "",
      coverB: "",
      simulatedWinner: "",
      realWinner: realWinner as ValidationWinner,
      testMode: "",
      model: "",
      simulationDate: test.createdAt ? test.createdAt.slice(0, 10) : null,
      realPkDate: typeof body.realPkDate === "string" && body.realPkDate ? body.realPkDate : dateToday(),
      errorCategory: null,
      notes: typeof body.notes === "string" ? body.notes : null
    });
    const hydrated = await hydrateFromSimulation(rawRecord);
    const merged = await mergeValidationRecords([hydrated.record]);
    const records = await readValidationRecords();
    return Response.json({
      record: hydrated.record,
      created: merged.created,
      updated: merged.updated,
      warning: hydrated.warning,
      records,
      stats: calculateValidationStats(records)
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存真实 PK 结果失败" }, { status: 400 });
  }
}
