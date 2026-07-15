"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientState, ConversationEntry, TurnResult } from "@/lib/types";
import { SPEC_DOCS } from "@/lib/types";

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

  useEffect(() => {
    loadClients();
  }, [loadClients]);

  useEffect(() => {
    if (activeSlug) loadDetail(activeSlug);
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
      await Promise.all([activeSlug ? loadDetail(activeSlug) : null, loadClients()]);
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
    <div className="app">
      {/* 左：客户列表 */}
      <div className="col">
        <div className="col-head">
          <h2>客户</h2>
        </div>
        <div className="col-body">
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <input
              placeholder="新客户名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createClient()}
            />
            <button className="primary" onClick={createClient}>
              +
            </button>
          </div>
          {clients.length === 0 && <div className="empty">还没有客户，先建一个</div>}
          {clients.map((c) => (
            <div
              key={c.slug}
              className={`client-item ${c.slug === activeSlug ? "active" : ""}`}
              onClick={() => setActiveSlug(c.slug)}
            >
              <div className="name">{c.name}</div>
              <div className="meta">
                <span className={`badge ${c.status}`}>{c.status}</span>
                <span>{c.rounds} 轮</span>
                {c.lastReadiness && <span>就绪 {c.lastReadiness.score}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 中：对话 */}
      <div className="col">
        <div className="col-head">
          <h2>{detail ? `对话 · ${detail.state.name}` : "对话"}</h2>
          {toast && <span className={`toast ${toast.err ? "err" : ""}`}>{toast.msg}</span>}
        </div>
        <div className="col-body">
          {!detail && <div className="empty">← 选择或创建一个客户开始</div>}
          {detail?.conversation.map((e, i) => (
            <div key={i} className={`msg ${e.role}`}>
              <div className="who">{e.role === "customer" ? "客户" : "FDE Copilot"}</div>
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
              <div className="who">FDE Copilot</div>
              <div className="bubble">
                <span className="spinner" />
                正在读现状、更新规格、调研缺口…（这一步可能要 1–3 分钟）
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
        {detail && (
          <div className="composer">
            <textarea
              rows={3}
              placeholder="说说你的情况和诉求（v0 支持文字；语音/图片/PDF 输入下一版接入）"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
              }}
            />
            <div className="row">
              <span className="hint">⌘/Ctrl+Enter 发送</span>
              <div style={{ flex: 1 }} />
              <button className="primary" onClick={send} disabled={sending || !input.trim()}>
                {sending ? "生成中…" : "发送"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 右：实时 spec 文档 */}
      <div className="col">
        <div className="col-head">
          <h2>Loop-ready 规格</h2>
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
                就绪度 <b style={{ color: "var(--text)" }}>{readiness.score}/100</b>
                {readiness.loop_ready ? " · ✅ loop-ready" : " · 尚未就绪"}
                {readiness.missing.length > 0 && (
                  <span> · 还缺：{readiness.missing.join("、")}</span>
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
          {!detail && <div className="empty">规格文档会随对话实时生成</div>}
          {detail && <div className="doc">{detail.docs[activeDoc] ?? "（空）"}</div>}
        </div>
      </div>
    </div>
  );
}
