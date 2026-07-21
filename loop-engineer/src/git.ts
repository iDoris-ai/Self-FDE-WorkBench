import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "./log.js";

const pexec = promisify(execFile);

// git 子进程一律非交互：缺凭据/需确认时立即失败，绝不阻塞在终端提示上（clone/fetch/push 都走这条）。
const GIT_EXEC_OPTS = {
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
} as const;

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", ["-C", repo, ...args], GIT_EXEC_OPTS);
  return stdout.trim();
}

async function tryGit(repo: string, args: string[]): Promise<string | null> {
  try {
    return await git(repo, args);
  } catch {
    return null;
  }
}

function safeBranch(b: string): string {
  return b.replace(/[^a-zA-Z0-9._-]/g, "__");
}

/** 存放本引擎所有 worktree 的目录（在目标 repo 隔壁，不污染其工作树） */
function wtRoot(repo: string): string {
  return path.join(path.dirname(path.resolve(repo)), ".loop-wt", path.basename(repo));
}

export async function isGitRepo(repo: string): Promise<boolean> {
  return (await tryGit(repo, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

/** 远程 repo（需 clone）：http(s)/git/ssh scheme，或 scp-like `git@host:path`。本地路径返回 false。 */
export function isRemoteRepo(repo: string): boolean {
  return /^(https?|ssh|git):\/\//i.test(repo) || /^[^\s/]+@[^\s/]+:/.test(repo);
}

/**
 * 把 push token 临时注入 https 远程 URL（仅用于本次 clone/fetch/push 的命令行，绝不写回
 * .git/config —— clone 后我们会把 origin 改回干净 URL）。非 https 或无 token 时原样返回。
 */
function withToken(remoteUrl: string, token?: string): string {
  if (!token) return remoteUrl;
  const m = remoteUrl.match(/^https:\/\/(.+)$/i);
  if (!m) return remoteUrl;
  const rest = m[1].replace(/^[^@/]+(:[^@/]*)?@/, ""); // 去掉已有的 user[:pass]@
  return `https://x-access-token:${token}@${rest}`;
}

/**
 * 确保远程 repo 有一份本地 clone（W2/W4 补漏：loop 自己 clone 远程仓再编码/回推）。
 * - 已是 git 仓：best-effort fetch base（不 reset，保住已有 loop/integration 进度）。
 * - 路径存在但非 git 仓（残留半成品）：清掉重 clone。
 * - 缺失：clone。token 只临时用于拉取，clone 后 origin 改回干净 URL，不落盘凭据。
 */
export async function ensureClone(
  remoteUrl: string,
  localPath: string,
  baseBranch: string,
  token?: string,
): Promise<void> {
  if (await isGitRepo(localPath)) {
    await tryGit(localPath, ["fetch", withToken(remoteUrl, token), baseBranch]);
    return;
  }
  const exists = await fs
    .access(localPath)
    .then(() => true)
    .catch(() => false);
  if (exists) await fs.rm(localPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await pexec("git", ["clone", withToken(remoteUrl, token), localPath], GIT_EXEC_OPTS);
  // 干净化：不把带 token 的 URL 留在 .git/config
  await tryGit(localPath, ["remote", "set-url", "origin", remoteUrl]);
}

/**
 * 把本地分支 push 回远程若干 refspec（token 临时注入命令行，不持久化）。
 * 逐条独立 push：某条失败（如 main 非 fast-forward）不影响其它条落地。
 */
export async function pushRefs(
  repo: string,
  remoteUrl: string,
  refspecs: string[],
  token?: string,
): Promise<{ pushed: boolean; detail: string }> {
  const url = withToken(remoteUrl, token);
  const okRefs: string[] = [];
  const failRefs: string[] = [];
  for (const spec of refspecs) {
    const r = await tryGit(repo, ["push", url, spec]);
    if (r === null) failRefs.push(spec);
    else okRefs.push(spec);
  }
  if (failRefs.length === 0) return { pushed: true, detail: `已 push：${okRefs.join(" ")}` };
  return {
    pushed: okRefs.length > 0,
    detail: `push 部分/全部失败 —— 成功[${okRefs.join(" ") || "无"}] 失败[${failRefs.join(" ")}]`,
  };
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await tryGit(repo, ["rev-parse", "--verify", "--quiet", branch])) !== null;
}

/**
 * 确保集成分支存在，并为它建一个专用 worktree（合并都在这里做，
 * 目标 repo 的主工作树全程不被 checkout 打扰）。返回集成 worktree 路径。
 */
export async function ensureIntegrationWorktree(
  repo: string,
  baseBranch: string,
  integrationBranch: string,
): Promise<string> {
  const wtPath = path.join(wtRoot(repo), "__integration__");

  if (!(await branchExists(repo, integrationBranch))) {
    await git(repo, ["branch", integrationBranch, baseBranch]);
    log.ok(`建集成分支 ${integrationBranch}（自 ${baseBranch}）`);
  }

  // 已挂载？
  const list = (await tryGit(repo, ["worktree", "list", "--porcelain"])) ?? "";
  if (!list.includes(wtPath)) {
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    await git(repo, ["worktree", "add", wtPath, integrationBranch]);
    log.ok(`挂载集成 worktree ${wtPath}`);
  }
  return wtPath;
}

/** 为一个任务建独立 worktree，分支起点 = 集成分支当前 tip */
export async function createTaskWorktree(
  repo: string,
  integrationBranch: string,
  taskBranch: string,
): Promise<string> {
  const wtPath = path.join(wtRoot(repo), safeBranch(taskBranch));
  // 若残留同名分支/worktree，先清
  await removeWorktree(repo, wtPath);
  if (await branchExists(repo, taskBranch)) {
    await tryGit(repo, ["branch", "-D", taskBranch]);
  }
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  await git(repo, ["worktree", "add", wtPath, "-b", taskBranch, integrationBranch]);
  return wtPath;
}

/** 清理该 repo 下已失效/遗留的 worktree 记录（超时/失败后的半成品清理，尽力而为）。 */
export async function pruneWorktrees(repo: string): Promise<void> {
  await tryGit(repo, ["worktree", "prune"]);
}

export async function removeWorktree(repo: string, wtPath: string): Promise<void> {
  const exists = await fs
    .access(wtPath)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    await tryGit(repo, ["worktree", "remove", "--force", wtPath]);
  }
  await tryGit(repo, ["worktree", "prune"]);
}

/** 任务分支相对集成分支的 diff（喂给单发 chat reviewer；容量上限保护） */
export async function diffAgainst(wtPath: string, integrationBranch: string): Promise<string> {
  const diff = (await tryGit(wtPath, ["diff", `${integrationBranch}...HEAD`])) ?? "";
  const stat = (await tryGit(wtPath, ["diff", "--stat", `${integrationBranch}...HEAD`])) ?? "";
  const capped = diff.length > 60_000 ? diff.slice(0, 60_000) + "\n…(diff 过长已截断)" : diff;
  return `## 改动概览\n${stat}\n\n## 完整 diff\n${capped}`;
}

export async function hasChanges(wtPath: string): Promise<boolean> {
  const s = await tryGit(wtPath, ["status", "--porcelain"]);
  return !!s;
}

export async function commitAll(wtPath: string, message: string): Promise<boolean> {
  await git(wtPath, ["add", "-A"]);
  if (!(await hasChanges(wtPath))) return false;
  await git(wtPath, ["commit", "-m", message]);
  return true;
}

/** 在集成 worktree 里把任务分支 --no-ff 合并进集成分支 */
export async function mergeToIntegration(
  integrationWtPath: string,
  taskBranch: string,
  message: string,
): Promise<void> {
  await git(integrationWtPath, ["merge", "--no-ff", taskBranch, "-m", message]);
}

export interface PrResult {
  opened: boolean;
  url?: string;
  detail: string;
}

/**
 * 尽力开 PR：需要 remote + gh。推 taskBranch 并对 integrationBranch 开 PR。
 * 本地无 remote/gh 时优雅跳过（仍会在本地合并到集成分支）。
 */
export async function openPr(
  repo: string,
  taskBranch: string,
  integrationBranch: string,
  title: string,
  body: string,
): Promise<PrResult> {
  const hasRemote = await tryGit(repo, ["remote"]);
  if (!hasRemote) return { opened: false, detail: "无 remote，跳过 PR，走本地集成合并" };

  const pushed = await tryGit(repo, ["push", "-u", "origin", taskBranch]);
  if (pushed === null) return { opened: false, detail: "push 失败，跳过 PR" };

  try {
    const { stdout } = await pexec(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        await repoSlug(repo),
        "--base",
        integrationBranch,
        "--head",
        taskBranch,
        "--title",
        title,
        "--body",
        body,
      ],
      { cwd: repo },
    );
    return { opened: true, url: stdout.trim(), detail: "PR 已开" };
  } catch (e) {
    return { opened: false, detail: `gh pr create 失败：${(e as Error).message.slice(0, 200)}` };
  }
}

async function repoSlug(repo: string): Promise<string> {
  const url = (await tryGit(repo, ["remote", "get-url", "origin"])) ?? "";
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return m ? m[1] : "";
}
