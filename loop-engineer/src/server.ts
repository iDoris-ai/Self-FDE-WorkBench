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
import { isGitRepo, pruneWorktrees, isRemoteRepo, ensureClone, pushRefs } from "./git.js";
import { runWithTimeout } from "./timeout.js";
import { writeStatus, readStatus } from "./persist.js";
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
  /** B1：/plan 入队时置 true —— 后台 job 先跑 planSpec(拆规格)再跑任务,避免 /plan 同步阻塞。 */
  needsPlan?: boolean;
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
  // C1：状态落盘(fire-and-forget,last-write-wins),重启后 /status 仍可查
  void persist(rec);
}

/** 把 rec 快照写到其规格目录 .loop/status.json（失败仅告警，不打断编排）。 */
async function persist(rec: JobRecord): Promise<void> {
  try {
    await writeStatus(rec.specDir, {
      jobId: rec.jobId,
      repo: rec.repo,
      clientSlug: rec.clientSlug,
      projectSlug: rec.projectSlug,
      state: rec.state,
      prUrl: rec.prUrl,
      appUrl: rec.appUrl,
      error: rec.error,
      updatedAt: rec.updatedAt,
    });
  } catch (e) {
    log.warn(`状态落盘失败(${rec.jobId})：${(e as Error).message}`);
  }
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
      const r = await runWithTimeout(async (signal) => {
        // B1：/plan 只入队秒返回,真正的拆规格(planSpec,分钟级)在这里后台跑,不阻塞 HTTP。
        const r0 = registry.get(jobId);
        if (r0?.needsPlan) {
          setState(r0, "planning");
          await planSpec(r0.specDir, config, { repo: r0.repo });
          r0.needsPlan = false;
        }
        if (signal?.aborted) return;
        await processJob(jobId, signal);
      }, jobTimeoutMs());
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

/**
 * loop 回推远程仓用的 push token。B2 边界：只在编排进程（server）里读，用于构造带凭证的
 * 临时 push/clone URL；sandboxEnv() 白名单不含这些键，coder/reviewer 沙箱读不到。
 * 凭据留在本机 loop-engineer/.env，绝不经 hack5 过线（契约不变，hack5 零改动）。
 */
function loopPushToken(): string | undefined {
  return process.env.LOOP_GIT_PUSH_TOKEN || process.env.GITHUB_BOT_TOKEN || undefined;
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
  // W2/W4 补漏：repo 是远程 URL 时，loop 先把它 clone 到本地 job 目录，再编码/回推。
  // （之前 loadJob 会把 URL 当本地路径拼歪 → isGitRepo=false → job 秒挂。Bug1。）
  if (job.remoteUrl) {
    try {
      await ensureClone(job.remoteUrl, job.repoPath, job.manifest.baseBranch, loopPushToken());
    } catch (e) {
      setState(rec, "failed", { error: `clone 远程仓失败（${job.remoteUrl}）：${(e as Error).message}` });
      return;
    }
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
    // W4：远程仓 → 把编码成果回推远程（loop/integration 分支保底 + fast-forward base 便于部署）。
    // 逐条独立 push：base 若非 FF 失败也不影响 integration 分支落地。凭据来自本机 token，
    // 沙箱不可见。push 失败不改 job 状态（尽力而为），只告警。
    if (job.remoteUrl) {
      const integ = job.manifest.integrationBranch;
      const r = await pushRefs(
        job.repoPath,
        job.remoteUrl,
        [`${integ}:refs/heads/${integ}`, `${integ}:${job.manifest.baseBranch}`],
        loopPushToken(),
      );
      (r.pushed ? log.ok : log.warn)(`回推远程 ${job.remoteUrl}：${r.detail}`);
    }
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
  // 远程仓：只接受 https://github.com/（挡任意 scheme / SSRF）。clone 落 job 本地目录，
  // 不涉本机路径穿越，故跳过下面的本地路径白名单校验。
  if (isRemoteRepo(repo)) {
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/i.test(repo)) {
      throw new Error(`远程 repo 仅支持 https://github.com/<owner>/<repo>：${repo}`);
    }
    return;
  }
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

// 冷启动可安全恢复的状态：非「运行中」的都可原样恢复
const RESTART_SAFE = new Set<JobState>(["queued", "done", "failed"]);

/**
 * 从磁盘补齐 registry（server 重启后 /run /status 仍能定位已 plan 过的 job）。
 * 优先读持久化快照(C1)拿真实状态 + prUrl/appUrl;无快照则从 loop.json 粗略推断。
 * 冷启动 reconcile：快照里「运行中」的状态(planning/coding/reviewing)必是被重启打断的
 * ——进程已死、没有在跑，标 failed(可 /run 重跑),避免永久卡在 coding。
 */
async function findJobRecord(jobId: string): Promise<JobRecord | undefined> {
  const cached = registry.get(jobId);
  if (cached) return cached;
  const jobs = await scanJobs(config.watchDirs);
  const job = jobs.find((j) => j.manifest.id === jobId);
  if (!job) return undefined;
  const { clientSlug, projectSlug } = clientProjectFromSpecDir(job.jobDir);

  const snap = await readStatus(job.jobDir);
  const rec: JobRecord = {
    jobId,
    specDir: job.jobDir,
    repo: job.manifest.repo,
    clientSlug,
    projectSlug,
    state: deriveState(job),
    updatedAt: new Date().toISOString(),
  };
  if (snap) {
    const snapState = snap.state as JobState;
    if (RESTART_SAFE.has(snapState)) {
      rec.state = snapState;
    } else {
      // 运行中被重启打断
      rec.state = "failed";
      rec.error = `server 重启,原状态「${snap.state}」的运行已中断(可重跑)`;
    }
    rec.prUrl = snap.prUrl;
    rec.appUrl = snap.appUrl;
    if (rec.state === "failed" && !rec.error) rec.error = snap.error;
    rec.updatedAt = snap.updatedAt;
  }
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

  // B1：/plan 入队秒返回,不同步跑 planSpec（planner 分钟级,会让 hack5 的 CF Worker 超时 502）。
  // jobId 确定可复现 = projectSlug（manifest.id = basename(specDir) = projectSlug）。
  // 真正的拆规格 planSpec 由后台 job 先跑(needsPlan),再跑任务闭环,进度/结果走 /status + 回调。
  const jobId = projectSlug;
  const rec: JobRecord = {
    jobId,
    specDir,
    repo,
    clientSlug,
    projectSlug,
    state: "planning",
    needsPlan: true,
    updatedAt: new Date().toISOString(),
  };
  registry.set(jobId, rec);
  void persist(rec);
  enqueue(jobId); // 后台:planSpec → 任务闭环
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
