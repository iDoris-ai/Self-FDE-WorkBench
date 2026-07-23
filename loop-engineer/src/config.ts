import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "./types.js";
import type { ProviderName } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");

// 加载 .env（Node 20.12+）。缺失不报错。
export function loadEnv(): void {
  const p = path.join(PROJECT_ROOT, ".env");
  try {
    process.loadEnvFile(p);
  } catch {
    /* 无 .env 也 ok，用外部环境变量 */
  }
}

export async function loadConfig(): Promise<Config> {
  const p = path.join(PROJECT_ROOT, "loop-engineer.config.json");
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    /* 用默认 */
  }
  const cfg = Config.parse(raw);

  // 环境变量覆盖（便于 mock 测试 / 临时切供应商，不改提交的配置文件）
  if (process.env.LOOP_WATCH_DIRS) {
    cfg.watchDirs = process.env.LOOP_WATCH_DIRS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.LOOP_PLANNER) cfg.providers.planner = process.env.LOOP_PLANNER;
  if (process.env.LOOP_CODER) cfg.providers.coder = process.env.LOOP_CODER;
  if (process.env.LOOP_REVIEWER) cfg.providers.reviewer = process.env.LOOP_REVIEWER;
  if (process.env.LOOP_OUTER_REVIEWER) cfg.providers.outerReviewer = process.env.LOOP_OUTER_REVIEWER;
  return cfg;
}

/**
 * 执行模式：`api`（默认，云 key 驱动，无人值守/容器可跑）| `local`（显式 opt-in，
 * 允许用本机 `claude login` 订阅）。CC-58：默认云化，彻底摆脱"某台 Mac Mini 醒着 +
 * 交互式订阅态"的硬依赖；只有显式 `EXECUTION_MODE=local` 才放行裸 `claude` 订阅 provider。
 */
export function executionMode(): "api" | "local" {
  return process.env.EXECUTION_MODE === "local" ? "local" : "api";
}

/** agentic = 起 `claude -p`（要 Anthropic 端点）；chat = 单发 OpenAI /chat/completions */
export type ProviderKind = "anthropic-agentic" | "openai-chat" | "mock";

export interface ResolvedProvider {
  name: string;
  kind: ProviderKind;
  /** anthropic-agentic：传给 claude CLI 的 env 覆盖 */
  env: Record<string, string>;
  /** openai-chat：网关 base URL / key */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  isMock: boolean;
}

/**
 * 解析供应商字符串成可执行配置：
 * - `claude`：本机订阅，agentic，无 env 覆盖
 * - `glm`/`kimi`/`deepseek`：Anthropic 兼容端点，agentic（覆盖 BASE_URL+AUTH_TOKEN+MODEL）
 * - `hilinkup` / `hilinkup:<model>`：OpenAI 兼容网关，单发 chat（一 key 多模型）
 * - `mock`：本地模拟
 */
/**
 * CC-58（jason 12:13 决策）：chat 角色（planner/reviewer）按 **key 价值级联**，用尽即切下一个。
 * 默认顺序 `workers-ai → deepseek-chat → hilinkup`（成本从低到高，先榨满已付费的 Workers AI 额度）。
 * 缺 key 的档自动跳过（不抛错）。可用 LOOP_CHAT_CASCADE 覆盖顺序。
 * 均为 openai-chat（单发）；agentic coder 走 claude -p 另算，不在此级联。
 */
export function resolveChatCascade(): ResolvedProvider[] {
  const order = (process.env.LOOP_CHAT_CASCADE || "workers-ai,deepseek-chat,hilinkup:kimi-k2.5")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: ResolvedProvider[] = [];
  for (const name of order) {
    try {
      const p = resolveProvider(name);
      if (p.kind === "openai-chat") out.push(p);
    } catch {
      /* 该档缺 key → 跳过，级联到下一个 */
    }
  }
  return out;
}

/** 级联里排在 primaryName 之后的兜底档（供 runChat 的 fallbacks 用）；primary 不在级联则整条当兜底。 */
export function chatFallbacksAfter(primaryName: string): ResolvedProvider[] {
  const casc = resolveChatCascade();
  const idx = casc.findIndex((p) => p.name === primaryName);
  return idx >= 0 ? casc.slice(idx + 1) : casc;
}

