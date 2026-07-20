import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * 与 fde-copilot 一致的鉴权：校验 `x-workbench-token` 请求头。
 *
 * fail-closed：未配置 `WORKBENCH_TOKEN` 环境变量时一律拒绝——这些端点会 spawn 自主
 * 编码器（runTask），绝不能在无 token 的情况下裸奔可达。
 */
export function checkWorkbenchToken(req: IncomingMessage): boolean {
  const expected = process.env.WORKBENCH_TOKEN;
  if (!expected) return false;
  const raw = req.headers["x-workbench-token"];
  const got = Array.isArray(raw) ? raw[0] : raw;
  if (typeof got !== "string" || got.length === 0) return false;
  return timingSafeEqualStr(got, expected);
}

/** 定长比较，避免时序侧信道（长度不同直接判否，但仍走一次比较以稳定耗时） */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // 长度不同必不相等；仍与自身比一次，避免因提前返回泄漏长度信息
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
