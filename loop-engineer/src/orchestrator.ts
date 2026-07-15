import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";
import { resolveProvider } from "./config.js";
import type { Config, LoadedJob, ReviewVerdict, Task } from "./types.js";
import { runAgent, extractJson } from "./providers.js";
import {
  ensureIntegrationWorktree,
  createTaskWorktree,
  removeWorktree,
  commitAll,
  hasChanges,
  mergeToIntegration,
  openPr,
} from "./git.js";
import { runGate } from "./gate.js";
import { saveJob, appendJournal } from "./jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS = path.resolve(__dirname, "..", "prompts");

async function prompt(name: string): Promise<string> {
  return fs.readFile(path.join(PROMPTS, name), "utf8");
}

function taskBlock(task: Task, integrationBranch: string): string {
  return [
    `- 任务 ID：${task.id}`,
    `- 标题：${task.title}`,
    `- 说明：${task.spec}`,
    `- 验收标准：\n${task.acceptance.map((a) => `    - ${a}`).join("\n") || "    （无）"}`,
    task.files.length ? `- 建议改动范围：${task.files.join(", ")}` : "",
    `- 集成分支（diff 基线）：${integrationBranch}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// —— mock 处理器（无 key 时跑通编排）——
function mockCoder(task: Task) {
  return async (_p: string, cwd: string): Promise<string> => {
    const f = path.join(cwd, `feature_${task.id}.txt`);
    await fs.writeFile(f, `mock implementation for ${task.id}: ${task.title}\n`, "utf8");
    return `[mock coder] 创建 feature_${task.id}.txt`;
  };
}
function mockReviewer(task: Task) {
  return async (): Promise<string> => {
    const v: ReviewVerdict = {
      approved: true,
      score: 90,
      blocking: [],
      suggestions: [],
      summary: `[mock reviewer] ${task.id} 通过`,
    };
    return JSON.stringify(v);
  };
}

export interface RunTaskResult {
  ok: boolean;
  status: Task["status"];
  detail: string;
}

/**
 * 跑单个任务的完整闭环：worktree → coder → gate → 跨模型 review → 返工(≤maxAttempts)
 * → PR(尽力) → 合并集成分支 → 标记 done。
 */
export async function runTask(job: LoadedJob, task: Task, config: Config): Promise<RunTaskResult> {
  const repo = job.repoPath;
  const integration = job.manifest.integrationBranch;
  const coder = resolveProvider(config.providers.coder);
  const reviewer = resolveProvider(config.providers.reviewer);

  const integrationWt = await ensureIntegrationWorktree(repo, job.manifest.baseBranch, integration);
  const branch = `loop/${job.manifest.id}/${task.id}`;
  task.branch = branch;

  log.step(`任务 ${task.id} · ${task.title}`);
  await appendJournal(job, task.id, `开始（coder=${coder.name} reviewer=${reviewer.name}）`);

  const wt = await createTaskWorktree(repo, integration, branch);
  const tb = taskBlock(task, integration);
  const workerTpl = await prompt("worker.md");
  const reviewerTpl = await prompt("reviewer.md");

  let feedback = "";
  let success = false;
  let lastDetail = "";

  try {
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      task.attempts = attempt;
      log.info(`  尝试 ${attempt}/${config.maxAttempts} · 编码中（${coder.name}）`);

      const workerPrompt = workerTpl
        .replace("{{TASK_BLOCK}}", tb)
        .replace("{{FEEDBACK_BLOCK}}", feedback || "（首轮，无返工反馈）");
      await runAgent(workerPrompt, {
        cwd: wt,
        provider: coder,
        mockHandler: coder.isMock ? mockCoder(task) : undefined,
      });

      const committed = await commitAll(wt, `feat(${task.id}): ${task.title} [attempt ${attempt}]`);
      if (!committed && !(await hasChanges(wt))) {
        // 首轮就没产出任何改动 → 判 blocked
        if (attempt === 1) {
          lastDetail = "coder 未产生任何改动";
          await appendJournal(job, task.id, `⚠ ${lastDetail}`);
          break;
        }
      }

      // 质量闸
      log.info(`  质量闸（${job.manifest.verify.commands.length} 步）`);
      const gate = await runGate(wt, job.manifest.verify);
      if (!gate.passed) {
        feedback = `质量闸失败：\n${gate.failureLog}`;
        lastDetail = `质量闸失败（尝试 ${attempt}）`;
        log.warn(`  ${lastDetail} → 返工`);
        await appendJournal(job, task.id, `✗ 质量闸失败 → 返工`);
        continue;
      }

      // 跨模型 review
      log.info(`  跨模型评审（${reviewer.name}）`);
      const reviewPrompt = reviewerTpl.replace("{{TASK_BLOCK}}", tb);
      const rev = await runAgent(reviewPrompt, {
        cwd: wt,
        provider: reviewer,
        allowedTools: ["Read", "Grep", "Glob", "Bash"],
        mockHandler: reviewer.isMock ? mockReviewer(task) : undefined,
      });
      const verdict = extractJson<ReviewVerdict>(rev.text);

      if (!verdict) {
        feedback = "评审未返回可解析的裁决，请确保改动清晰。";
        lastDetail = "评审输出无法解析";
        log.warn(`  ${lastDetail} → 返工`);
        continue;
      }
      if (!verdict.approved) {
        feedback = `评审打回（score ${verdict.score}）：\n${verdict.blocking.map((b) => `- ${b}`).join("\n")}`;
        lastDetail = `评审打回：${verdict.summary}`;
        log.warn(`  ${lastDetail} → 返工`);
        await appendJournal(job, task.id, `✗ 评审打回：${verdict.summary}`);
        continue;
      }

      // 通过
      success = true;
      lastDetail = `通过（评审 score ${verdict.score}）`;
      log.ok(`  ${lastDetail}`);
      break;
    }

    if (success) {
      const pr = await openPr(
        repo,
        branch,
        integration,
        `loop(${task.id}): ${task.title}`,
        `自主编码循环完成任务 ${task.id}。\n\n${task.spec}\n\n验收：\n${task.acceptance.map((a) => `- ${a}`).join("\n")}`,
      );
      await mergeToIntegration(integrationWt, branch, `Merge ${branch}: ${task.title}`);
      task.status = "done";
      task.lastResult = `${lastDetail}；${pr.detail}`;
      log.ok(`  合并进 ${integration}；${pr.detail}`);
      await appendJournal(job, task.id, `✓ 完成并合并（${pr.opened ? pr.url : "本地集成"}）`);
    } else {
      task.status = task.attempts >= config.maxAttempts ? "failed" : "blocked";
      task.lastResult = lastDetail;
      log.err(`  任务未通过：${lastDetail}`);
      await appendJournal(job, task.id, `✗ 收工未通过：${lastDetail}`);
    }
  } finally {
    await removeWorktree(repo, wt);
    await saveJob(job);
  }

  return { ok: success, status: task.status, detail: lastDetail };
}
