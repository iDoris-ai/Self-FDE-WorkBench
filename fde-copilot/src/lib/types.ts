// 系统贯穿的类型定义

export interface ClientState {
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  rounds: number;
  status: "intake" | "building" | "testing" | "ready";
  lastReadiness: Readiness | null;
}

export interface Readiness {
  /** 0-100，规格离「下游 loop 可独立开工」的成熟度 */
  score: number;
  loop_ready: boolean;
  /** 还差哪些东西才 loop-ready */
  missing: string[];
}

export interface OpenQuestion {
  id: string;
  question: string;
  /** 为什么需要问这个（哪块规格卡在这里） */
  why: string;
}

export interface ResearchNote {
  claim: string;
  source?: string;
  /** true = 这是 AI 的调研假设，需客户确认 */
  needs_confirmation: boolean;
}

/** agent 每轮通过 submit_turn 工具交回的结构化结果 */
export interface TurnResult {
  reply: string;
  open_questions: OpenQuestion[];
  research_notes: ResearchNote[];
  readiness: Readiness;
  /** 本轮更新过的文档文件名 */
  updated_docs: string[];
}

export interface ConversationEntry {
  role: "customer" | "copilot";
  at: string;
  /** customer 侧为原始输入文本；copilot 侧为 reply */
  text: string;
  /** copilot 侧附带的结构化结果 */
  result?: TurnResult;
  /** 客户附带的文件（多模态）文件名，v0 仅记录 */
  attachments?: string[];
}

/** 客户目录里的 spec 文档清单（顺序即展示顺序） */
export const SPEC_DOCS = [
  "SPEC.md",
  "PRODUCT.md",
  "FEATURES.md",
  "TECH_SPEC.md",
  "INTERACTIONS.md",
  "GAPS.md",
  "INTAKE.md",
] as const;

export type SpecDoc = (typeof SPEC_DOCS)[number];
