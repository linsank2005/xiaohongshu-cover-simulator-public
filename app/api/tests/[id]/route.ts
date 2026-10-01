import { getApiUsage } from "@/lib/api-usage";
import { determineWinner } from "@/lib/result-rules";
import { deleteTest, getChoiceStats, getTest } from "@/lib/db";
import { drainFileCleanup } from "@/lib/test-files";
import { testDurationMs } from "@/lib/test-duration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const test = await getTest(id);
  if (!test) return Response.json({ error: "测试不存在" }, { status: 404 });

  const choiceStats = ["completed", "cancelled"].includes(test.status) ? await getChoiceStats(id) : null;
  const totalTrials = test.totalTrials || test.candidates.length * 100;
  const isCancelled = test.status === "cancelled";
  const trialsPerVariant = test.candidates.length > 0
    ? Math.round(totalTrials / test.candidates.length)
    : 100;
  const variants = test.candidates.map((candidate) => {
    const stat = choiceStats?.variants.find((item) => item.variantKey === candidate.key);
    const variantTrials = stat?.totalTrials ?? (isCancelled ? 0 : trialsPerVariant);
    const selectedCount = stat?.coverSelectedCount ?? 0;
    const noneSelectedCount = stat?.noneCount ?? 0;
    return {
      key: candidate.key,
      label: candidate.label,
      selectedCount,
      totalTrials: variantTrials,
      validTrials: stat?.totalTrials ?? 0,
      selectionRate: variantTrials > 0 ? Math.round((selectedCount / variantTrials) * 100) : 0,
      noneSelectedCount,
      noneRate: variantTrials > 0 ? Math.round((noneSelectedCount / variantTrials) * 100) : 0,
      feedPreviewUrl: "/api/tests/" + id + "/feed?variant=" + encodeURIComponent(candidate.key)
    };
  });
  const primaryVariant = variants[0];
  const noneSelectedCount = primaryVariant?.noneSelectedCount ?? test.noneSelectedCount;

  return Response.json({
    id: test.id,
    title: test.title,
    createdAt: test.createdAt,
    completedAt: test.completedAt,
    durationMs: testDurationMs(test.createdAt, test.completedAt),
    status: test.status,
    feedPreviewUrl: test.status === "completed" ? (primaryVariant?.feedPreviewUrl ?? null) : null,
    feedPreviewUrls: test.status === "completed"
      ? Object.fromEntries(variants.map((variant) => [variant.key, variant.feedPreviewUrl]))
      : {},
    candidates: test.candidates.map((candidate) => ({ key: candidate.key, label: candidate.label })),
    candidateCount: test.candidates.length,
    agentsPerVariant: 100,
    randomSeed: test.randomSeed,
    testMode: test.testMode,
    testModeLabel: test.testMode === "vertical" ? "纵向信息流" : "四宫格",
    simulatedClickRate: primaryVariant?.selectionRate ?? test.simulatedClickRate,
    selectedCount: primaryVariant?.selectedCount ?? test.selectedCount,
    totalTrials,
    validTrials: choiceStats?.totalTrials ?? test.validTrials,
    requestCount: test.requestCount,
    apiUsage: getApiUsage(id),
    winnerKey: test.status === "completed" ? determineWinner(variants) : null,
    cancelReason: test.cancelReason,
    cancelledAt: test.cancelledAt,
    variants,
    selectionRateDifference: variants.length === 2
      ? Math.abs(variants[0].selectionRate - variants[1].selectionRate)
      : null,
    noneSelectedCount,
    noneClickRate: noneSelectedCount === null || noneSelectedCount === undefined || (primaryVariant?.totalTrials ?? totalTrials) === 0 ? null : Math.round((noneSelectedCount / (primaryVariant?.totalTrials ?? totalTrials)) * 100),
    model: test.model,
    promptVersion: test.promptVersion,
    error: test.errorMessage
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const test = await getTest(id);
  if (!test) return Response.json({ error: "测试不存在" }, { status: 404 });
  if (test.status !== "completed" || test.candidates.length !== 2) return Response.json({ error: "只有已完成的双封面测试可以删除" }, { status: 400 });
  try {
    const deleted = await deleteTest(id);
    if (!deleted) return Response.json({ error: "测试不存在" }, { status: 404 });
    const cleanupPending = await drainFileCleanup(id) > 0;
    return Response.json({ deleted: true, removedValidationCount: deleted.removedValidationCount, cleanupPending }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "删除测试记录失败" }, { status: 500 });
  }
}
