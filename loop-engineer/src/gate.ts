import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { VerifyConfig } from "./types.js";

const pexec = promisify(exec);

export interface GateStepResult {
  command: string;
  passed: boolean;
  output: string;
}

export interface GateResult {
  passed: boolean;
  steps: GateStepResult[];
  /** 失败步骤的输出拼接，喂给 worker 返工 */
  failureLog: string;
}

async function runCmd(cmd: string, cwd: string, timeoutMs = 600_000): Promise<GateStepResult> {
  try {
    const { stdout, stderr } = await pexec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { command: cmd, passed: true, output: (stdout + stderr).slice(-4000) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    const out = (err.stdout ?? "") + (err.stderr ?? "") + (err.message ?? "");
    return { command: cmd, passed: false, output: out.slice(-4000) };
  }
}

/**
 * 质量闸：先跑一次 install（若配），再顺序跑所有 verify 命令。
 * 任一非零退出即失败，收集失败输出供返工。
 */
export async function runGate(cwd: string, verify: VerifyConfig): Promise<GateResult> {
  const steps: GateStepResult[] = [];

  if (verify.install) {
    const r = await runCmd(verify.install, cwd);
    steps.push(r);
    if (!r.passed) {
      return { passed: false, steps, failureLog: `[install] ${verify.install}\n${r.output}` };
    }
  }

  for (const cmd of verify.commands) {
    const r = await runCmd(cmd, cwd);
    steps.push(r);
    if (!r.passed) {
      return { passed: false, steps, failureLog: `[failed] ${cmd}\n${r.output}` };
    }
  }

  return { passed: true, steps, failureLog: "" };
}
