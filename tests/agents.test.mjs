import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agents = JSON.parse(fs.readFileSync(path.join(projectRoot, "data", "agents.json"), "utf8"));

function ageBand(age) {
  if (age < 25) return "18-24";
  if (age < 35) return "25-34";
  return "35+";
}

test("Agent 数据集包含 100 个唯一画像", () => {
  assert.equal(agents.length, 100);
  assert.equal(new Set(agents.map((agent) => agent.id)).size, 100);
});

test("Agent 数据集符合固定人口配额", () => {
  const genderCounts = Map.groupBy(agents, (agent) => agent.gender);
  const ageCounts = Map.groupBy(agents, (agent) => ageBand(agent.age));
  assert.equal(genderCounts.get("女性").length, 72);
  assert.equal(genderCounts.get("男性").length, 28);
  assert.equal(ageCounts.get("18-24").length, 43);
  assert.equal(ageCounts.get("25-34").length, 37);
  assert.equal(ageCounts.get("35+").length, 20);
});

test("每个 Agent 都有行为参数和审计字段", () => {
  const arrayFields = ["interests", "contentPreferences", "consumptionHabits", "visualPreferences", "contentAvoidances", "triggers"];
  const scoreFields = ["titleReliance", "visualReliance", "readabilitySensitivity", "realLifeScenePreference", "humanPresencePreference", "resultNumberSensitivity", "adSkepticism", "noveltySeeking"];
  for (const agent of agents) {
    for (const field of arrayFields) assert.ok(Array.isArray(agent[field]) && agent[field].length > 0, `${agent.id}.${field}`);
    for (const field of scoreFields) assert.ok(agent[field] >= 0 && agent[field] <= 1, `${agent.id}.${field}`);
    assert.equal(agent.profileVersion, "persona-v1");
    assert.equal(agent.source, "synthetic_xhs_quota_v1");
  }
});
