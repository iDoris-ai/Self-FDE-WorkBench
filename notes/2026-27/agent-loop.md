# Agent Loop / Loop Engineering 讲义

> **一句话主旨**：单个 Agent 的本质是一个 `while(还要调工具)` 的推理循环；**Loop Engineering** 是把这个循环工程化成"自动触发 + 隔离并行 + 记忆沉淀 + 独立验证 + 状态延续"的复利系统；而真正决定成败的，是最外层那个跑在真实用户身上的慢循环。
>
> 素材来源：小红书搜索 "agent loop" 点赞前 7 篇笔记（❤1293→❤138，共 40 张图 OCR），交叉去伪后与权威一手来源对齐。

---

## 0. 为什么现在讲这个

AI 圈的操作范式三年换了四代，平均不到半年一个新词：

| 阶段 | 时间 | 你在做什么 |
|---|---|---|
| **Prompt Engineering** | 2023 | 写好一句话指令 |
| **Context Engineering** | 2025.6 | 管好喂进模型的上下文 |
| **Harness Engineering** | 2026.2 | 给单个 Agent 套缰绳（工具集 + 验证规则） |
| **Loop Engineering** | 2026.6 | 设计一个自跑系统，把"你"从循环里移出去 |

导火索：2026-06-07 独立开发者 **Peter Steinberger** 一条推文（约 150 万浏览）说"别再 prompt 你的 Agent，去设计 prompt 你 Agent 的 Loop"；次日 Google 工程师 **Addy Osmani** 发长文《Loop Engineering》把概念系统化。Claude Code 负责人 **Boris Cherny** 的原话成了标志性总结：

> "I don't prompt Claude anymore. I write loops and the loops do the work. **My job is to write loops.**"

---

## 1. 整体结构：一个词，三个尺度

"loop"在这批内容里其实指**三个层次的循环**，务必分清：

### 🔬 微观 —— 单个 Agent 的执行循环（"loop"最原始的含义）

```python
# Agent 的心脏
while stop_reason != "tool_use":   # 只要模型还要调工具，就继续
    resp   = LLM(context)                 # 1. 推理
    result = harness.run(resp.tool_call)  # 2. 执行工具
    context += result                     # 3. 观察结果回灌上下文
# 模型不再要求调工具 → 循环终止
```

**推理 → 调工具 → 观察 → 再推理**，转到模型不再调工具为止。这就是 ReAct 范式的工程落地（见 §2）。

### ⚙️ 中观 —— 工程化的自动流水线（Loop Engineering 主战场）

把上面的循环变成**可调度、可协作、会积累**的系统。Addy Osmani 给出的解剖学是五个模块：

| 模块 | 作用 | 常见实现 |
|---|---|---|
| **Automations**（心跳/调度） | 定时触发，不空转 | cron、hooks、GitHub Actions、`/goal` |
| **Worktrees**（工作隔离） | 多 Agent 并行不互撞 | git worktree，各占一分支 |
| **Skills**（记忆/规范） | 经验复利沉淀，"意图外化" | `SKILL.md` |
| **Connectors**（手臂） | 连真实世界、从"建议"变"执行" | **MCP** |
| **Sub-agents**（制衡） | 独立 verifier 审查主 Agent | 多智能体分工：探索/实现/验收 |

等价表述——"**会复利的 loop**"五要素：合适时机被触发 → 读得到历史（记忆） → 输出沉淀成 **artifact** → 记录 signal/task/log 并验证 → 状态延续到下一轮。
> 核心洞见：**Prompt 是一次性的，Loop 才会积累。**

### 🌍 宏观 —— 吴恩达的三层嵌套 loop（速度由内到外递减）

| 层 | 循环体 | 时间尺度 | 谁在循环 |
|---|---|---|---|
| **1. 编码循环** | Coding agent ↔ spec/evals | 分钟 | Agent 自写自测 → **最不重要** |
| **2. 开发者反馈循环** | 开发者的 vision | 小时 | 人从 QA 升级为**产品经理** |
| **3. 外部反馈循环** | 真实用户在真实场景的反应 | 天/周 | 唯一发生在现实世界，**决定产品生死** |

> 吴恩达的关键提醒：别用玄乎的"品味(taste)"，要用可注入系统的 **"上下文优势"(context advantage)**——你比 AI 多知道的具体知识（用户是谁、什么场景对）。品味是无法改进的黑箱，上下文优势是能持续扩大的护城河。

---

## 2. 技术原理：三个硬核点

**① ReAct 是理论根基（2022）**
动作空间 `Â = A ∪ L`：`A` 是改变环境的外部动作，`L` 是不改变环境的语言动作。输出落在 `L` 即天然终止。这后来被 API 固化成 Anthropic 的 `stop_reason` 与 OpenAI 的 `finish_reason`。

**② 停止判定是一个有限状态机**
"没有 tool call" 是唯一吸收态。为什么选它？因为 harness **不需要懂业务**——只要数返回内容里 `type:"tool_use"` 的个数就能判断，通用、可靠、跨任务复用。`stop_reason` 是二值开关（tool_use / end_turn），**没有"卡住/信息不足"的第三态**。

**③ 最大的坑：模型不知道何时该停，且"停 ≠ 完成"**
RLHF 训练奖励"更勤劳"，模型无法自我诊断"信息够不够"。工程上的补救 = **收敛信号**：
- 边际收益衰减检测
- 无进展检测（同输入反复出同输出就停）
- embedding 收敛轨迹分析
- 最重要的——**独立 verifier agent 把关**

> 警示案例（来自笔记，宜作为"轶事"看待）：有 Agent 因缺终止判据空转数百小时、烧掉数万美元；反面则是 Karpathy 的 autoresearch——极简 Agent loop 跑约 48 小时 / 数百次迭代自动做实验。

