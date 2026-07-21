import { promises as fs } from "node:fs";
import path from "node:path";
import { JobManifest } from "./types.js";
import type { LoadedJob, Task } from "./types.js";
import { PROJECT_ROOT } from "./config.js";
import { isRemoteRepo } from "./git.js";

/** 远程仓 clone 到 job 目录下的这个子目录（编码/回推都在这份本地 clone 上做）。 */
const LOCAL_CLONE_DIR = ".loop-repo";

const MANIFEST = "loop.json";

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === MANIFEST) out.push(full);
    else if (e.isDirectory()) await walk(full, depth - 1, out);
  }
}

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

/** 扫描 watchDirs（深度有限）找所有 loop.json，解析成 job */
export async function scanJobs(watchDirs: string[]): Promise<LoadedJob[]> {
  const found: string[] = [];
  for (const d of watchDirs) {
    await walk(resolveFromRoot(d), 4, found);
  }
  const jobs: LoadedJob[] = [];
  for (const manifestPath of found) {
    const job = await loadJob(manifestPath);
    if (job) jobs.push(job);
  }
  return jobs;
}

export async function loadJob(manifestPath: string): Promise<LoadedJob | null> {
  try {
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const manifest = JobManifest.parse(raw);
    const jobDir = path.dirname(manifestPath);
    // 远程 URL：不能当本地路径 path.resolve（会拼成 .../https:/github.com/... 的假路径），
    // 而是指向 job 目录下的本地 clone（processJob 会先 ensureClone 到这里再编码）。
    const remote = isRemoteRepo(manifest.repo);
    const repoPath = remote
      ? path.join(jobDir, LOCAL_CLONE_DIR)
      : path.isAbsolute(manifest.repo)
        ? manifest.repo
        : path.resolve(jobDir, manifest.repo);
    return {
      manifest,
      jobDir,
      manifestPath,
      repoPath,
      remoteUrl: remote ? manifest.repo : undefined,
    };
  } catch {
    return null;
  }
}

export async function saveJob(job: LoadedJob): Promise<void> {
  await fs.writeFile(job.manifestPath, JSON.stringify(job.manifest, null, 2) + "\n", "utf8");
}

/** 下一个可开工任务：todo 且依赖全 done。返回 null 表示该 job 无待办 */
export function nextTask(job: LoadedJob): Task | null {
  const doneIds = new Set(job.manifest.tasks.filter((t) => t.status === "done").map((t) => t.id));
  for (const t of job.manifest.tasks) {
    if (t.status !== "todo") continue;
    if (t.dependsOn.every((d) => doneIds.has(d))) return t;
  }
  return null;
}

export function hasPending(job: LoadedJob): boolean {
  return job.manifest.tasks.some((t) => t.status === "todo" || t.status === "in_progress");
}

/** 写任务级 journal（append），外部记忆，供人回溯 */
export async function appendJournal(job: LoadedJob, taskId: string, line: string): Promise<void> {
  const dir = path.join(job.jobDir, ".loop");
  await fs.mkdir(dir, { recursive: true });
  const at = new Date().toISOString();
  await fs.appendFile(path.join(dir, "journal.md"), `- \`${at}\` **${taskId}** ${line}\n`, "utf8");
}
