export const VALIDATION_COLUMNS = [
  "validationId",
  "simulationTestId",
  "source",
  "validationStatus",
  "validationType",
  "title",
  "coverA",
  "coverB",
  "simulatedWinner",
  "realWinner",
  "testMode",
  "model",
  "simulationDate",
  "realPkDate",
  "errorCategory",
  "notes",
  "impressions",
  "views",
  "likes",
  "saves",
  "comments"
] as const;

export type ValidationStatus = "valid" | "invalid" | "inconclusive" | "cancelled";
export type ValidationType = "prospective" | "retrospective";
export type ValidationWinner = "A" | "B" | "tie" | "unknown" | null;

export type ValidationRecord = {
  validationId: string;
  simulationTestId: string;
  source: string;
  validationStatus: ValidationStatus;
  validationType: ValidationType;
  title: string;
  coverA: string;
  coverB: string;
  simulatedWinner: ValidationWinner;
  realWinner: ValidationWinner;
  testMode: "grid" | "vertical" | null;
  model: string;
  simulationDate: string | null;
  realPkDate: string | null;
  errorCategory: string | null;
  notes: string | null;
  impressions: number | null;
  views: number | null;
  likes: number | null;
  saves: number | null;
  comments: number | null;
  updatedAt: string;
};

export type ValidationGroup = {
  key: string;
  label: string;
  totalCount: number;
  validCount: number;
  correctCount: number;
  agreementRate: number | null;
};

export type ValidationStats = {
  totalCount: number;
  validCount: number;
  correctCount: number;
  incorrectCount: number;
  inconclusiveCount: number;
  invalidCount: number;
  cancelledCount: number;
  agreementRate: number | null;
  sampleGate: {
    minimum: number;
    label: string;
  };
  byValidationType: ValidationGroup[];
  byTestMode: ValidationGroup[];
  byModel: ValidationGroup[];
  errorCategories: Array<{ key: string; label: string; count: number }>;
};

export type ValidationImportResult = {
  records: ValidationRecord[];
  warnings: string[];
};

const STATUS_VALUES: ValidationStatus[] = ["valid", "invalid", "inconclusive", "cancelled"];
const TYPE_VALUES: ValidationType[] = ["prospective", "retrospective"];

