"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Client, ConversationEntry, ProjectState, TurnResult, Usage, DeliverableType,
} from "@/lib/types";
import { SPEC_DOCS, DELIVERABLE_TYPES } from "@/lib/types";

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
    clients: "客户", newClient: "＋ 新客户", clientName: "客户名称", background: "客户背景 / 自我介绍",
    bgPh: "简单介绍这个客户：是谁、做什么、目标受众、风格偏好…（会被该客户下所有项目共享）",
    create: "创建", cancel: "取消", noClients: "还没有客户，先建一个",
    newProject: "＋ 新项目", projectName: "项目名称", deliverable: "交付物", deliverableName: "交付物命名",
    dlvPh: "如：我的视频简历 / 产品发布 PPT", noProjects: "该客户下还没有项目",
    pick: "← 选择或新建一个项目开始", you: "FDE Copilot", customer: "客户",
    composerPh: "说说你的情况和诉求（v0 文字；语音/图片/PDF 下一版）", sendHint: "⌘/Ctrl+Enter 发送",
    send: "发送", sending: "生成中…", working: "正在读现状、更新规格、调研缺口…（1–3 分钟）",
    specs: "规格", readinessLabel: "就绪度", loopReady: "✅ loop-ready", notReady: "尚未就绪",
    missing: "还缺", specsEmpty: "规格文档会随对话实时生成", empty: "（空）",
    tokens: "tokens", cache: "缓存", computeSecs: "计算秒", roundsRefresh: "轮 · 每 3 分钟刷新",
    theWorkbench: "生成「{x}」的 workbench", collapse: "折叠", rounds: "轮", ready: "就绪",
  },
  en: {
    clients: "Clients", newClient: "＋ New client", clientName: "Client name", background: "Client background / intro",
    bgPh: "Briefly introduce this client: who, what, audience, style… (shared by all their projects)",
    create: "Create", cancel: "Cancel", noClients: "No clients yet — create one",
    newProject: "＋ New project", projectName: "Project name", deliverable: "Deliverable", deliverableName: "Deliverable name",
    dlvPh: "e.g. My video resume / Launch PPT", noProjects: "No projects for this client yet",
    pick: "← Select or create a project to start", you: "FDE Copilot", customer: "You",
    composerPh: "Describe your situation and needs (v0: text)", sendHint: "⌘/Ctrl+Enter to send",
    send: "Send", sending: "Generating…", working: "Reading state, updating specs, researching gaps… (1–3 min)",
    specs: "Specs", readinessLabel: "Readiness", loopReady: "✅ loop-ready", notReady: "not ready yet",
    missing: "missing", specsEmpty: "Spec docs generate as you talk", empty: "(empty)",
    tokens: "tokens", cache: "cache", computeSecs: "compute-s", roundsRefresh: "turns · refresh 3 min",
    theWorkbench: "Workbench that generates “{x}”", collapse: "Collapse", rounds: "rounds", ready: "ready",
  },
} as const;

interface ProjectDetail {
  client: Client;
  state: ProjectState;
  docs: Record<string, string>;
  conversation: ConversationEntry[];
}

