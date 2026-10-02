"use client";
import { useEffect, useRef, useState } from "react";
import { MODEL_OPTIONS, type ModelProvider } from "@/lib/model-options";
import type { ModelSettingsResponse, PublicModelSettings } from "@/lib/model-settings";
import type { OllamaModel } from "@/lib/ollama";

const headers = { "Content-Type": "application/json", "x-simulator-client": "local" };
export default function ModelSettingsDialog({ initialProvider, onClose, onSaved }: {
  initialProvider: ModelProvider; onClose: () => void; onSaved: (settings: ModelSettingsResponse) => void;
}) {
  const [provider, setProvider] = useState(initialProvider);
  const [settings, setSettings] = useState<ModelSettingsResponse | null>(null);
  const [key, setKey] = useState(""); const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState<OllamaModel[]>([]); const [downloadName, setDownloadName] = useState("qwen3.5:4b");
  const [busy, setBusy] = useState(""); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const dialog = useRef<HTMLDivElement>(null); const downloadController = useRef<AbortController | null>(null);
  const field = settings?.providers[provider];
  useEffect(() => {
    let disposed = false;
    const previous = document.activeElement as HTMLElement | null; const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    dialog.current?.focus();
    fetch("/api/settings", { cache: "no-store" }).then(async response => { if (!response.ok) throw Error("无法读取设置"); return response.json(); }).then(data => { if (!disposed) setSettings(data); }).catch(() => { if (!disposed) setError("读取设置失败，请关闭后重试"); });
    return () => { disposed = true; downloadController.current?.abort(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  function edit(patch: Partial<PublicModelSettings>) {
    setSettings(current => current ? { providers: { ...current.providers, [provider]: { ...current.providers[provider], ...patch } } } : current);
    setError(""); setMessage("");
  }
  function payload() { return { provider, ...field, ...(clearKey ? { apiKey: "" } : key ? { apiKey: key } : {}) }; }
  async function request(url: string, body?: unknown, method = "POST") {
    const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: "no-store" });
    const data = await response.json(); if (!response.ok) throw Error(data.error ?? "操作失败，请重试"); return data;
  }
  async function action(name: string, work: () => Promise<void>) {
    setBusy(name); setError(""); setMessage("");
    try { await work(); } catch (error) { setError(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(""); }
  }
  async function refreshModels() {
    const data = await request(`/api/ollama?baseUrl=${encodeURIComponent(settings!.providers.ollama.baseUrl)}`, undefined, "GET");
    setModels(data.models); setMessage(`Ollama 已连接，找到 ${data.models.filter((m: OllamaModel) => m.vision && m.local).length} 个可用的本地图片模型。`); return data;
  }
  async function downloadModel() {
    await action("download", async () => {
      const controller = new AbortController(); downloadController.current = controller; setProgress(null);
      const response = await fetch("/api/ollama/pull", { method: "POST", headers, body: JSON.stringify({ baseUrl: field!.baseUrl, model: downloadName.trim() }), signal: controller.signal });
      if (!response.ok) { const data = await response.json(); throw Error(data.error ?? "下载无法开始"); }
      if (!response.body) throw Error("未收到下载进度");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ""; let success = false;
      function receive(line: string) {
        if (!line.trim()) return; const item = JSON.parse(line);
        if (item.error) throw Error(String(item.error));
        setMessage(item.status === "success" ? "下载完成，正在检查图片能力…" : String(item.status ?? "下载中…"));
        setProgress(item.total ? Math.min(100, Math.round((item.completed ?? 0) / item.total * 100)) : null);
        if (item.status === "success") success = true;
      }
      try {
        for (;;) { const next = await reader.read(); if (next.done) break; pending += decoder.decode(next.value, { stream: true }); const lines = pending.split("\n"); pending = lines.pop() ?? ""; lines.forEach(receive); }
        pending += decoder.decode(); receive(pending);
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); downloadController.current = null; }
      if (!success) throw Error("下载未完成，可以重新点击继续下载");
      const info = await refreshModels();
      const model = info.models.find((m: OllamaModel) => m.name === downloadName.trim() || m.name === `${downloadName.trim()}:latest`);
      if (model?.vision && model.local) { edit({ model: model.name }); setMessage(`已下载 ${model.name}，支持图片识别。点击“保存设置”即可使用。`); }
      else setError("下载完成，但这个模型不支持本地图片识别，请选择其他视觉模型");
    });
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={dialog} tabIndex={-1} onKeyDown={event => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key === "Tab") { const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary'); if (!focusable?.length) return; const first = focusable[0]; const last = focusable[focusable.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
    }}>
      <div className="panel-heading"><div><h2 id="settings-title">模型设置</h2><p>填好并保存后，就可以在首页开始测试。</p></div><button className="icon-button" onClick={onClose} disabled={!!busy} aria-label="关闭设置">×</button></div>
      {!settings && !error && <p role="status">正在读取本机设置…</p>}
      {field && <>
        <label className="model-field">模型服务<select value={provider} disabled={!!busy} onChange={event => { setProvider(event.target.value as ModelProvider); setKey(""); setClearKey(false); setMessage(""); setError(""); }}>{MODEL_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.id === "ollama" ? "Ollama · 本机模型" : option.label}</option>)}</select></label>
        <label className="title-field">{provider === "ollama" ? "Ollama 地址" : "API 基础地址"}<input value={field.baseUrl} disabled={!!busy} onChange={event => edit({ baseUrl: event.target.value })} autoComplete="off" spellCheck={false} /></label>
        {provider !== "ollama" && <label className="title-field">API Key<input type="password" value={key} onChange={event => { setKey(event.target.value); setClearKey(false); setMessage(""); }} disabled={!!busy} placeholder={clearKey ? "保存后将清除已有 Key" : field.apiKeyConfigured ? "已配置；留空沿用，填写可替换" : "粘贴服务商提供的 API Key"} autoComplete="off" spellCheck={false} /><small>保存在这台电脑的服务端，页面不回显。{(provider === "zhipu" || provider === "glm-4.6v") && "两个智谱入口共用 Key。"}</small>{field.apiKeyConfigured && <button type="button" className="text-button" onClick={() => { setClearKey(!clearKey); setKey(""); }} disabled={!!busy}>{clearKey ? "撤销清除" : "清除已保存的 Key"}</button>}</label>}
        <label className="title-field">模型名称<input value={field.model} onChange={event => edit({ model: event.target.value })} disabled={!!busy} spellCheck={false} autoComplete="off" /></label>
        {provider === "ollama" && <section className="local-model-help">
          <h3>接入本地模型</h3><ol><li>首次使用：<a href="https://ollama.com/download/windows" target="_blank" rel="noreferrer">下载安装 Ollama</a>。</li><li>启动 Ollama，刷新列表，选择支持图片的本地模型。</li><li>没有合适的模型，可以在下面下载；完成后保存设置。</li></ol>
          <div className="button-row"><button className="secondary-button" disabled={!!busy} onClick={() => void action("start", async () => { await request("/api/ollama/start", { baseUrl: field.baseUrl }); await refreshModels(); })}>{busy === "start" ? "启动中…" : "启动 Ollama"}</button><button className="secondary-button" disabled={!!busy} onClick={() => void action("refresh", refreshModels)}>{busy === "refresh" ? "检测中…" : "刷新已安装模型"}</button></div>
          {models.length > 0 && <label className="model-field">已安装模型<select value={models.some(m => m.name === field.model) ? field.model : ""} disabled={!!busy} onChange={event => edit({ model: event.target.value })}><option value="" disabled>选择本地图片模型</option>{models.map(model => <option key={model.name} value={model.name} disabled={!model.vision || !model.local}>{model.name} · {model.message}{model.size ? ` · ${(model.size / 1024 ** 3).toFixed(1)}GB` : ""}</option>)}</select></label>}
          <label className="title-field">下载模型名称<input value={downloadName} onChange={event => setDownloadName(event.target.value)} placeholder="例如 qwen3.5:4b" disabled={!!busy} autoComplete="off" /><small>支持其他本地视觉模型。更大的模型需要更多内存和更长时间。</small></label>
          <div className="button-row"><button className="secondary-button" disabled={!!busy || !downloadName.trim()} onClick={() => void downloadModel()}>下载模型</button>{busy === "download" && <button className="secondary-button" onClick={() => { downloadController.current?.abort(); setMessage("已停止下载，下次可继续"); }}>停止下载</button>}<a href="https://ollama.com/search?c=vision" target="_blank" rel="noreferrer">查看视觉模型</a></div>
          {busy === "download" && <div role="status"><p className="help-text">{message}{progress !== null ? ` · ${progress}%` : ""}</p>{progress !== null && <progress value={progress} max={100} />}</div>}
        </section>}
        <details className="advanced-settings"><summary>高级设置</summary><div className="settings-number-grid"><label>单次超时（秒）<input type="number" min={30} max={600} value={field.timeoutSeconds} disabled={!!busy} onChange={event => edit({ timeoutSeconds: Number(event.target.value) })} /></label><label>输出 token 上限<input type="number" min={128} max={32768} value={field.maxTokens} disabled={!!busy} onChange={event => edit({ maxTokens: Number(event.target.value) })} /></label>{provider === "ollama" && <label>上下文长度<input type="number" min={4096} max={65536} value={field.contextLength} disabled={!!busy} onChange={event => edit({ contextLength: Number(event.target.value) })} /></label>}</div><p className="help-text">默认参数适合封面测试；大模型较慢时可以增加超时。智谱思考模型建议保留较高的输出上限。</p></details>
        <p className="help-text">“检测图片连接”会发送一张小测试图。云服务可能计费 1 次请求；保存设置本身不调用模型。</p>
        <div className="settings-footer"><button className="secondary-button" disabled={!!busy} onClick={() => void action("check", async () => { const data = await request("/api/settings/check", payload()); setMessage(`${data.model}：${data.message}（${(data.elapsedMs / 1000).toFixed(1)} 秒）。当前填写的设置可用。`); })}>{busy === "check" ? "检测中…" : "检测图片连接"}</button><button className="primary-button" disabled={!!busy} onClick={() => void action("save", async () => { const data = await request("/api/settings", payload(), "PATCH"); setSettings(data); setKey(""); setClearKey(false); onSaved(data); setMessage("已保存在本机，后续测试将使用这套配置。"); })}>{busy === "save" ? "保存中…" : "保存设置"}</button></div>
      </>}
      {message && busy !== "download" && <p className="validation-success" role="status">{message}</p>}{error && <p className="error-message" role="alert">{error}</p>}
    </div>
  </div>;
}
