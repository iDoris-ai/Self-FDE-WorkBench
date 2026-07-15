import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { clientDir } from "./clients";

const pexec = promisify(execFile);

// 仓库根 = fde-copilot 的上一级（本子项目位于大 repo 内）
function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await pexec("git", args, { cwd: repoRoot(), maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

/**
 * 提交某客户目录下的 spec 文档（不含 state.json / conversation.jsonl，已被 .gitignore）。
 * push 仅在显式要求且已配置 remote 时执行。
 */
export async function commitClient(
  slug: string,
  message: string,
  push = false,
): Promise<{ committed: boolean; pushed: boolean; detail: string }> {
  const rel = path.relative(repoRoot(), clientDir(slug));
  await git(["add", "--", rel]);

  // 无变更则跳过
  const status = await git(["status", "--porcelain", "--", rel]);
  if (!status) {
    return { committed: false, pushed: false, detail: "无文档变更，跳过提交" };
  }

  await git([
    "commit",
    "-m",
    message,
    "-m",
    "Claude-Session: https://claude.ai/code/session_01Auxf6v5qsq3sNYjDP5qcnX",
    "--",
    rel,
  ]);

  let pushed = false;
  let detail = `已提交 ${rel}`;
  if (push) {
    try {
      await git(["push"]);
      pushed = true;
      detail += "，已 push";
    } catch (e) {
      detail += `，push 失败：${(e as Error).message}`;
    }
  }
  return { committed: true, pushed, detail };
}