export default function Workbench() {
  const [clients, setClients] = useState<Client[]>([]);
  const [projectsByClient, setProjectsByClient] = useState<Record<string, ProjectState[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeClient, setActiveClient] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [activeDoc, setActiveDoc] = useState<string>("SPEC.md");
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [lang, setLang] = useState<Lang>("zh");
  const [sidebar, setSidebar] = useState(true);
  const [newClient, setNewClient] = useState<{ name: string; background: string } | null>(null);
  const [newProject, setNewProject] = useState<{ client: string; name: string; dlvName: string; dlvType: DeliverableType } | null>(null);
  const t = STR[lang];
  const chatEndRef = useRef<HTMLDivElement>(null);
  // 工作台切换条 URL（部署时用 NEXT_PUBLIC_WB_*_URL 覆盖为你的域名）
  const WB = {
    fde: process.env.NEXT_PUBLIC_WB_FDE_URL || "http://localhost:3939",
    loop: process.env.NEXT_PUBLIC_WB_LOOP_URL || "http://localhost:4040",
    packs: process.env.NEXT_PUBLIC_WB_PACKS_URL || "http://localhost:4141",
    site: process.env.NEXT_PUBLIC_WB_SITE_URL || "http://localhost:8080",
  };

  const flash = (msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 4000);
  };

  const loadClients = useCallback(async () => {
    const r = await fetch("/api/clients");
    const j = await r.json();
    setClients(j.clients ?? []);
  }, []);

  const loadProjects = useCallback(async (clientSlug: string) => {
    const r = await fetch(`/api/clients/${clientSlug}/projects`);
    if (!r.ok) return;
    const j = await r.json();
    setProjectsByClient((m) => ({ ...m, [clientSlug]: j.projects ?? [] }));
  }, []);

  const loadDetail = useCallback(async (c: string, p: string) => {
    const r = await fetch(`/api/clients/${c}/projects/${p}`);
    if (!r.ok) return;
    setDetail((await r.json()) as ProjectDetail);
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const r = await fetch("/api/usage");
      if (r.ok) setUsage((await r.json()).global as Usage);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadClients();
    loadUsage();
    const t2 = setInterval(loadUsage, 180_000);
    if (typeof window !== "undefined") {
      const l = localStorage.getItem("fde:lang");
      if (l === "en" || l === "zh") setLang(l);
    }
    return () => clearInterval(t2);
  }, [loadClients, loadUsage]);

  useEffect(() => {
    if (activeClient && activeProject) loadDetail(activeClient, activeProject);
  }, [activeClient, activeProject, loadDetail]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.conversation.length, sending]);

  const toggleLang = () => {
    const next: Lang = lang === "zh" ? "en" : "zh";
    setLang(next);
    if (typeof window !== "undefined") localStorage.setItem("fde:lang", next);
  };

  const toggleExpand = async (slug: string) => {
    const nx = new Set(expanded);
    if (nx.has(slug)) nx.delete(slug);
    else {
      nx.add(slug);
      if (!projectsByClient[slug]) await loadProjects(slug);
    }
    setExpanded(nx);
  };

  const createClient = async () => {
    if (!newClient?.name.trim()) return;
    const r = await fetch("/api/clients", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(newClient),
    });
    const j = await r.json();
    if (!r.ok) return flash(j.error ?? "创建失败", true);
    setNewClient(null);
    await loadClients();
    setExpanded((s) => new Set(s).add(j.client.slug));
  };

  const createProject = async () => {
    if (!newProject?.name.trim()) return;
    const r = await fetch(`/api/clients/${newProject.client}/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: newProject.name,
        deliverableName: newProject.dlvName || newProject.name,
        deliverableType: newProject.dlvType,
      }),
    });
    const j = await r.json();
    if (!r.ok) return flash(j.error ?? "创建失败", true);
    await loadProjects(newProject.client);
    setActiveClient(newProject.client);
    setActiveProject(j.project.slug);
    setNewProject(null);
  };

  const send = async () => {
    if (!activeClient || !activeProject || !input.trim() || sending) return;
    const text = input.trim();
    setInput("");
    setSending(true);
    setDetail((d) =>
      d ? { ...d, conversation: [...d.conversation, { role: "customer", at: new Date().toISOString(), text }] } : d,
    );
    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientSlug: activeClient, projectSlug: activeProject, input: text }),
      });
      const j = await r.json();
      if (!r.ok) flash(j.error ?? "发送失败", true);
      else {
        const res = j.result as TurnResult;
        if (j.usedFallback) flash("未返回结构化结果，已用兜底文本", true);
        if (res.readiness.loop_ready) flash("🎉 规格已达 loop-ready！");
      }
    } catch (e) {
      flash(`网络错误：${(e as Error).message}`, true);
    } finally {
      setSending(false);
      await Promise.all([
        activeClient && activeProject ? loadDetail(activeClient, activeProject) : null,
        activeClient ? loadProjects(activeClient) : null,
        loadUsage(),
      ]);
    }
  };

  const commit = async (push: boolean) => {
    if (!activeClient || !activeProject) return;
    const r = await fetch("/api/commit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientSlug: activeClient, projectSlug: activeProject, push }),
    });
    const j = await r.json();
    flash(r.ok ? (j.detail ?? "已提交") : (j.error ?? "提交失败"), !r.ok);
  };

  const readiness = detail?.state.lastReadiness;
  const dlvLabel = (type: string) =>
    DELIVERABLE_TYPES.find((d) => d.id === type)?.[lang === "zh" ? "label" : "labelEn"] ?? type;

  return (
    <div className="shell">
      <div className="wbnav">
        <span className="wbbrand">WORKBENCH</span>
        <a href={WB.fde} className="cur">① 需求 fde-copilot</a>
        <span className="wbsep">→</span>
        <a href={WB.loop}>② 造 loop-engineer</a>
        <span className="wbsep">→</span>
        <a href={WB.packs}>③ 能力 capability-packs</a>
        <a className="wbsite" href={WB.site}>官网 ↗</a>
      </div>
      <header className="topbar">
        <div className="brand">
          <button className="ghost icon" onClick={() => setSidebar((s) => !s)} title={t.collapse}>
            {sidebar ? "⟨" : "☰"}
          </button>
          FDE Copilot
        </div>
        <div className="stats">
          <span className="stat">🔢 <b>{usage ? fmtTokens(usage.inputTokens + usage.outputTokens) : "—"}</b> {t.tokens}</span>
          <span className="stat">⚙️ <b>{usage ? fmtSecs(usage.computeMs) : "—"}</b> {t.computeSecs}</span>
          <span className="stat" title="等效 API 成本，订阅实付≈0">💰 <b>{usage ? fmtCost(usage.costUsd) : "—"}</b></span>
          <span className="stat dim">{usage ? usage.turns : 0} {t.roundsRefresh}</span>
          <button className="ghost" onClick={toggleLang}>{lang === "zh" ? "EN" : "中"}</button>
        </div>
        {toast && <span className={`toast ${toast.err ? "err" : ""}`}>{toast.msg}</span>}
      </header>

      <div className={`app ${sidebar ? "" : "nosidebar"}`}>
        {/* 左：客户 → 项目 树（可折叠） */}
        {sidebar && (
          <div className="col sidebar">
            <div className="col-head">
              <h2>{t.clients}</h2>
              <button className="ghost sm" onClick={() => setNewClient({ name: "", background: "" })}>{t.newClient}</button>
            </div>
            <div className="col-body">
              {clients.length === 0 && <div className="empty">{t.noClients}</div>}
              {clients.map((c) => (
                <div key={c.slug} className="tree-client">
                  <div className="tree-row" onClick={() => toggleExpand(c.slug)}>
                    <span className="caret">{expanded.has(c.slug) ? "▾" : "▸"}</span>
                    <span className="cname">{c.name}</span>
                  </div>
                  {expanded.has(c.slug) && (
                    <div className="tree-projects">
                      {(projectsByClient[c.slug] ?? []).map((p) => (
                        <div
                          key={p.slug}
                          className={`tree-project ${activeClient === c.slug && activeProject === p.slug ? "active" : ""}`}
                          onClick={() => { setActiveClient(c.slug); setActiveProject(p.slug); }}
                        >
                          <div className="pname">{p.name}</div>
                          <div className="pmeta">
                            <span className={`badge ${p.status}`}>{p.status}</span>
                            <span>{dlvLabel(p.deliverable.type)}</span>
                          </div>
                        </div>
                      ))}
                      {(projectsByClient[c.slug]?.length ?? 0) === 0 && <div className="empty sm">{t.noProjects}</div>}
                      <button
                        className="ghost sm block"
                        onClick={() => setNewProject({ client: c.slug, name: "", dlvName: "", dlvType: "video" })}
                      >
                        {t.newProject}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 中：对话 */}
        <div className="col">
          <div className="col-head">
            <h2>{detail ? `${detail.client.name} · ${detail.state.name}` : "—"}</h2>
          </div>
          <div className="col-body">
            {!detail && <div className="empty">{t.pick}</div>}
            {detail?.conversation.map((e, i) => (
              <div key={i} className={`msg ${e.role}`}>
                <div className="who">{e.role === "customer" ? t.customer : t.you}</div>
                <div className="bubble">{e.text}</div>
                {e.result && e.result.open_questions.length > 0 && (
                  <div className="questions">
                    {e.result.open_questions.map((q) => (
                      <div className="q" key={q.id}><div>❓ {q.question}</div><div className="why">{q.why}</div></div>
                    ))}
                  </div>
                )}
                {e.result && <div className="readiness-bar"><span style={{ width: `${e.result.readiness.score}%` }} /></div>}
              </div>
            ))}
            {sending && (
              <div className="msg copilot">
                <div className="who">{t.you}</div>
                <div className="bubble"><span className="spinner" />{t.working}</div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          {detail && (
            <div className="composer">
              <textarea rows={3} placeholder={t.composerPh} value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
              <div className="row">
                <span className="hint">{t.sendHint}</span><div style={{ flex: 1 }} />
                <button className="primary" onClick={send} disabled={sending || !input.trim()}>
                  {sending ? t.sending : t.send}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 右：交付物优先 + 规格 */}
        <div className="col">
          <div className="col-head">
            <h2>{t.deliverable}</h2>
            {detail && (
              <div style={{ display: "flex", gap: 6 }}>
                <button className="ghost" onClick={() => commit(false)}>commit</button>
                <button className="ghost" onClick={() => commit(true)}>commit+push</button>
              </div>
            )}
          </div>
          {detail && (
            <div className="deliverable">
              <div className="dlv-type">{dlvLabel(detail.state.deliverable.type)}</div>
              <div className="dlv-name">{detail.state.deliverable.name}</div>
              <div className="dlv-sub">{t.theWorkbench.replace("{x}", detail.state.deliverable.name)}</div>
              {readiness && (
                <div className="hint" style={{ marginTop: 10 }}>
                  {t.readinessLabel} <b style={{ color: "var(--text)" }}>{readiness.score}/100</b>
                  {readiness.loop_ready ? ` · ${t.loopReady}` : ` · ${t.notReady}`}
                  {readiness.missing.length > 0 && <span> · {t.missing}：{readiness.missing.join("、")}</span>}
                </div>
              )}
              <div className="tabs" style={{ marginTop: 10 }}>
                {SPEC_DOCS.map((doc) => (
                  <div key={doc} className={`tab ${doc === activeDoc ? "active" : ""}`} onClick={() => setActiveDoc(doc)}>
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

      {/* 新建客户 */}
      {newClient && (
        <div className="modal-bg" onClick={() => setNewClient(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t.newClient.replace("＋ ", "")}</h3>
            <label>{t.clientName}</label>
            <input value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} autoFocus />
            <label>{t.background}</label>
            <textarea rows={4} placeholder={t.bgPh} value={newClient.background}
              onChange={(e) => setNewClient({ ...newClient, background: e.target.value })} />
            <div className="modal-actions">
              <button className="ghost" onClick={() => setNewClient(null)}>{t.cancel}</button>
              <button className="primary" onClick={createClient} disabled={!newClient.name.trim()}>{t.create}</button>
            </div>
          </div>
        </div>
      )}

      {/* 新建项目 */}
      {newProject && (
        <div className="modal-bg" onClick={() => setNewProject(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t.newProject.replace("＋ ", "")}</h3>
            <label>{t.projectName}</label>
            <input value={newProject.name} onChange={(e) => setNewProject({ ...newProject, name: e.target.value })} autoFocus />
            <label>{t.deliverableName}</label>
            <input placeholder={t.dlvPh} value={newProject.dlvName}
              onChange={(e) => setNewProject({ ...newProject, dlvName: e.target.value })} />
            <label>{t.deliverable}</label>
            <select value={newProject.dlvType}
              onChange={(e) => setNewProject({ ...newProject, dlvType: e.target.value as DeliverableType })}>
              {DELIVERABLE_TYPES.map((d) => (
                <option key={d.id} value={d.id}>{lang === "zh" ? d.label : d.labelEn}</option>
              ))}
            </select>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setNewProject(null)}>{t.cancel}</button>
              <button className="primary" onClick={createProject} disabled={!newProject.name.trim()}>{t.create}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
