"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { determineWinner } from "@/lib/result-rules";
import { MODEL_OPTIONS, type ModelProvider } from "@/lib/model-options";
import type { TestMode } from "@/lib/types";
import type { ValidationRecord, ValidationStats } from "@/lib/validation";

type TestState = "idle" | "pending" | "uploading" | "running" | "cancelling" | "cancelled" | "completed" | "failed";

type CandidateResult = {
  key: string;
  label: string;
  selectedCount: number;
  totalTrials: number;
  validTrials: number;
  selectionRate: number;
  noneSelectedCount: number;
  noneRate: number;
  feedPreviewUrl: string;
};

type TestStatus = {
  id: string;
  title?: string;
  status: TestState;
  feedPreviewUrl?: string | null;
  feedPreviewUrls?: Record<string, string>;
  testMode?: TestMode;
  testModeLabel?: string;
  simulatedClickRate: number | null;
  selectedCount?: number | null;
  totalTrials?: number;
  validTrials?: number;
  candidates?: Array<{ key: string; label: string }>;
  variants?: CandidateResult[] | null;
  selectionRateDifference?: number | null;
  candidateCount?: number;
  agentsPerVariant?: number;
  noneSelectedCount?: number | null;
  noneClickRate?: number | null;
  requestCount?: number;
  apiUsage?: { tracked: boolean; requestCount: number; retryCount: number; totalTokens: number; unknownUsageRequests: number; notSentRequests?: number };
  cancelReason?: string | null;
  cancelledAt?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  durationMs?: number | null;
  error?: string;
};

type ReferenceCover = { id: string; label: string; title: string; url: string };
type CandidateView = { key: string; label: string; url: string };

type ValidationResponse = {
  records: ValidationRecord[];
  stats: ValidationStats;
  imported?: number;
  created?: number;
  updated?: number;
  warnings?: string[];
};

type HistoryTest = {
  id: string;
  title: string;
  testMode: TestMode;
  testModeLabel: string;
  createdAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  model: string | null;
  simulatedWinner: "A" | "B" | "tie" | null;
  selectionRates: Array<{ key: string; rate: number }>;
  candidates: Array<{ key: string; label: string; imageUrl: string }>;
  validation: { validationId: string; validationStatus: string; realWinner: "A" | "B" | "tie" | "unknown" | null } | null;
};

type HistoryResponse = { tests: HistoryTest[] };
type PageTab = "test" | "validation";

const LAST_TEST_KEY = "xhs-cover-simulator:last-test-id";
const AGENTS_PER_VARIANT = 100;
const CANDIDATE_COUNT = 2;

