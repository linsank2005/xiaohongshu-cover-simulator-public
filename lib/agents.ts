import fs from "node:fs";
import path from "node:path";
import type { AgentProfile } from "./types";

export const AGENT_COUNT = 100;

const agentsPath = path.join(process.cwd(), "data", "agents.json");
const requiredArrayFields = [
  "interests",
  "contentPreferences",
  "consumptionHabits",
  "visualPreferences",
  "contentAvoidances",
  "triggers"
] as const;

function ageBand(age: number) {
  if (age < 25) return "18-24";
  if (age < 35) return "25-34";
  return "35+";
}

function assertText(value: unknown, field: string, agentId: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Agent ${agentId} 的 ${field} 必须是非空文本`);
  }
}

function assertScore(value: unknown, field: string, agentId: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Agent ${agentId} 的 ${field} 必须是 0 到 1 之间的数字`);
  }
}

export function validateAgents(agents: AgentProfile[]) {
  if (agents.length !== AGENT_COUNT) {
    throw new Error(`agents.json 必须包含 ${AGENT_COUNT} 个 Agent，当前为 ${agents.length} 个`);
  }

  const ids = new Set<string>();
  const genderCounts = new Map<string, number>();
  const ageBandCounts = new Map<string, number>();

  for (const agent of agents) {
    assertText(agent.id, "id", agent.id || "unknown");
    if (ids.has(agent.id)) throw new Error(`Agent ID 重复：${agent.id}`);
    ids.add(agent.id);

    if (!Number.isInteger(agent.age) || agent.age < 18 || agent.age > 65) {
      throw new Error(`Agent ${agent.id} 的年龄必须在 18 到 65 岁之间`);
    }
    if (agent.gender !== "女性" && agent.gender !== "男性") {
      throw new Error(`Agent ${agent.id} 的性别不在允许范围内`);
    }
    if (!["一线", "新一线", "二线", "其他"].includes(agent.cityTier)) {
      throw new Error(`Agent ${agent.id} 的城市层级不在允许范围内`);
    }
    if (!["学生", "职场", "专业服务", "经营创业", "内容创作", "家庭与生活"].includes(agent.occupationCluster)) {
      throw new Error(`Agent ${agent.id} 的职业类别不在允许范围内`);
    }
    if (!["低", "中", "中高", "高", "很高"].includes(agent.titleSensitivity)) {
      throw new Error(`Agent ${agent.id} 的标题敏感度不在允许范围内`);
    }

    for (const field of ["occupation", "lifeStage", "familyStage", "usageFrequency", "currentBrowseState", "clickHabit", "personality", "browsePurpose", "profileVersion", "source"] as const) {
      assertText(agent[field], field, agent.id);
    }
    for (const field of requiredArrayFields) {
      if (!Array.isArray(agent[field]) || agent[field].length === 0 || agent[field].some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error(`Agent ${agent.id} 的 ${field} 必须是非空文本数组`);
      }
    }
    for (const field of [
      "titleReliance",
      "visualReliance",
      "readabilitySensitivity",
      "realLifeScenePreference",
      "humanPresencePreference",
      "resultNumberSensitivity",
      "adSkepticism",
      "noveltySeeking"
    ] as const) {
      assertScore(agent[field], field, agent.id);
    }

    genderCounts.set(agent.gender, (genderCounts.get(agent.gender) ?? 0) + 1);
    const band = ageBand(agent.age);
    ageBandCounts.set(band, (ageBandCounts.get(band) ?? 0) + 1);
  }

  const expectedGenderCounts = { 女性: 72, 男性: 28 };
  for (const [gender, expected] of Object.entries(expectedGenderCounts)) {
    if (genderCounts.get(gender) !== expected) {
      throw new Error(`Agent 性别配额不符合预设：${gender} 应为 ${expected} 个，实际为 ${genderCounts.get(gender) ?? 0} 个`);
    }
  }
  const expectedAgeBandCounts = { "18-24": 43, "25-34": 37, "35+": 20 };
  for (const [band, expected] of Object.entries(expectedAgeBandCounts)) {
    if (ageBandCounts.get(band) !== expected) {
      throw new Error(`Agent 年龄配额不符合预设：${band} 应为 ${expected} 个，实际为 ${ageBandCounts.get(band) ?? 0} 个`);
    }
  }

  return agents;
}

export function loadAgents(): AgentProfile[] {
  const agents = JSON.parse(fs.readFileSync(agentsPath, "utf8")) as AgentProfile[];
  return validateAgents(agents);
}
