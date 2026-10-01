import fs from "node:fs";
import path from "node:path";
import type { AgentProfile, TestMode } from "./types";

const AGENT_PROMPT_PATH = path.join(process.cwd(), "config", "agent-prompt.md");
const AGENT_PROFILE_PLACEHOLDER = "{{AGENT_PROFILE_JSON}}";
const FEED_MODE_PLACEHOLDER = "{{FEED_MODE_INSTRUCTIONS}}";
const CHOICE_VALUES_PLACEHOLDER = "{{CHOICE_VALUES}}";

function loadAgentPromptTemplate() {
  const template = fs.readFileSync(AGENT_PROMPT_PATH, "utf8").trim();
  if (!template) throw new Error("Agent prompt template is empty");
  if (!template.includes(AGENT_PROFILE_PLACEHOLDER)) {
    throw new Error(`Agent prompt template must include ${AGENT_PROFILE_PLACEHOLDER}`);
  }
  if (!template.includes(FEED_MODE_PLACEHOLDER)) {
    throw new Error(`Agent prompt template must include ${FEED_MODE_PLACEHOLDER}`);
  }
  if (!template.includes(CHOICE_VALUES_PLACEHOLDER)) {
    throw new Error(`Agent prompt template must include ${CHOICE_VALUES_PLACEHOLDER}`);
  }
  return template;
}

function feedModeInstructions(testMode: TestMode) {
  if (testMode === "vertical") {
    return "这是纵向信息流测试。十张卡片按两列五行排列，模拟小红书双列信息流中用户从上到下连续向下滑动时依次看到的内容。位置标签 A 到 J 按从上到下、每行从左到右对应十个位置。请按双列连续浏览和同屏竞争场景判断，不要把它当成十张图片中挑一张最好看的图片。";
  }
  return "这是四宫格测试。四张卡片分别位于左上、右上、左下、右下，位置标签 A、B、C、D 依次对应这四个位置。请按同屏竞争场景判断。";
}

function choiceValues(testMode: TestMode) {
  return testMode === "vertical" ? "A、B、C、D、E、F、G、H、I、J" : "A、B、C、D";
}

export function buildAgentPrompt(agent: AgentProfile, testMode: TestMode = "grid") {
  const { id: _id, source: _source, profileVersion: _version, ...behavior } = agent;
  return loadAgentPromptTemplate()
    .replace(AGENT_PROFILE_PLACEHOLDER, JSON.stringify(behavior))
    .replace(FEED_MODE_PLACEHOLDER, feedModeInstructions(testMode))
    .replace(CHOICE_VALUES_PLACEHOLDER, choiceValues(testMode));
}
