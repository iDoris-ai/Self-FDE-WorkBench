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
export function resolveProvider(name: string): ResolvedProvider {
  if (name === "claude") {
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
