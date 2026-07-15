import { NextResponse } from "next/server";
import { readState, writeState, appendConversation } from "@/lib/clients";
import { runTurn } from "@/lib/agent";
import { commitClient } from "@/lib/git";
import { authError } from "@/lib/auth";
import { addUsage, ZERO_USAGE } from "@/lib/types";

export const runtime = "nodejs";
// agent 单轮可能较久（调研 + 多文件写入）
export const maxDuration = 800;

export async function POST(req: Request) {
  const denied = authError(req);
  if (denied) return denied;
  const { slug, input, attachments } = (await req.json()) as {
    slug?: string;
    input?: string;
    attachments?: string[];
  };

  if (!slug || !input || !input.trim()) {
    return NextResponse.json({ error: "缺少 slug 或 input" }, { status: 400 });
  }

  const state = await readState(slug);
  if (!state) {
    return NextResponse.json({ error: "客户不存在" }, { status: 404 });
  }

  const now = new Date().toISOString();

  // 1. 记录客户输入
  await appendConversation(slug, {
    role: "customer",
    at: now,
    text: input.trim(),
    attachments,
  });

  // 2. 跑 agent
  let out;
  try {
    out = await runTurn({ slug, customerInput: input.trim(), attachments });
  } catch (e) {
    return NextResponse.json({ error: `agent 执行失败：${(e as Error).message}` }, { status: 500 });
  }

  // 3. 记录 copilot 回复
  await appendConversation(slug, {
    role: "copilot",
    at: new Date().toISOString(),
    text: out.result.reply,
    result: out.result,
  });

  // 4. 更新客户状态
  const nextStatus =
    out.result.readiness.loop_ready ? "ready" : state.status === "intake" ? "building" : state.status;
  await writeState({
    ...state,
    updatedAt: new Date().toISOString(),
    rounds: state.rounds + 1,
    status: nextStatus,
    lastReadiness: out.result.readiness,
    usage: addUsage(state.usage ?? ZERO_USAGE, out.usage),
  });

  // 5. 可选自动提交
  let commit: { committed: boolean; pushed: boolean; detail: string } | null = null;
  if (process.env.AUTO_COMMIT === "true") {
    try {
      commit = await commitClient(
        slug,
        `docs(${slug}): 第 ${state.rounds + 1} 轮 spec 更新（readiness ${out.result.readiness.score}）`,
        process.env.AUTO_PUSH === "true",
      );
    } catch (e) {
      commit = { committed: false, pushed: false, detail: `提交失败：${(e as Error).message}` };
    }
  }

  return NextResponse.json({ result: out.result, usedFallback: out.usedFallback, commit });
}
