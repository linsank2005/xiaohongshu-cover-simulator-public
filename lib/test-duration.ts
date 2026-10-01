function timestampMs(value: string | null) {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(" ", "T") + "Z"
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function testDurationMs(createdAt: string | null, completedAt: string | null) {
  const start = timestampMs(createdAt);
  const end = timestampMs(completedAt);
  if (start === null || end === null || end < start) return null;
  return end - start;
}
