import assert from "node:assert/strict";
import test from "node:test";
import { testDurationMs } from "../lib/test-duration.ts";

test("test duration uses persisted UTC timestamps and rejects incomplete ranges", () => {
  assert.equal(testDurationMs("2026-09-21 01:02:03", "2026-09-21 01:04:08"), 125000);
  assert.equal(testDurationMs("2026-09-21T01:02:03.250Z", "2026-09-21T01:02:04.000Z"), 750);
  assert.equal(testDurationMs(null, "2026-09-21 01:04:08"), null);
  assert.equal(testDurationMs("2026-09-21 01:04:08", "2026-09-21 01:02:03"), null);
  assert.equal(testDurationMs("invalid", "2026-09-21 01:04:08"), null);
});
