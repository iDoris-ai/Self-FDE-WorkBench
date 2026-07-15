import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";
import { resolveProvider } from "./config.js";
import type { Config, LoadedJob, ReviewVerdict, Task } from "./types.js";
import { runAgent, runChat, extractJson } from "./providers.js";
import {
  ensureIntegrationWorktree,
  createTaskWorktree,
  removeWorktree,
  commitAll,
  hasChanges,
  mergeToIntegration,
  openPr,
  diffAgainst,
} from "./git.js";
import { runGate } from "./gate.js";
import { saveJob, appendJournal } from "./jobs.js";
import { reportBlocked } from "./feedback.js";

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
  // per-task 模型路由：任务可覆盖全局默认（难任务派更强的模型）
  const coder = resolveProvider(task.coderProvider ?? config.providers.coder);
  if (coder.kind === "openai-chat") {
    // agentic 编码需 Anthropic 端点或 codex；OpenAI 网关（HiLinkup）不能直接驱动 claude -p
    task.status = "failed";
    task.lastResult = `coder 不能用 OpenAI 网关(${coder.name})：agentic 编码需 Anthropic 端点(claude/glm/kimi/deepseek 直连)或 codex`;
    log.err(`  ${task.lastResult}`);
    await saveJob(job);
    return { ok: false, status: "failed", detail: task.lastResult };
  }
  const innerReviewer = resolveProvider(task.reviewerProvider ?? config.providers.reviewer);
  // 评审面板：内层（快、便宜）+ 可选外层（如 deepseek，独立第二意见），双过才 merge
  const reviewers = [{ tag: "内层", provider: innerReviewer }];
  if (config.providers.outerReviewer) {
    reviewers.push({ tag: "外层", provider: resolveProvider(config.providers.outerReviewer) });
  }

  const integrationWt = await ensureIntegrationWorktree(repo, job.manifest.baseBranch, integration);
  const branch = `loop/${job.manifest.id}/${task.id}`;
  task.branch = branch;

  log.step(`任务 ${task.id} · ${task.title}`);
  await appendJournal(
    job,
    task.id,
    `开始（coder=${coder.name} reviewers=${reviewers.map((r) => r.provider.name).join("+")}）`,
  );

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

      // 跨模型评审面板（内层 + 可选外层），任一打回即返工
      const reviewPrompt = reviewerTpl.replace("{{TASK_BLOCK}}", tb);
      // 评审 diff 预先算好，喂给两类 reviewer（agentic 也不必自己跑 git，从而可收成只读）
      const reviewDiff = await diffAgainst(wt, integration);
      // 单次评审调用（agentic 或 chat）
      const callReviewer = async (rp: (typeof reviewers)[number]): Promise<string> => {
        if (rp.provider.kind === "openai-chat") {
          return (
            await runChat(
              "你是严格、对抗性的代码评审员。直接输出一个 JSON 对象，第一个字符就是 {，不要任何解释文字或 markdown。",
              `${reviewPrompt}\n\n${reviewDiff}`,
              { provider: rp.provider },
            )
          ).text;
        }
        return (
          await runAgent(`${reviewPrompt}\n\n${reviewDiff}`, {
            cwd: wt,
            provider: rp.provider,
            // reviewer 只读：只给检索工具，并硬禁写/命令（deny 优先于 skip-permissions）
            allowedTools: ["Read", "Grep", "Glob"],
            disallowedTools: ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"],
            mockHandler: rp.provider.isMock ? mockReviewer(task) : undefined,
          })
        ).text;
      };

      let panelPassed = true;
      for (const r of reviewers) {
        log.info(`  ${r.tag}评审（${r.provider.name}）`);
        // 解析重试：评审输出非 JSON 只是模型格式抖动，重试评审而非返工重编（省 token、防误判）
        let verdict: ReviewVerdict | null = null;
        for (let ri = 1; ri <= 2 && !verdict; ri++) {
          verdict = extractJson<ReviewVerdict>(await callReviewer(r));
          if (!verdict && ri < 2) log.warn(`  ${r.tag}评审输出非 JSON，重试解析(${ri}/2)`);
        }

        if (!verdict) {
          // 两次都拿不到可解析裁决：保守放行本层（gate 已过），避免格式问题空转返工
          log.warn(`  ${r.tag}评审两次均无法解析，gate 已过，保守放行本层`);
          await appendJournal(job, task.id, `⚠ ${r.tag}评审输出无法解析，gate 已过→放行`);
          continue;
        }
        if (!verdict.approved) {
          feedback = `${r.tag}评审打回（score ${verdict.score}）：\n${verdict.blocking.map((b) => `- ${b}`).join("\n")}`;
          lastDetail = `${r.tag}评审打回：${verdict.summary}`;
          log.warn(`  ${lastDetail} → 返工`);
          await appendJournal(job, task.id, `✗ ${r.tag}评审打回：${verdict.summary}`);
          panelPassed = false;
          break;
        }
        log.ok(`  ${r.tag}评审通过（score ${verdict.score}）`);
      }
      if (!panelPassed) continue;

      // 全部评审通过
      success = true;
      lastDetail = `通过（${reviewers.length} 层评审）`;
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
      // v0.2 失败回流：把技术失败翻译成面向客户的澄清问题，回写规格目录 GAPS.md
      try {
        await reportBlocked(job, task, `${lastDetail}\n\n${feedback}`, config);
      } catch (e) {
        log.warn(`  回流失败：${(e as Error).message}`);
      }
    }
  } finally {
    await removeWorktree(repo, wt);
    await saveJob(job);
  }

  return { ok: success, status: task.status, detail: lastDetail };
}
