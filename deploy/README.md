# WorkBench · Cloudflare 常驻部署（CC-58）

把 WorkBench 从"某台常驻 Mac Mini"搬成 **7×24 在线的 Cloudflare 容器服务**，与 hack5 前台（本身跑在 CF Workers 上）在线衔接。hack5 接口零改动——继续调原来的 `/plan /run /status /deploy` + 收 W5 回调，只是对端换成稳定的 CF 容器 endpoint，不再受本机开关机/睡眠影响。

## 形态

| 组件 | Worker | 容器端口 | 域名（建议） | 说明 |
|---|---|---|---|---|
| loop-engineer | `workbench-loop-engineer` | 4050 | `loop.aastar.io` | plan→code→review→push→deploy 引擎（单例容器） |
| fde-copilot | `workbench-fde-copilot` | 3939 | `workbench.aastar.io` | 诉求→规格 对话器（单例容器） |

每个 Worker = 薄代理，`getContainer(binding,"singleton").fetch(request)` 透传请求到单例容器；容器内跑原封不动的 loop-engineer / fde-copilot，认证/回调等 secret 由 CF Secret 注入容器 env。**默认云模式 `EXECUTION_MODE=api`：零本机 `claude login` 订阅、零官方 Anthropic key。**

## 认证模型（重要）

模型全走**现有云 key**，都进 CF Secret：
- `HILINKUP_API_KEY` —— planner / reviewer 单发 chat（OpenAI 兼容网关，一 key 多模型）。
- `DEEPSEEK_API_KEY` + `DEEPSEEK_BASE_URL`(`https://api.deepseek.com/anthropic`) + `DEEPSEEK_MODEL` —— agentic coder（Anthropic 兼容端点，HiLinkup 无 Anthropic 端点驱动不了 `claude -p`）。fde-copilot 的 full agent-sdk 路径也回落这个端点。

**没有官方 Anthropic key，没有本机订阅。** 本机 `claude login` 仅在显式 `EXECUTION_MODE=local`（自建/离线开发）时启用。

## 前置

1. Cloudflare 账号已开 **Containers（Workers 付费计划，beta）**。
2. 本机 `wrangler login`（或设 `CLOUDFLARE_API_TOKEN`）。
3. 本机有可用 **Docker**（wrangler 本地构建镜像再推到 CF）。
   - ⚠️ 若你本机 Docker 走本地代理（如 `~/.docker/config.json` 的 `127.0.0.1:7890`），确保 OrbStack/Docker 能正常拉 Docker Hub 镜像后再 `wrangler deploy`。
4. 域名 `loop.aastar.io` / `workbench.aastar.io` 在你的 CF 账号（用于 Custom Domain）。

## 部署（两个 Worker 各来一次）

### loop-engineer

```bash
cd deploy/loop-engineer
pnpm install

# —— 配 Secret（值不入库，交互输入）——
wrangler secret put WORKBENCH_TOKEN            # 端点鉴权（fail-closed，必配）
# chat 级联：Workers AI（下方 CF Token）→ deepseek-chat（DEEPSEEK_API_KEY）→ HiLinkup
wrangler secret put HILINKUP_API_KEY           # chat 级联末档兜底
wrangler secret put HILINKUP_BASE_URL          # https://hilinkup.com/v1
wrangler secret put DEEPSEEK_API_KEY           # coder(anthropic 端点) + chat 级联第2档(deepseek-chat)共用
wrangler secret put DEEPSEEK_BASE_URL          # https://api.deepseek.com/anthropic （coder 用）
wrangler secret put DEEPSEEK_MODEL             # deepseek-v4-pro （coder 用；chat 档默认 deepseek-chat）
wrangler secret put WORKBENCH_CALLBACK_URL     # hack5 的 W5 回调接收端
wrangler secret put WORKBENCH_CALLBACK_SECRET  # 回调 HMAC 共享密钥
wrangler secret put WORKBENCH_PUSH_TOKEN       # 回推参赛者仓库（仓库级 fine-grained）
wrangler secret put CLOUDFLARE_API_TOKEN       # Workers AI(planner/reviewer 默认) + /deploy CF Pages
wrangler secret put CLOUDFLARE_ACCOUNT_ID      # Workers AI REST 端点用
# 可选：WORKERS_AI_MODEL（默认 @cf/meta/llama-3.3-70b-instruct-fp8-fast）/ LOOP_CHAT_FALLBACK
# 可选：LOOP_CONCURRENCY / LOOP_JOB_TIMEOUT_MS / LOOP_REPO_ROOT / WORKBENCH_ALLOWED_ORIGINS

pnpm run deploy                                # wrangler 构建镜像 + 部署
# 部署后：CF Dashboard → 该 Worker → Settings → Domains & Routes → 加 loop.aastar.io
```

### fde-copilot

```bash
cd deploy/fde-copilot
pnpm install

wrangler secret put WORKBENCH_TOKEN
wrangler secret put WORKBENCH_SCOPED_SECRET    # 参赛者作用域 token（hack5 HMAC 签发）
wrangler secret put HILINKUP_API_KEY           # 快 chat 直连（默认路径）
wrangler secret put DEEPSEEK_API_KEY           # full agent-sdk 路径回落端点
wrangler secret put DEEPSEEK_BASE_URL
wrangler secret put DEEPSEEK_MODEL
wrangler secret put WORKBENCH_PUSH_TOKEN        # 把 spec push 到参赛者公有仓库
# 可选：WORKBENCH_PUSH_BRANCH / WORKBENCH_ALLOWED_PUSH_HOSTS / AGENT_MAX_TURNS / CHAT_FULL_SPEC

pnpm run deploy
# 部署后加 Custom Domain：workbench.aastar.io
```

## 冒烟验证

```bash
# 1. 云 endpoint 活着（401 = 要 token，正常）
curl -i https://loop.aastar.io/status/nope

# 2. 带 token 打一个 job（示例）
curl -X POST https://loop.aastar.io/plan \
  -H "x-workbench-token: $WORKBENCH_TOKEN" -H "content-type: application/json" \
  -d '{"clientSlug":"smoke","projectSlug":"t1","repo":"https://github.com/<you>/<repo>"}'

# 3. hack5 把它对接的 WorkBench endpoint 指到 loop.aastar.io，跑一个 idea：
#    badge 应从 排队 → 构建 → 上线 正常推进，且 Mac Mini 关机也不受影响。
```

## 已知取舍（最小版）

- **单例容器**：loop-engineer 的 job 队列/worktree 在内存+本地磁盘，必须命中同一实例（`max_instances: 1`）。要并发扩容需把编排（队列/状态机/W5 回调）搬进 Worker + Durable Objects/Workflows —— 留作后续（A 的完整版）。
- **`sleepAfter: "1h"`**：容器空闲 1h 才休眠；容器磁盘 ephemeral（重启即清）。长任务鲁棒化（跨重启续跑）同样属后续编排改造。
- 镜像构建在 `wrangler deploy` 时本地进行（需 Docker + 能拉 Docker Hub）。
