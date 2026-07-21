#!/usr/bin/env -S npx tsx
/**
 * W1 — loop-engineer 薄 HTTP 编排 API
 *
 * 让 hack5（Cloudflare Worker，碰不到 Mac Mini 文件系统）能远程触发编码循环。
 * 复用现有函数：planSpec（planner.ts）、runTask（orchestrator.ts）、jobs.ts 的 job 模型。
 *
 * 契约（见 docs/hack5-对接-实现计划.md §1）：
 *   POST /plan      { clientSlug, projectSlug, repo } → { jobId }
 *   POST /run       { jobId }                         → { started, state }
 *   GET  /status/:jobId                               → { state, prUrl?, appUrl? }
 *
 * 鉴权：所有端点校验 `x-workbench-token`（复用 WORKBENCH_TOKEN，与 fde-copilot 一致）。
 *
 * 并发（B1）：底层引擎串行，这里用单 worker 队列。busy 时 /run 返回 state:"queued"
 * （入队语义，不 409），worker 空出即自动开跑。一场 Mini 几十个想法可安全排队。
 *
 * 安全（B4）：默认只绑 127.0.0.1。远程可达须经隧道（token + 网络管控做补偿控制）。
 * 状态存储为进程内内存：重启丢失（对 W1 mock 自测足够；持久化留后续）。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { loadConfig, loadEnv, PROJECT_ROOT } from "./config.js";
import { loadJob, nextTask, hasPending, saveJob, scanJobs } from "./jobs.js";
import { planSpec } from "./planner.js";
import { runTask } from "./orchestrator.js";
import { isGitRepo, pruneWorktrees } from "./git.js";
import { runWithTimeout } from "./timeout.js";
import { checkWorkbenchToken } from "./auth.js";
import { emitLifecycle } from "./lifecycle.js";
import { createPool } from "./pool.js";
import { installCallbackSink } from "./callback.js";
import { log } from "./log.js";
import type { Config, LoadedJob } from "./types.js";

// —— 契约状态机 ——
type JobState = "queued" | "planning" | "coding" | "reviewing" | "done" | "failed";

interface JobRecord {
  jobId: string;
  specDir: string;
  repo: string;
  clientSlug: string;
  projectSlug: string;
  state: JobState;
  prUrl?: string;
  appUrl?: string;
  error?: string;
  updatedAt: string;
}

/** 从规格目录反推 clientSlug/projectSlug（.../clients/<c>/projects/<p>） */
function clientProjectFromSpecDir(specDir: string): { clientSlug: string; projectSlug: string } {
  const projectSlug = path.basename(specDir);
  const clientSlug = path.basename(path.dirname(path.dirname(specDir)));
  return { clientSlug, projectSlug };
}

const registry = new Map<string, JobRecord>();

function setState(rec: JobRecord, state: JobState, patch?: Partial<JobRecord>): void {
  rec.state = state;
  if (patch) Object.assign(rec, patch);
  rec.updatedAt = new Date().toISOString();
}

// —— 有界并发池（W7）——
// 契约 v2 · B1:v1 默认串行(LOOP_CONCURRENCY=1);一场 Mini 几十个想法可把并发调高。
// 以 repo 作 key → 同 repo 的 job 串行(worktree/集成分支互斥)、跨 repo 并行。
let config: Config;

