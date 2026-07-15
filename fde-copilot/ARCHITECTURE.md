# 架构 · FDE Copilot v0

## 全景

```
┌─────────────────────────── 浏览器 (Next.js UI) ───────────────────────────┐
│  客户列表        │   多模态对话流         │   实时 loop-ready 规格文档       │
│  建客户/切客户   │   输入→回复+待答问题   │   6 类文档 tab + 就绪度 + commit │
└──────┬───────────────────┬────────────────────────────┬───────────────────┘
       │ /api/clients       │ /api/chat                   │ /api/commit
       ▼                    ▼                             ▼
┌──────────────────────── Next.js API (Node runtime) ──────────────────────┐
│  clients.ts (文件存储)   agent.ts (Agent SDK)   git.ts (提交客户目录)      │
└──────────────────────────────────┬───────────────────────────────────────┘
                                    │ query() · cwd=clients/<slug>
                                    ▼
┌──────────────────── Claude Agent SDK (复用订阅认证) ──────────────────────┐
│  system.md 角色       内置工具 Read/Write/Edit/WebSearch                   │
│  自定义工具 submit_turn(结构化结果回传)                                    │
│  在客户目录里就地读写 6 类 spec 文档                                       │
└──────────────────────────────────┬───────────────────────────────────────┘
                                    ▼
                         clients/<slug>/*.md  ──git──▶  下游 Claude Code loop
```

## 一轮对话的数据流（`/api/chat`）

1. 记录客户输入到 `conversation.jsonl`
2. `runTurn()`：以客户目录为 cwd 起一个 Agent SDK `query()`
   - 注入 `prompts/system.md` 为 system prompt（定义 FDE 角色 + loop-ready 硬门槛）
   - 挂内置工具（Read/Write/Edit/WebSearch/WebFetch）+ 自定义 `submit_turn`
   - `settingSources: []` 隔离大 repo 的 CLAUDE.md；`permissionMode: bypassPermissions` 免交互
   - agent：读现状 → 融合更新文档 → 检缺口 → 调研/抛问题 → 评就绪 → 调 `submit_turn` 一次
3. 从 `submit_turn` 拿到结构化 `TurnResult`（reply / open_questions / research_notes / readiness / updated_docs）
4. 写回 `conversation.jsonl` + 更新 `state.json`
5. 可选 `AUTO_COMMIT` → `git.ts` 提交客户目录

## 关键设计取舍

- **文档即状态**：spec 文档本身就是累积记忆，agent 每轮读盘获取上下文，不依赖长 session。历史用 `conversation.jsonl` 兜底注入最近几轮。
- **结构化回传用工具而非解析文本**：`submit_turn` 用 zod schema 强约束，UI 拿到干净结构，agent 写文件与回传解耦。
- **缺口两条腿**：能自己查的（技术选型/行业惯例）走 WebSearch 写进文档并标「调研假设·待确认」；只有客户知道的（商业决策/优先级）抛 `open_questions`。
- **隔离**：每个客户一个 cwd，`settingSources:[]` 避免串味；git 只提交该客户目录。
- **提交默认手动**：`AUTO_COMMIT` 默认关，UI 有 commit / commit+push 按钮，符合"改动出仓前先确认"。

## 已留的扩展点

- 多模态：`/api/chat` 的 `attachments` 字段与 agent prompt 的附件提示已就位；接入语音转写 / PDF·Word·图片解析后，把文件落到客户目录、文件名进 `attachments` 即可，agent 用 Read 读。
- 输出目标：`git.ts` 目前提交本 repo 子目录；换成 per-client GitHub repo 只需改这一层。
- 下游 loop：commit 后可触发一个「照 spec 建系统」的 Claude Code loop，其测试输出作为新一轮 `customerInput` 回流，形成自完善飞轮。
```
