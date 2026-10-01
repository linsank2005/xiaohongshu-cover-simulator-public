import { determineWinner } from "./result-rules";
import { dataDirectory } from "./storage";
import { referenceImageDirectory } from "./reference-library";
import type { getApiUsage } from "./api-usage";
import fs from "node:fs/promises";
import path from "node:path";
import type { CandidateStats, ReferenceCover, TestCandidate, TestMode } from "./types";

type ExportInput = {
  apiUsage?: ReturnType<typeof getApiUsage>;
  testId: string;
  title: string;
  uploadedPath: string;
  candidates?: TestCandidate[];
  references: ReferenceCover[];
  selectedCount: number;
  totalTrials: number;
  validTrials: number;
  simulatedClickRate: number;
  coverClickRates: Array<{
    key: string;
    label: string;
    selectedCount: number;
    rate: number;
  }>;
  noneSelectedCount: number;
  model: string;
  promptVersion: string;
  variantStats?: CandidateStats[];
  randomSeed?: string;
  testMode: TestMode;
  feedPreviewDataUrl?: string;
  feedPreviewOrder?: string[];
  feedPreviews?: Record<string, { dataUrl: string; order: string[] }>;
};

export async function exportTestResult(input: ExportInput) {
  const resultDir = path.join(dataDirectory(), "results", input.testId);
  const referencesDir = path.join(resultDir, "references");
  await fs.mkdir(referencesDir, { recursive: true });

  const uploadedExtension = path.extname(input.uploadedPath) || ".jpg";
  const uploadedFileName = input.candidates?.length
    ? "tested-cover-" + input.candidates[0].key + uploadedExtension
    : "tested-cover" + uploadedExtension;
  await fs.copyFile(input.uploadedPath, path.join(resultDir, uploadedFileName));
  const candidateFiles: Array<{ key: string; label: string; fileName: string }> = [{
    key: input.candidates?.[0]?.key ?? "A",
    label: input.candidates?.[0]?.label ?? "封面 A",
    fileName: uploadedFileName
  }];
  for (const candidate of input.candidates?.slice(1) ?? []) {
    const extension = path.extname(candidate.path) || ".jpg";
    const fileName = "tested-cover-" + candidate.key + extension;
    await fs.copyFile(candidate.path, path.join(resultDir, fileName));
    candidateFiles.push({ key: candidate.key, label: candidate.label, fileName });
  }

  const feedPreviewFileName = "feed-preview.jpg";
  if (input.feedPreviewDataUrl) {
    const base64Marker = "base64,";
    const base64Start = input.feedPreviewDataUrl.indexOf(base64Marker);
    if (base64Start < 0) throw new Error("AI 测试预览数据格式无效");
    await fs.writeFile(
      path.join(resultDir, feedPreviewFileName),
      Buffer.from(input.feedPreviewDataUrl.slice(base64Start + base64Marker.length), "base64")
    );
  }

  const referenceFiles: Array<{ id: string; fileName: string; label: string; path: string }> = [];
  for (const [index, reference] of input.references.entries()) {
    const outputFileName = `${String(index + 1).padStart(2, "0")}-${reference.fileName}`;
    await fs.copyFile(
      path.join(referenceImageDirectory(), reference.fileName),
      path.join(referencesDir, outputFileName)
    );
    referenceFiles.push({
      id: reference.id,
      fileName: reference.fileName,
      label: reference.label,
      path: path.join("references", outputFileName)
    });
  }

  const feedPreviewFiles: Array<{ key: string; fileName: string; cardOrder: string[] }> = input.feedPreviewDataUrl
    ? [{ key: candidateFiles[0].key, fileName: feedPreviewFileName, cardOrder: input.feedPreviewOrder ?? [] }]
    : [];
  for (const candidate of input.candidates?.slice(1) ?? []) {
    const preview = input.feedPreviews?.[candidate.key];
    if (!preview) continue;
    const fileName = "feed-preview-" + candidate.key + ".jpg";
    const base64Marker = "base64,";
    const base64Start = preview.dataUrl.indexOf(base64Marker);
    if (base64Start < 0) throw new Error("AI 测试预览数据格式无效");
    await fs.writeFile(
      path.join(resultDir, fileName),
      Buffer.from(preview.dataUrl.slice(base64Start + base64Marker.length), "base64")
    );
    feedPreviewFiles.push({ key: candidate.key, fileName, cardOrder: preview.order });
  }
  const comparison = input.variantStats && input.variantStats.length === 2
    ? {
      winnerKey: determineWinner(input.variantStats),
      selectionRateDifference: Math.abs(input.variantStats[0].selectionRate - input.variantStats[1].selectionRate)
    }
    : null;

  const result = {
    testId: input.testId,
    apiUsage: input.apiUsage ?? null,
    title: input.title,
    model: input.model,
    promptVersion: input.promptVersion,
    testMode: input.testMode,
    testModeLabel: input.testMode === "vertical" ? "纵向信息流" : "四宫格",
    randomSeed: input.randomSeed ?? null,
    candidates: candidateFiles,
    variants: input.variantStats ?? null,
    comparison,
    simulatedClickRate: input.simulatedClickRate,
    selectedCount: input.selectedCount,
    totalTrials: input.totalTrials,
    validTrials: input.validTrials,
    noneSelectedCount: input.noneSelectedCount,
    noneClickRate: input.variantStats?.[0]?.noneRate ?? Math.round((input.noneSelectedCount / input.totalTrials) * 100),
    coverClickRates: input.coverClickRates,
    testedCover: uploadedFileName,
    referenceCovers: referenceFiles,
    feedPreview: input.feedPreviewDataUrl
      ? { fileName: feedPreviewFileName, cardOrder: input.feedPreviewOrder ?? null }
      : null,
    feedPreviews: feedPreviewFiles,
    exportedAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(resultDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(resultDir, "result.txt"),
    [
      "测试模式：" + (input.testMode === "vertical" ? "纵向信息流" : "四宫格"),
      ...(input.variantStats ? [
        "候选封面版本对比",
        ...input.variantStats.map((variant) => variant.label + "：" + variant.selectionRate + "%（" + variant.selectedCount + "/" + variant.totalTrials + "），自然跳过 " + variant.noneRate + "%"),
        input.variantStats.length === 2
          ? "选择率差值：" + Math.abs(input.variantStats[0].selectionRate - input.variantStats[1].selectionRate) + " 个百分点"
          : ""
      ] : []),
      ...(input.variantStats ? [] : [
      `用户封面：${input.coverClickRates[0].rate}%（${input.coverClickRates[0].selectedCount}/${input.totalTrials}）`,
      ...input.coverClickRates.slice(1).map((cover) => `${cover.label}：${cover.rate}%（${cover.selectedCount}/${input.totalTrials}）`),
      `自然跳过：${input.noneSelectedCount}/${input.totalTrials}（${Math.round((input.noneSelectedCount / input.totalTrials) * 100)}%）`,
      ]),
      `有效判断：${input.validTrials}/${input.totalTrials}`,
      `模型：${input.model}`,
      `提示词版本：${input.promptVersion}`
    ].join("\n") + "\n",
    "utf8"
  );
}
