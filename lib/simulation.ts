import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadAgents } from "./agents";
import { buildAgentPrompt } from "./agent-prompt";
import { assertTestRunning, heartbeatTest, completeTest, getTest, isTestCancellationRequested, markTestCancelled, saveTrial, startTest, failTest } from "./db";
import type { ModelProvider } from "./model-options";
import { exportTestResult } from "./result-export";
import { VERTICAL_CARD_NAMES } from "./types";
import { cardNamesForMode } from "./result-rules";
import { MAX_IMAGE_PIXELS } from "./upload-image";
import { getApiUsage } from "./api-usage";
import { SimulationControl, TestCancelledError, callWithRetry, modelNameForProvider } from "./model-client";
import { modelRequestPolicy } from "./model-transport";
import { referenceImageDirectory } from "./reference-library";
import type { AgentProfile, CandidateStats, ModelChoice, ReferenceCover, TestCandidate, TestMode } from "./types";
export { parseModelChoice } from "./model-client";
export const PROMPT_VERSION = "v10-paired-compact-profile-validated-choices";
export const CARD_NAMES = VERTICAL_CARD_NAMES;
const globalState = globalThis as typeof globalThis & { activeCoverSimulations?: Map<string, SimulationControl> };
const activeSimulations = globalState.activeCoverSimulations ??= new Map<string, SimulationControl>();
export function cancelActiveSimulation(testId: string) {
  activeSimulations.get(testId)?.stop(new TestCancelledError("用户取消测试"));
}
async function ensureSimulationActive(testId: string, control: SimulationControl) {
  control.check();
  if (await isTestCancellationRequested(testId)) {
    control.stop(new TestCancelledError("用户取消测试"));
    control.check();
  }
  assertTestRunning(testId);
  control.check();
}
function toDataUrl(buffer: Buffer) {
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

function escapeSvgText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}


function titleLines(title: string) {
  const characters = Array.from(title.trim());
  const maxCharsPerLine = 18;
  const maxLines = 4;
  const visibleCharacters = characters.slice(0, maxCharsPerLine * maxLines);
  if (characters.length > visibleCharacters.length && visibleCharacters.length > 0) {
    visibleCharacters[visibleCharacters.length - 1] = "…";
  }
  const lines: string[] = [];
  for (let index = 0; index < visibleCharacters.length; index += maxCharsPerLine) {
    lines.push(visibleCharacters.slice(index, index + maxCharsPerLine).join(""));
  }
  return lines;
}

function titleBlock(title: string) {
  const lines = titleLines(title);
  const lineHeight = 29;
  const firstBaseline = 47;
  const quote = String.fromCharCode(34);
  const text = lines.map((line, index) => "<tspan x=" + quote + "24" + quote + " dy=" + quote + (index === 0 ? 0 : lineHeight) + quote + ">" + escapeSvgText(line) + "</tspan>").join("");
  return Buffer.from("<svg width=" + quote + "540" + quote + " height=" + quote + "160" + quote + "><rect x=" + quote + "0" + quote + " y=" + quote + "0" + quote + " width=" + quote + "540" + quote + " height=" + quote + "160" + quote + " fill=" + quote + "#fffdfa" + quote + "/><text x=" + quote + "24" + quote + " y=" + quote + firstBaseline + quote + " fill=" + quote + "#292522" + quote + " font-family=" + quote + "Microsoft YaHei, PingFang SC, Arial, sans-serif" + quote + " font-size=" + quote + "23" + quote + " font-weight=" + quote + "500" + quote + ">" + text + "</text></svg>");
}

async function normalizedImage(filePath: string, title: string) {
  const image = await sharp(filePath, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning" }).rotate()
    .resize(540, 560, { fit: "contain", background: { r: 248, g: 245, b: 240, alpha: 1 } })
    .jpeg({ quality: 86 })
    .toBuffer();
  return sharp({ create: { width: 540, height: 720, channels: 3, background: { r: 255, g: 253, b: 250 } } })
    .composite([
      { input: image, left: 0, top: 0 },
      { input: titleBlock(title), left: 0, top: 560 }
    ])
    .jpeg({ quality: 86 })
    .toBuffer();
}

async function makeFeedImage(images: Buffer[], order: string[], testMode: TestMode) {
  const byCard = new Map(order.map((card, index) => [card, images[index]]));
  if (testMode === "vertical") {
    const cardHeight = 720;
    const gap = 24;
    const columns = 2;
    const rows = Math.ceil(CARD_NAMES.length / columns);
    const canvasHeight = rows * cardHeight + Math.max(0, rows - 1) * gap;
    return toDataUrl(await sharp({ create: { width: 1080, height: canvasHeight, channels: 3, background: { r: 248, g: 245, b: 240 } } })
      .composite(CARD_NAMES.map((card, index) => ({
        input: byCard.get(card)!,
        left: (index % columns) * 540,
        top: Math.floor(index / columns) * (cardHeight + gap)
      })))
      .jpeg({ quality: 84 })
      .toBuffer());
  }
  const canvas = await sharp({ create: { width: 1080, height: 1440, channels: 3, background: { r: 248, g: 245, b: 240 } } })
    .composite([
      { input: byCard.get("A")!, left: 0, top: 0 },
      { input: byCard.get("B")!, left: 540, top: 0 },
      { input: byCard.get("C")!, left: 0, top: 720 },
      { input: byCard.get("D")!, left: 540, top: 720 }
    ])
    .jpeg({ quality: 84 })
    .toBuffer();
  return toDataUrl(canvas);
}

function seededRandom(seed: string) {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number) {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(random() * (index + 1));
    [output[index], output[randomIndex]] = [output[randomIndex], output[index]];
  }
  return output;
}

