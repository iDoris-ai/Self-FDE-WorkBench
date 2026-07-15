# 部署（一）· 部署 WorkBench 平台本身

> **本文 = 把 WorkBench 平台（三个应用）架起来**，给运营方 / 自持者。
> 用户**造好的专属工具**怎么部署与跑，见 [DEPLOY-TOOL.md](./DEPLOY-TOOL.md)。经济/计价见 [ECONOMIC_MODEL.md](./ECONOMIC_MODEL.md)。

> 本套（fde-copilot / loop-engineer / capability-packs）含 **Claude Code 本地 agent + 本地 FLUX 生图**，
> 不能跑云端 serverless。标准形态：**一台常驻 Mac Mini 跑全部，Cloudflare Tunnel 映射到互联网。**

## 为什么是 Mac Mini + Tunnel

```
┌─────────────────── Mac Mini（常驻，唯一有密钥的机器）────────────────────┐
│  Claude Code（订阅登录）   本地 FLUX（生图）                              │
│  fde-copilot :3939/3940    loop-engineer 面板 :4040    cap-packs :4141    │
│  各应用只绑 127.0.0.1（不开公网端口）                                     │
│                              │ 只出站                                     │
│                        cloudflared                                        │
└──────────────────────────────┼───────────────────────────────────────────┘
                               ▼
                   Cloudflare Tunnel（自带 TLS）
                               ▼
                   Cloudflare Access（Zero Trust 登录）
                               ▼
                            互联网用户
```

- **Claude Code 必须本地常驻**：它要长驻进程、订阅登录、还要调本地 FLUX / 文件系统。云函数跑不了。
- **Tunnel 只出站**：Mac Mini 主动连 Cloudflare，不在路由器/防火墙开任何入站端口，攻击面最小。
- **密钥全留在这台机器**，不上云、不进 repo。

## 组件与端口

| 应用 | 端口 | 说明 |
|---|---|---|
| fde-copilot | 3939（旧）/ 3940（客户·项目版） | 客户售前对话 → loop-ready spec |
| loop-engineer 面板 | 4040 | 用量 + 任务状态（`pnpm exec tsx src/cli.ts dashboard`） |
| capability-packs | 4141 | 能力包 + 网页账号配置（`pnpm web`） |

正式上线后只保留一个 fde-copilot（新版），旧版可停。

## 前置

- Mac Mini（Apple Silicon，为本地 FLUX）
- `claude login`（Pro/Max 订阅，供 Claude Code 复用）
- Node 22 + pnpm
- 本地 FLUX 模型（`~/.omlx/models/FLUX.2-klein-4B-mflux-4bit` + `~/venvs/ml`）—— 见 capability-packs / banner skill
- `cloudflared`（`brew install cloudflared`）+ 一个 Cloudflare 账号 + 域名

## 步骤

### 0. 先开 FileVault（全盘加密）
系统设置 → 隐私与安全性 → FileVault → 打开。**这是用户数据静态加密的底线。**

### 1. 拉代码 + 装依赖 + 登录
```bash
git clone <repo> && cd Self-FDE-WorkBench
( cd fde-copilot && pnpm install )
( cd loop-engineer && pnpm install )
( cd capability-packs && pnpm install )
claude login          # 供 Claude Code / Agent SDK 复用订阅
```

### 2. 配密钥（都在本地，chmod 600，绝不入库）
```bash
# fde-copilot/.env —— 本机已 claude login 则无需 key；仅无人值守才填
#   WORKBENCH_TOKEN=<强随机>            # 若不叠 Cloudflare Access，至少设它
# loop-engineer/.env
#   DEEPSEEK_API_KEY / HILINKUP_API_KEY  # 编码/审用的便宜模型
# capability-packs 的平台账号（公众号 AppID/Secret、小红书 Cookie）走网页 :4141 填，
#   存到 capability-packs/accounts/*.json（已 gitignore + chmod 600）
chmod 600 */.env
```

### 3. 启动各应用（默认只绑 127.0.0.1）
```bash
( cd fde-copilot && pnpm start ) &                         # :3940
( cd loop-engineer && pnpm exec tsx src/cli.ts dashboard ) &   # :4040
( cd capability-packs && pnpm web ) &                      # :4141
```
生产建议用 **launchd** 或 **pm2** 常驻 + 开机自启（见文末）。

