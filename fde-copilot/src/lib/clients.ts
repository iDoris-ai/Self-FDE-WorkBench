import { promises as fs } from "node:fs";
import path from "node:path";
import type { ClientState, ConversationEntry } from "./types";
import { SPEC_DOCS } from "./types";

// 客户目录根：<project>/clients/<slug>/
export const CLIENTS_DIR = path.join(process.cwd(), "clients");

export function clientDir(slug: string): string {
  return path.join(CLIENTS_DIR, slug);
}

export function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `client-${Date.now()}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// —— 文档骨架（新客户初始化时写入，agent 后续就地填充）——
function docScaffold(name: string, now: string): Record<string, string> {
  const header = (title: string, hint: string) =>
    `# ${title}\n\n> 客户：${name} ｜ 创建：${now}\n> ${hint}\n> 本文件由 FDE Copilot 随每轮对话自动维护。\n\n_（尚未开始，等待客户首次输入）_\n`;
  return {
    "SPEC.md": header("需求规格 · Spec", "问题定义 / 目标 / 范围 / 成功指标 / 非目标"),
    "PRODUCT.md": header("产品描述 · Product", "一句话定位 / 目标用户 / 核心价值 / 关键场景"),
    "FEATURES.md": header("Feature 细节", "每个 feature：用户故事 + 验收标准 + 边界/异常 + 优先级"),
    "TECH_SPEC.md": header("技术方案 · Tech Spec", "架构 / 数据模型 / 接口契约 / 依赖 / 部署 / 技术风险"),
    "INTERACTIONS.md": header("交互流程与验收", "逐步用户交互 + 每步检查/验收标准（可被自动化测试消费）"),
    "GAPS.md":
      `# 缺口台账 · Gaps\n\n> 客户：${name} ｜ 创建：${now}\n> 【调研假设·待确认】= AI 查到但需客户拍板；【待客户回答】= 只有客户知道；【已关闭】= 已确认。\n\n## 待客户回答\n\n_（暂无）_\n\n## 调研假设·待确认\n\n_（暂无）_\n\n## 已关闭\n\n_（暂无）_\n`,
    "INTAKE.md":
      `# 原始需求记录 · Intake\n\n> 客户：${name} ｜ 创建：${now}\n> 客户每轮原话/输入的累积摘要（只追加，不删历史）。\n`,
  };
}

export async function listClients(): Promise<ClientState[]> {
  if (!(await exists(CLIENTS_DIR))) return [];
  const entries = await fs.readdir(CLIENTS_DIR, { withFileTypes: true });
  const out: ClientState[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const state = await readState(e.name);
    if (state) out.push(state);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readState(slug: string): Promise<ClientState | null> {
  const p = path.join(clientDir(slug), "state.json");
  if (!(await exists(p))) return null;
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as ClientState;
  } catch {
    return null;
  }
}

export async function writeState(state: ClientState): Promise<void> {
  const p = path.join(clientDir(state.slug), "state.json");
  await fs.writeFile(p, JSON.stringify(state, null, 2), "utf8");
}

export async function createClient(name: string): Promise<ClientState> {
  const slug = slugify(name);
  const dir = clientDir(slug);
  if (await exists(dir)) {
    throw new Error(`客户「${slug}」已存在`);
  }
  await fs.mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const nowh = now.slice(0, 10);

  const scaffold = docScaffold(name, nowh);
  await Promise.all(
    Object.entries(scaffold).map(([file, content]) =>
      fs.writeFile(path.join(dir, file), content, "utf8"),
    ),
  );

  const state: ClientState = {
    slug,
    name,
    createdAt: now,
    updatedAt: now,
    rounds: 0,
    status: "intake",
    lastReadiness: null,
  };
  await writeState(state);
  await fs.writeFile(path.join(dir, "conversation.jsonl"), "", "utf8");
  return state;
}

export async function readDoc(slug: string, file: string): Promise<string | null> {
  if (!SPEC_DOCS.includes(file as never)) return null;
  const p = path.join(clientDir(slug), file);
  if (!(await exists(p))) return null;
  return fs.readFile(p, "utf8");
}

export async function readAllDocs(slug: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of SPEC_DOCS) {
    const c = await readDoc(slug, file);
    if (c != null) out[file] = c;
  }
  return out;
}

export async function appendConversation(slug: string, entry: ConversationEntry): Promise<void> {
  const p = path.join(clientDir(slug), "conversation.jsonl");
  await fs.appendFile(p, JSON.stringify(entry) + "\n", "utf8");
}

export async function readConversation(slug: string): Promise<ConversationEntry[]> {
  const p = path.join(clientDir(slug), "conversation.jsonl");
  if (!(await exists(p))) return [];
  const raw = await fs.readFile(p, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ConversationEntry);
}