export function resolveProvider(name: string): ResolvedProvider {
  if (name === "claude") {
    // 本机 claude login 订阅 = 显式 opt-in（CC-58）。默认云模式（EXECUTION_MODE=api）下禁用，
    // 避免容器/无人值守环境里静默依赖不存在的订阅态而无限排队。切 EXECUTION_MODE=local 才放行。
    if (executionMode() !== "local") {
      throw new Error(
        `provider "claude"（本机订阅）需显式 opt-in：设 EXECUTION_MODE=local 才可用。` +
          `默认云模式请用云 provider（hilinkup:* 或 deepseek，key 走 .env / CF Secret）。`,
      );
    }
    return { name, kind: "anthropic-agentic", env: {}, isMock: false };
  }
  if (name === "mock") {
    return { name, kind: "mock", env: {}, isMock: true };
  }
  // OpenAI 兼容网关：hilinkup 或 hilinkup:<model>
  if (name === "hilinkup" || name.startsWith("hilinkup:")) {
    const model = name.includes(":") ? name.slice(name.indexOf(":") + 1) : process.env.HILINKUP_MODEL;
    const baseUrl = process.env.HILINKUP_BASE_URL || "https://hilinkup.com/v1";
    const apiKey = process.env.HILINKUP_API_KEY;
    if (!apiKey) throw new Error("hilinkup 缺少 HILINKUP_API_KEY（在 .env 配置）");
    if (!model) throw new Error(`hilinkup 需指定模型，如 "hilinkup:glm-5.1"（或设 HILINKUP_MODEL）`);
    return { name, kind: "openai-chat", env: {}, baseUrl, apiKey, model, isMock: false };
  }
  // DeepSeek 的 OpenAI 兼容端点（单发 chat）：deepseek-chat —— 用于 chat 角色级联的中间档。
  // 注意与 agentic 的 `deepseek`（anthropic 端点，驱动 claude -p）区分：那个走 /anthropic，这个走 /chat/completions。
  if (name === "deepseek-chat") {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("deepseek-chat 缺少 DEEPSEEK_API_KEY（在 .env / CF Secret 配置）");
    const baseUrl = process.env.DEEPSEEK_CHAT_BASE_URL || "https://api.deepseek.com";
    const model = process.env.DEEPSEEK_CHAT_MODEL || "deepseek-chat";
    return { name, kind: "openai-chat", env: {}, baseUrl, apiKey, model, isMock: false };
  }
  // Cloudflare Workers AI（OpenAI 兼容端点，单发 chat）：workers-ai 或 workers-ai:<model>。
  // CC-58：planner/reviewer 默认走 Workers AI（含额度）,用尽/限流 → runChat 层 failover 到 HiLinkup。
  // 容器内直连 Workers AI REST + CF API Token（CLOUDFLARE_API_TOKEN/ACCOUNT_ID 入 CF Secret）。
  if (name === "workers-ai" || name.startsWith("workers-ai:")) {
    const model = name.includes(":")
      ? name.slice(name.indexOf(":") + 1)
      : process.env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiKey = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId) throw new Error("workers-ai 缺少 CLOUDFLARE_ACCOUNT_ID（在 .env / CF Secret 配置）");
    if (!apiKey) throw new Error("workers-ai 缺少 CLOUDFLARE_API_TOKEN（在 .env / CF Secret 配置）");
    const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
    return { name, kind: "openai-chat", env: {}, baseUrl, apiKey, model, isMock: false };
  }
  const n = name as ProviderName;
  const upper = n.toUpperCase();
  const key = process.env[`${upper}_API_KEY`];
  const base = process.env[`${upper}_BASE_URL`];
  const model = process.env[`${upper}_MODEL`];
  if (!key || !base) {
    throw new Error(
      `供应商 ${n} 缺少 ${upper}_API_KEY / ${upper}_BASE_URL（在 .env 配置，或把该角色改成 mock）`,
    );
  }
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: key,
  };
  if (model) {
    // 覆盖所有模型 slot，避免 claude 内部选 opus/sonnet/haiku 时回落到 Anthropic
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    const haiku = process.env[`${upper}_HAIKU_MODEL`] || model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
    env.ANTHROPIC_SMALL_FAST_MODEL = haiku;
  }
  return { name: n, kind: "anthropic-agentic", env, model, isMock: false };
}
