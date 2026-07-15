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

- **v0（本次，已跑通）**：文件轮询 + 单 repo 串行 + GLM/Kimi/mock + 闸+跨模型审 + 集成分支合并 + 失败封顶。含 `pnpm smoke` 无 key 验证。
- **v0.1**：`plan` 打磨（从 fde-copilot 规格稳定产出高质量任务 + verify 建议）；真实接一次 GLM/Kimi 跑通端到端。
- **v0.2**：失败回流——任务连续失败或规格有歧义时，自动回写 fde-copilot 的 `GAPS.md` 抛问题给客户，形成"实现受阻→反问→补规格→再实现"的飞轮。
- **v0.3**：多 worktree 并行 + 依赖图调度；多 repo 编排。
- **v0.4**：MCP 直连 fde-copilot 实时取任务；测试/运行结果回灌规格。

## 成本直觉

指挥/仲裁走订阅（不额外花钱），大头 token（编码+评审）落在 GLM/Kimi 的便宜档。Claude 只在拆解规格、仲裁评审分歧等"少而关键"的地方出手。

## 来源

- Z.ai GLM-5.2 × Claude Code 接入：apidog、digitalapplied、datacamp
- Moonshot Kimi × Claude Code Anthropic 兼容端点：Moonshot 官方 issue #129、medianeth.dev
- Ralph loop：codecentric、zerosync、Geoffrey Huntley 访谈（Dev Interrupted）
- Orchestrator-Worker / worktree / 质量闸：htdocs.dev、Augment Code、addyosmani.com
