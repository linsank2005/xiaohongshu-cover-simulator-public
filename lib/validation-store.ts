import { getDatabase, transaction } from "./storage";
import type { ValidationRecord } from "./validation";

function readRecords(): ValidationRecord[] {
  return getDatabase().prepare("SELECT record_json FROM validation_records").all()
    .map(row => JSON.parse(String(row.record_json)) as ValidationRecord)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function readValidationRecords() { return readRecords(); }
export async function mergeValidationRecords(incoming: ValidationRecord[]) {
  const db = getDatabase();
  return transaction(db, () => {
    let created = 0;
    let updated = 0;
    const seen = new Set<string>();
    for (const input of incoming) {
      if (seen.has(input.simulationTestId)) throw new Error("同一批导入不能重复包含同一个 simulationTestId");
      seen.add(input.simulationTestId);
      const test = db.prepare("SELECT status FROM tests WHERE id = ?").get(input.simulationTestId);
      if (input.validationStatus === "valid" && test?.status !== "completed") throw new Error("测试不存在或已被删除，不能保存有效校准记录");
      const record = { ...input, validationId: `pk-${input.simulationTestId}`, updatedAt: new Date().toISOString() };
      if (db.prepare("SELECT 1 FROM validation_records WHERE simulation_test_id = ?").get(record.simulationTestId)) updated++;
      else created++;
      db.prepare("INSERT INTO validation_records VALUES (?, ?) ON CONFLICT(simulation_test_id) DO UPDATE SET record_json = excluded.record_json")
        .run(record.simulationTestId, JSON.stringify(record));
    }
    return { records: readRecords(), created, updated };
  });
}
export async function removeValidationRecordsForSimulationTest(id: string) {
  return Number(getDatabase().prepare("DELETE FROM validation_records WHERE simulation_test_id = ?").run(id).changes);
}