function stringValue(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function requiredString(value: unknown, field: string, index: number) {
  const result = stringValue(value);
  if (!result) throw new Error("\u7b2c " + (index + 1) + " \u6761\u8bb0\u5f55\u7f3a\u5c11 " + field);
  return result;
}

function optionalString(value: unknown) {
  const result = stringValue(value);
  return result || null;
}

function parseStatus(value: unknown, index: number): ValidationStatus {
  const result = stringValue(value) as ValidationStatus;
  if (!STATUS_VALUES.includes(result)) throw new Error("\u7b2c " + (index + 1) + " \u6761\u8bb0\u5f55\u7684 validationStatus \u65e0\u6548");
  return result;
}

function parseType(value: unknown, index: number): ValidationType {
  const result = stringValue(value) as ValidationType;
  if (!TYPE_VALUES.includes(result)) throw new Error("\u7b2c " + (index + 1) + " \u6761\u8bb0\u5f55\u7684 validationType \u65e0\u6548");
  return result;
}

function parseWinner(value: unknown, field: string, index: number): ValidationWinner {
  const result = stringValue(value).toLowerCase();
  if (!result) return null;
  if (result === "a") return "A";
  if (result === "b") return "B";
  if (["tie", "draw", "平局"].includes(result)) return "tie";
  if (["unknown", "\u4e0d\u786e\u5b9a", "\u65e0\u660e\u786e\u8d62\u5bb6"].includes(result)) return "unknown";
  throw new Error("\u7b2c " + (index + 1) + " \u6761\u8bb0\u5f55\u7684 " + field + " \u65e0\u6548\uff0c\u53ea\u80fd\u586b A\u3001B\u3001tie \u6216 unknown");
}

function parseDate(value: unknown, field: string, index: number) {
  const result = optionalString(value);
  if (result && !/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new Error("\u7b2c " + (index + 1) + " \u6761\u8bb0\u5f55\u7684 " + field + " \u5fc5\u987b\u662f YYYY-MM-DD");
  }
  return result;
}

function parseNumber(value: unknown, field: string, index: number) {
  const result = optionalString(value);
  if (!result) return null;
  const number = Number(result);
  if (!Number.isFinite(number) || number < 0) throw new Error("\u7b2c " + (index + 1) + " \u6761\u8bb0\u5f55\u7684 " + field + " \u5fc5\u987b\u662f\u975e\u8d1f\u6570\u5b57");
  return number;
}

export function normalizeValidationRecord(input: Record<string, unknown>, index = 0): ValidationRecord {
  const validationStatus = parseStatus(input.validationStatus, index);
  const simulatedWinner = parseWinner(input.simulatedWinner, "simulatedWinner", index);
  const realWinner = parseWinner(input.realWinner, "realWinner", index);
  if (validationStatus === "valid" && (!realWinner || !["A", "B"].includes(realWinner))) {
    throw new Error("\u7b2c " + (index + 1) + " \u6761\u8bb0\u5f55\u6807\u8bb0\u4e3a valid \u65f6\uff0c\u771f\u5b9e\u8d62\u5bb6\u5fc5\u987b\u662f A \u6216 B\uff1b\u6a21\u62df\u8d62\u5bb6\u53ef\u7559\u7a7a\uff0c\u7531\u7cfb\u7edf\u6309 simulationTestId \u590d\u6838");
  }
  const rawTestMode = optionalString(input.testMode);
  if (rawTestMode && rawTestMode !== "grid" && rawTestMode !== "vertical") {
    throw new Error("\u7b2c " + (index + 1) + " \u6761\u8bb0\u5f55\u7684 testMode \u65e0\u6548");
  }
  return {
    validationId: requiredString(input.validationId, "validationId", index),
    simulationTestId: requiredString(input.simulationTestId, "simulationTestId", index),
    source: requiredString(input.source || "xiaohongshu-cover-pk", "source", index),
    validationStatus,
    validationType: parseType(input.validationType, index),
    title: stringValue(input.title),
    coverA: stringValue(input.coverA),
    coverB: stringValue(input.coverB),
    simulatedWinner,
    realWinner,
    testMode: rawTestMode as "grid" | "vertical" | null,
    model: stringValue(input.model),
    simulationDate: parseDate(input.simulationDate, "simulationDate", index),
    realPkDate: parseDate(input.realPkDate, "realPkDate", index),
    errorCategory: optionalString(input.errorCategory),
    notes: optionalString(input.notes),
    impressions: parseNumber(input.impressions, "impressions", index),
    views: parseNumber(input.views, "views", index),
    likes: parseNumber(input.likes, "likes", index),
    saves: parseNumber(input.saves, "saves", index),
    comments: parseNumber(input.comments, "comments", index),
    updatedAt: stringValue(input.updatedAt) || new Date().toISOString()
  };
}

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"') {
      if (quoted && next === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  return rows;
}

function parseCsv(text: string) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new Error("CSV 文件没有可导入的内容");
  const headers = rows[0].map((header) => header.trim());
  const missing = VALIDATION_COLUMNS.filter((column) => !headers.includes(column) && ["validationId", "simulationTestId", "validationStatus", "validationType", "realWinner", "realPkDate"].includes(column));
  if (missing.length > 0) throw new Error(`CSV 缺少必要列：${missing.join(", ")}`);
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export function parseValidationImport(text: string, format: "json" | "csv"): ValidationImportResult {
  let rawRecords: unknown[];
  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("JSON 文件格式无效");
    }
    if (Array.isArray(parsed)) rawRecords = parsed;
    else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown[] }).records)) rawRecords = (parsed as { records: unknown[] }).records;
    else throw new Error("JSON \u5fc5\u987b\u662f\u8bb0\u5f55\u6570\u7ec4\uff0c\u6216\u5305\u542b records \u6570\u7ec4\u7684\u5bf9\u8c61");
  } else {
    rawRecords = parseCsv(text);
  }
  if (rawRecords.length === 0) throw new Error("没有可导入的验证记录");
  const seen = new Set<string>();
  const records = rawRecords.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("\u7b2c " + (index + 1) + " \u6761\u8bb0\u5f55\u5fc5\u987b\u662f\u5bf9\u8c61");
    const record = normalizeValidationRecord(value as Record<string, unknown>, index);
    if (seen.has(record.validationId)) throw new Error("\u5bfc\u5165\u6587\u4ef6\u4e2d\u5b58\u5728\u91cd\u590d validationId: " + record.validationId);
    seen.add(record.validationId);
    return record;
  });
  return { records, warnings: [] };
}