### 4. Cloudflare Tunnel
```bash
cloudflared tunnel login
cloudflared tunnel create workbench
# ~/.cloudflared/config.yml
```
```yaml
tunnel: <tunnel-id>
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: app.example.com      # fde-copilot
    service: http://127.0.0.1:3940
  - hostname: loop.example.com     # loop-engineer 面板
    service: http://127.0.0.1:4040
  - hostname: packs.example.com    # capability-packs
    service: http://127.0.0.1:4141
  - service: http_status:404
```
```bash
cloudflared tunnel route dns workbench app.example.com   # 每个 hostname 一条
cloudflared tunnel run workbench
```

### 5. 加鉴权：Cloudflare Access（强烈建议）
Zero Trust → Access → Applications，为每个 hostname 建一个 Self-hosted 应用，策略限定你的邮箱/组织。**这样只有登录用户能到达 Tunnel**，比应用内 shared-secret 更正规。
> capability-packs（管凭证 + 能执行 + 能发布）**务必**放 Access 后面，别裸暴露。

## 中国大陆部署（Cloudflare Tunnel 在陆不可靠时）

⚠️ **Cloudflare 的 IP 被 GFW 干扰，Tunnel 在中国大陆不保证可用/稳定**：非企业版无国内节点、Pages 在陆不可用、WARP 也被封。所以上面的 Cloudflare 方案主要适用**境外访问**。国内换方案：

| 场景 | 方案 | 备案 |
|---|---|---|
| **公网 web 访问**（对外服务） | **frp / nps 自建反向代理**：跑在有公网 IP 的国内 VPS（阿里云/腾讯云 ECS）上 frps，Mac Mini 上 frpc。阿里云/腾讯云**没有等价的免费 Tunnel 产品**，基本靠 frp 自建。 | 公网**域名需 ICP 备案**；发布公众号/小红书本就要合规 |
| **家庭私有访问**（只你/家人访问自己的 Mac Mini） | **Tailscale / ZeroTier** 之类 mesh VPN：免公网暴露、**免备案**。国内连通性看情况，可自建 **Headscale / ZeroTier moon** 提升稳定性。 | 免（不对公网开放） |

**取舍**：个人/家庭优先 mesh VPN（简单、免备案、主权强）；要真正对公众提供服务再上 frp + 备案 VPS。企业场景通常本就有备案域名和云资源，frp 或云厂商内网穿透即可。

## 密钥 / 配置清单（都在 Mac Mini 本地，不上云、不入库）

| 凭证 | 位置 | 谁用 |
|---|---|---|
| Claude 订阅 | `claude login`（`~/.claude`） | fde-copilot / loop-engineer orchestrator |
| `DEEPSEEK_API_KEY` | `loop-engineer/.env` | loop-engineer 编码 |
| `HILINKUP_API_KEY` | `loop-engineer/.env` | loop-engineer 审 / plan |
| 公众号 AppID/Secret、小红书 Cookie | `capability-packs/accounts/*.json`（网页填） | 发布类能力包 |
| `WORKBENCH_TOKEN`（可选） | `fde-copilot/.env` | 无 Cloudflare Access 时的 API 鉴权 |

全部 `.gitignore` 排除；凭证文件 `chmod 600`。

## 数据加密清单

1. **静态**：FileVault 全盘加密（底线）。凭证文件额外 `chmod 600`。
2. **传输**：Cloudflare Tunnel 全程 TLS；应用只绑 `127.0.0.1`，明文流量不出机器。
3. **应用层（可选加强）**：客户 spec / 对话目前是明文文件。要更强，可对敏感文件做应用级静态加密，密钥从 **macOS Keychain** 取、不落盘。
4. **多租户（后续工程）**：真要对外多用户，需 per-user 鉴权 + 数据隔离 + per-user 加密，属独立课题。

## 常驻（launchd 示例）

`~/Library/LaunchAgents/cv.mushroom.fde-copilot.plist`：`ProgramArguments` 指向 `pnpm start`，`WorkingDirectory` 指向 `fde-copilot`，`KeepAlive=true`，`RunAtLoad=true`。`launchctl load` 即开机自启、崩溃重拉。cloudflared 同理（或 `brew services start cloudflared`）。

## 安全 checklist（上线前逐条过）

- [ ] FileVault 已开
- [ ] 所有应用绑 `127.0.0.1`（非 0.0.0.0），公网入口只经 Tunnel
- [ ] Cloudflare Access 覆盖全部 hostname（尤其 capability-packs）
- [ ] 密钥全在本地 `.env` / `accounts/`，`chmod 600`，`git status` 干净无凭证
- [ ] 无人值守场景设了 `WORKBENCH_TOKEN`（若未用 Access）
- [ ] 小红书 Cookie 等会过期的凭证有更新提醒
