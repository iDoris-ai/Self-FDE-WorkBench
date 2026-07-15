# 架构 · Loop-Engineer v0

## 模块图

```
cli.ts ──────────── plan / run[--once|--drain] / status
  │
  ├─ config.ts ····· 读 loop-engineer.config.json + .env；LOOP_* 覆盖；resolveProvider()
  ├─ jobs.ts ······· scanJobs(watchDirs) 找 loop.json；nextTask(依赖就绪) ；saveJob；journal
  ├─ planner.ts ···· 规格 → 任务队列（planner 供应商，写 loop.json）
  └─ orchestrator.ts ─ runTask() 单任务闭环
        ├─ providers.ts ── runAgent(prompt, provider)：spawn `claude -p` + env 覆盖 / mock
        ├─ git.ts ──────── worktree（含专用集成 worktree）/ 分支 / 合并 / PR
        └─ gate.ts ─────── runGate()：顺序跑 verify 命令，收集失败日志
```

## 供应商统一原语

`runAgent(prompt, { provider })` 是唯一的模型调用入口：

- `claude`：不覆盖 env → 用本机订阅（`claude login`）。
- `glm`/`kimi`：覆盖 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL`（及 haiku/small-fast 同源，避免后台调用回落 Anthropic）→ 同一个 `claude -p` 进程改指第三方 Anthropic 兼容端点。
- `mock`：不 spawn，跑本地 handler，用于无 key 验证编排。

输出用 `--output-format json` 取 `.result`；reviewer/planner 的结构化裁决用 `extractJson()` 稳健抽取（容忍 ```json 包裹与前后废话）。

## worktree 隔离策略

关键：**目标 repo 的主工作树全程不被 checkout 打扰**。

- 所有 worktree 建在 `<repo>/../.loop-wt/<repoName>/` 下。
- 一个**专用集成 worktree**（`__integration__`）常驻，checkout 到集成分支；所有 `--no-ff` 合并在这里做。
- 每个任务一个临时 worktree，分支起点 = 集成分支当前 tip；任务结束即 `worktree remove`。
- 因此任务间零冲突，串行合并顺序可控，用户手头的 repo 不受影响。

## 单任务状态机（orchestrator.runTask）

```
todo → in_progress
  loop attempt 1..maxAttempts:
     coder 编码 → commitAll(任务分支)
     runGate：install + commands 顺序跑
        fail → feedback=失败日志 → 下一轮返工
     reviewer 跨模型审 → extractJson 裁决
        !approved → feedback=blocking → 下一轮返工
        approved → 成功，break
  成功 → openPr(尽力) → mergeToIntegration(--no-ff) → done
  失败 → attempts 到顶 = failed，否则 blocked（不合并）
finally → 删任务 worktree + saveJob + journal
```

`nextTask` 只挑 `dependsOn` 全 `done` 的 `todo` 任务；`run` 每轮只跑一个任务再重扫（串行，v0 决策）。

## 安全与 back-pressure

- `maxAttempts` 封顶返工，杜绝无限循环。
- 双验证：deterministic 质量闸（必须全绿）+ 跨模型评审（另一个模型挑错），缺一不 merge。
- 只自动并到 `integrationBranch`，`main` 由人守（v0 合并策略决策）。
- reviewer 用 `--allowedTools Read/Grep/Glob/Bash` + prompt 约束"不改文件"，只审不写。

## 已验证（`pnpm smoke` + 失败路径）

- happy path：两任务 worktree→mock 编码→闸过→评审过→顺序 `--no-ff` 并入集成分支，主干不动，依赖顺序正确。
- 失败路径：闸持续失败 → 返工 3 次触顶 → 标记 `failed`，不合并、不死循环。

## 与 fde-copilot 的衔接

```
fde-copilot/clients/<客户>/*.md   ← loop-ready 规格
        │  pnpm plan（planner=Claude 拆解）
        ▼
   同目录 loop.json（tasks + verify）
        │  watchDirs 轮询命中
        ▼
   Loop-Engineer 逐任务实现 → 集成分支 → 你 review 入主干
```

## v0 未做（见 PLAN.md 路线）

- MCP 直连 fde-copilot 取任务（v0 走文件轮询）
- 多 worktree 并行（v0 串行）
- 多 repo 编排、失败自动回流给 fde-copilot 反问客户、测试结果回灌规格
