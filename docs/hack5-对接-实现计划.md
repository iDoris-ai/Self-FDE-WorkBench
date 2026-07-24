# WorkBench × hack5 Mini 对接 —— 本仓库实现计划

> **给谁看**:在本仓库(`Self-FDE-WorkBench`)跑 `/loop` 的执行者。按本文从上到下把 W1–W7 实现掉,
> 每项**独立分支 + 自测(`tsc --noEmit`)+ 开 PR,禁止自动合并**,等人 review。
>
> **协作背景**:hack5.net 的 Mini 黑客松(面向非开发者)要让参赛者「输入一句想法 → 自动生成规格 → 自动编码 →
> 入库到参赛者命名的**公有**仓库(hack5 方 PAT 账户下)→ 部署上线」。hack5 侧(客户端/建仓/UI/计费)自己建,
> 对着 mock 已在推进。**本仓库要补齐 W1–W7 这几个对接能力**。协同任务在 Seeder:
> **Cooperation-Center 项目 · CC-51**(标签 `repo:workbench`,发起方 `from:hack5-net`)。

---

## 0. 现状与工具链

- **fde-copilot**(Next.js,`src/app/api/*`):`clients` / `clients/[client]/projects` / `chat` / `commit` / `usage` 五个 API 已在;鉴权 `src/lib/auth.ts`(`x-workbench-token`)。→ **接口契约 §1 已就绪,不用改。**
- **loop-engineer**(TS CLI,`src/*`):`cli.ts` 已支持 `plan <specDir> --repo <repoPath> [--base] [--verify]`(`src/cli.ts:42`);编排 `orchestrator.ts:runTask`、规划 `planner.ts:planSpec`、push `git.ts`、job 模型 `jobs.ts`、用量 `usage.ts`。**没有 HTTP。**
- **工具链**:根 `pnpm`;`loop-engineer` 用 `tsx` + `pnpm typecheck`(`tsc --noEmit`);`fde-copilot` 用 Next.js(`pnpm typecheck` / `pnpm build`)。
- **提交规范**:conventional commits(`feat:` / `docs:` / `chore:`)。
- **重要**:**写代码 + typecheck 不需要 Mac Mini 在线**。真实端到端(跑真模型/真 push/真部署)留到 Mini 起来 + hack5 侧就绪。所以本文每项都能**先对 mock/桩落地**。

---

## 1. 接口契约(双方共同合同 —— 唯一真相来源,两边都按这个建)

鉴权:所有调用带 `x-workbench-token: <WORKBENCH_TOKEN>`。

```
# 已就绪(fde-copilot,勿改形状)
POST /api/clients              { name, background }                         → { client:{slug,...} }
POST /api/clients/:c/projects  { name, deliverableName, deliverableType }   → { project:{slug,...} }
POST /api/chat                 { clientSlug, projectSlug, input, attachments? }
                               → { result:{ readiness:{ score, loop_ready } }, commit }
POST /api/commit               { clientSlug, projectSlug, push, repo? }      → { pushed, sha, ... }   ← repo 为 W2 新增
GET  /api/usage                → { global, perProject, at }

# 新增(loop-engineer 薄 HTTP,W1)
POST /plan   { clientSlug, projectSlug, repo }  → { jobId }
POST /run    { jobId }                          → { started }
GET  /status/:jobId                             → { state: queued|planning|coding|reviewing|done|failed, prUrl?, appUrl? }

# 新增(回调,W5)  hack5 接收端 POST <WORKBENCH_CALLBACK_URL>
{ event:'loop_ready'|'coding_done'|'deployed', clientSlug, projectSlug, repo, appUrl? }
```

### 1.1 契约 v2 修订(定稿 2026-07-20,CC-51 对齐后)—— 以下**覆盖**上面初版对应处

契约评审发现几处矛盾/安全点,hack5 已逐条拍板。**按 v2 建**:

