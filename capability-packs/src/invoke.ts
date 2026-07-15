import { spawn } from "node:child_process";
import path from "node:path";
import { getPack } from "./registry.js";
import { ROOT, missingAuth, authEnv } from "./accounts.js";
import { platform } from "./types.js";

export interface InvokeResult {
  ok: boolean;
  /** blocked=账号未配，需先在网页配置 */
  blocked?: boolean;
  /** skill 型：交回给 agent 用 Skill 工具执行 */
  mode?: "skill";
  skill?: string;
  missing?: Array<{ id: string; name: string }>;
  message: string;
  output?: string;
  exitCode?: number;
}

/** 把 cmd 里非绝对路径解析到能力包根 */
function resolveCmd(cmd: string): string {
  const first = cmd.split(/\s+/)[0];
  if (first.startsWith("/") || first.startsWith("./") === false) return cmd;
  return path.resolve(ROOT, cmd);
}

/**
 * 调一个能力包。发布类先过账号闸（缺则 blocked，指引去网页配置）；
 * 生成/研究直接跑后端；skill 型交回 agent。
 */
export async function invoke(
  packId: string,
  input: Record<string, string> = {},
): Promise<InvokeResult> {
  const pack = await getPack(packId);
  if (!pack) return { ok: false, message: `未知能力包：${packId}` };

  // 账号闸
  if (pack.needsAuth.length) {
    const miss = await missingAuth(pack.needsAuth);
    if (miss.length) {
      return {
        ok: false,
        blocked: true,
        missing: miss.map((id) => ({ id, name: platform(id)?.name ?? id })),
        message: `缺少账号配置：${miss.map((id) => platform(id)?.name ?? id).join("、")}。请先在网页「账号配置」里填好再发布。`,
      };
    }
  }

  const b = pack.backend;
  if (b.type === "skill") {
    return {
      ok: true,
      mode: "skill",
      skill: b.skill,
      message: b.note ?? `请用 Skill 工具调用 ${b.skill}`,
    };
  }
  if (!b.cmd) return { ok: false, message: `pack ${packId} 后端缺 cmd` };

  // local / script / cli：注入账号凭证 + 输入变量，bash 执行
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(await authEnv(pack.needsAuth)),
  };
  for (const [k, v] of Object.entries(input)) env[`INPUT_${k.toUpperCase()}`] = v;

  const cmd = resolveCmd(b.cmd);
  const cwd = b.cwd ? (path.isAbsolute(b.cwd) ? b.cwd : path.resolve(ROOT, b.cwd)) : ROOT;

  return new Promise<InvokeResult>((resolve) => {
    const child = spawn("bash", ["-lc", cmd], { cwd, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => resolve({ ok: false, message: `启动失败：${e.message}`, output: out }));
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        message: code === 0 ? `${pack.name} 执行完成` : `${pack.name} 退出码 ${code}`,
        output: out.slice(-4000),
      });
    });
  });
}
