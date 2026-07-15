import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "./log.js";

const pexec = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", ["-C", repo, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
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
