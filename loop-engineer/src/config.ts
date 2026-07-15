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
  return cfg;
}

export interface ResolvedProvider {
  name: ProviderName;
  /** 传给 claude CLI 子进程的 env 覆盖；claude=订阅无覆盖；mock=不 spawn */
  env: Record<string, string>;
  model?: string;
  isMock: boolean;
}

/**
 * 把逻辑供应商名解析成 claude CLI 的 env 覆盖。
 * - claude：本机订阅，无覆盖
 * - glm/kimi：Anthropic 兼容端点，覆盖 BASE_URL + AUTH_TOKEN + MODEL
 * - mock：本地模拟，不真调模型
 */
export function resolveProvider(name: string): ResolvedProvider {
  const n = name as ProviderName;
  if (n === "claude") {
    return { name: n, env: {}, isMock: false };
  }
  if (n === "mock") {
    return { name: n, env: {}, isMock: true };
  }
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
    // 覆盖主模型与小/快模型，避免后台调用回落到 Anthropic
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    env.ANTHROPIC_SMALL_FAST_MODEL = model;
  }
  return { name: n, env, model, isMock: false };
}
