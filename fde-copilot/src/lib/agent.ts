import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { clientDir, readConversation } from "./clients";
import type { ConversationEntry, TurnResult } from "./types";

/**
 * 权限闸（对抗 prompt injection）：客户输入原样进 prompt，故必须硬性约束工具。
 * 文件读写/搜索路径必须落在该客户目录内；只放行检索与 submit_turn；其余（Bash/WebFetch 等）一律拒绝。
 */
function makeCanUseTool(root: string): CanUseTool {
  const base = path.resolve(root);
  const inside = (p: unknown): boolean => {
    if (typeof p !== "string" || p.length === 0) return false;
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(base, p);
    return abs === base || abs.startsWith(base + path.sep);
  };
  const PATH_KEY: Record<string, string> = {
    Read: "file_path",
    Write: "file_path",
    Edit: "file_path",
    MultiEdit: "file_path",
    NotebookEdit: "notebook_path",
  };
  return async (toolName, input) => {
    if (process.env.CANUSE_DEBUG) console.error(`[canUseTool] ${toolName}`);
    if (toolName.startsWith("mcp__workbench__")) return { behavior: "allow", updatedInput: input };
    if (toolName === "WebSearch" || toolName === "TodoWrite") {
      return { behavior: "allow", updatedInput: input };
    }
    if (toolName in PATH_KEY) {
      const p = (input as Record<string, unknown>)[PATH_KEY[toolName]];
      if (!inside(p)) return { behavior: "deny", message: `拒绝越界路径：${String(p)}（仅允许客户目录内）` };
      return { behavior: "allow", updatedInput: input };
    }
    if (toolName === "Glob" || toolName === "Grep") {
      const p = (input as Record<string, unknown>).path;
      if (p !== undefined && !inside(p)) {
        return { behavior: "deny", message: `拒绝越界搜索路径：${String(p)}` };
      }
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `工具 ${toolName} 未被安全策略允许` };
  };
}

async function loadSystemPrompt(): Promise<string> {
  const p = path.join(process.cwd(), "prompts", "system.md");
  return fs.readFile(p, "utf8");
}

// —— submit_turn：agent 每轮结束必须调用一次，把结构化结果交回网页 ——
function buildSubmitTool(sink: { value: TurnResult | null }) {
  return tool(
    "submit_turn",
    "把本轮的结构化结果交回网页 UI。每一轮结束时恰好调用一次，这是你本轮的最后一个动作。",
    {
      reply: z.string().describe("给客户看的中文回复：先小结本轮做了什么，再抛最关键的问题"),
      open_questions: z
        .array(
          z.object({
            id: z.string(),
            question: z.string(),
            why: z.string().describe("为什么需要问：哪块规格卡在这里"),
          }),
        )
        .describe("必须由客户回答的问题（只有客户知道的信息）"),
      research_notes: z
        .array(
          z.object({
            claim: z.string(),
            source: z.string().optional(),
            needs_confirmation: z.boolean().describe("true=AI 调研假设需客户确认"),
          }),
        )
        .describe("本轮你自主调研得到的结论"),
      readiness: z.object({
        score: z.number().min(0).max(100).describe("规格离下游 loop 可独立开工的成熟度"),
        loop_ready: z.boolean(),
        missing: z.array(z.string()).describe("还差哪些才 loop-ready"),
      }),
      updated_docs: z.array(z.string()).describe("本轮更新过的文档文件名"),
    },
    async (args) => {
      sink.value = args as TurnResult;
      return { content: [{ type: "text", text: "已记录，本轮结束。" }] };
    },
  );
}

function recentContext(history: ConversationEntry[], take = 6): string {
  const slice = history.slice(-take);
  if (slice.length === 0) return "（这是客户第一次输入，尚无历史。）";
  return slice
    .map((e) => `${e.role === "customer" ? "客户" : "你(Copilot)"}：${e.text}`)
    .join("\n");
}

export interface RunTurnInput {
  slug: string;
  customerInput: string;
  attachments?: string[];
}

export interface RunTurnOutput {
  result: TurnResult;
  /** 若 agent 未调用 submit_turn，用于兜底提示 */
  usedFallback: boolean;
  rawText: string;
}

/**
 * 跑一轮：给定客户新输入，让 agent 读现状→更新文档→调研→抛问题→submit_turn。
 * cwd 锁定为该客户目录，agent 直接就地读写 spec 文档。
 */
export async function runTurn(input: RunTurnInput): Promise<RunTurnOutput> {
  const dir = clientDir(input.slug);
  const system = await loadSystemPrompt();
  const history = await readConversation(input.slug);

  const sink: { value: TurnResult | null } = { value: null };
  const submitServer = createSdkMcpServer({
    name: "workbench",
    version: "1.0.0",
    tools: [buildSubmitTool(sink)],
  });

  // 附件名客户可控：只取 basename，杜绝借文件名做路径穿越/误导 Read 越界
  const safeAttachments = (input.attachments ?? []).map((a) => path.basename(a)).filter(Boolean);
  const attachNote = safeAttachments.length
    ? `\n\n客户本轮附带了文件（已存到当前目录，可用 Read 读取）：${safeAttachments.join(", ")}`
    : "";

  const prompt = `## 最近对话
${recentContext(history)}

## 客户本轮新输入
${input.customerInput}${attachNote}

## 你的任务
按 system prompt 的流程处理这轮输入：读现状 → 融合更新当前目录下的 spec 文档 → 检缺口 → 能查的自己查、只有客户知道的抛问题 → 评估 readiness → 最后调用 mcp__workbench__submit_turn 恰好一次。`;

  const maxTurns = Number(process.env.AGENT_MAX_TURNS ?? 40);
  const model = process.env.CLAUDE_MODEL || undefined;

  let rawText = "";
  for await (const msg of query({
    prompt,
    options: {
      cwd: dir,
      systemPrompt: system,
      model,
      mcpServers: { workbench: submitServer },
      // 关键：文件/搜索工具「不」放进 allowedTools——放进去会被免问放行、绕过 canUseTool。
      // 只免问放行确定安全的 WebSearch 与自有 MCP 工具；Read/Write/Edit/Glob/Grep 一律
      // 落到 canUseTool 逐次校验路径。WebFetch 既不放行也会被 canUseTool 默认拒绝（SSRF）。
      allowedTools: ["WebSearch", "mcp__workbench__submit_turn"],
      // 不加载大 repo 的 CLAUDE.md / 项目设置，保持每个客户会话隔离
      settingSources: [],
      // 不再 bypass；default + canUseTool 硬性约束路径，防越界写/读与 SSRF
      permissionMode: "default",
      canUseTool: makeCanUseTool(dir),
      maxTurns,
    },
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") rawText += block.text;
      }
    } else if (msg.type === "result" && "result" in msg && typeof msg.result === "string") {
      if (!rawText) rawText = msg.result;
    }
  }

  if (sink.value) {
    return { result: sink.value, usedFallback: false, rawText };
  }

  // 兜底：agent 没调 submit_turn，用其最终文本当回复
  const fallback: TurnResult = {
    reply: rawText || "（本轮 Copilot 未返回结构化结果，请重试或补充信息。）",
    open_questions: [],
    research_notes: [],
    readiness: { score: 0, loop_ready: false, missing: ["agent 未提交结构化结果"] },
    updated_docs: [],
  };
  return { result: fallback, usedFallback: true, rawText };
}
