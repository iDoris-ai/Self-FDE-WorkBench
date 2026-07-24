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

/**
 * 授权 origin 白名单（与 fde-copilot 一致）。默认放行本机 UI + 授权合作方 hack5.net(含子域)
 * + 本地。WORKBENCH_ALLOWED_ORIGINS（逗号分隔 host）可覆盖。
 */
function allowedOrigins(): string[] {
  const raw = process.env.WORKBENCH_ALLOWED_ORIGINS?.trim();
  const defaults = "workbench.aastar.io,loop.aastar.io,hack5.net,localhost,127.0.0.1";
  return (raw || defaults)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => s.replace(/^https?:\/\//, "").replace(/[:/].*$/, ""));
}

/**
 * 授权 origin 门禁：只对带 Origin 的请求生效（浏览器跨站会带 Origin）。不在白名单的域一律拒；
 * hack5 的 Worker 是服务端调用、无 Origin → 放行去走 token 门禁。无 Origin 返回 true。
 */
export function checkOrigin(req: IncomingMessage): boolean {
  const raw = req.headers["origin"];
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (!origin) return true; // 服务端调用无 Origin
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return allowedOrigins().some((a) => hostname === a || hostname.endsWith("." + a));
  } catch {
    return false; // Origin 不可解析 → 拒
  }
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
