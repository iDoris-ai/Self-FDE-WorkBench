// CC-58 · fde-copilot 的 Cloudflare Worker + Container 前置代理
//
// 形态：单例容器（客户会话/spec 文件写在本地磁盘 + git push 交付；同会话须命中同一实例）。
// Worker 透传请求；fde-copilot 自身用 x-workbench-token / scoped token 鉴权（fail-closed）。
// 默认云模式 EXECUTION_MODE=api：full agent-sdk 路径走 DeepSeek 云端点，零本机订阅。
import { Container, getContainer } from "@cloudflare/containers";

const PASSTHROUGH_KEYS = [
  // 鉴权
  "WORKBENCH_TOKEN",
  "WORKBENCH_SCOPED_SECRET",
  // 模型云 key（快 chat 直连 HiLinkup；full 路径回落 DeepSeek 云端点；均非 Anthropic 官方）
  "HILINKUP_API_KEY",
  "HILINKUP_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_MODEL",
  "ANTHROPIC_API_KEY", // 可选兜底，非默认
  "CLAUDE_MODEL",
  // git push（把 spec 推到参赛者公有仓库）
  "WORKBENCH_PUSH_TOKEN",
  "WORKBENCH_PUSH_BRANCH",
  "WORKBENCH_ALLOWED_PUSH_HOSTS",
  // 行为可调
  "AGENT_MAX_TURNS",
  "CHAT_FULL_SPEC",
  "CHAT_WEBSEARCH",
] as const;

export interface Env {
  FDE_COPILOT: DurableObjectNamespace<FdeCopilotContainer>;
  [key: string]: unknown;
}

function buildEnvVars(env: Env): Record<string, string> {
  const vars: Record<string, string> = {
    EXECUTION_MODE: "api",
    NODE_ENV: "production",
    // CC-61：/api/plan 代理转发目标（「上传现成 spec 一键构建」）。默认指向常驻 loop-engineer。
    LOOP_ENGINEER_URL:
      (typeof env.LOOP_ENGINEER_URL === "string" && env.LOOP_ENGINEER_URL) ||
      "https://loop.aastar.io",
  };
  for (const k of PASSTHROUGH_KEYS) {
    const v = env[k];
    if (typeof v === "string" && v.length > 0) vars[k] = v;
  }
  return vars;
}

export class FdeCopilotContainer extends Container<Env> {
  defaultPort = 3939;
  requiredPorts = [3939];
  sleepAfter = "1h";
  enableInternet = true; // 模型 API、git push、（可选）联网调研

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = buildEnvVars(env);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 单例：同会话命中同一容器（spec 文件 + git push 交付）。Container.fetch 自动冷启并代理。
    return getContainer(env.FDE_COPILOT, "singleton").fetch(request);
  },
};
