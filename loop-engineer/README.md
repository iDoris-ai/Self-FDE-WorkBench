# Loop-Engineer

> 自主编码循环的**指挥大师**：轮询 fde-copilot 产出的 loop-ready 规格，派便宜的外部模型（GLM 编码 / Kimi 跨模型审）干活，跑「闸 → 返工 → PR → 合并」直到任务完成，你只守主干。

`Self-FDE-WorkBench` 的第二个子项目，接在 [`../fde-copilot`](../fde-copilot) 后面：fde-copilot 把客户诉求变成规格，Loop-Engineer 把规格变成代码。

## 核心思路

一个 worker 本质就是**换了 env 的 `claude -p` 子进程**——因为 GLM / Kimi 都提供 Anthropic 兼容端点。于是三家供应商统一成一个 `runAgent(prompt, provider)` 原语：

| 角色 | 默认供应商 | 认证 |
|---|---|---|
| planner / 指挥仲裁 | Claude（你的订阅） | `claude login`，零 key |
| coder | GLM-5.2 (`api.z.ai/api/anthropic`) | `GLM_API_KEY` |
| reviewer（跨模型审） | Kimi (`api.moonshot.ai/anthropic`) | `KIMI_API_KEY` |

指挥大师跑在订阅上不花钱，干活的用便宜 API key，跨模型审避免"自己审自己看不出错"。

## 一个任务的闭环

```
挑任务 → git worktree 隔离 → coder 编码/写测试 → 质量闸(install+typecheck+test)
   ↓ 过                                    ↓ 不过
Kimi 跨模型评审 ──打回──────────────────→ 返工（带失败日志，≤maxAttempts）
   ↓ approved                                  ↓ 到上限
开 PR(尽力) → --no-ff 合并进集成分支 → done   标记 failed（不合并）
```

- **Ralph 式**：每轮 worker 是 fresh context 的新进程，记忆全在磁盘（worktree 文件 + `.loop/journal.md`）。
- **back-pressure**：`maxAttempts` 封顶，闸+评审双验证，绝不无验证就 merge。
- **人守主干**：任务只自动并到 `integration` 分支，进 `main` 由你 review。

## 快速开始

```bash
cd loop-engineer
pnpm install
cp .env.example .env      # 填 GLM_API_KEY / KIMI_API_KEY；planner 用订阅无需 key

# 1) 无 key 先跑通编排（mock 供应商）
pnpm smoke

# 2) 把一份 loop-ready 规格拆成任务
pnpm plan ../fde-copilot/clients/<客户> --repo /path/to/目标repo \
  --verify "pnpm i, pnpm typecheck, pnpm test"

# 3) 启动循环（轮询 watchDirs）
pnpm run run            # 常驻；--once 只处理一个任务；--drain 清空待办后退出
pnpm run status         # 看进度
```

## 输入契约：`loop.json`

放在被监听目录（`loop-engineer.config.json` 的 `watchDirs`）下的任意子目录：

```jsonc
{
  "id": "coffee-app",
  "repo": "./repo",                       // 目标 git 仓库
  "baseBranch": "main",
  "integrationBranch": "loop/integration",
  "verify": {
    "install": "pnpm i",
    "commands": ["pnpm typecheck", "pnpm test"]   // 质量闸，全绿才算过
  },
  "tasks": [
    { "id": "T1", "title": "...", "spec": "零上下文可开工的说明",
      "acceptance": ["Given/When/Then ..."], "dependsOn": [] }
  ]
}
```

`pnpm plan` 会用 planner（Claude）读规格自动生成这个文件；`verify` 需你确认。

## 配置

`loop-engineer.config.json`（可被 `LOOP_*` 环境变量覆盖，见 `.env.example`）：

| 键 | 说明 |
|---|---|
| `watchDirs` | 轮询哪些目录找 `loop.json` |
| `pollIntervalMs` | 轮询间隔 |
| `maxAttempts` | 单任务返工上限（back-pressure） |
| `providers.{planner,coder,reviewer}` | 各角色供应商（`claude`/`glm`/`kimi`/`mock`） |

设计细节见 [ARCHITECTURE.md](./ARCHITECTURE.md)，规划与调研见 [PLAN.md](./PLAN.md)。