export function createBalancedCardOrders(seed: string, count: number, testMode: TestMode = "grid") {
  const random = seededRandom(seed);
  const cardNames = cardNamesForMode(testMode);
  const targetCards = shuffled(
    Array.from({ length: count }, (_, index) => cardNames[index % cardNames.length]),
    random
  );
  return targetCards.map((targetCard) => [
    targetCard,
    ...shuffled(cardNames.filter((card) => card !== targetCard), random)
  ]);
}


export async function runWithConcurrency<T>(items: T[], worker: (item: T) => Promise<void>, control: SimulationControl, concurrency = 5) {
  let cursor = 0;
  async function runner() {
    while (cursor < items.length && !control.error) {
      const item = items[cursor++];
      try { await worker(item); }
      catch (error) { control.stop(error instanceof Error ? error : new Error(String(error))); }
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
  control.check();
}

type TrialOutcome = {
  variantKey: string;
  index: number;
  agent: AgentProfile;
  repetition: number;
  targetCard: string;
  cardOrder: string[];
  chosenCard: ModelChoice;
  retryCount: number;
};

export type SimulationDependencies = {
  transport?: typeof fetch;
  prepareImages?: (paths: string[], titles: string[]) => Promise<Buffer[]>;
  renderFeed?: (images: Buffer[], order: string[], mode: TestMode) => Promise<string>;
  exportResult?: typeof exportTestResult;
};

export async function runSimulation(testId: string, candidates: TestCandidate[], references: ReferenceCover[], title: string, provider: ModelProvider = "ollama", randomSeed = testId, testMode: TestMode = "grid", dependencies: SimulationDependencies = {}) {
  // Claim once, before creating any worker or loading mutable input. Duplicate dispatch is a no-op.
  if (!await startTest(testId, { model: modelNameForProvider(provider), promptVersion: PROMPT_VERSION })) return;
  const simulation = new SimulationControl();
  activeSimulations.set(testId, simulation);
  let lastHeartbeat = 0;
  const timer = setInterval(() => {
    try {
      assertTestRunning(testId);
      if (Date.now() - lastHeartbeat > 5_000) { heartbeatTest(testId); lastHeartbeat = Date.now(); }
    } catch (error) { simulation.stop(error instanceof Error ? error : new Error("任务已停止")); }
  }, 250);
  try {
    const agents = loadAgents();
    if (candidates.length !== 2) throw new Error("每次测试必须包含 2 张候选封面");
    const referenceCount = testMode === "vertical" ? 9 : 3;
    if (references.length !== referenceCount) throw new Error(`当前测试模式必须包含 ${referenceCount} 张参考封面`);
    const referencePaths = references.map((reference) => path.join(referenceImageDirectory(), reference.fileName));
    const cardNames = cardNamesForMode(testMode);
    const cardOrders = createBalancedCardOrders(randomSeed, agents.length, testMode);
    const jobs = agents.map((agent, index) => ({ agent, index, repetition: 1, order: cardOrders[index], prompt: buildAgentPrompt(agent, testMode) }));
    const outcomes: TrialOutcome[] = [];
    const feedPreviews: Record<string, { dataUrl: string; order: string[] }> = {};
    await ensureSimulationActive(testId, simulation);
    const prepare = dependencies.prepareImages ?? (async (paths: string[], titles: string[]) => Promise.all(paths.map((file, i) => normalizedImage(file, titles[i]))));
    const referenceImages = await prepare(referencePaths, references.map(reference => reference.title));
    for (const candidate of candidates) {
      const images = [...await prepare([candidate.path], [title]), ...referenceImages];
      const feedCache = new Map<string, Promise<string>>();
      await ensureSimulationActive(testId, simulation);
      await runWithConcurrency(jobs, async ({ agent, index, repetition, order, prompt }) => {
        await ensureSimulationActive(testId, simulation);
        const cacheKey = order.join("");
        let feed = feedCache.get(cacheKey);
        if (!feed) {
          feed = (dependencies.renderFeed ?? makeFeedImage)(images, order, testMode);
          feedCache.set(cacheKey, feed);
        }
        const feedDataUrl = await feed;
        await ensureSimulationActive(testId, simulation);
        if (!feedPreviews[candidate.key]) {
          feedPreviews[candidate.key] = { dataUrl: feedDataUrl, order };
        }
        const result = await callWithRetry({ testId, variantKey: candidate.key, agentId: agent.id, provider,
          prompt, feedDataUrl, testMode, control: simulation, transport: dependencies.transport });
        await ensureSimulationActive(testId, simulation);
        const outcome = {
          variantKey: candidate.key,
          index,
          agent,
          repetition,
          targetCard: order[0],
          cardOrder: order,
          chosenCard: result.choice,
          retryCount: result.retryCount
        } satisfies TrialOutcome;
        await saveTrial({
          testId,
          variantKey: outcome.variantKey,
          agentId: outcome.agent.id,
          repetition: outcome.repetition,
          targetCard: outcome.targetCard,
          cardOrder: outcome.cardOrder,
          chosenCard: outcome.chosenCard,
          model: modelNameForProvider(provider),
          promptVersion: PROMPT_VERSION,
          retryCount: outcome.retryCount
        });
        outcomes.push(outcome);
      }, simulation, modelRequestPolicy(provider, testMode).concurrency);
    }

    await ensureSimulationActive(testId, simulation);
    outcomes.sort((left, right) => left.variantKey.localeCompare(right.variantKey) || left.index - right.index);

    const variantStats: CandidateStats[] = candidates.map((candidate) => {
      const candidateOutcomes = outcomes.filter((outcome) => outcome.variantKey === candidate.key);
      const selectedCount = candidateOutcomes.filter((outcome) => outcome.chosenCard === outcome.cardOrder[0]).length;
      const noneSelectedCount = candidateOutcomes.filter((outcome) => outcome.chosenCard === "NONE").length;
      return {
        key: candidate.key,
        label: candidate.label,
        selectedCount,
        totalTrials: jobs.length,
        validTrials: candidateOutcomes.length,
        selectionRate: Math.round((selectedCount / jobs.length) * 100),
        noneSelectedCount,
        noneRate: Math.round((noneSelectedCount / jobs.length) * 100)
      };
    });
    const primaryStats = variantStats[0];
    const primaryOutcomes = outcomes.filter((outcome) => outcome.variantKey === primaryStats.key);
    const coverSelectedCounts = Array.from({ length: cardNames.length }, () => 0);
    for (const outcome of primaryOutcomes) {
      if (outcome.chosenCard === "NONE") continue;
      const selectedIndex = outcome.cardOrder.indexOf(outcome.chosenCard);
      if (selectedIndex >= 0) coverSelectedCounts[selectedIndex] += 1;
    }
    const coverClickRates = [
      { key: "uploaded", label: primaryStats.label, selectedCount: coverSelectedCounts[0], rate: primaryStats.selectionRate },
      ...references.map((reference, index) => ({
        key: "reference-" + (index + 1),
        label: reference.label,
        selectedCount: coverSelectedCounts[index + 1],
        rate: Math.round((coverSelectedCounts[index + 1] / primaryStats.totalTrials) * 100)
      }))
    ];
    const totalTrials = outcomes.length;

    try {
      await (dependencies.exportResult ?? exportTestResult)({
        testId,
        title,
        uploadedPath: candidates[0].path,
        candidates,
        references,
        selectedCount: primaryStats.selectedCount,
        simulatedClickRate: primaryStats.selectionRate,
        coverClickRates,
        variantStats,
        totalTrials,
        validTrials: outcomes.length,
        noneSelectedCount: primaryStats.noneSelectedCount,
        model: modelNameForProvider(provider),
        promptVersion: PROMPT_VERSION,
        randomSeed,
        testMode,
        feedPreviewDataUrl: feedPreviews[primaryStats.key]?.dataUrl,
        feedPreviewOrder: feedPreviews[primaryStats.key]?.order,
        feedPreviews,
        apiUsage: getApiUsage(testId)
      });
    } catch (error) {
      throw new Error(`结果文件导出失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
    await ensureSimulationActive(testId, simulation);
    const completed = await completeTest(testId, {
      selectedCount: primaryStats.selectedCount,
      primaryTotalTrials: primaryStats.totalTrials,
      totalTrials,
      validTrials: outcomes.length,
      requestCount: getApiUsage(testId).requestCount,
      noneSelectedCount: primaryStats.noneSelectedCount,
      model: modelNameForProvider(provider),
      promptVersion: PROMPT_VERSION
    });
    if (!completed) {
      if (await isTestCancellationRequested(testId)) throw new TestCancelledError();
      throw new Error("测试状态已改变，无法完成");
    }
  } catch (error) {
    if (error instanceof TestCancelledError || await isTestCancellationRequested(testId)) {
      await markTestCancelled(testId, "用户取消测试");
      return;
    }
    await failTest(testId, error instanceof Error ? error.message : "真实模型测试失败");
  } finally {
    clearInterval(timer);
    activeSimulations.delete(testId);
  }
}

export async function cleanupUploadedFile(testId: string) {
  const test = await getTest(testId);
  if (!test) return;
  await Promise.all(test.candidates.map((candidate) => fs.rm(candidate.path, { force: true })));
}
