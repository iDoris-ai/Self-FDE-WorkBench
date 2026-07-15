# Loop-Engineer 规划与调研

## 一句话

Claude（订阅）当指挥大师，GLM/Kimi（便宜 API key）当工兵，把 fde-copilot 产出的 loop-ready 规格自主实现成代码，人只守主干。

## 调研结论（2026-07）

### 技术支点：第三方模型走 Anthropic 兼容端点

GLM 和 Kimi 都为 Claude Code 提供了 Anthropic 兼容端点，所以「用外部 agent」= 换 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL` 的 `claude` 进程：

| 供应商 | 端点 | 定价（参考） |
|---|---|---|
| GLM-5.2 (Z.ai) | `https://api.z.ai/api/anthropic` | ~$1.4/M in、$4.4/M out；或 GLM Coding Plan 包月不计 token |
| Kimi (Moonshot) | `https://api.moonshot.ai/anthropic` | 按 token，便宜 |

### 业界最佳实践（已收敛，直接采纳）

- **Ralph loop**（Geoffrey Huntley）：每轮 fresh context、**文件系统当记忆**、必须有可测验收标准才知道何时算完、用 back-pressure（约束+反馈）换自主度。→ 我们的 worker 每次是新 `claude -p` 进程，记忆在 worktree + journal；验收标准来自规格；`maxAttempts` 是 back-pressure。
- **Orchestrator-Worker**：coordinator/specialist/verifier 角色分离、per-task 模型路由、**git worktree 隔离**、自动质量闸、**跨模型 review**、顺序合并。→ 全部落进 v0。

## v0 决策（已与你确认）

| 维度 | 选择 |
|---|---|
| 任务来源 | 轮询 repo 子目录里的 loop-ready spec（文件驱动、解耦、可断点续跑） |
| 模型分工 | GLM 编码 + Kimi 跨模型审 + Claude 指挥/仲裁 |
| 合并策略 | 每任务开 PR + 自动并到集成分支，人守主干 |
| 并发/范围 | 单 repo、串行一次一任务 |

## 最难的点：验证 oracle

「返工/接受」需要客观判定，不能让模型自己说"做完了"。v0 的双保险：

1. **deterministic 质量闸**：`verify.commands`（typecheck/test/build）必须全绿——这是硬门槛。
2. **跨模型评审**：Kimi 对照验收标准挑错，输出结构化裁决。

真正的关键在**测试从哪来**：worker prompt 要求「先让验收标准可验证（补/改测试）再写实现」，让 规格验收标准 → 测试 → 实现 闭环。规格里 `acceptance` 的 Given/When/Then 就是给它的测试蓝本。**verify.commands 配得好不好，直接决定这套循环靠不靠谱**——这是接入真实项目时最该花心思的地方。

## 路线图

- **v0（已跑通）**：文件轮询 + 单 repo 串行 + GLM/Kimi/mock + 闸+跨模型审 + 集成分支合并 + 失败封顶。含 `pnpm smoke` 无 key 验证。
- **v0.1（已做）**：per-task 模型路由（`coderProvider`/`reviewerProvider`）；两层评审（内层 Kimi + 外层 DeepSeek），DeepSeek 外层 reviewer 已真实端到端验证。
- **v0.2（已做）**：失败回流——任务连续失败且判定为规格缺口时，用 planner 把技术失败翻译成面向客户的澄清问题，回写规格目录 `GAPS.md`，形成"实现受阻→反问→补规格→再实现"的飞轮。已验证写入。
- **v0.3（下一步）**：接入完整 PR-Daemon 作为**权威外层 review**（见下）。
- **v0.4**：多 worktree 并行 + 依赖图调度；多 repo 编排。
- **v0.5**：MCP 直连 fde-copilot 实时取任务；测试/运行结果回灌规格。

## PR-Daemon 集成方案（post-PR 权威 review）

**结论：不改 MCP，用「GitHub 当总线」两层 review。** PR-Daemon 已 24/7 监控 auraai 组织所有 open PR，跑 DeepSeek→Sonnet→Codex→Opus 的 2/4 轮 PK 并把 verdict 发布为 GitHub PR review——这正是"提 PR 之后的 review"。

```
Loop-Engineer 内层评审(Kimi/DeepSeek) 过 → 开 PR(→集成分支)
      │
      ▼  PR-Daemon 自动接管 → 2/4 轮 PK → verdict 发到 GitHub
      ▼
Loop-Engineer 轮询 gh pr view <n> --json reviews
   ├─ APPROVE          → 合并集成分支 → done
   └─ REQUEST_CHANGES  → 解析评论 → 喂 GLM 返工 → push → 重审（= pr-daemon 的 $pr-fix 循环）
```

- **为什么不改 MCP**：pr-daemon 是 shell/skill 驱动、绑 Claude Max + codex 的自治 loop；GitHub 本就是两边都说的集成面，包 MCP 工作量大且强耦合。
- **唯一要补**：按需触发某 PR 的 review（pr-daemon 有 `review-current.sh` / review PR #N 入口），否则等 24/7 扫到（延迟可接受）；给 loop-engineer 的 PR 打 `loop-engineer` label 便于 pr-daemon 强制走 4 轮。
- **踏脚石（已落）**：DeepSeek 当 loop-engineer 内部的外层 reviewer（pre-merge），与 pr-daemon 第一轮同源。整套 pr-daemon 之后从同一个"外层 review 接缝"接入。

## 上下文如何不偏离（context engineering）

**原则：不要把所有东西堆进一根越来越长的对话/单个 md 全程传**（LLM 过 ~100–150k token 质量掉，是漂移头号原因）。分层记忆：

| 层 | 载体 | 说明 |
|---|---|---|
| 持久·长期 | spec `.md` + `loop.json` | md=人可读真相源；**机器状态用 JSON**（status/attempts/依赖），不用散文 |
| 情节 | `.loop/journal.md` | 发生了什么，供审计与回流，不回灌进 prompt |
| 工作·短期 | 每步的 task block + 相关文件切片 | 每步 fresh；worker 用 Read **按需读文件**，不把全部 md 塞 prompt |

即 **context firewall / sub-agent 隔离**：orchestrator 握主线，每个 worker/reviewer 无状态、拿窄 brief、返回结构化结果，子 agent 的上下文永不污染主线，主线也不把全史倒给子 agent。返工只传"上一轮失败日志"一小段，不传全历史。这与 Ralph 的 fresh-context 一致，也是 Anthropic 官方 sub-agent + 上下文压缩模式。

## 成本直觉

指挥/仲裁走订阅（不额外花钱），大头 token（编码+评审）落在 GLM/Kimi 的便宜档。Claude 只在拆解规格、仲裁评审分歧等"少而关键"的地方出手。

## 来源

- Z.ai GLM-5.2 × Claude Code 接入：apidog、digitalapplied、datacamp
- Moonshot Kimi × Claude Code Anthropic 兼容端点：Moonshot 官方 issue #129、medianeth.dev
- Ralph loop：codecentric、zerosync、Geoffrey Huntley 访谈（Dev Interrupted）
- Orchestrator-Worker / worktree / 质量闸：htdocs.dev、Augment Code、addyosmani.com
