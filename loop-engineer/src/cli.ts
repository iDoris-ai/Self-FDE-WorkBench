#!/usr/bin/env -S npx tsx
import { setTimeout as sleep } from "node:timers/promises";
import { log, color } from "./log.js";
import { loadConfig, loadEnv } from "./config.js";
import { scanJobs, nextTask, hasPending, saveJob } from "./jobs.js";
import { isGitRepo } from "./git.js";
import { runTask } from "./orchestrator.js";
import { planSpec } from "./planner.js";
import { startDashboard } from "./dashboard.js";
import { loadLedger, fmtTokens, fmtCost, fmtSecs } from "./usage.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

async function cmdStatus(): Promise<void> {
  const config = await loadConfig();
  const jobs = await scanJobs(config.watchDirs);
  if (jobs.length === 0) {
    log.info(`watchDirs 下没有 job（loop.json）：${config.watchDirs.join(", ")}`);
    return;
  }
  for (const job of jobs) {
    const m = job.manifest;
    const done = m.tasks.filter((t) => t.status === "done").length;
    log.raw(`\n${color.bold(m.id)}  ${color.dim(job.jobDir)}`);
    log.raw(`  repo=${job.repoPath}  集成分支=${m.integrationBranch}  ${done}/${m.tasks.length} done`);
    for (const t of m.tasks) {
      const mark =
        t.status === "done" ? color.green("✓") :
        t.status === "failed" ? color.red("✗") :
        t.status === "blocked" ? color.yellow("⁃") :
        t.status === "in_progress" ? color.cyan("▸") : "·";
      log.raw(`    ${mark} ${t.id} ${t.title} ${color.dim(`[${t.status}${t.attempts ? ` a${t.attempts}` : ""}]`)}`);
    }
  }
}

async function cmdPlan(): Promise<void> {
  const specDir = process.argv[3];
  const repo = arg("--repo");
  if (!specDir || !repo) {
    log.err("用法：loop-engineer plan <specDir> --repo <repoPath> [--base <branch>] [--verify \"cmd1,cmd2\"]");
    process.exit(1);
  }
  const config = await loadConfig();
  const verify = arg("--verify")?.split(",").map((s) => s.trim()).filter(Boolean);
  await planSpec(specDir, config, { repo, baseBranch: arg("--base"), verify });
}

async function processOneCycle(config: Awaited<ReturnType<typeof loadConfig>>): Promise<boolean> {
  const jobs = await scanJobs(config.watchDirs);
  for (const job of jobs) {
    if (!hasPending(job)) continue;
    if (!(await isGitRepo(job.repoPath))) {
      log.err(`job ${job.manifest.id} 的 repo 不是 git 仓库：${job.repoPath}（跳过）`);
      continue;
    }
    const task = nextTask(job);
    if (!task) continue; // 有 pending 但被依赖阻塞
    task.status = "in_progress";
    await saveJob(job);
    try {
      await runTask(job, task, config);
    } catch (e) {
      task.status = "failed";
      task.lastResult = (e as Error).message;
      await saveJob(job);
      log.err(`任务 ${task.id} 异常：${(e as Error).message}`);
    }
    return true; // 串行：一轮只处理一个任务，然后重扫
  }
  return false;
}

async function cmdRun(): Promise<void> {
  const config = await loadConfig();
  const once = has("--once");
  const drain = has("--drain");
  log.step(`Loop-Engineer 启动 · watchDirs=${config.watchDirs.join(", ")} · ${drain ? "drain" : once ? "once" : "daemon"}`);
  log.info(`providers：planner=${config.providers.planner} coder=${config.providers.coder} reviewer=${config.providers.reviewer}`);

  for (;;) {
    const did = await processOneCycle(config);
    if (once) {
      if (!did) log.info("无待办任务");
      break;
    }
    if (!did) {
      if (drain) {
        log.info("待办清空，drain 结束");
        break;
      }
      await sleep(config.pollIntervalMs);
    }
  }
}

async function cmdUsage(): Promise<void> {
  const l = await loadLedger();
  const t = l.total;
  log.raw(`\n${color.bold("累计用量")}  ${color.dim("(更新于 " + l.updatedAt + ")")}`);
  log.raw(`  Token：${color.cyan(fmtTokens(t.inputTokens + t.outputTokens))}（输入 ${fmtTokens(t.inputTokens)} / 输出 ${fmtTokens(t.outputTokens)}）`);
  log.raw(`  计算秒：${fmtSecs(t.computeMs)}   成本估算：${color.green(fmtCost(t.costUsd))}   调用：${t.calls}`);
  const provs = Object.entries(l.byProvider);
  if (provs.length) {
    log.raw(`\n  ${color.dim("按供应商：")}`);
    for (const [name, u] of provs) {
      log.raw(`    ${name.padEnd(26)} tok ${fmtTokens(u.inputTokens + u.outputTokens).padStart(7)}  ${fmtSecs(u.computeMs).padStart(6)}  ${fmtCost(u.costUsd)}  ×${u.calls}`);
    }
  }
}

async function main(): Promise<void> {
  loadEnv();
  const cmd = process.argv[2];
  switch (cmd) {
    case "status":
      return cmdStatus();
    case "plan":
      return cmdPlan();
    case "run":
      return cmdRun();
    case "dashboard": {
      const port = Number(arg("--port") ?? process.env.LOOP_DASHBOARD_PORT ?? 4040);
      await startDashboard(port);
      return; // http server 保持进程存活
    }
    case "usage":
      return cmdUsage();
    default:
      log.raw("Loop-Engineer — 自主编码循环指挥大师\n");
      log.raw("命令：");
      log.raw("  run [--once|--drain]                 轮询 watchDirs，串行执行任务");
      log.raw("  plan <specDir> --repo <p> [--verify] 把 loop-ready 规格拆成 loop.json 任务");
      log.raw("  status                               看所有 job/任务进度");
      log.raw("  dashboard [--port 4040]              启动网页用量面板（token/计算秒/成本）");
      log.raw("  usage                                终端打印累计用量");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  log.err(e.stack ?? String(e));
  process.exit(1);
});