### Open vs Closed loop（成本视角）

| | Open loop | Closed loop |
|---|---|---|
| 特点 | 探索性强、烧 token、松标准 | 有边界、每步 eval、可复现 |
| 结果 | 快速产垃圾、要无限预算 | 便宜诚实、普通预算可稳跑 30h+ |

**Harness = 跑在 loop 上、用 eval/标准守住闭环的封闭执行体**：`audit(审查) → fix(修复) → review(复盘) → golden(规范沉淀)`。
**Fleet loop（舰队循环）**：Orchestrator 持目标 → 分发给多个 specialist → 每个再带 subagents，每个节点跑同一套 loop。

---

## 3. 三个陷阱（Loop Engineering 的反模式）

1. **验证盲区**——"Done" 只是 loop 的声明，不是完成证明；人是最后兜底。
2. **理解负债**——代码写得越快，你懂的 < 仓库里有的，裂缝越拉越大，不看代码就挖坑。
3. **认知投降**——loop 给啥接啥。带判断力去设计是解药，为省脑子去设计是毒药。

---

## 4. 常规技术栈

```
运行时/工具   Claude Code(/loop /goal hooks SubAgents)、Codex、Cursor
Agent 框架    Vercel AI SDK、LangGraph、smolagents、LangChain
循环范式      ReAct + 原生 tool-use API(stop_reason / finish_reason)
编排要素      git worktree(隔离)、SKILL.md(记忆)、MCP(连接)、cron/GitHub Actions(调度)
协作/落地     Linear(任务)、Slack(通知)、Playwright(验证)、CI/PR
理论出处      ReAct(2022)、Sutton "Bitter Lesson"(2019)
```

---

## 5. 一页速记

- Agent = `while(还要调工具){ 推理→执行→观察 }`
- Loop Engineering = 把这个循环 **自动化 + 隔离 + 记忆 + 验证 + 延续**
- 五模块：Automations / Worktrees / Skills / Connectors(MCP) / Sub-agents
- 三层 loop：编码(分钟) ⊂ 开发者反馈(小时) ⊂ 外部反馈(天/周)，越外层越重要
- 会踩的坑：模型不知道何时停 → 靠 verifier + 收敛信号 + eval 兜底
- 底层真相：Prompt 一次性，Loop 会积累；稀缺的不是代码，是"知道该做什么"

---

## 6. 权威引用来源

### 一手概念来源（Loop Engineering 起源）
- **Addy Osmani《Loop Engineering》原文**（2026-06-08，概念系统化）
  - Substack: https://addyo.substack.com/p/loop-engineering
  - 个人博客: https://addyosmani.com/blog/loop-engineering/
  - O'Reilly Radar 版: https://www.oreilly.com/radar/loop-engineering/
- **Boris Cherny "My job is to write loops"**（Claude Code 负责人，标志性论断）
  - 溯源分析（含原始 4 分钟片段）: https://x.com/Av1dlive/status/2064321381953675599
- **Andrej Karpathy — Autonomy Slider / AutoResearch loop**（"把自己移出循环"）
  - Fortune《The Karpathy Loop》: https://fortune.com/2026/03/17/andrej-karpathy-loop-autonomous-ai-agents-future/
  - The New Stack（自动实验脚本详解）: https://thenewstack.io/karpathy-autonomous-experiment-loop/
  - Software 3.0 / Autonomy Slider（Latent Space）: https://www.latent.space/p/s3

### 理论根基
- **ReAct: Synergizing Reasoning and Acting in Language Models**（Yao et al., ICLR 2023）
  - arXiv: https://arxiv.org/abs/2210.03629
  - 代码: https://github.com/ysymyth/ReAct
- **Rich Sutton — The Bitter Lesson**（2019-03-13）
  - 原文: http://www.incompleteideas.net/IncIdeas/BitterLesson.html

### 协议与 API 规范
- **Model Context Protocol (MCP)**
  - 官网/文档: https://modelcontextprotocol.io
  - GitHub 组织: https://github.com/modelcontextprotocol
  - 规范仓库: https://github.com/modelcontextprotocol/modelcontextprotocol
  - 参考服务器: https://github.com/modelcontextprotocol/servers
  - Anthropic 发布公告: https://www.anthropic.com/news/model-context-protocol
- **Anthropic 停止原因 / tool_use（stop_reason 状态机）**
  - Handling stop reasons: https://docs.anthropic.com/en/api/handling-stop-reasons
  - Messages API: https://platform.claude.com/docs/en/build-with-claude/working-with-messages

### Agent 框架（常规技术栈）
- **LangGraph**: https://github.com/langchain-ai/langgraph
- **LangChain**: https://github.com/langchain-ai/langchain
- **smolagents (Hugging Face)**: https://github.com/huggingface/smolagents
- **Vercel AI SDK**: https://github.com/vercel/ai ｜ 文档 https://ai-sdk.dev

### 延伸阅读（二手，导论/实战向）
- Loop Engineering 实战 Field Guide（DEV）: https://dev.to/truongpx396/the-agentic-loop-a-practical-field-guide-mnc
- "I Don't Prompt Claude Anymore, I Write Loops"（Medium）: https://medium.com/@fahey_james/i-dont-prompt-claude-anymore-i-write-loops-that-prompt-claude-57e48a4f28d7

---

*注：小红书 7 篇笔记的逐图 OCR 转录见同目录各 `NOTE.md`；本讲义为交叉综合 + 一手来源对齐后的成稿。轶事类数据（空转时长/花费、迭代次数）以原始出处为准，讲课时建议标注"据报道"。*
