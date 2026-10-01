import { getChoiceStats, getCompletedDualCoverTests } from "@/lib/db";
import { deriveSimulatedWinner } from "@/lib/validation-service";
import { readValidationRecords } from "@/lib/validation-store";
import { drainFileCleanup } from "@/lib/test-files";
import { testDurationMs } from "@/lib/test-duration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await drainFileCleanup();
    const [tests, validationRecords] = await Promise.all([getCompletedDualCoverTests(), readValidationRecords()]);
    const validationByTest = new Map<string, (typeof validationRecords)[number]>();
    for (const record of validationRecords) {
      if (!validationByTest.has(record.simulationTestId)) validationByTest.set(record.simulationTestId, record);
    }
    const history = await Promise.all(tests.map(async (test) => {
      const choiceStats = await getChoiceStats(test.id);
      const summary = deriveSimulatedWinner(test, choiceStats);
      const validation = validationByTest.get(test.id) ?? null;
      return {
        id: test.id,
        title: test.title,
        status: test.status,
        testMode: test.testMode,
        testModeLabel: test.testMode === "vertical" ? "纵向信息流" : "四宫格",
        createdAt: test.createdAt,
        completedAt: test.completedAt,
        durationMs: testDurationMs(test.createdAt, test.completedAt),
        model: test.model,
        promptVersion: test.promptVersion,
        simulatedWinner: summary.winner,
        selectionRates: summary.scores,
        candidates: test.candidates.map((candidate) => ({
          key: candidate.key,
          label: candidate.label,
          imageUrl: `/api/tests/${encodeURIComponent(test.id)}/cover?variant=${encodeURIComponent(candidate.key)}`
        })),
        validation: validation ? {
          validationId: validation.validationId,
          validationStatus: validation.validationStatus,
          realWinner: validation.realWinner
        } : null
      };
    }));
    history.sort((left, right) => {
      const leftPending = left.validation?.realWinner ? 1 : 0;
      const rightPending = right.validation?.realWinner ? 1 : 0;
      if (leftPending !== rightPending) return leftPending - rightPending;
      return String(right.completedAt ?? right.createdAt ?? "").localeCompare(String(left.completedAt ?? left.createdAt ?? ""));
    });
    return Response.json({ tests: history }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取历史测试失败" }, { status: 500 });
  }
}
