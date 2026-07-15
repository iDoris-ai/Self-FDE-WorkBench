import { spawn } from "node:child_process";
import type { ResolvedProvider } from "./config.js";

export interface RunAgentOpts {
  cwd: string;
  provider: ResolvedProvider;
  /** 限制工具（如 reviewer 只读）。不传则用默认全量 + skip-permissions */
  allowedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
  /** provider.isMock 时用它替代真实调用 */
  mockHandler?: (prompt: string, cwd: string) => Promise<string>;
}

export interface RunAgentResult {
  text: string;
  provider: string;
}

/**
 * 统一原语：把一个 prompt 交给某供应商执行。
 * 真实供应商 = spawn `claude -p`，用 provider.env 覆盖端点/模型（订阅/GLM/Kimi 同一机制）。
 * mock = 本地模拟，用于无 key 跑通编排。
 */
export async function runAgent(prompt: string, opts: RunAgentOpts): Promise<RunAgentResult> {
  const { provider } = opts;

  if (provider.isMock) {
    const text = opts.mockHandler
      ? await opts.mockHandler(prompt, opts.cwd)
      : "[mock] no handler";
    return { text, provider: "mock" };
  }

  const maxTurns = opts.maxTurns ?? 60;
  const timeoutMs = opts.timeoutMs ?? 600_000;

  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--max-turns",
    String(maxTurns),
  ];
  if (opts.allowedTools && opts.allowedTools.length) {
    args.push("--allowedTools", ...opts.allowedTools);
  }

  const env = { ...process.env, ...provider.env };

  return new Promise<RunAgentResult>((resolve, reject) => {
    const child = spawn("claude", args, { cwd: opts.cwd, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`供应商 ${provider.name} 超时（${timeoutMs}ms）`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`spawn claude 失败：${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`供应商 ${provider.name} 退出码 ${code}：${stderr.slice(0, 500)}`));
        return;
      }
      resolve({ text: extractResult(stdout), provider: provider.name });
    });
  });
}

/** 从 `claude -p --output-format json` 的输出里取最终文本 */
function extractResult(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj.result === "string") return obj.result;
  } catch {
    /* 非 JSON，回退原文 */
  }
  return trimmed;
}

/** 从模型输出里稳健地抽第一个 JSON 对象（容忍 ```json 包裹与前后废话） */
export function extractJson<T>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
