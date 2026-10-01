import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeValidationRecord } from "./validation";

export const dataDirectory = () => path.resolve(process.env.SIMULATOR_DATA_DIR || path.join(process.cwd(), "data"));
const connections = new Map<string, DatabaseSync>();

export function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getDatabase() {
  const directory = dataDirectory();
  const existing = connections.get(directory);
  if (existing) return existing;
  fs.mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, "simulator.db"));
  try {
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    transaction(database, () => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS tests (
          id TEXT PRIMARY KEY, uploaded_path TEXT NOT NULL, reference_ids TEXT NOT NULL,
          status TEXT NOT NULL, selected_count INTEGER, total_trials INTEGER NOT NULL DEFAULT 200,
          simulated_click_rate INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS trials (
          id INTEGER PRIMARY KEY AUTOINCREMENT, test_id TEXT NOT NULL REFERENCES tests(id),
          agent_id TEXT NOT NULL, repetition INTEGER NOT NULL, target_card TEXT NOT NULL,
          card_order TEXT NOT NULL, chosen_card TEXT NOT NULL, model TEXT NOT NULL,
          prompt_version TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS validation_records (
          simulation_test_id TEXT PRIMARY KEY, record_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS file_cleanup (test_id TEXT PRIMARY KEY, test_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS api_requests (
          id TEXT PRIMARY KEY, test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
          variant_key TEXT NOT NULL, agent_id TEXT NOT NULL, attempt INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'started', prompt_tokens INTEGER, completion_tokens INTEGER,
          total_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT,
          UNIQUE(test_id, variant_key, agent_id, attempt)
        );
      `);
      const columns: Record<string, Record<string, string>> = {
        tests: {
          title: "TEXT NOT NULL DEFAULT ''", candidate_paths: "TEXT NOT NULL DEFAULT '[]'",
          candidate_count: "INTEGER NOT NULL DEFAULT 1", random_seed: "TEXT NOT NULL DEFAULT 'legacy'",
          test_mode: "TEXT NOT NULL DEFAULT 'grid'", valid_trials: "INTEGER NOT NULL DEFAULT 0",
          request_count: "INTEGER NOT NULL DEFAULT 0", none_selected_count: "INTEGER", model: "TEXT",
          prompt_version: "TEXT", error_message: "TEXT", cancel_reason: "TEXT", cancelled_at: "TEXT",
          owner_id: "TEXT", owner_pid: "INTEGER", heartbeat_at: "INTEGER", request_key: "TEXT",
          usage_tracked: "INTEGER NOT NULL DEFAULT 0"
        },
        trials: { variant_key: "TEXT NOT NULL DEFAULT 'A'", retry_count: "INTEGER NOT NULL DEFAULT 0" },
        api_requests: { error_code: "TEXT", error_message: "TEXT", http_status: "INTEGER", provider_code: "TEXT", elapsed_ms: "INTEGER", request_bytes: "INTEGER" }
      };
      for (const [table, definitions] of Object.entries(columns)) {
        const present = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
        for (const [column, definition] of Object.entries(definitions)) {
          if (!present.has(column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
      // Keep legacy duplicates for audit instead of silently destroying their evidence.
      database.exec(`
        CREATE TABLE IF NOT EXISTS legacy_duplicate_trials AS SELECT * FROM trials WHERE 0;
        INSERT INTO legacy_duplicate_trials SELECT * FROM trials WHERE id NOT IN
          (SELECT MIN(id) FROM trials GROUP BY test_id, variant_key, agent_id, repetition);
        UPDATE tests SET status = 'failed', error_message = '历史 trial 存在重复，已归档，请重新测试'
          WHERE id IN (SELECT DISTINCT test_id FROM legacy_duplicate_trials);
        DELETE FROM trials WHERE id NOT IN
          (SELECT MIN(id) FROM trials GROUP BY test_id, variant_key, agent_id, repetition);
        CREATE UNIQUE INDEX IF NOT EXISTS trial_identity ON trials(test_id, variant_key, agent_id, repetition);
        CREATE UNIQUE INDEX IF NOT EXISTS request_identity ON tests(request_key) WHERE request_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS trial_test ON trials(test_id);
      `);
      if (!database.prepare("SELECT 1 FROM migrations WHERE name = 'validation-json'").get()) {
        const legacy = path.join(directory, "validation-records.json");
        if (fs.existsSync(legacy)) {
          const input: unknown = JSON.parse(fs.readFileSync(legacy, "utf8"));
          if (!Array.isArray(input)) throw new Error("验证记录文件必须是数组");
          const records = input.map((row, index) => normalizeValidationRecord(row, index))
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
          for (const record of records) {
            const test = database.prepare("SELECT status FROM tests WHERE id = ?").get(record.simulationTestId);
            if (record.validationStatus === "valid" && test?.status !== "completed") {
              record.validationStatus = "invalid";
              record.notes = [record.notes, "迁移时未找到对应的已完成测试"].filter(Boolean).join("；");
            }
            database.prepare("INSERT OR REPLACE INTO validation_records VALUES (?, ?)")
              .run(record.simulationTestId, JSON.stringify({ ...record, validationId: `pk-${record.simulationTestId}` }));
          }
          // The original JSON remains untouched as the migration backup.
        }
        database.prepare("INSERT INTO migrations VALUES ('validation-json')").run();
      }
    });
    connections.set(directory, database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function closeDatabases() {
  for (const database of connections.values()) database.close();
  connections.clear();
}
