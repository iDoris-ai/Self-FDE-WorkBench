import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";
import { resolveProvider } from "./config.js";
import { runAgent, runChat, extractJson } from "./providers.js";
import { JobManifest } from "./types.js";
import type { Config } from "./types.js";

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
export async function planSpec(
  specDir: string,
  config: Config,
  opts: { repo: string; baseBranch?: string; verify?: string[] },
): Promise<void> {
  const planner = resolveProvider(config.providers.planner);
  const tpl = await fs.readFile(path.join(__dirname, "..", "prompts", "planner.md"), "utf8");

  log.step(`拆解规格 ${specDir}（planner=${planner.name}）`);
  let res;
  if (planner.kind === "openai-chat") {
    // 单发 chat：无 Read 工具，自己把规格文档拼进去
    const docs = await readSpecDocs(specDir);
    res = await runChat(tpl, `## 规格文档\n\n${docs}`, { provider: planner, maxTokens: 8000 });
  } else {
    res = await runAgent(tpl, {
      cwd: specDir,
      provider: planner,
      allowedTools: ["Read", "Grep", "Glob"],
      mockHandler: planner.isMock
        ? async () => JSON.stringify({ tasks: [], skipped: "mock" } satisfies PlanOut)
        : undefined,
    });
  }

  const plan = extractJson<PlanOut>(res.text);
  if (!plan || !Array.isArray(plan.tasks)) {
    throw new Error("planner 未返回可解析的任务列表");
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
}
