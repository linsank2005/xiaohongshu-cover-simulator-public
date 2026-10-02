"use client";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { RecordView, RecordSource } from "@/lib/records";
import { formatLocalDate } from "@/lib/display-date";
const statusNames = { pending: "等待开始", running: "进行中", cancelling: "正在取消", completed: "已完成", failed: "失败", cancelled: "已取消" };
const headers = { "Content-Type": "application/json", "x-simulator-client": "local" };
type RecordsResponse = { records: RecordView[]; total: number; page: number; pages: number };
export default function RecordsPanel({ onOpen, onValidation, running }: { onOpen: (id: string) => void; onValidation: () => void; running: boolean }) {
  const [data, setData] = useState<RecordsResponse | null>(null); const [source, setSource] = useState<RecordSource>("local");
  const [query, setQuery] = useState(""); const [status, setStatus] = useState(""); const [page, setPage] = useState(1); const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<string[]>([]); const [editing, setEditing] = useState<string | null>(null); const [notes, setNotes] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    const timer = setTimeout(async () => {
      try { const response = await fetch(`/api/records?${new URLSearchParams({ source, q: query, status, page: String(page) })}`, { cache: "no-store", signal: controller.signal }); const result = await response.json(); if (!response.ok) throw Error(result.error ?? "记录读取失败"); setData(result); setError(""); }
      catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "记录读取失败"); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [source, query, status, page, reload]);
  function filterChange() { setPage(1); setSelected([]); setEditing(null); }
  async function action(name: string, work: () => Promise<void>) {
    setBusy(name); setError(""); setMessage(""); try { await work(); } catch (error) { setError(error instanceof Error ? error.message : "操作失败"); } finally { setBusy(""); }
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    await action("import", async () => {
      const form = new FormData(); form.append("file", file);
      const response = await fetch("/api/records/import", { method: "POST", headers: { "x-simulator-client": "local" }, body: form }); const result = await response.json();
      if (!response.ok) throw Error(result.error ?? "导入失败");
      setMessage(`导入完成：新增 ${result.created} 条，更新 ${result.updated} 条${result.skipped ? `，跳过本机已有 ${result.skipped} 条` : ""}。`);
      setSource("imported"); filterChange(); setReload(value => value + 1);
    });
    if (importInput.current) importInput.current.value = "";
  }
  async function exportFile(includeCovers: boolean) {
    await action("export", async () => {
      const params = new URLSearchParams({ source, q: query, status, includeCovers: includeCovers ? "1" : "0" }); selected.forEach(id => params.append("id", id));
      const response = await fetch(`/api/records/export?${params}`, { cache: "no-store" });
      if (!response.ok) { const result = await response.json(); throw Error(result.error ?? "导出失败"); }
      const count = Number(response.headers.get("X-Record-Count")); if (!count) throw Error("当前范围没有可以导出的记录");
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = `xhs-records-${new Date().toISOString().slice(0, 10)}.${includeCovers ? "zip" : "json"}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const missing = Number(response.headers.get("X-Missing-Covers"));
      setMessage(`已导出 ${count} 条记录${includeCovers ? "及可用封面" : "（不含图片）"}${missing ? `；${missing} 张封面文件不存在，结果仍已导出` : ""}。你可以自行把这个文件发给收集者。`);
    });
  }
  return <section className="records-panel workspace-card" aria-labelledby="records-title">
    <div className="panel-heading"><div><h2 id="records-title">我的记录</h2><p>自动保存在这台电脑，关闭页面也会保留。备注和结果可导出成文件，由你决定是否分享。</p></div><button className="secondary-button" onClick={() => setReload(value => value + 1)} disabled={loading}>刷新</button></div>
    <div className="record-toolbar"><label>来源<select value={source} onChange={event => { setSource(event.target.value as RecordSource); filterChange(); }}><option value="local">本机测试</option><option value="imported">导入的记录</option><option value="all">全部记录</option></select></label><label>状态<select value={status} onChange={event => { setStatus(event.target.value); filterChange(); }}><option value="">全部状态</option>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="record-search">搜索<input value={query} maxLength={200} placeholder="标题、模型或备注" onChange={event => { setQuery(event.target.value); filterChange(); }} /></label></div>
    <div className="button-row record-export-row"><button className="secondary-button" onClick={() => void exportFile(false)} disabled={!!busy || loading}>导出 JSON</button><button className="secondary-button" onClick={() => void exportFile(true)} disabled={!!busy || loading}>导出封面 ZIP</button><label className="validation-upload-button">{busy === "import" ? "正在导入…" : "导入记录文件"}<input ref={importInput} type="file" accept=".json,.zip,application/json,application/zip" onChange={event => void importFile(event)} disabled={!!busy} /></label></div>
    <p className="help-text">{selected.length ? `导出已选的 ${selected.length} 条；` : "未勾选时导出当前筛选范围；"}JSON 包含结果与备注，ZIP 另含 A、B 封面。导入文件只在本机汇总。</p>
    {loading && <p className="validation-empty" role="status">正在读取记录…</p>}
    {!loading && data && <>
      <div className="record-count"><label><input type="checkbox" checked={!!data.records.length && data.records.every(record => selected.includes(record.id))} onChange={event => setSelected(event.target.checked ? [...new Set([...selected, ...data.records.map(r => r.id)])] : selected.filter(id => !data.records.some(r => r.id === id)))} />选择本页</label><span>共 {data.total} 条{selected.length ? ` · 已选 ${selected.length} 条` : ""}</span></div>
      {!data.records.length && <div className="records-empty"><h3>{source === "imported" ? "还没有导入的记录" : "还没有测试记录"}</h3><p>{source === "imported" ? "拿到他人主动分享的 JSON 或 ZIP 后，点击“导入记录文件”。" : "完成一次测试后会自动出现在这里；也可以调整搜索条件。"}</p></div>}
      <div className="history-list">{data.records.map(record => <article className="history-item record-item" key={record.id}>
        <div className="history-item-heading"><label className="record-checkbox"><input type="checkbox" checked={selected.includes(record.id)} onChange={event => setSelected(event.target.checked ? [...selected, record.id] : selected.filter(id => id !== record.id))} aria-label={`选择记录 ${record.title}`} /></label><div className="record-heading-main"><h3>{record.title || "未命名测试"}</h3><p>{formatLocalDate(record.createdAt)} · {record.testMode === "vertical" ? "纵向信息流" : "四宫格"} · {record.model ?? "模型未开始"}</p></div><span className={`status-pill status-${record.status}`}>{statusNames[record.status]}</span></div>
        <div className="history-cover-grid">{record.candidates.map(candidate => { const stat = record.variants.find(v => v.key === candidate.key); return <div className="history-cover" key={candidate.key}>{record.imageUrls[candidate.key] ? <img src={record.imageUrls[candidate.key]} alt={candidate.label} loading="lazy" /> : <span className="record-image-missing">无图片</span>}<div><strong>{candidate.label}</strong><span>{record.status === "completed" ? `模拟选择率 ${stat?.selectionRate ?? 0}%` : `已记录 ${stat?.totalTrials ?? 0}/100 次判断`}</span></div></div>; })}</div>
        {record.realResult && <p className="help-text">已记录真实结果：{record.realResult.winner === "unknown" ? "无法判断" : record.realResult.winner === "tie" ? "持平" : `${record.realResult.winner} 胜`}</p>}
        {record.notes && editing !== record.id && <p className="record-notes">{record.notes}</p>}
        {editing === record.id && <div className="notes-editor"><label>备注<textarea value={notes} maxLength={4000} onChange={event => setNotes(event.target.value)} placeholder="例如：发布计划、后续反馈或观察" rows={3} /></label><div className="button-row"><button className="secondary-button" disabled={!!busy} onClick={() => void action("notes", async () => { const response = await fetch(`/api/records/${encodeURIComponent(record.id)}`, { method: "PATCH", headers, body: JSON.stringify({ notes }) }); const result = await response.json(); if (!response.ok) throw Error(result.error ?? "备注保存失败"); setEditing(null); setReload(value => value + 1); setMessage("备注已保存在本机。"); })}>保存备注</button><button className="text-button" onClick={() => setEditing(null)}>取消</button></div></div>}
        <div className="record-item-actions">{record.source === "local" && <button className="text-button" disabled={running || !!busy} onClick={() => onOpen(record.testId)}>查看测试</button>}<button className="text-button" disabled={!!busy} onClick={() => { setEditing(record.id); setNotes(record.notes); }}>{record.notes ? "编辑备注" : "添加备注"}</button><span>{record.source === "imported" ? "来自文件导入" : `模型请求 ${record.apiUsage.requestCount} 次`}</span><button className="history-delete-button" disabled={!!busy || (record.source === "local" && ["pending", "running", "cancelling"].includes(record.status))} onClick={() => { if (!window.confirm(`删除“${record.title}”及对应的本机封面文件？`)) return; void action("delete", async () => { const response = await fetch(`/api/records/${encodeURIComponent(record.id)}`, { method: "DELETE", headers }); const result = await response.json(); if (!response.ok) throw Error(result.error ?? "删除失败"); setSelected(ids => ids.filter(id => id !== record.id)); setReload(value => value + 1); setMessage(result.cleanupPending ? "记录已删除；个别被占用的文件将在后续重试清理。" : "记录已删除。"); }); }}>删除</button></div>
      </article>)}</div>
      {data.pages > 1 && <div className="record-pagination"><button className="secondary-button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {data.page}/{data.pages} 页</span><button className="secondary-button" disabled={page >= data.pages || loading} onClick={() => setPage(value => value + 1)}>下一页</button></div>}
    </>}
    {message && <p className="validation-success" role="status">{message}</p>}{error && <p className="error-message" role="alert">{error}</p>}
    <details className="optional-calibration"><summary>已经有真实 PK 结果？（可选）</summary><p className="help-text">可以补充真实赢家，现有的校准工具仍可使用。日常保存与导出记录不需要填写真实结果。</p><button className="secondary-button" disabled={running} onClick={onValidation}>打开真实 PK 记录工具</button></details>
  </section>;
}
