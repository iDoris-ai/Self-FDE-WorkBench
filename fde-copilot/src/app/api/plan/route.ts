import { NextResponse } from "next/server";
import { scopedAuthError } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * 「上传现成 spec 一键构建」代理（CC-61）。
 *
 * 浏览器上传一份 markdown 全文 → 本路由（服务端持 WORKBENCH_TOKEN）转发到 loop-engineer 的
 * POST /plan { clientSlug, projectSlug, repo, spec }，loop 内联写 SPEC.md 直接建 job。
 * 与 /api/chat 同一鉴权：originError + scopedAuthError（参赛者作用域 token / admin 全通 / 本机放行），
 * 浏览器同源调用不带 token（与 chat 一致）。真正的 loop 端 token 只在服务端注入，不下发浏览器。
 *
 * GET  ?jobId=<id> → 透传 loop GET /status/:jobId，供 UI 轮询进度。
 */
function loopBase(): string {
  return (process.env.LOOP_ENGINEER_URL || "http://localhost:4040").replace(/\/+$/, "");
}

/** 服务端调用 loop-engineer 时注入的 admin token（与 loop 共享 WORKBENCH_TOKEN）。 */
function loopHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const tok = process.env.WORKBENCH_TOKEN?.trim();
  if (tok) h["x-workbench-token"] = tok;
  return h;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    clientSlug?: string;
    projectSlug?: string;
    repo?: string;
    spec?: string;
  };
  const clientSlug = body.clientSlug?.trim();
  const projectSlug = body.projectSlug?.trim();
  const repo = body.repo?.trim();
  const spec = typeof body.spec === "string" ? body.spec : undefined;

  if (!clientSlug || !projectSlug || !repo) {
    return NextResponse.json(
      { error: "缺少 clientSlug / projectSlug / repo" },
      { status: 400 },
    );
  }
  if (!spec || !spec.trim()) {
    return NextResponse.json({ error: "spec 为空（请上传 markdown 全文）" }, { status: 400 });
  }
  // 与 loop-engineer /plan 同一上限（512KB）：在代理侧先挡掉超大 body，避免整段 buffer + 转发后才被 loop 拒。
  if (spec.length > 512 * 1024) {
    return NextResponse.json({ error: "spec 过大（上限 512KB）" }, { status: 400 });
  }
  // 与 chat 一致：origin 门禁 + 作用域/admin token（越权访问他人项目 → 403）
  const denied = scopedAuthError(req, clientSlug, projectSlug);
  if (denied) return denied;

  try {
    const r = await fetch(`${loopBase()}/plan`, {
      method: "POST",
      headers: loopHeaders(),
      body: JSON.stringify({ clientSlug, projectSlug, repo, spec }),
    });
    const text = await r.text();
    // 原样透传 loop 的 JSON 与状态码（其 400/401/404/500 都自带 error 文案）
    const data = text ? safeJson(text) : {};
    return NextResponse.json(data, { status: r.status });
  } catch (e) {
    return NextResponse.json(
      { error: `无法连接 loop-engineer：${(e as Error).message}` },
      { status: 502 },
    );
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId")?.trim();
  const clientSlug = url.searchParams.get("clientSlug")?.trim() ?? "";
  const projectSlug = url.searchParams.get("projectSlug")?.trim() ?? "";
  if (!jobId) return NextResponse.json({ error: "缺少 jobId" }, { status: 400 });

  // 轮询也过同一鉴权门（作用域 token 需与 client/project 一致；admin/本机放行）
  const denied = scopedAuthError(req, clientSlug || jobId, projectSlug || jobId);
  if (denied) return denied;

  try {
    const r = await fetch(`${loopBase()}/status/${encodeURIComponent(jobId)}`, {
      headers: loopHeaders(),
    });
    const text = await r.text();
    const data = text ? safeJson(text) : {};
    return NextResponse.json(data, { status: r.status });
  } catch (e) {
    return NextResponse.json(
      { error: `无法连接 loop-engineer：${(e as Error).message}` },
      { status: 502 },
    );
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
