import { determineWinner } from "./result-rules";
import { getChoiceStats, getTest } from "./db";
import type { StoredTest } from "./types";
import type { ValidationRecord, ValidationWinner } from "./validation";

export function appendValidationNote(record: ValidationRecord, note: string) {
  return { ...record, notes: record.notes ? `${record.notes}；${note}` : note };
}

export function deriveSimulatedWinner(test: StoredTest, choiceStats: Awaited<ReturnType<typeof getChoiceStats>>) {
  const variants = test.candidates.map(candidate => {
    const stat = choiceStats.variants.find(item => item.variantKey === candidate.key);
    return { key: candidate.key, selectedCount: stat?.coverSelectedCount ?? 0, totalTrials: stat?.totalTrials ?? 0 };
  });
  return { winner: determineWinner(variants), scores: variants.map(v => ({ key: v.key, rate: v.totalTrials ? Math.round(v.selectedCount / v.totalTrials * 100) : 0 })) };
}

export async function hydrateFromSimulation(record: ValidationRecord) {
  const test = await getTest(record.simulationTestId);
  if (!test) {
    return {
      record: record.validationStatus === "valid" ? appendValidationNote({ ...record, validationStatus: "invalid" }, "未找到对应的本地 simulationTestId") : record,
      warning: `${record.validationId}：未找到对应的本地 simulationTestId`
    };
  }
  if (test.status === "cancelled") {
    return {
      record: appendValidationNote({ ...record, validationStatus: "cancelled" }, "对应模拟任务已取消，不进入准确率统计"),
      warning: `${record.validationId}：对应模拟任务已取消`
    };
  }
  if (test.status !== "completed") {
    return {
      record: record.validationStatus === "valid" ? appendValidationNote({ ...record, validationStatus: "inconclusive" }, "对应模拟任务尚未完成") : record,
      warning: `${record.validationId}：对应模拟任务尚未完成`
    };
  }

  const choiceStats = await getChoiceStats(test.id);
  const summary = deriveSimulatedWinner(test, choiceStats);
  if (summary.winner === null) {
    return {
      record: record.validationStatus === "valid" ? appendValidationNote({ ...record, validationStatus: "inconclusive" }, "对应模拟任务没有完整的双版本 trial") : record,
      warning: `${record.validationId}：对应模拟任务没有完整的双版本 trial`
    };
  }
  const status = record.validationStatus === "valid" && ["A", "B"].includes(summary.winner) && ["A", "B"].includes(record.realWinner ?? "")
    ? "valid"
    : record.validationStatus === "valid" ? "inconclusive" : record.validationStatus;
  const hydrated = {
    ...record,
    validationStatus: status,
    title: test.title,
    coverA: record.coverA || test.candidates[0]?.label || "封面 A",
    coverB: record.coverB || test.candidates[1]?.label || "封面 B",
    simulatedWinner: summary.winner,
    testMode: test.testMode,
    model: test.model || "未记录"
  } satisfies ValidationRecord;
  return { record: hydrated, warning: status === "inconclusive" ? `${record.validationId}：模拟结果没有明确赢家或真实赢家未填写` : null };
}
