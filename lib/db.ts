import { randomUUID } from "node:crypto";
import { getDatabase, transaction } from "./storage";
import { AGENTS_PER_VARIANT, cardNamesForMode, isValidChoice } from "./result-rules";
import { isTestMode, type ModelChoice, type ReferenceCover, type StoredTest, type TestCandidate, type TestMode, type TestStatus } from "./types";

const runtime = globalThis as typeof globalThis & { simulatorOwner?: string };
const ownerId = runtime.simulatorOwner ??= randomUUID();
const LEASE_MS = 30_000;

function ownerAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function recoverInterruptedTests(now = Date.now()) {
  const db = getDatabase();
  transaction(db, () => {
    const rows = db.prepare("SELECT * FROM tests WHERE status IN ('pending','running','cancelling')").all();
    for (const row of rows) {
      const timestamp = Number(row.heartbeat_at) || Date.parse(String(row.created_at).replace(" ", "T") + "Z");
      const dead = row.owner_pid != null && !ownerAlive(Number(row.owner_pid));
      if (!dead && now - timestamp <= LEASE_MS) continue;
      const cancelled = row.status === "cancelling";
      db.prepare("UPDATE tests SET status = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP, cancelled_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE cancelled_at END, valid_trials = (SELECT COUNT(*) FROM trials WHERE test_id = tests.id) WHERE id = ?")
        .run(cancelled ? "cancelled" : "failed", cancelled ? null : "执行器已中断，请重新测试", cancelled ? 1 : 0, row.id);
      db.prepare("UPDATE api_requests SET status = 'interrupted', finished_at = CURRENT_TIMESTAMP WHERE test_id = ? AND status = 'started'").run(row.id);
    }
  });
}

export class ActiveTestError extends Error {}
export async function createTest(test: {
  id: string; uploadedPath: string; candidates: TestCandidate[]; title: string;
  referenceIds: string[]; randomSeed: string; testMode: TestMode; requestKey?: string;
}) {
  recoverInterruptedTests();
  const db = getDatabase();
  return transaction(db, () => {
    if (test.requestKey) {
      const existing = db.prepare("SELECT id FROM tests WHERE request_key = ?").get(test.requestKey);
      if (existing) return { id: String(existing.id), created: false };
      // A local account has one request budget at a time, across tabs and server processes.
      if (db.prepare("SELECT 1 FROM tests WHERE status IN ('pending','running','cancelling')").get()) {
        throw new ActiveTestError("已有测试正在执行，请等待完成或取消后再试");
      }
    }
    db.prepare("INSERT INTO tests (id, uploaded_path, candidate_paths, candidate_count, random_seed, test_mode, reference_ids, title, status, total_trials, valid_trials, request_key, heartbeat_at, usage_tracked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, 1)")
      .run(test.id, test.uploadedPath, JSON.stringify(test.candidates), test.candidates.length, test.randomSeed, test.testMode, JSON.stringify(test.referenceIds), test.title, test.candidates.length * AGENTS_PER_VARIANT, test.requestKey ?? null, Date.now());
    return { id: test.id, created: true };
  });
}

export async function startTest(id: string, metadata?: { model: string; promptVersion: string; provider?: import("./model-options").ModelProvider; modelConfig?: import("./model-settings").ModelConfigSnapshot }) {
  recoverInterruptedTests();
  return getDatabase().prepare("UPDATE tests SET status = 'running', owner_id = ?, owner_pid = ?, heartbeat_at = ?, model = COALESCE(?, model), prompt_version = COALESCE(?, prompt_version), model_provider = COALESCE(?, model_provider), model_config = COALESCE(?, model_config), error_message = NULL WHERE id = ? AND status = 'pending'")
    .run(ownerId, process.pid, Date.now(), metadata?.model ?? null, metadata?.promptVersion ?? null, metadata?.provider ?? null, metadata?.modelConfig ? JSON.stringify(metadata.modelConfig) : null, id).changes > 0;
}

export function heartbeatTest(id: string) {
  return getDatabase().prepare("UPDATE tests SET heartbeat_at = ? WHERE id = ? AND owner_id = ? AND status = 'running'")
    .run(Date.now(), id, ownerId).changes > 0;
}

export function assertTestRunning(id: string) {
  const row = getDatabase().prepare("SELECT status, owner_id, heartbeat_at FROM tests WHERE id = ?").get(id);
  if (!row || row.status !== "running" || row.owner_id !== ownerId || Date.now() - Number(row.heartbeat_at) > LEASE_MS) {
    throw new Error("测试已停止或执行租约已失效");
  }
}

export async function requestTestCancellation(id: string, reason = "用户取消测试") {
  recoverInterruptedTests();
  const db = getDatabase();
  return transaction(db, () => {
    const row = db.prepare("SELECT status FROM tests WHERE id = ?").get(id);
    if (!row) return null;
    if (["completed", "failed", "cancelled"].includes(String(row.status))) return String(row.status);
    const next = row.status === "pending" ? "cancelled" : "cancelling";
    db.prepare("UPDATE tests SET status = ?, cancel_reason = ?, cancelled_at = CASE WHEN ? = 'cancelled' THEN CURRENT_TIMESTAMP ELSE cancelled_at END, completed_at = CASE WHEN ? = 'cancelled' THEN CURRENT_TIMESTAMP ELSE completed_at END WHERE id = ?")
      .run(next, reason, next, next, id);
    return next;
  });
}