- **/run 改入队语义**(B1):`POST /run {jobId}` → `{ accepted:true, jobId, queuePos }`;`GET /status` 保留真实 `queued` 态。v1 **串行队列**(忙则入队,不返 409);并发(W7)往后放。
- **push token 安全**(B2,**最高优先硬约束**):产出仓落在**隔离 bot 账户**(如 `hack5-mini-bot`,不挂主 org);每个想法用**仓库级、短时效 fine-grained token**(或 GitHub App installation token,scope 仅该 repo);**token 对 loop 代码执行沙箱不可见**——不进 `env`/`loop.json`/worktree,只在 push 边界用。**绝不下发 account 级 PAT。**
- **双层鉴权**(B3):编排调用(clients/projects/plan/run/commit)用 hack5 的 **admin `WORKBENCH_TOKEN`**;参赛者会话(chat)用 hack5 **HMAC 签发的作用域 token**(claim 含 client/project 路径),WorkBench 验签 + 比对路径子树。
- **远程可达**(B4):端点**保持本机绑定 + `WORKBENCH_TOKEN` 鉴权**,hack5 经**鉴权隧道**打入、隧道改写 Host 过 `dashboard.ts:197` 的 127.0.0.1 校验。不裸露公网。
- **状态机**(C1):复用 `dashboard.ts:235` 已有 `/api/run`·`/status`·`/progress`·`/journal`,补**持久化 per-job 状态机** `queued→planning→coding→reviewing→done→failed` + `prUrl`/`appUrl`。
- **回调加固**(C2):回调体加 **HMAC 签名**(`WORKBENCH_CALLBACK_SECRET`)+ 重试 + 幂等键。
- **部署范围**(C3):v1 只支持**静态 + CF Worker/Pages Functions**;全栈/要 DB 的产出 v1 不接。
- **计费**(C4):成本模型(token 加价 + 机时 + CF)**Phase 2** 落地;v1 只记录用量,免费/付费由 hack5 侧 `plan='paid'` 控制。
- **幂等/失败/jobId**(Q1–Q3):`(client, participant)` 幂等键,重复 `/plan` 返回同一 jobId/repo 不重复建仓;`status` 加 `failed` + 30min 超时 + `maxAttempts=3` 重试 + 失败保留 branch 标记;`jobId = manifest.id`,`loop.json` 写 `../fde-copilot/clients/<c>/projects/<p>/`。

> **W1 起步提示**:先复用 `dashboard.ts` 那 60% 脚手架,别从零写 server.ts。

---

## 2. 可执行任务(按此顺序,PR-per-item)

### W1 — loop-engineer 薄 HTTP 编排 API 【最高优先 · 最大阻塞】
- **目标**:让 hack5(Cloudflare Worker,碰不到 Mac Mini 文件系统)能远程触发编码循环。
- **改哪**:新增 `loop-engineer/src/server.ts`(Node `http` 或轻量框架),复用现有函数:
  - `POST /plan` → 调 `planSpec(specDir, config, { repo })`(`planner.ts`);specDir 由 `{clientSlug, projectSlug}` 映射到 `../fde-copilot/clients/<c>/projects/<p>/`;返回 `jobId`(用 `jobs.ts` 的 job 模型)。
  - `POST /run` → 调 `runTask(job, task, config)`(`orchestrator.ts`)。
  - `GET /status/:jobId` → 读 `jobs.ts` job 状态,映射到契约的 `{state, prUrl?, appUrl?}`。
  - 鉴权复用 `WORKBENCH_TOKEN`(与 fde-copilot 一致的 header 校验,可抽 `loop-engineer/src/auth.ts`)。
  - `package.json` 加 `"serve": "tsx src/server.ts"`。
- **验收**:本地 `pnpm serve` 后,`curl -H x-workbench-token:... POST /plan` → 拿到 jobId → `POST /run` → `GET /status/:id` 能查到状态流转。coder/reviewer 用 `mock`(见 `loop-engineer.config.json` 的 notes)即可无 key 跑通编排,**不需要 Mini**。
- **分支**:`feat/loop-http-api`。

### W2 — commit/push 与 loop 输出可指定目标仓库
- **目标**:把 spec + 代码推到**参赛者命名的那个公有仓库**(hack5 方 PAT 账户下),而非内部默认 remote。
- **改哪**:
  - `fde-copilot/src/app/api/commit/route.ts`:已收 `push`,**加收 `repo`**(远程 URL)透传。
  - `fde-copilot/src/lib/git.ts`:支持"设置/覆盖 remote + 用注入的 push token push 到 `repo`"(注释已写「push 仅在显式要求且已配置 remote 时执行」,在此扩展)。
  - loop 侧:`cli.ts` 的 `--repo` 已在,补统一的 **push token 注入**(env 或请求参数,由 hack5 侧提供 PAT token;不硬编码)。
