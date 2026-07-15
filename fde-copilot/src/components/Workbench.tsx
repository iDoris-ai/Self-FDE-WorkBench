"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientState, ConversationEntry, TurnResult, Usage } from "@/lib/types";
import { SPEC_DOCS } from "@/lib/types";

const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;
const fmtCost = (u: number) => (u >= 0.01 ? `$${u.toFixed(2)}` : `$${u.toFixed(4)}`);
const fmtSecs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
};

type Lang = "zh" | "en";
const STR = {
  zh: {
    clients: "客户", newClient: "新客户名称", noClients: "还没有客户，先建一个",
    rounds: "轮", ready: "就绪", chat: "对话", pickClient: "← 选择或创建一个客户开始",
    you: "FDE Copilot", customer: "客户",
    composerPh: "说说你的情况和诉求（v0 支持文字；语音/图片/PDF 输入下一版接入）",
    sendHint: "⌘/Ctrl+Enter 发送", send: "发送", sending: "生成中…",
    working: "正在读现状、更新规格、调研缺口…（这一步可能要 1–3 分钟）",
    specs: "Loop-ready 规格", readinessLabel: "就绪度", loopReady: "✅ loop-ready",
    notReady: "尚未就绪", missing: "还缺", specsEmpty: "规格文档会随对话实时生成", empty: "（空）",
    tokens: "tokens", cache: "缓存", computeSecs: "计算秒", roundsRefresh: "轮 · 每 3 分钟刷新",
  },
  en: {
    clients: "Clients", newClient: "New client name", noClients: "No clients yet — create one",
    rounds: "rounds", ready: "ready", chat: "Chat", pickClient: "← Select or create a client to start",
    you: "FDE Copilot", customer: "You",
    composerPh: "Describe your situation and needs (v0: text; voice/image/PDF coming next)",
    sendHint: "⌘/Ctrl+Enter to send", send: "Send", sending: "Generating…",
    working: "Reading state, updating specs, researching gaps… (can take 1–3 min)",
    specs: "Loop-ready specs", readinessLabel: "Readiness", loopReady: "✅ loop-ready",
    notReady: "not ready yet", missing: "missing", specsEmpty: "Spec docs generate as you talk", empty: "(empty)",
    tokens: "tokens", cache: "cache", computeSecs: "compute-s", roundsRefresh: "turns · refresh every 3 min",
  },
} as const;

interface ClientDetail {
  state: ClientState;
  docs: Record<string, string>;
  conversation: ConversationEntry[];
}

