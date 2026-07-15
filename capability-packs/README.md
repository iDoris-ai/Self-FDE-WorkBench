# Capability Packs

> 把已有后端（生成 skill / blog 发布脚本 / agent-reach）抽象成可复用「能力包」，供 fde-copilot、loop-engineer 和 blog 按需调用——**不每次重造**。含网页账号配置。

`Self-FDE-WorkBench` 第三个子项目。

## 核心

- **pack** = 一份清单（`packs/<id>/pack.json`）：`category`(generate/publish/research) + `backend`(local/script/cli/skill/http) + `needsAuth`。真正的活交给已有后端，pack 只是薄适配。
- **registry** 扫描所有 pack；**invoke** 查 pack → 过账号闸 → 跑后端 / 交回 agent。
- **账号走网页**：用户在配置页填各平台凭证（公众号 AppID/Secret、小红书 Cookie…），存本地 `accounts/<平台>.json`（**gitignored，绝不入库**）；发布类 pack 缺账号会被 `blocked`，指引去网页配置。

## 首批能力包

| id | 类别 | 后端 | 账号 |
|---|---|---|---|
| `generate-illustration` | generate | 本地 FLUX（`adapters/gen-illustration.sh`） | 无 |
| `research-fetch` | research | agent-reach（skill，只读抓取） | 无 |
| `publish-wechat` | publish | blog `publish.sh`（官方 API） | **公众号 AppID/Secret** |
| `publish-xhs` | publish | blog `publish-xhs.sh`（M3 automation） | **小红书 Cookie** |

## 用

```bash
cd capability-packs
pnpm install
pnpm web           # http://127.0.0.1:4141  ← 网页配账号 + 试生成
pnpm packs list    # 列能力包
pnpm packs accounts
pnpm packs invoke generate-illustration --prompt "minimalist black ink line art, a fox reading"
pnpm packs invoke publish-xhs --content note.txt   # 未配账号会被拦，指引去网页配置
```

## agent 怎么用

两个 agent 载入 `registry`，按需 `invoke(packId, input)`：
- fde-copilot 产出客户交付物时调 `generate-illustration` / `market-research`；
- loop-engineer 完成后调发布类把成果发出去（先确认账号已配）；
- `skill` 型 pack（如 `research-fetch`）返回一个指令，让 agent 用 Skill 工具执行。

## 安全

- 账号凭证只存本地 `accounts/`，gitignored，网页只回显打码占位、不回传明文。
- 网页只绑 `127.0.0.1`。
- 发布类一律先过账号闸，缺则拒绝并指引配置——不会拿空凭证乱发。

## 扩展

加能力 = 加一个 `packs/<id>/pack.json`（+ 需要时一个 adapter 脚本）；加平台 = 在 `src/types.ts` 的 `PLATFORMS` 加一项（网页自动渲染其配置表单）。