export default function HomePage() {
  const [files, setFiles] = useState<Array<File | null>>([null, null]);
  const [title, setTitle] = useState("");
  const [modelProvider, setModelProvider] = useState<ModelProvider>("ollama");
  const [testMode, setTestMode] = useState<TestMode>("grid");
  const [previewUrls, setPreviewUrls] = useState<Array<string | null>>([null, null]);
  const [candidateViews, setCandidateViews] = useState<CandidateView[]>([]);
  const [test, setTest] = useState<TestStatus | null>(null);
  const [references, setReferences] = useState<ReferenceCover[]>([]);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<PageTab>("test");
  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [validationLoading, setValidationLoading] = useState(true);
  const [validationImporting, setValidationImporting] = useState(false);
  const [validationMessage, setValidationMessage] = useState("");
  const [validationError, setValidationError] = useState("");
  const [history, setHistory] = useState<HistoryTest[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [winnerPickerId, setWinnerPickerId] = useState<string | null>(null);
  const [savingWinnerId, setSavingWinnerId] = useState<string | null>(null);
  const [deletingHistoryId, setDeletingHistoryId] = useState<string | null>(null);
  const submissionKey = useRef<string | null>(null);
  const uploadInputRef = useRef<Array<HTMLInputElement | null>>([]);
  const previewUrlsRef = useRef<Array<string | null>>([null, null]);
  const validationInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => {
    previewUrlsRef.current.forEach((url) => { if (url) URL.revokeObjectURL(url); });
  }, []);

  useEffect(() => {
    void Promise.all([loadValidation(), loadHistory()]);
  }, []);

  useEffect(() => {
    const storedTestId = window.localStorage.getItem(LAST_TEST_KEY);
    if (!storedTestId) return;
    const testId = storedTestId;
    let cancelled = false;
    async function restoreLastTest() {
      try {
        const response = await fetch(`/api/tests/${testId}`, { cache: "no-store" });
        if (!response.ok) return;
        const restored = (await response.json()) as TestStatus;
        if (cancelled || !["pending", "running", "cancelling", "cancelled", "completed", "failed"].includes(restored.status)) return;
        setTest(restored);
        setTitle(restored.title ?? "");
        setTestMode(restored.testMode ?? "grid");
        if (restored.status === "failed") setError(restored.error ?? "真实模型测试失败，请重试");
        if (restored.status === "completed") await loadReferences(testId, cancelled);
      } catch {
        // 恢复历史测试失败时仍保留新的上传入口。
      }
    }
    void restoreLastTest();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!test || !["pending", "uploading", "running", "cancelling"].includes(test.status)) return;
    const id = test.id;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(`/api/tests/${id}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("暂时无法读取任务状态，正在重试");
        const next = (await response.json()) as TestStatus;
        if (controller.signal.aborted) return;
        setTest(next);
        setError(next.status === "failed" ? next.error ?? "真实模型测试失败，请重试" : "");
        if (next.status === "completed") { await loadReferences(id, false); await loadHistory(); }
        if (!["pending", "running", "cancelling"].includes(next.status)) return;
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(error instanceof Error ? error.message : "读取任务状态失败");
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1200);
    }
    timer = setTimeout(poll, 1200);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [test?.id, test?.status]);

  async function loadReferences(testId: string, cancelled: boolean) {
    const response = await fetch(`/api/tests/${testId}/references`, { cache: "no-store" });
    if (!response.ok || cancelled) return;
    const data = (await response.json()) as { candidates?: CandidateView[]; references: ReferenceCover[] };
    setCandidateViews(data.candidates ?? []);
    setReferences(data.references);
  }

  async function loadValidation() {
    setValidationLoading(true);
    try {
      const response = await fetch("/api/validation", { cache: "no-store" });
      const data = (await response.json()) as ValidationResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "读取验证记录失败");
      setValidation(data);
      setValidationError("");
    } catch (requestError) {
      setValidationError(requestError instanceof Error ? requestError.message : "读取验证记录失败");
    } finally {
      setValidationLoading(false);
    }
  }

  async function loadHistory() {
    setHistoryLoading(true);
    try {
      const response = await fetch("/api/tests/history", { cache: "no-store" });
      const data = (await response.json()) as HistoryResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "读取历史测试失败");
      setHistory(data.tests ?? []);
      setHistoryError("");
    } catch (requestError) {
      setHistoryError(requestError instanceof Error ? requestError.message : "读取历史测试失败");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function recordRealWinner(historyTest: HistoryTest, realWinner: "A" | "B" | "unknown") {
    setSavingWinnerId(historyTest.id);
    setValidationMessage("");
    setValidationError("");
    try {
      const response = await fetch("/api/validation/result", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-simulator-client": "local" },
        body: JSON.stringify({ simulationTestId: historyTest.id, realWinner })
      });
      const data = (await response.json()) as ValidationResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "保存真实 PK 结果失败");
      setValidation({ records: data.records, stats: data.stats });
      setWinnerPickerId(null);
      setValidationMessage(realWinner === "unknown" ? "已记录为无法判断，该样本不会进入赢家一致率分母。" : "已记录真实 PK 赢家，校准统计已更新。");
      await loadHistory();
    } catch (requestError) {
      setValidationError(requestError instanceof Error ? requestError.message : "保存真实 PK 结果失败");
    } finally {
      setSavingWinnerId(null);
    }
  }

  async function deleteHistoryTest(historyTest: HistoryTest) {
    const confirmed = window.confirm("确定删除这条历史测试记录吗？这会同时删除本地上传封面、结果快照、trial 明细和关联的真实 PK 校准记录，删除后无法恢复。");
    if (!confirmed) return;
    setDeletingHistoryId(historyTest.id);
    setValidationMessage("");
    setValidationError("");
    try {
      const response = await fetch("/api/tests/" + encodeURIComponent(historyTest.id), { method: "DELETE", headers: { "x-simulator-client": "local" } });
      const data = (await response.json()) as { error?: string; cleanupPending?: boolean };
      if (!response.ok) throw new Error(data.error ?? "删除历史测试失败");
      if (test?.id === historyTest.id) resetForNewTest();
      setWinnerPickerId(null);
      setValidationMessage(data.cleanupPending ? "记录已删除，部分文件正被占用，将在刷新列表时重试清理。" : "已删除这条历史测试记录及其本地快照。");
      await Promise.all([loadHistory(), loadValidation()]);
    } catch (requestError) {
      setValidationError(requestError instanceof Error ? requestError.message : "删除历史测试失败");
    } finally {
      setDeletingHistoryId(null);
    }
  }

  async function importValidationFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setValidationImporting(true);
    setValidationMessage("");
    setValidationError("");
    const formData = new FormData();
    formData.append("file", file);
    try {
      const response = await fetch("/api/validation", { method: "POST", headers: { "x-simulator-client": "local" }, body: formData });
      const data = (await response.json()) as ValidationResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "导入验证记录失败");
      setValidation(data);
      void loadHistory();
      setValidationMessage("已导入 " + (data.imported ?? 0) + " 条记录，新增 " + (data.created ?? 0) + " 条，更新 " + (data.updated ?? 0) + " 条" + (data.warnings?.length ? "；部分记录需要复核" : "。"));
    } catch (requestError) {
      setValidationError(requestError instanceof Error ? requestError.message : "导入验证记录失败");
    } finally {
      setValidationImporting(false);
      if (validationInputRef.current) validationInputRef.current.value = "";
    }
  }

  function onFileChange(index: number, event: ChangeEvent<HTMLInputElement>) {
    submissionKey.current = null;
    const nextFile = event.target.files?.[0] ?? null;
    setFiles((current) => {
      const next = [...current];
      next[index] = nextFile;
      return next;
    });
    if (previewUrlsRef.current[index]) URL.revokeObjectURL(previewUrlsRef.current[index]!);
    const nextPreviewUrl = nextFile ? URL.createObjectURL(nextFile) : null;
    previewUrlsRef.current[index] = nextPreviewUrl;
    setPreviewUrls((current) => {
      const next = [...current];
      next[index] = nextPreviewUrl;
      return next;
    });
    setError("");
    setTest(null);
    window.localStorage.removeItem(LAST_TEST_KEY);
    setCandidateViews([]);
    setReferences([]);
  }

  function resetForNewTest() {
    previewUrlsRef.current.forEach((url) => { if (url) URL.revokeObjectURL(url); });
    previewUrlsRef.current = [null, null];
    submissionKey.current = null;
    setFiles([null, null]);
    setTitle("");
    setTestMode("grid");
    setPreviewUrls([null, null]);
    setCandidateViews([]);
    setTest(null);
    setReferences([]);
    setError("");
    setIsSubmitting(false);
    window.localStorage.removeItem(LAST_TEST_KEY);
    uploadInputRef.current.forEach((input) => { if (input) input.value = ""; });
  }

  async function runTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting || test?.status === "running" || test?.status === "cancelling") return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) { setError("请输入笔记标题"); return; }
    if (files.some((file) => !file)) { setError("请先上传 2 张候选封面图"); return; }
    setError("");
    setIsSubmitting(true);
    setTest(null);
    const formData = new FormData();
    files.forEach((file) => formData.append("cover", file!));
    submissionKey.current ??= crypto.randomUUID();
    formData.append("requestKey", submissionKey.current);
    formData.append("title", trimmedTitle);
    formData.append("provider", modelProvider);
    formData.append("testMode", testMode);
    try {
      const response = await fetch("/api/tests", { method: "POST", headers: { "x-simulator-client": "local" }, body: formData });
      const data = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !data.id) throw new Error(data.error ?? "测试创建失败");
      setTest({
        id: data.id,
        title: trimmedTitle,
        status: "running",
        simulatedClickRate: null,
        totalTrials: AGENTS_PER_VARIANT * CANDIDATE_COUNT,
        candidateCount: CANDIDATE_COUNT,
        agentsPerVariant: AGENTS_PER_VARIANT,
        testMode
      });
      window.localStorage.setItem(LAST_TEST_KEY, data.id);
      submissionKey.current = null;
      setIsSubmitting(false);
    } catch (requestError) {
      setIsSubmitting(false);
      window.localStorage.removeItem(LAST_TEST_KEY);
      setTest({ id: "failed", title: trimmedTitle, status: "failed", simulatedClickRate: null });
      setError(requestError instanceof Error ? requestError.message : "测试失败，请重试");
    }
  }

  async function cancelTest() {
    if (!test || !["pending", "running"].includes(test.status)) return;
    setError("");
    setTest({ ...test, status: "cancelling" });
    try {
      const response = await fetch("/api/tests/" + test.id + "/cancel", { method: "POST", headers: { "x-simulator-client": "local" } });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "取消测试失败");
      const statusResponse = await fetch("/api/tests/" + test.id, { cache: "no-store" });
      if (statusResponse.ok) setTest((await statusResponse.json()) as TestStatus);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "取消测试失败");
    }
  }

  const isRunning = isSubmitting || test?.status === "pending" || test?.status === "uploading" || test?.status === "running" || test?.status === "cancelling";
  const isDone = test?.status === "completed";
  const visibleCoverUrls = previewUrls.some(Boolean)
    ? previewUrls
    : candidateViews.map((candidate) => candidate.url);
  const selectedModelLabel = MODEL_OPTIONS.find((option) => option.id === modelProvider)?.label ?? MODEL_OPTIONS[0].label;
  const totalTrials = test?.totalTrials ?? AGENTS_PER_VARIANT * CANDIDATE_COUNT;
  const candidateResults = test?.variants ?? [];
  const winnerKey = determineWinner(candidateResults);
  const winner = candidateResults.find(candidate => candidate.key === winnerKey) ?? null;
  const pendingValidationCount = history.filter((item) => !item.validation?.realWinner).length;

  return (
    <main className="page-shell">
      <section className="hero">
        <p className="eyebrow">XHS COVER SIMULATOR</p>
        <h1>小红书封面<br />AI 对比测试</h1>
        <p className="intro">上传两个候选版本，让同一批 100 个模拟用户在相同信息流条件下比较选择。</p>
      </section>
      <nav className="page-tabs" aria-label="页面功能切换" role="tablist">
        <button className="page-tab" type="button" role="tab" aria-selected={activeTab === "test"} onClick={() => setActiveTab("test")}>开始测试</button>
        <button className="page-tab" type="button" role="tab" aria-selected={activeTab === "validation"} onClick={() => setActiveTab("validation")} disabled={isRunning}>真实 PK 校准{pendingValidationCount > 0 && <span className="page-tab-badge">{pendingValidationCount}</span>}</button>
      </nav>
      {activeTab === "test" && <section className="workspace-card">
        <form onSubmit={runTest}>
          <label className="title-field" htmlFor="post-title">
            <span>笔记标题</span>
            <input id="post-title" type="text" value={title} maxLength={80} placeholder="输入这篇笔记准备发布的标题" onChange={(event) => { setTitle(event.target.value); setError(""); }} disabled={isRunning} required />
          </label>
          <label className="model-field" htmlFor="test-mode">
            <span>测试场景</span>
            <select id="test-mode" value={testMode} onChange={(event) => { setTestMode(event.target.value as TestMode); setError(""); }} disabled={isRunning}>
              <option value="grid">四宫格对比</option>
              <option value="vertical">纵向信息流</option>
            </select>
            <small>{testMode === "vertical" ? "1 张候选封面 + 9 张参考封面，按两列五行排列，模拟双列信息流向下浏览。" : "1 张候选封面 + 3 张参考封面同时出现，作为四宫格对比基线。"}</small>
          </label>
          <p className="reference-library-note">参考图库已接入 100 张模拟封面：根据小红书参考封面逐张通过 imagegen 生成，并非真实发布的封面。每次按权重抽取，两个候选版本共用同一组参考图。</p>
          <label className="model-field" htmlFor="model-provider">
            <span>使用模型</span>
            <select id="model-provider" value={modelProvider} onChange={(event) => { setModelProvider(event.target.value as ModelProvider); setError(""); }} disabled={isRunning}>
              {MODEL_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            {modelProvider === "ollama" && <small>完全在本机运行，无 API 费用。RTX 3060 Ti 8GB 使用单并发；完整双封面对比仍执行 200 次独立判断，预计耗时较长。</small>}
          </label>
          <div className="candidate-upload-grid">
            {files.map((candidateFile, index) => {
              const key = String.fromCharCode(65 + index);
              return <label className="upload-zone" htmlFor={"cover-upload-" + key} key={key}>
                {previewUrls[index] ? <div className="cover-preview-shell"><img className="cover-preview" src={previewUrls[index]!} alt={"候选封面 " + key + " 预览"} />{title.trim() && <span className="cover-title-below">{title.trim()}</span>}</div> : <span className="upload-placeholder"><span className="upload-icon">＋</span><span>上传候选封面 {key}</span><small>支持 JPG、PNG、WEBP，单张不超过 10MB</small></span>}
                <input ref={(element) => { uploadInputRef.current[index] = element; }} id={"cover-upload-" + key} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => onFileChange(index, event)} disabled={isRunning} />
              </label>;
            })}
          </div>
          <button className="primary-button" type="submit" disabled={files.some((file) => !file) || !title.trim() || isRunning}>{isRunning ? "AI 用户正在测试…" : "开始双封面对比"}</button>
        </form>

        {isRunning && <div className="status-message" role="status">{test?.status === "cancelling" ? "正在取消测试，停止后续 API 请求…" : <>正在使用 {selectedModelLabel} 让两个版本各接受 100 次判断，请稍候<span className="loading-dots"><i /> <i /> <i /></span></>}</div>}
        {test && ["pending", "running"].includes(test.status) && <button className="cancel-button" type="button" onClick={cancelTest}>取消测试</button>}
        {test?.status === "cancelled" && <div className="cancelled-message" role="status">测试已取消，已完成的判断已保留，但不会作为完整结果。已发起请求：{test.requestCount ?? 0} 次。</div>}

        {test?.apiUsage?.tracked && <p className="result-meta">模型请求尝试 {test.apiUsage.requestCount} 次（含重试 {test.apiUsage.retryCount} 次） · 已报告 token {test.apiUsage.totalTokens.toLocaleString()}{!!test.apiUsage.notSentRequests && ` · ${test.apiUsage.notSentRequests} 次连接失败，确认未发送`}{test.apiUsage.unknownUsageRequests > 0 && ` · ${test.apiUsage.unknownUsageRequests} 次请求用量未知，未计入 token 合计`}</p>}
        {isDone && candidateResults.length > 0 && <div className="result-block">
          <p className="result-label">同条件下的优先版本</p>
          <p className="result-number">{winner?.label ?? "差异接近"}{winner && <span>{winner.selectionRate}%</span>}</p>
          <p className="result-meta">{candidateResults.map((variant) => variant.label + " " + variant.selectedCount + "/" + variant.totalTrials).join(" · ")} · 每个版本各接受 100 次判断{test.durationMs !== null && test.durationMs !== undefined ? ` · 总耗时 ${formatDuration(test.durationMs)}` : ""}</p>
          <div className="candidate-result-grid">
            {candidateResults.map((variant, index) => {
              const imageUrl = visibleCoverUrls[index] ?? candidateViews.find((candidate) => candidate.key === variant.key)?.url ?? null;
              return <CandidateResultCard key={variant.key} stat={variant} imageUrl={imageUrl} title={test.title ?? title} />;
            })}
          </div>
          {test.feedPreviewUrl && <section className="feed-preview-block" aria-labelledby="feed-preview-title">
            <div className="feed-preview-heading"><div><p className="feed-preview-label" id="feed-preview-title">AI {test.testMode === "vertical" ? "纵向信息流" : "四宫格"}预览</p><p className="feed-preview-description">这是模型实际看到的带标题信息流示例。</p></div><div className="feed-preview-actions"><a href={test.feedPreviewUrl} target="_blank" rel="noreferrer">打开大图</a><a href={test.feedPreviewUrl} download={`ai-feed-preview-${test.id}.jpg`}>保存图片</a></div></div>
            <a className="feed-preview-image-link" href={test.feedPreviewUrl} target="_blank" rel="noreferrer"><img className="feed-preview-image" src={test.feedPreviewUrl} alt={`AI 模拟信息流${test.testMode === "vertical" ? "纵向" : "四宫格"}预览`} /></a>
            {test.feedPreviewUrls?.B && test.feedPreviewUrls.B !== test.feedPreviewUrl && <div className="feed-preview-secondary"><p>封面 B 的同条件预览</p><a className="feed-preview-image-link" href={test.feedPreviewUrls.B} target="_blank" rel="noreferrer"><img className="feed-preview-image" src={test.feedPreviewUrls.B} alt={`候选封面 B 的 AI ${test.testMode === "vertical" ? "纵向信息流" : "四宫格"}预览`} /></a></div>}
            <p className="feed-preview-note">两个版本共用同一组模拟参考封面和位置计划，分别按{test.testMode === "vertical" ? "双列五行纵向信息流" : "四宫格"}场景进行判断。参考图通过 imagegen 生成，并非真实发布的封面。</p>
          </section>}
          <div className="result-explanation">
            <p>选择率表示 100 个模拟用户在当前测试场景中选择该版本的次数。</p>
            <p>{candidateResults.map((variant) => variant.label + " 自然跳过 " + variant.noneSelectedCount + "/" + variant.totalTrials + "（" + variant.noneRate + "%）").join(" · ")}</p>
            <p>该结果用于比较封面版本，不等同于真实发布后的 CTR。</p>
          </div>
          <button className="restart-button" type="button" onClick={resetForNewTest}>重新测试两个新版本</button>
        </div>}
        {(test?.status === "failed" || test?.status === "cancelled") && <button className="restart-button restart-after-error" type="button" onClick={resetForNewTest}>重新测试</button>}
        {error && <p className="error-message" role="alert">{error}</p>}
      </section>}
      {activeTab === "validation" && <section className="validation-card" aria-labelledby="validation-title">
        <div className="validation-heading">
          <div>
            <p className="validation-eyebrow">REAL PK CALIBRATION</p>
            <h2 id="validation-title">真实 PK 校准</h2>
            <p>测试完成后记录会保存在本机。过几天拿到小红书封面 PK 结果，直接在下方找到对应测试并点选真实赢家；CSV / JSON 仅作为批量导入入口。</p>
          </div>
          <div className="validation-actions">
            <label className="validation-upload-button" htmlFor="validation-file">
              {validationImporting ? "正在导入…" : "导入 CSV / JSON"}
              <input ref={validationInputRef} id="validation-file" type="file" accept=".csv,.json,text/csv,application/json" onChange={importValidationFile} disabled={validationImporting} />
            </label>
            <a className="validation-link-button" href="/api/validation?format=csv&template=1" download="xhs-validation-template.csv">下载模板</a>
            <a className="validation-link-button" href="/api/validation?format=csv" download="xhs-validation-records.csv">导出记录</a>
          </div>
        </div>
        <div className="history-section">
          <div className="history-section-heading">
            <div><h3>所有已完成的双封面测试</h3><p>这里会保留已完成的测试。真实 PK 结果可能几天后才知道，所以你可以重新打开网页再录入。</p></div>
            <button className="validation-link-button" type="button" onClick={() => { void loadHistory(); }} disabled={historyLoading}>刷新列表</button>
          </div>
          {historyLoading && <p className="validation-empty">正在读取历史测试…</p>}
          {historyError && <p className="error-message" role="alert">{historyError}</p>}
          {!historyLoading && !historyError && history.length === 0 && <p className="validation-empty">暂时没有已完成的双封面测试。</p>}
          {history.length > 0 && <div className="history-list">{history.map((historyTest) => {
            const realWinner = historyTest.validation?.realWinner;
            const isSaving = savingWinnerId === historyTest.id;
            const isDeleting = deletingHistoryId === historyTest.id;
            const simulatedLabel = historyTest.simulatedWinner === "tie" ? "模拟结果接近" : historyTest.simulatedWinner ? "模拟 " + historyTest.simulatedWinner + " 优先" : "模拟结果待复核";
            return <article className="history-item" key={historyTest.id}>
              <div className="history-item-heading"><div><h4>{historyTest.title || "未命名测试"}</h4><p>{formatHistoryDate(historyTest.completedAt ?? historyTest.createdAt)} · {historyTest.testModeLabel} · {historyTest.model || "GLM-5.3-Flash"}{historyTest.durationMs !== null ? ` · 总耗时 ${formatDuration(historyTest.durationMs)}` : ""}</p><small>测试 ID：{historyTest.id}</small></div><button className="history-delete-button" type="button" onClick={() => { void deleteHistoryTest(historyTest); }} disabled={isDeleting || isSaving}>{isDeleting ? "删除中…" : "删除记录"}</button></div>
              <div className="history-cover-grid">{historyTest.candidates.map((candidate) => <div className="history-cover" key={candidate.key}><img src={candidate.imageUrl} alt={candidate.label} /><div><strong>{candidate.label}</strong><span>模拟选择率 {historyTest.selectionRates.find((item) => item.key === candidate.key)?.rate ?? 0}%</span></div></div>)}</div>
              <div className="history-item-footer"><span className="history-simulated-label">{simulatedLabel}{realWinner && realWinner !== "unknown" && historyTest.simulatedWinner && historyTest.simulatedWinner !== "tie" ? (historyTest.simulatedWinner === realWinner ? " · 一致" : " · 不一致") : ""}</span>{realWinner ? <span className="history-real-label">真实结果：{realWinner === "unknown" ? "无法判断 / PK 无效" : realWinner + " 胜"}</span> : <span className="history-pending-label">待录入真实 PK 结果</span>}<button className="history-record-button" type="button" onClick={() => setWinnerPickerId(winnerPickerId === historyTest.id ? null : historyTest.id)} disabled={isDeleting || isSaving}>{isSaving ? "保存中…" : realWinner ? "修改真实结果" : "记录真实赢家"}</button></div>
              {winnerPickerId === historyTest.id && <div className="history-winner-picker"><span>小红书 PK 最后哪张赢了？</span><button type="button" onClick={() => { void recordRealWinner(historyTest, "A"); }} disabled={isSaving}>A 胜</button><button type="button" onClick={() => { void recordRealWinner(historyTest, "B"); }} disabled={isSaving}>B 胜</button><button type="button" onClick={() => { void recordRealWinner(historyTest, "unknown"); }} disabled={isSaving}>无法判断</button></div>}
            </article>;
          })}</div>}
        </div>
        {validationLoading && <p className="validation-empty">正在读取验证记录…</p>}
        {!validationLoading && validation && <div>
          <div className="validation-metric-grid">
            <div className="validation-metric"><span>有效样本</span><strong>{validation.stats.validCount}</strong><small>总记录 {validation.stats.totalCount}</small></div>
            <div className="validation-metric"><span>赢家一致率</span><strong>{validation.stats.agreementRate === null ? "—" : validation.stats.agreementRate + "%"}</strong><small>{validation.stats.correctCount} 正确 / {validation.stats.validCount} 有效</small></div>
            <div className="validation-metric"><span>需排除</span><strong>{validation.stats.invalidCount + validation.stats.inconclusiveCount + validation.stats.cancelledCount}</strong><small>无效 {validation.stats.invalidCount} · 不确定 {validation.stats.inconclusiveCount} · 取消 {validation.stats.cancelledCount}</small></div>
            <div className="validation-metric validation-metric-wide"><span>样本阶段</span><strong>{validation.stats.sampleGate.label}</strong><small>只在有效样本达到 10 / 30 / 50 / 100 条时进入对应判断。</small></div>
          </div>
          <div className="validation-breakdown-grid">
            <div><h3>按验证类型</h3>{validation.stats.byValidationType.length === 0 ? <p>暂无数据</p> : validation.stats.byValidationType.map((group) => <p key={group.key}>{group.label}：{group.agreementRate === null ? "—" : group.agreementRate + "%"}（{group.validCount}/{group.totalCount} 有效）</p>)}</div>
            <div><h3>按测试模式</h3>{validation.stats.byTestMode.length === 0 ? <p>暂无数据</p> : validation.stats.byTestMode.map((group) => <p key={group.key}>{group.label}：{group.agreementRate === null ? "—" : group.agreementRate + "%"}（{group.validCount}/{group.totalCount} 有效）</p>)}</div>
            <div><h3>按模型</h3>{validation.stats.byModel.length === 0 ? <p>暂无数据</p> : validation.stats.byModel.map((group) => <p key={group.key}>{group.label}：{group.agreementRate === null ? "—" : group.agreementRate + "%"}（{group.validCount}/{group.totalCount} 有效）</p>)}</div>
            <div><h3>不一致样本分类</h3>{validation.stats.errorCategories.length === 0 ? <p>暂无不一致样本</p> : validation.stats.errorCategories.map((category) => <p key={category.key}>{category.label}：{category.count} 条</p>)}</div>
          </div>
          {validation.records.length > 0 && <div className="validation-records">
            <h3>最近导入记录</h3>
            <div className="validation-table-wrap"><table><thead><tr><th>验证 ID</th><th>模拟 / 真实赢家</th><th>状态</th><th>模式</th><th>PK 日期</th></tr></thead><tbody>{validation.records.slice(0, 12).map((record) => <tr key={record.validationId}><td>{record.validationId}<small>{record.simulationTestId}</small></td><td>{record.simulatedWinner ?? "—"} / {record.realWinner ?? "—"}</td><td>{record.validationStatus}</td><td>{record.testMode === "vertical" ? "纵向信息流" : record.testMode === "grid" ? "四宫格" : "—"}</td><td>{record.realPkDate ?? "—"}</td></tr>)}</tbody></table></div>
          </div>}
        </div>}
        {validationMessage && <p className="validation-success" role="status">{validationMessage}</p>}
        {validationError && <p className="error-message" role="alert">{validationError}</p>}
      </section>}
    </main>
  );
}

function formatHistoryDate(value: string | null) {
  if (!value) return "时间未知";
  return value.replace("T", " ").replace("Z", "").slice(0, 16);
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours} 小时` : "", minutes ? `${minutes} 分` : "", `${seconds} 秒`].filter(Boolean).join(" ");
}

function CandidateResultCard({ stat, imageUrl, title }: { stat: CandidateResult; imageUrl: string | null; title: string }) {
  if (!stat) return null;
  return <article className="cover-rate-card">
    {imageUrl ? <div className="cover-rate-image"><img src={imageUrl} alt={stat.label} />{title && <span className="cover-title-below">{title}</span>}</div> : <div className="cover-rate-placeholder">{stat.label}</div>}
    <div className="cover-rate-meta"><p>{stat.label}</p><strong>{stat.selectionRate}%</strong><small>{stat.selectedCount}/{stat.totalTrials} 次选择 · 自然跳过 {stat.noneRate}%</small></div>
  </article>;
}