- **验收**:指定 `repo` 后,`/api/commit` 把 spec 推到该仓库;loop 跑完把代码也推到同一仓库。可先用一个测试用公有仓库验证。
- **分支**:`feat/commit-target-repo`。

### W3 — per-participant 实例/会话隔离 + 作用域 token
- **目标**:每个参赛者一个隔离入口,token 按参赛者作用域(替代单一 `WORKBENCH_TOKEN`)。
- **改哪**:目录隔离 `clients/<client>/projects/<participant>/` 已在(`src/lib/clients.ts`);把 `src/lib/auth.ts` 从"单 token 全通"升级为"按 client/participant 作用域校验 token"(可先设计 token 形如 `<client>:<participant>:<sig>`,HMAC 签名)。
- **验收**:两个参赛者的 token 各自只能访问自己的 project;越权返回 401/403。
- **分支**:`feat/scoped-token`。

### W4 — per-idea 建仓 + 部署自动化 hook
- **目标**:loop 跑完产出可访问在线 URL。
- **建议(待 hack5 确认)**:**部署归 hack5**,WorkBench 只在 loop 完成时回调(见 W5),不持有部署凭据——职责更清晰、更安全。若最终要 WorkBench 自己部署,则在 `orchestrator.ts` 末尾加 deploy hook(建 CF 项目 + `wrangler deploy`)。
- **验收**:loop 完成后,通过回调或 hook,最终有一个可访问的 `appUrl`。
- **分支**:`feat/deploy-hook`。**先在 CC-51 上问 hack5 部署环归属再动手。**

### W5 — 回调 webhook
- **目标**:免 hack5 轮询。
- **改哪**:`orchestrator.ts` 在 `loop_ready` / `coding_done` / `deployed` 各阶段 `POST` 到 `WORKBENCH_CALLBACK_URL`,body 按契约 `{event, clientSlug, projectSlug, repo, appUrl?}`;失败重试 + 幂等。
- **验收**:三个事件都能打到一个测试接收端(可用 webhook.site 或本地 stub)。
- **分支**:`feat/callback-webhook`。

### W6 — 计量 → 出账单接口
- **目标**:对齐 Mini「免费 1 场 / 之后后付费 / 可赞助代付」。
- **改哪**:`fde-copilot/src/app/api/usage/route.ts` + `src/lib/usage.ts` 已有 per-project token 用量;加**按 client 聚合**(`GET /api/usage?client=<slug>` 返回该黑客松各 participant 的 token 汇总)。
- **验收**:给定 client,返回其下各 participant 的 token 用量聚合。
- **分支**:`feat/usage-by-client`。

### W7(可选)— 并发
- **目标**:一场 mini 几十个想法并行。
- **改哪**:`orchestrator.ts` 现单串行;多 worktree 并行(v0.4)。
- **分支**:`feat/concurrent-loops`。低优先,最后做。

---

## 3. 纪律(每项都遵守)

1. **独立分支 + 独立 PR**,一项一个,不混。
2. 落地前:`pnpm typecheck`(相应子项目)必过;能对 mock/桩本地自测的就测。
3. **禁止自动合并**——开 PR 后停下,等人 review + approve 再合并。
4. Conventional commits(`feat:`/`docs:`/`chore:`)。
5. 每完成一项,到 Seeder **CC-51** 追一条 `[repo:workbench] 工兵回复`,把该 W 的**交付状态**从 `⏳` 更新为 `✅ 已实现(PR: <url>)`。可用 `/goutou` 或直接在 Seeder 评论。
6. 遇到需要 hack5 确认的点(如 W4 部署归属),在 CC-51 上 `@repo:hack5-net` 提问,不自己拍板跨仓语义。

---

## 4. 阻塞边界

- **今晚可自主**:W1、W2、W3、W5、W6 的**编码 + typecheck**(对 mock/桩),不依赖 Mac Mini。
- **需 hack5 确认后再动**:W4(部署环归属)。
- **真实端到端联调**:依赖 ① Mac Mini(claude login + 便宜模型 key)② hack5 侧 A1–A7 就绪 ③ 我方 PAT push token —— 留到最后统一联调,别卡住前面的编码。

---

*实现计划稿。协同任务:Seeder · Cooperation-Center · CC-51。hack5 侧对应文档见 hack5-net 仓库 `docs/mini-workbench-对接计划.md`。WorkBench · AuraAI × hack5 · Mycelium。*
