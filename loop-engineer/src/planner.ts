import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";
import { resolveProvider } from "./config.js";
import { runAgent, runChat, extractJson } from "./providers.js";
import { JobManifest } from "./types.js";
import type { Config } from "./types.js";
import { ZERO, add } from "./usage.js";
import type { Usage } from "./usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SPEC_FILES = ["SPEC.md", "PRODUCT.md", "FEATURES.md", "TECH_SPEC.md", "INTERACTIONS.md", "GAPS.md"];

/** 读规格目录里的文档，拼成一段（供无工具的 chat 供应商） */
async function readSpecDocs(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const f of SPEC_FILES) {
    try {
      const c = await fs.readFile(path.join(dir, f), "utf8");
      parts.push(`### ${f}\n${c}`);
    } catch {
      /* 缺文件跳过 */
    }
  }
  return parts.join("\n\n---\n\n") || "（规格目录为空）";
}

interface PlanOut {
  tasks: Array<{
    id: string;
    title: string;
    spec: string;
    acceptance?: string[];
    files?: string[];
    dependsOn?: string[];
  }>;
  skipped?: string;
}

/**
 * 读 specDir 下的 loop-ready 规格，用 planner 供应商拆成任务，写/并入 specDir/loop.json。
 * 已存在的同 id 任务保留其 status（不重置进度）。
 */
const STRICT_JSON_HINT =
  "\n\n【重要】上一轮没有严格只输出可解析的 JSON。请只输出一个 JSON 对象(第一个字符就是 {)," +
  "含 tasks 数组(每项 id/title/spec/acceptance/files/dependsOn)与可选 skipped,不要任何解释文字或 markdown 代码围栏。";

/**
 * 用一个 provider 跑一次拆规格,返回 {可解析的 PlanOut 或 null, 本次用量}。调用失败会 throw。
 * strict=true 时在提示词后追加「严格只输出 JSON」指令(供同一 provider 解析失败后的重试)。
 */
async function callPlanner(
  providerName: string,
  tpl: string,
  specDir: string,
  strict = false,
): Promise<{ plan: PlanOut | null; usage: Usage }> {
  const planner = resolveProvider(providerName);
  const prompt = strict ? tpl + STRICT_JSON_HINT : tpl;
  let res;
  if (planner.kind === "openai-chat") {
    // 单发 chat：无 Read 工具，自己把规格文档拼进去
    const docs = await readSpecDocs(specDir);
    res = await runChat(prompt, `## 规格文档\n\n${docs}`, { provider: planner, maxTokens: 8000 });
  } else {
    res = await runAgent(prompt, {
      cwd: specDir,
      provider: planner,
      allowedTools: ["Read", "Grep", "Glob"],
      mockHandler: planner.isMock
        ? async () => JSON.stringify({ tasks: [], skipped: "mock" } satisfies PlanOut)
        : undefined,
    });
  }
  const plan = extractJson<PlanOut>(res.text);
  return { plan: plan && Array.isArray(plan.tasks) ? plan : null, usage: res.usage };
}

/** 拆规格并返回本 job planning 阶段的累计用量(CC-54：供 per-job 成本汇总)。 */
export async function planSpec(
  specDir: string,
  config: Config,
  opts: { repo: string; baseBranch?: string; verify?: string[] },
): Promise<Usage> {
  const tpl = await fs.readFile(path.join(__dirname, "..", "prompts", "planner.md"), "utf8");

  // planner 降级链：主选(如 hilinkup:glm-5.2)失败/无输出 → 依次降级到更稳的 provider。
  // 上游(HiLinkup)偶发 fetch failed/524 会让单一 planner 把整个 job 在 0% 打挂;有链兜底更稳。
  // 可用 LOOP_PLANNER_FALLBACK(逗号分隔)覆盖默认 deepseek→claude。
  const primary = config.providers.planner;
  // 降级先用 deepseek(便宜 0.44/0.88 且可靠——它就是 coder),claude 留最后兜底(最稳但按 API
  // 价计费很贵,一次 planning ~$0.5)。主选一般是便宜的 glm,只在其挂时才走这链。可用
  // LOOP_PLANNER_FALLBACK 覆盖。
  const fallbacks = (process.env.LOOP_PLANNER_FALLBACK ?? "deepseek,claude")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const chain = [primary, ...fallbacks.filter((f) => f !== primary)];

  let plan: PlanOut | null = null;
  let lastErr: Error | null = null;
  let planUsage: Usage = { ...ZERO };
  // 每个 provider 先自重试一次（解析失败多是模型格式抖动，重试同一便宜 provider 比降级更省），
  // 再降级到链上下一个。调用错(网络/auth)不自重试，直接降级。
  const ATTEMPTS_PER_PROVIDER = 2;
  outer: for (let i = 0; i < chain.length; i++) {
    const name = chain[i];
    for (let a = 1; a <= ATTEMPTS_PER_PROVIDER; a++) {
      const tag = `${i > 0 ? " · 降级" : ""}${a > 1 ? " · 自重试" : ""}`;
      log.step(`拆解规格 ${specDir}（planner=${name}${tag}）`);
      try {
        const r = await callPlanner(name, tpl, specDir, a > 1);
        planUsage = add(planUsage, r.usage); // 每次尝试都计成本
        plan = r.plan;
        if (plan) {
          if (i > 0 || a > 1) log.ok(`planner 用 ${name}${a > 1 ? "(自重试)" : ""} 成功拆出任务`);
          break outer;
        }
        log.warn(
          `planner ${name} 未返回可解析任务` +
            (a < ATTEMPTS_PER_PROVIDER
              ? "，同一 provider 自重试"
              : i < chain.length - 1
                ? "，降级下一个"
                : ""),
        );
      } catch (e) {
        // 调用错(网络/auth/超时) = 真故障,自重试同 provider 无意义 → 直接降级下一个
        lastErr = e as Error;
        log.warn(
          `planner ${name} 调用失败(${lastErr.message.slice(0, 80)})${i < chain.length - 1 ? "，降级下一个" : ""}`,
        );
        break; // 跳出自重试内层,进下一个 provider
      }
    }
  }
  if (!plan) {
    throw new Error(`所有 planner 均失败(${chain.join("→")})：${lastErr ? lastErr.message : "无可解析任务列表"}`);
  }
  if (plan.skipped) log.warn(`跳过（未确认）：${plan.skipped}`);

  const manifestPath = path.join(specDir, "loop.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    /* 新建 */
  }
  const prevStatus = new Map<string, string>(
    (existing.tasks as Array<{ id: string; status: string }> | undefined)?.map((t) => [
      t.id,
      t.status,
    ]) ?? [],
  );

  const manifest = JobManifest.parse({
    id: (existing.id as string) ?? path.basename(specDir),
    repo: opts.repo,
    baseBranch: opts.baseBranch ?? (existing.baseBranch as string) ?? "main",
    integrationBranch: (existing.integrationBranch as string) ?? "loop/integration",
    verify: opts.verify
      ? { commands: opts.verify }
      : (existing.verify as object) ?? { commands: [] },
    tasks: plan.tasks.map((t) => ({
      ...t,
      status: prevStatus.get(t.id) ?? "todo",
    })),
  });

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  log.ok(`写入 ${manifestPath}：${manifest.tasks.length} 个任务`);
  if (!opts.verify && (!manifest.verify.commands || manifest.verify.commands.length === 0)) {
    log.warn("loop.json 的 verify.commands 为空——请填入 typecheck/test 等质量闸命令，否则闸形同虚设");
  }
  return planUsage;
}