function csvValue(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeValidationCsv(records: ValidationRecord[] = []) {
  const rows = [VALIDATION_COLUMNS.join(",")];
  for (const record of records) rows.push(VALIDATION_COLUMNS.map((column) => csvValue(record[column])).join(","));
  return rows.join("\n") + "\n";
}

function percentage(correctCount: number, validCount: number) {
  return validCount > 0 ? Math.round((correctCount / validCount) * 1000) / 10 : null;
}

function summarize(records: ValidationRecord[], key: string, label: string, selector: (record: ValidationRecord) => string) {
  const groups = new Map<string, ValidationRecord[]>();
  for (const record of records) {
    const groupKey = selector(record) || "unknown";
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), record]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([groupKey, groupRecords]) => {
    const validRecords = groupRecords.filter((record) => record.validationStatus === "valid");
    const correctCount = validRecords.filter((record) => record.simulatedWinner === record.realWinner).length;
    return { key: key + ":" + groupKey, label: label === "\u6a21\u578b" ? groupKey : groupKey === "grid" ? "\u56db\u5bab\u683c" : groupKey === "vertical" ? "\u7eb5\u5411\u4fe1\u606f\u6d41" : groupKey === "prospective" ? "\u524d\u77bb\u9a8c\u8bc1" : groupKey === "retrospective" ? "\u56de\u6eaf\u6837\u672c" : groupKey, totalCount: groupRecords.length, validCount: validRecords.length, correctCount, agreementRate: percentage(correctCount, validRecords.length) };
  });
}

export function calculateValidationStats(records: ValidationRecord[]): ValidationStats {
  const validRecords = records.filter((record) => record.validationStatus === "valid");
  const correctCount = validRecords.filter((record) => record.simulatedWinner === record.realWinner).length;
  const sampleCount = validRecords.length;
  const sampleGate = sampleCount >= 100
    ? { minimum: 100, label: "\u5df2\u8fbe\u5230 100 \u6761\uff1a\u9636\u6bb5\u6027\u7ed3\u8bba\u95e8\u69db" }
    : sampleCount >= 50
      ? { minimum: 100, label: "\u5df2\u8fbe\u5230 50 \u6761\uff1a\u7a33\u5b9a\u6027\u68c0\u67e5\u95e8\u69db" }
      : sampleCount >= 30
        ? { minimum: 50, label: "\u5df2\u8fbe\u5230 30 \u6761\uff1a\u7cfb\u7edf\u590d\u76d8\u95e8\u69db" }
        : sampleCount >= 10
          ? { minimum: 30, label: "\u5df2\u8fbe\u5230 10 \u6761\uff1a\u89c2\u5bdf\u95e8\u69db" }
          : { minimum: 10, label: "\u5c1a\u672a\u8fbe\u5230 10 \u6761\u6709\u6548\u6837\u672c\u89c2\u5bdf\u95e8\u69db" };
  const categories = new Map<string, number>();
  for (const record of validRecords) {
    if (record.simulatedWinner !== record.realWinner) {
      const category = record.errorCategory || "\u672a\u5206\u7c7b";
      categories.set(category, (categories.get(category) ?? 0) + 1);
    }
  }
  return {
    totalCount: records.length,
    validCount: sampleCount,
    correctCount,
    incorrectCount: sampleCount - correctCount,
    inconclusiveCount: records.filter((record) => record.validationStatus === "inconclusive").length,
    invalidCount: records.filter((record) => record.validationStatus === "invalid").length,
    cancelledCount: records.filter((record) => record.validationStatus === "cancelled").length,
    agreementRate: percentage(correctCount, sampleCount),
    sampleGate,
    byValidationType: summarize(records, "validationType", "验证类型", (record) => record.validationType),
    byTestMode: summarize(records, "testMode", "测试模式", (record) => record.testMode ?? "unknown"),
    byModel: summarize(records, "model", "模型", (record) => record.model || "未记录"),
    errorCategories: [...categories.entries()].sort(([, left], [, right]) => right - left).map(([key, count]) => ({ key, label: key, count }))
  };
}
