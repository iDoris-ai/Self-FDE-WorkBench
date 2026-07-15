import { promises as fs } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";

/** 用量：token + 计算量(墙钟) + 成本估算 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** 成本估算（USD）：claude 用 SDK 报告值；openai-chat 用价表估 */
  costUsd: number;
  /** 计算量代理：模型墙钟毫秒（"计算秒" = computeMs/1000） */
  computeMs: number;
  /** 调用次数 */
  calls: number;
}

export const ZERO: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
  computeMs: 0,
  calls: 0,
};

export function add(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd + b.costUsd,
    computeMs: a.computeMs + b.computeMs,
    calls: a.calls + b.calls,
  };
}

// —— 成本估算价表（USD / 1M token，[输入, 输出]）——
// 粗估，可按实际账单调整；claude 直接用 SDK 的 total_cost_usd 不走这里。
const PRICE: Record<string, [number, number]> = {
  "glm-5.1": [1.4, 4.4],
  "glm-5": [1.0, 3.0],
  "kimi-k2.7-code": [0.6, 2.5],
  "kimi-k2.5": [0.6, 2.5],
  "deepseek-v4-pro": [0.5, 2.0],
  "deepseek-v4-flash": [0.1, 0.4],
};

export function estimateCost(model: string | undefined, inTok: number, outTok: number): number {
  if (!model) return 0;
  const p = PRICE[model];
  if (!p) return 0;
  return (inTok * p[0] + outTok * p[1]) / 1_000_000;
}

// —— 账本（持久化在项目 .loop/usage.json，gitignored）——
export interface Ledger {
  total: Usage;
  byProvider: Record<string, Usage>;
  updatedAt: string;
}

const LEDGER_PATH = path.join(PROJECT_ROOT, ".loop", "usage.json");

export async function loadLedger(): Promise<Ledger> {
  try {
    return JSON.parse(await fs.readFile(LEDGER_PATH, "utf8")) as Ledger;
  } catch {
    return { total: ZERO, byProvider: {}, updatedAt: new Date().toISOString() };
  }
}

/** 记一笔用量（provider 名 → 累加进 total 与 byProvider），带时间戳 */
export async function recordUsage(providerName: string, u: Usage, now: string): Promise<void> {
  const l = await loadLedger();
  l.total = add(l.total, u);
  l.byProvider[providerName] = add(l.byProvider[providerName] ?? ZERO, u);
  l.updatedAt = now;
  await fs.mkdir(path.dirname(LEDGER_PATH), { recursive: true });
  await fs.writeFile(LEDGER_PATH, JSON.stringify(l, null, 2), "utf8");
}

// —— 展示格式化 ——
export const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;
export const fmtCost = (u: number) => (u >= 0.01 ? `$${u.toFixed(2)}` : `$${u.toFixed(4)}`);
export const fmtSecs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
};
