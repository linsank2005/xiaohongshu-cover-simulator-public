import assert from "node:assert/strict";
import test from "node:test";
import { testDurationMs } from "../lib/test-duration.ts";
import { formatLocalDate } from "../lib/display-date.ts";

test("record dates interpret SQLite timestamps as UTC and display the viewer's timezone", () => {
  assert.equal(formatLocalDate("2026-10-02 09:03:00", "Asia/Shanghai"), formatLocalDate("2026-10-02T09:03:00Z", "Asia/Shanghai"));
  assert.match(formatLocalDate("2026-10-02 09:03:00", "Asia/Shanghai"), /17:03/);
  assert.match(formatLocalDate("2026-10-02T09:03:00Z", "UTC"), /09:03/);
  assert.equal(formatLocalDate("bad date"), "时间未知");
});

test("test duration uses persisted UTC timestamps and rejects incomplete ranges", () => {
  assert.equal(testDurationMs("2026-09-21 01:02:03", "2026-09-21 01:04:08"), 125000);
  assert.equal(testDurationMs("2026-09-21T01:02:03.250Z", "2026-09-21T01:02:04.000Z"), 750);
  assert.equal(testDurationMs(null, "2026-09-21 01:04:08"), null);
  assert.equal(testDurationMs("2026-09-21 01:04:08", "2026-09-21 01:02:03"), null);
  assert.equal(testDurationMs("invalid", "2026-09-21 01:04:08"), null);
});
