import { NextResponse } from "next/server";
import { readProjectState, writeProjectState, appendConversation } from "@/lib/clients";
import { runTurn } from "@/lib/agent";
import { commitProject } from "@/lib/git";
import { scopedAuthError } from "@/lib/auth";
import { addUsage, ZERO_USAGE } from "@/lib/types";

export const runtime = "nodejs";
// agent 单轮可能较久（调研 + 多文件写入）
export const maxDuration = 800;

export async function POST(req: Request) {
  const { clientSlug, projectSlug, input, attachments } = (await req.json()) as {
    clientSlug?: string;
    projectSlug?: string;
    input?: string;
    attachments?: string[];
  };

  if (!clientSlug || !projectSlug || !input || !input.trim()) {
    return NextResponse.json({ error: "缺少 clientSlug / projectSlug / input" }, { status: 400 });
  }

  // B3：参赛者会话用作用域 token（或 admin 全通）；越权访问他人项目 → 403
  const denied = scopedAuthError(req, clientSlug, projectSlug);
  if (denied) return denied;

  const state = await readProjectState(clientSlug, projectSlug);
  if (!state) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const now = new Date().toISOString();
  await appendConversation(clientSlug, projectSlug, {
    role: "customer",
    at: now,
    text: input.trim(),
    attachments,
  });

  let out;
  try {
    out = await runTurn({ clientSlug, projectSlug, customerInput: input.trim(), attachments });
  } catch (e) {
    return NextResponse.json({ error: `agent 执行失败：${(e as Error).message}` }, { status: 500 });
  }

  await appendConversation(clientSlug, projectSlug, {
    role: "copilot",
    at: new Date().toISOString(),
    text: out.result.reply,
    result: out.result,
  });

  const nextStatus =
    out.result.readiness.loop_ready ? "ready" : state.status === "intake" ? "building" : state.status;
  await writeProjectState({
    ...state,
    updatedAt: new Date().toISOString(),
    rounds: state.rounds + 1,
    status: nextStatus,
    lastReadiness: out.result.readiness,
    usage: addUsage(state.usage ?? ZERO_USAGE, out.usage),
  });

  let commit: { committed: boolean; pushed: boolean; detail: string } | null = null;
  if (process.env.AUTO_COMMIT === "true") {
    try {
      commit = await commitProject(
        clientSlug,
        projectSlug,
        `docs(${clientSlug}/${projectSlug}): 第 ${state.rounds + 1} 轮 spec（readiness ${out.result.readiness.score}）`,
        process.env.AUTO_PUSH === "true",
      );
    } catch (e) {
      commit = { committed: false, pushed: false, detail: `提交失败：${(e as Error).message}` };
    }
  }

  return NextResponse.json({ result: out.result, usedFallback: out.usedFallback, commit });
}