export async function isTestCancellationRequested(id: string) {
  const row = getDatabase().prepare("SELECT status FROM tests WHERE id = ?").get(id);
  return Boolean(row && ["cancelling", "cancelled"].includes(String(row.status)));
}

export async function markTestCancelled(id: string, reason = "用户取消测试") {
  return getDatabase().prepare("UPDATE tests SET status = 'cancelled', cancel_reason = COALESCE(cancel_reason, ?), valid_trials = (SELECT COUNT(*) FROM trials WHERE test_id = tests.id), completed_at = CURRENT_TIMESTAMP, cancelled_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('pending','running','cancelling')")
    .run(reason, id).changes > 0;
}

export async function failTest(id: string, message: string) {
  getDatabase().prepare("UPDATE tests SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP, valid_trials = (SELECT COUNT(*) FROM trials WHERE test_id = tests.id) WHERE id = ? AND owner_id = ? AND status = 'running'")
    .run(message, id, ownerId);
}

export async function completeTest(id: string, stats: {
  selectedCount: number; primaryTotalTrials: number; totalTrials: number; validTrials: number;
  requestCount: number; noneSelectedCount: number; model: string; promptVersion: string;
}) {
  const db = getDatabase();
  return transaction(db, () => {
    const row = db.prepare("SELECT * FROM tests WHERE id = ? AND status = 'running' AND owner_id = ?").get(id, ownerId);
    if (!row) return false;
    const variants = getChoiceStatsSync(id).variants;
    const candidates = JSON.parse(String(row.candidate_paths)) as TestCandidate[];
    if (candidates.length !== 2 || variants.length !== 2 || candidates.some(c => !variants.some(v => v.variantKey === c.key && v.totalTrials === AGENTS_PER_VARIANT))) {
      throw new Error("trial 不完整，不能标记测试完成");
    }
    const primary = variants.find(v => v.variantKey === candidates[0].key)!;
    db.prepare("UPDATE tests SET status = 'completed', selected_count = ?, total_trials = 200, valid_trials = 200, simulated_click_rate = ?, none_selected_count = ?, model = ?, prompt_version = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(primary.coverSelectedCount, primary.coverSelectedCount, primary.noneCount, stats.model, stats.promptVersion, id);
    return true;
  });
}

export async function saveTrial(trial: {
  testId: string; variantKey: string; agentId: string; repetition: number; targetCard: string;
  cardOrder: string[]; chosenCard: ModelChoice; model: string; promptVersion: string; retryCount: number;
}) {
  const db = getDatabase();
  return transaction(db, () => {
    assertTestRunning(trial.testId);
    const row = db.prepare("SELECT test_mode, candidate_paths FROM tests WHERE id = ?").get(trial.testId)!;
    const mode = row.test_mode as TestMode;
    const names = cardNamesForMode(mode);
    if (!isValidChoice(trial.chosenCard, mode) || trial.cardOrder.length !== names.length || new Set(trial.cardOrder).size !== names.length || trial.cardOrder.some(c => !names.includes(c)) || trial.targetCard !== trial.cardOrder[0]) throw new Error("无效的 trial 选择或位置计划");
    if (!(JSON.parse(String(row.candidate_paths)) as TestCandidate[]).some(c => c.key === trial.variantKey)) throw new Error("未知的候选版本");
    db.prepare("INSERT INTO trials (test_id, variant_key, agent_id, repetition, target_card, card_order, chosen_card, model, prompt_version, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(trial.testId, trial.variantKey, trial.agentId, trial.repetition, trial.targetCard, JSON.stringify(trial.cardOrder), trial.chosenCard, trial.model, trial.promptVersion, trial.retryCount);
    // Persist progress in the same transaction as the valid judgment. Failed or
    // duplicate inserts cannot advance the counter shown by the live page.
    db.prepare("UPDATE tests SET valid_trials = valid_trials + 1 WHERE id = ?").run(trial.testId);
  });
}

function getChoiceStatsSync(testId: string) {
  const rows = getDatabase().prepare("SELECT variant_key, card_order, chosen_card FROM trials WHERE test_id = ? ORDER BY id").all(testId);
  const variants = new Map<string, { variantKey: string; coverSelectedCount: number; noneCount: number; totalTrials: number; referenceSelectedCounts: number[] }>();
  for (const row of rows) {
    const key = String(row.variant_key);
    const order = JSON.parse(String(row.card_order)) as string[];
    const choice = String(row.chosen_card);
    // Corrupt legacy rows must never enter a valid trial denominator.
    if (choice !== "NONE" && !order.includes(choice)) continue;
    const stat = variants.get(key) ?? { variantKey: key, coverSelectedCount: 0, noneCount: 0, totalTrials: 0, referenceSelectedCounts: Array(9).fill(0) as number[] };
    stat.totalTrials++;
    if (choice === "NONE") stat.noneCount++;
    else if (order.indexOf(choice) === 0) stat.coverSelectedCount++;
    else stat.referenceSelectedCounts[order.indexOf(choice) - 1]++;
    variants.set(key, stat);
  }
  return { variants: [...variants.values()], totalTrials: [...variants.values()].reduce((n, v) => n + v.totalTrials, 0) };
}
export async function getChoiceStats(testId: string) { return getChoiceStatsSync(testId); }

function rowToTest(row: Record<string, unknown>): StoredTest {
  const parsedCandidates = row.candidate_paths === null || row.candidate_paths === undefined
    ? []
    : JSON.parse(String(row.candidate_paths)) as TestCandidate[];
  const candidates = parsedCandidates.length > 0
    ? parsedCandidates
    : [{ key: "A", label: "封面 A", path: String(row.uploaded_path) }];
  return {
    id: String(row.id),
    uploadedPath: String(row.uploaded_path),
    candidates,
    createdAt: row.created_at === null || row.created_at === undefined ? null : String(row.created_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
    randomSeed: row.random_seed === null || row.random_seed === undefined ? "legacy" : String(row.random_seed),
    testMode: isTestMode(row.test_mode) ? row.test_mode : "grid",
    title: row.title === null || row.title === undefined ? "" : String(row.title),
    referenceIds: JSON.parse(String(row.reference_ids)) as string[],
    status: String(row.status) as TestStatus,
    selectedCount: row.selected_count === null || row.selected_count === undefined ? null : Number(row.selected_count),
    totalTrials: Number(row.total_trials),
    validTrials: row.valid_trials === null || row.valid_trials === undefined ? 0 : Number(row.valid_trials),
    requestCount: row.request_count === null || row.request_count === undefined ? 0 : Number(row.request_count),
    simulatedClickRate: row.simulated_click_rate === null || row.simulated_click_rate === undefined ? null : Number(row.simulated_click_rate),
    noneSelectedCount: row.none_selected_count === null || row.none_selected_count === undefined ? null : Number(row.none_selected_count),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    provider: row.model_provider === null || row.model_provider === undefined ? null : String(row.model_provider) as import("./model-options").ModelProvider,
    modelConfig: row.model_config ? JSON.parse(String(row.model_config)) : null,
    notes: String(row.notes ?? ""),
    promptVersion: row.prompt_version === null || row.prompt_version === undefined ? null : String(row.prompt_version),
    errorMessage: row.error_message === null || row.error_message === undefined ? null : String(row.error_message),
    cancelReason: row.cancel_reason === null || row.cancel_reason === undefined ? null : String(row.cancel_reason),
    cancelledAt: row.cancelled_at === null || row.cancelled_at === undefined ? null : String(row.cancelled_at)
  };
}


export async function getCompletedDualCoverTests(): Promise<StoredTest[]> {
  recoverInterruptedTests();
  return getDatabase().prepare("SELECT * FROM tests WHERE status = 'completed' AND candidate_count = 2 ORDER BY COALESCE(completed_at, created_at) DESC").all().map(rowToTest);
}

export async function getAllDualCoverTests(): Promise<StoredTest[]> {
  recoverInterruptedTests();
  return getDatabase().prepare("SELECT * FROM tests WHERE candidate_count = 2 ORDER BY created_at DESC").all().map(rowToTest);
}

export async function getTest(id: string): Promise<StoredTest | null> {
  recoverInterruptedTests();
  const row = getDatabase().prepare("SELECT * FROM tests WHERE id = ?").get(id);
  return row ? rowToTest(row) : null;
}

export async function deleteTest(id: string) {
  const db = getDatabase();
  return transaction(db, () => {
    const row = db.prepare("SELECT * FROM tests WHERE id = ? AND status IN ('completed','failed','cancelled')").get(id);
    if (!row) return null;
    const removedValidationCount = Number(db.prepare("DELETE FROM validation_records WHERE simulation_test_id = ?").run(id).changes);
    const test = rowToTest(row);
    db.prepare("INSERT INTO file_cleanup VALUES (?, ?)").run(id, JSON.stringify(test));
    db.prepare("DELETE FROM trials WHERE test_id = ?").run(id);
    db.prepare("DELETE FROM api_requests WHERE test_id = ?").run(id);
    db.prepare("DELETE FROM tests WHERE id = ?").run(id);
    return { ...test, removedValidationCount };
  });
}
export async function getTestCandidate(id: string, key: string) {
  return (await getTest(id))?.candidates.find(candidate => candidate.key === key) ?? null;
}
export async function getReferenceIdsForTest(id: string) { return (await getTest(id))?.referenceIds ?? null; }
export function getReferenceById(id: string, references: ReferenceCover[]) { return references.find(reference => reference.id === id); }

export async function getTestByRequestKey(key: string) {
  const row = getDatabase().prepare("SELECT * FROM tests WHERE request_key = ?").get(key);
  return row ? rowToTest(row) : null;
}