function maxConcurrency(): number {
  const n = Number(process.env.LOOP_CONCURRENCY ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

const pool = createPool(maxConcurrency);

/** 提交一个 job 到并发池（以其 repo 为互斥 key）。 */
function enqueue(jobId: string): void {
  const rec = registry.get(jobId);
  if (!rec) return;
  pool.submit({
    id: jobId,
    key: rec.repo,
    run: async () => {
      // Q2:job 级超时。超时 → abort（kill 子进程 + runTask.finally 清 worktree）→ 标 failed。
      const r = await runWithTimeout((signal) => processJob(jobId, signal), jobTimeoutMs());
      const job = registry.get(jobId);
      if (r.timedOut) {
        if (job) setState(job, "failed", { error: `job 超时（${jobTimeoutMs()}ms），已中止并清理` });
        log.err(`job ${jobId} 超时中止`);
        await pruneRepoWorktrees(job?.repo);
      } else if (r.error) {
        if (job) setState(job, "failed", { error: (r.error as Error).message });
        log.err(`job ${jobId} 处理异常：${(r.error as Error).message}`);
      }
    },
  });
}

/** job 级超时上限（默认 30min，契约 v2 · Q2 建议值）。 */
function jobTimeoutMs(): number {
  const n = Number(process.env.LOOP_JOB_TIMEOUT_MS ?? 30 * 60 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
}

/** 超时/失败后清理该 repo 遗留的半成品 worktree（尽力而为）。 */
async function pruneRepoWorktrees(repo?: string): Promise<void> {
  if (!repo) return;
  try {
    await pruneWorktrees(repo);
  } catch (e) {
    log.warn(`worktree 清理失败：${(e as Error).message}`);
  }
}

/** 跑一个 job 的全部待办任务到收工，实时更新 registry 状态。 */
async function processJob(jobId: string, signal?: AbortSignal): Promise<void> {
  const rec = registry.get(jobId);
  if (!rec) return;
  const job = await loadJob(path.join(rec.specDir, "loop.json"));
  if (!job) {
    setState(rec, "failed", { error: "loop.json 不存在或不可解析" });
    return;
  }
  if (!(await isGitRepo(job.repoPath))) {
    setState(rec, "failed", { error: `目标 repo 不是 git 仓库：${job.repoPath}` });
    return;
  }

  setState(rec, "coding");
  while (hasPending(job)) {
    const task = nextTask(job);
    if (!task) break; // 有 pending 但被依赖阻塞
    task.status = "in_progress";
    await saveJob(job);
    try {
      const result = await runTask(job, task, config, {
        onPhase: (phase) => setState(rec, phase),
        signal,
      });
      if (result.prUrl) rec.prUrl = result.prUrl;
    } catch (e) {
      task.status = "failed";
      task.lastResult = (e as Error).message;
      await saveJob(job);
      log.err(`任务 ${task.id} 异常：${(e as Error).message}`);
      if (signal?.aborted) break; // job 超时 → 不再取下一个任务
    }
  }

  const tasks = job.manifest.tasks;
  if (tasks.some((t) => t.status === "failed")) {
    setState(rec, "failed", {
      error: tasks.filter((t) => t.status === "failed").map((t) => `${t.id}: ${t.lastResult ?? ""}`).join("; "),
    });
  } else {
    setState(rec, "done");
    // W4：coding 完成 → 广播 coding_done。部署归 hack5(只回调),此处不自部署。
    // sink 失败不影响 job 状态(emitLifecycle 内部各 sink 独立 try/catch)。
    await emitLifecycle({
      event: "coding_done",
      clientSlug: rec.clientSlug,
      projectSlug: rec.projectSlug,
      repo: rec.repo,
      prUrl: rec.prUrl,
    });
  }
}

// —— HTTP 辅助 ——
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * slug 安全校验：slug 直接来自 /plan 请求体（多租户 Worker 传入），path.join 不阻止 `..`。
 * 与 fde-copilot 的 clients.ts assertSafe 一致：拒绝含分隔符/`..`/空，从而挡路径穿越，
 * 同时允许项目里既有的中文 slug（如 `格格` / `主项目`）。
 */
function assertSafeSlug(slug: string, label: string): void {
  if (
    !slug ||
    slug.includes("/") ||
    slug.includes("\\") ||
    slug.includes("..") ||
    slug.includes("\0")
  ) {
    throw new Error(`非法 ${label}：${slug}`);
  }
}

/** clientSlug/projectSlug → 规格目录（fde-copilot 的 clients/<c>/projects/<p>/），带穿越防护 */
function specDirFor(clientSlug: string, projectSlug: string): string {
  assertSafeSlug(clientSlug, "clientSlug");
  assertSafeSlug(projectSlug, "projectSlug");
  const clientsDir = config.watchDirs[0] ?? "../fde-copilot/clients";
  const base = path.isAbsolute(clientsDir) ? clientsDir : path.resolve(PROJECT_ROOT, clientsDir);
  const dir = path.join(base, clientSlug, "projects", projectSlug);
  // canonical-prefix 断言：解析后仍须落在 base 内（双保险，防绕过 slug 规则的编码穿越）
  const resolved = path.resolve(dir);
  const baseResolved = path.resolve(base);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    throw new Error(`规格目录越界：${clientSlug}/${projectSlug}`);
  }
  return dir;
}

/**
 * repo 路径防护：repo 原样进 manifest → 成为 runTask 开 worktree、跑 coder、建 PR 的目标。
 * 设了 LOOP_REPO_ROOT 时强制 repo 落在其下（白名单根前缀）；未设则至少拒绝 `..` 穿越。
 */
function assertSafeRepo(repo: string): void {
  if (repo.includes("\0")) throw new Error(`非法 repo：${repo}`);
  const root = process.env.LOOP_REPO_ROOT;
  if (root) {
    const rootResolved = path.resolve(root);
    const repoResolved = path.resolve(repo);
    if (repoResolved !== rootResolved && !repoResolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`repo 越界(不在 LOOP_REPO_ROOT 下)：${repo}`);
    }
  } else if (repo.split(/[\\/]/).includes("..")) {
    throw new Error(`repo 含路径穿越：${repo}`);
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

/** 从磁盘补齐 registry（供 server 重启后 /run /status 仍能定位已 plan 过的 job） */
async function findJobRecord(jobId: string): Promise<JobRecord | undefined> {
  const cached = registry.get(jobId);
  if (cached) return cached;
  const jobs = await scanJobs(config.watchDirs);
  const job = jobs.find((j) => j.manifest.id === jobId);
  if (!job) return undefined;
  const { clientSlug, projectSlug } = clientProjectFromSpecDir(job.jobDir);
  const rec: JobRecord = {
    jobId,
    specDir: job.jobDir,
    repo: job.manifest.repo,
    clientSlug,
    projectSlug,
    state: deriveState(job),
    updatedAt: new Date().toISOString(),
  };
  registry.set(jobId, rec);
  return rec;
}

/** 从磁盘 job 的任务状态粗略推断一个 rest 状态（server 冷启动时用） */
function deriveState(job: LoadedJob): JobState {
  const tasks = job.manifest.tasks;
  if (tasks.length === 0) return "queued";
  if (tasks.some((t) => t.status === "failed")) return "failed";
  if (tasks.every((t) => t.status === "done")) return "done";
  return "queued";
}

// —— 路由 ——
async function handlePlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const clientSlug = String(body.clientSlug ?? "");
  const projectSlug = String(body.projectSlug ?? "");
  const repo = String(body.repo ?? "");
  if (!clientSlug || !projectSlug || !repo) {
    send(res, 400, { error: "缺少 clientSlug / projectSlug / repo" });
    return;
  }
  // 输入校验（slug 穿越防护 + repo 白名单）→ 非法一律 400，不落到 500
  let specDir: string;
  try {
    specDir = specDirFor(clientSlug, projectSlug);
    assertSafeRepo(repo);
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
    return;
  }
  if (!(await exists(specDir))) {
    send(res, 404, { error: `规格目录不存在：${specDir}` });
    return;
  }

  // 临时占位 record（jobId 先用 projectSlug；planSpec 后以 manifest.id 为准）
  const provisional: JobRecord = {
    jobId: projectSlug,
    specDir,
    repo,
    clientSlug,
    projectSlug,
    state: "planning",
    updatedAt: new Date().toISOString(),
  };
  registry.set(provisional.jobId, provisional);

  try {
    await planSpec(specDir, config, { repo });
  } catch (e) {
    setState(provisional, "failed", { error: (e as Error).message });
    send(res, 500, { error: `plan 失败：${(e as Error).message}` });
    return;
  }

  // 读回 loop.json 拿真实 jobId（= manifest.id）
  const job = await loadJob(path.join(specDir, "loop.json"));
  const jobId = job?.manifest.id ?? projectSlug;
  if (jobId !== provisional.jobId) {
    registry.delete(provisional.jobId);
  }
  const rec: JobRecord = {
    jobId,
    specDir,
    repo,
    clientSlug,
    projectSlug,
    state: "queued",
    updatedAt: new Date().toISOString(),
  };
  registry.set(jobId, rec);
  send(res, 200, { jobId });
}

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const jobId = String(body.jobId ?? "");
  if (!jobId) {
    send(res, 400, { error: "缺少 jobId" });
    return;
  }
  const rec = await findJobRecord(jobId);
  if (!rec) {
    send(res, 404, { error: `job 不存在：${jobId}` });
    return;
  }
  // 契约 v2 · B1：入队语义，返回 {accepted, jobId, queuePos}。queuePos=0 表示正在跑。
  if (pool.isRunning(jobId)) {
    send(res, 200, { accepted: true, jobId, queuePos: 0 });
    return;
  }
  if (!pool.isActive(jobId)) {
    setState(rec, "queued");
    enqueue(jobId);
  }
  send(res, 200, { accepted: true, jobId, queuePos: pool.queuePos(jobId) });
}

async function handleStatus(res: ServerResponse, jobId: string): Promise<void> {
  const rec = await findJobRecord(jobId);
  if (!rec) {
    send(res, 404, { error: `job 不存在：${jobId}` });
    return;
  }
  send(res, 200, {
    state: rec.state,
    ...(rec.prUrl ? { prUrl: rec.prUrl } : {}),
    ...(rec.appUrl ? { appUrl: rec.appUrl } : {}),
    ...(rec.error ? { error: rec.error } : {}),
  });
}

async function router(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkWorkbenchToken(req)) {
    send(res, 401, { error: "未授权：需要有效的 x-workbench-token" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  if (req.method === "POST" && p === "/plan") return handlePlan(req, res);
  if (req.method === "POST" && p === "/run") return handleRun(req, res);
  if (req.method === "GET" && p.startsWith("/status/")) {
    return handleStatus(res, decodeURIComponent(p.slice("/status/".length)));
  }
  send(res, 404, { error: "未知路由" });
}

export async function startServer(port: number, host: string): Promise<void> {
  config = await loadConfig();
  installCallbackSink(); // W5：把 HMAC 签名回调挂到 lifecycle（coding_done 等事件外发给 hack5）
  const server = createServer((req, res) => {
    router(req, res).catch((e) => {
      log.err(`请求处理异常：${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    });
  });
  server.listen(port, host, () => {
    log.ok(`Loop-Engineer HTTP 编排 API 已启动：http://${host}:${port}`);
    if (!process.env.WORKBENCH_TOKEN) {
      log.warn("未设置 WORKBENCH_TOKEN —— 所有请求都会被拒（fail-closed）。请在 .env 配置。");
    }
  });
}

// 直接运行入口
loadEnv();
const port = Number(process.env.LOOP_HTTP_PORT ?? 4050);
const host = process.env.LOOP_HTTP_HOST ?? "127.0.0.1";
startServer(port, host).catch((e) => {
  log.err(e.stack ?? String(e));
  process.exit(1);
});
