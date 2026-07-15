import { spawn } from "node:child_process";
import type { ResolvedProvider } from "./config.js";

export interface RunAgentOpts {
  cwd: string;
  provider: ResolvedProvider;
  /** 限制工具（如 reviewer 只读）。不传则用默认全量 + skip-permissions */
  allowedTools?: string[];
  /** 硬禁工具（deny 优先级高于 skip-permissions，用于把 reviewer 收成只读） */
  disallowedTools?: string[];
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
  if (opts.disallowedTools && opts.disallowedTools.length) {
    // deny 优先于 skip-permissions，确保 reviewer 即便 skip 也无法写/跑命令
    args.push("--disallowedTools", ...opts.disallowedTools);
  }
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

/**
 * OpenAI 兼容单发调用（HiLinkup 等网关）。无 agentic 工具——上下文（diff/规格）
 * 由调用方拼进 messages。用于 reviewer/planner/回流 这类"喂上下文→出 JSON"的角色。
 */
export async function runChat(
  system: string,
  user: string,
  opts: { provider: ResolvedProvider; maxTokens?: number; timeoutMs?: number },
): Promise<RunAgentResult> {
  const { provider } = opts;
  if (!provider.baseUrl || !provider.apiKey || !provider.model) {
    throw new Error(`runChat 需要 openai-chat 供应商（有 baseUrl/apiKey/model）：${provider.name}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180_000);
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: opts.maxTokens ?? 4000,
        // 不设 temperature：部分模型（如 kimi-k2.7-code）只接受默认值
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`${provider.name} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { text: j.choices?.[0]?.message?.content ?? "", provider: provider.name };
  } finally {
    clearTimeout(timer);
  }
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