export default function Workbench() {
  const [clients, setClients] = useState<ClientState[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [newName, setNewName] = useState("");
  const [activeDoc, setActiveDoc] = useState<string>("SPEC.md");
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [lang, setLang] = useState<Lang>("zh");
  const t = STR[lang];
  const chatEndRef = useRef<HTMLDivElement>(null);

  const flash = (msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 4000);
  };

  const loadClients = useCallback(async () => {
    const r = await fetch("/api/clients");
    const j = await r.json();
    setClients(j.clients ?? []);
  }, []);

  const loadDetail = useCallback(async (slug: string) => {
    const r = await fetch(`/api/clients/${slug}`);
    if (!r.ok) return;
    const j = (await r.json()) as ClientDetail;
    setDetail(j);
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const r = await fetch("/api/usage");
      if (!r.ok) return;
      const j = await r.json();
      setUsage(j.global as Usage);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadClients();
    loadUsage();
    // 每 3 分钟刷新一次用量（不必实时）
    const t = setInterval(loadUsage, 180_000);
    return () => clearInterval(t);
  }, [loadClients, loadUsage]);

  // 刷新后恢复上次选中的客户（对话历史从服务端 conversation.jsonl 重新加载）+ 语言偏好
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("fde:activeSlug");
    if (saved) setActiveSlug(saved);
    const savedLang = localStorage.getItem("fde:lang");
    if (savedLang === "en" || savedLang === "zh") setLang(savedLang);
  }, []);

  const toggleLang = () => {
    const next: Lang = lang === "zh" ? "en" : "zh";
    setLang(next);
    if (typeof window !== "undefined") localStorage.setItem("fde:lang", next);
  };

  useEffect(() => {
    if (activeSlug) {
      loadDetail(activeSlug);
      if (typeof window !== "undefined") localStorage.setItem("fde:activeSlug", activeSlug);
    }
  }, [activeSlug, loadDetail]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.conversation.length, sending]);

  const createClient = async () => {
    if (!newName.trim()) return;
    const r = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    });
    const j = await r.json();
    if (!r.ok) return flash(j.error ?? "创建失败", true);
    setNewName("");
    await loadClients();
    setActiveSlug(j.client.slug);
  };

  const send = async () => {
    if (!activeSlug || !input.trim() || sending) return;
    const text = input.trim();
    setInput("");
    setSending(true);

    // 乐观插入客户气泡
    setDetail((d) =>
      d
        ? {
            ...d,
            conversation: [
              ...d.conversation,
              { role: "customer", at: new Date().toISOString(), text },
            ],
          }
        : d,
    );

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: activeSlug, input: text }),
      });
      const j = await r.json();
      if (!r.ok) {
        flash(j.error ?? "发送失败", true);
      } else {
        const res = j.result as TurnResult;
        if (j.usedFallback) flash("Copilot 未返回结构化结果，已用兜底文本", true);
        if (j.commit?.committed) flash(`已提交：${j.commit.detail}`);
        if (res.readiness.loop_ready) flash("🎉 规格已达 loop-ready！");
      }
    } catch (e) {
      flash(`网络错误：${(e as Error).message}`, true);
    } finally {
      setSending(false);
      await Promise.all([activeSlug ? loadDetail(activeSlug) : null, loadClients(), loadUsage()]);
    }
  };

  const commit = async (push: boolean) => {
    if (!activeSlug) return;
    const r = await fetch("/api/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: activeSlug, push }),
    });
    const j = await r.json();
    if (!r.ok) return flash(j.error ?? "提交失败", true);
    flash(j.detail ?? "已提交");
  };

  const readiness = detail?.state.lastReadiness;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">FDE Copilot</div>
        <div className="stats">
          <span className="stat" title="token">
            🔢 <b>{usage ? fmtTokens(usage.inputTokens + usage.outputTokens) : "—"}</b> {t.tokens}
            {usage && usage.cacheReadTokens > 0 && (
              <em className="dim"> ({fmtTokens(usage.cacheReadTokens)} {t.cache})</em>
            )}
          </span>
          <span className="stat" title="wall-clock model/agent time (machine/energy proxy)">
            ⚙️ <b>{usage ? fmtSecs(usage.computeMs) : "—"}</b> {t.computeSecs}
          </span>
          <span className="stat" title="est. cost = Claude SDK equivalent-API cost">
            💰 <b>{usage ? fmtCost(usage.costUsd) : "—"}</b>
          </span>
          <span className="stat dim">
            {usage ? usage.turns : 0} {t.roundsRefresh}
          </span>
          <button className="ghost" onClick={toggleLang} title="language">
            {lang === "zh" ? "EN" : "中"}
          </button>
        </div>
      </header>
      <div className="app">
        {/* 左：客户列表 */}
      <div className="col">
        <div className="col-head">
          <h2>{t.clients}</h2>
        </div>
        <div className="col-body">
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <input
              placeholder={t.newClient}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createClient()}
            />
            <button className="primary" onClick={createClient}>
              +
            </button>
          </div>
          {clients.length === 0 && <div className="empty">{t.noClients}</div>}
          {clients.map((c) => (
            <div
              key={c.slug}
              className={`client-item ${c.slug === activeSlug ? "active" : ""}`}
              onClick={() => setActiveSlug(c.slug)}
            >
              <div className="name">{c.name}</div>
              <div className="meta">
                <span className={`badge ${c.status}`}>{c.status}</span>
                <span>{c.rounds} {t.rounds}</span>
                {c.lastReadiness && <span>{t.ready} {c.lastReadiness.score}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 中：对话 */}
      <div className="col">
        <div className="col-head">
          <h2>{detail ? `${t.chat} · ${detail.state.name}` : t.chat}</h2>
          {toast && <span className={`toast ${toast.err ? "err" : ""}`}>{toast.msg}</span>}
        </div>
        <div className="col-body">
          {!detail && <div className="empty">{t.pickClient}</div>}
          {detail?.conversation.map((e, i) => (
            <div key={i} className={`msg ${e.role}`}>
              <div className="who">{e.role === "customer" ? t.customer : t.you}</div>
              <div className="bubble">{e.text}</div>
              {e.result && e.result.open_questions.length > 0 && (
                <div className="questions">
                  {e.result.open_questions.map((q) => (
                    <div className="q" key={q.id}>
                      <div>❓ {q.question}</div>
                      <div className="why">{q.why}</div>
                    </div>
                  ))}
                </div>
              )}
              {e.result && (
                <div className="readiness-bar">
                  <span style={{ width: `${e.result.readiness.score}%` }} />
                </div>
              )}
            </div>
          ))}
          {sending && (
            <div className="msg copilot">
              <div className="who">{t.you}</div>
              <div className="bubble">
                <span className="spinner" />
                {t.working}
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
        {detail && (
          <div className="composer">
            <textarea
              rows={3}
              placeholder={t.composerPh}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
              }}
            />
            <div className="row">
              <span className="hint">{t.sendHint}</span>
              <div style={{ flex: 1 }} />
              <button className="primary" onClick={send} disabled={sending || !input.trim()}>
                {sending ? t.sending : t.send}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 右：实时 spec 文档 */}
      <div className="col">
        <div className="col-head">
          <h2>{t.specs}</h2>
          {detail && (
            <div style={{ display: "flex", gap: 6 }}>
              <button className="ghost" onClick={() => commit(false)}>
                commit
              </button>
              <button className="ghost" onClick={() => commit(true)}>
                commit+push
              </button>
            </div>
          )}
        </div>
        {detail && (
          <div style={{ padding: "10px 12px 0" }}>
            {readiness && (
              <div className="hint" style={{ marginBottom: 8 }}>
                {t.readinessLabel} <b style={{ color: "var(--text)" }}>{readiness.score}/100</b>
                {readiness.loop_ready ? ` · ${t.loopReady}` : ` · ${t.notReady}`}
                {readiness.missing.length > 0 && (
                  <span> · {t.missing}：{readiness.missing.join("、")}</span>
                )}
              </div>
            )}
            <div className="tabs">
              {SPEC_DOCS.map((doc) => (
                <div
                  key={doc}
                  className={`tab ${doc === activeDoc ? "active" : ""}`}
                  onClick={() => setActiveDoc(doc)}
                >
                  {doc.replace(".md", "")}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="col-body">
          {!detail && <div className="empty">{t.specsEmpty}</div>}
          {detail && <div className="doc">{detail.docs[activeDoc] ?? t.empty}</div>}
        </div>
      </div>
      </div>
    </div>
  );
}
