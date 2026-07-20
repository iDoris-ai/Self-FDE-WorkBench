import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

/** 常量时间比较，避免 token 校验的时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * 最小鉴权（admin / 编排层）：若设了 WORKBENCH_TOKEN，则所有 API 需带 `x-workbench-token`
 * 匹配头，否则 401。未设 token 时视为「仅本机使用」——配合默认 bind 127.0.0.1。
 * 面向公网/无人值守部署务必设置 WORKBENCH_TOKEN。
 *
 * 契约 v2 · B3：编排类调用（clients / projects / commit / usage）走此 admin 门禁；
 * 参赛者会话（chat / 读自己项目）走 scopedAuthError（作用域 token）。
 */
export function authError(req: Request): NextResponse | null {
  const token = process.env.WORKBENCH_TOKEN?.trim();
  if (!token) return null;
  const got = req.headers.get("x-workbench-token");
  if (!got || !safeEqual(got, token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * 作用域 token 的 claim（W3 / B3）。由 hack5 用共享密钥 HMAC 签发，WorkBench 只验签 + 比对路径。
 * 令牌格式（双方共同合同）：
 *   token = base64url(payloadJson) + "." + base64url(HMAC_SHA256(payloadBytes, WORKBENCH_SCOPED_SECRET))
 *   payloadJson = { "client": "<clientSlug>", "project": "<projectSlug>", "exp"?: <unix 秒> }
 */
export interface ScopedClaims {
  client: string;
  project: string;
  exp?: number;
}

/** 验签作用域 token；失败/过期/格式错一律返回 null。签发方=hack5，此处只验。 */
export function verifyScopedToken(token: string, secret: string): ScopedClaims | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const p = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payloadBuf: Buffer;
  let gotSig: Buffer;
  try {
    payloadBuf = Buffer.from(p, "base64url");
    gotSig = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(payloadBuf).digest();
  if (gotSig.length !== expected.length || !timingSafeEqual(gotSig, expected)) return null;
  let claims: ScopedClaims;
  try {
    claims = JSON.parse(payloadBuf.toString("utf8")) as ScopedClaims;
  } catch {
    return null;
  }
  if (!claims.client || !claims.project) return null;
  if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp) return null;
  return claims;
}

/**
 * 参赛者会话鉴权（W3 / B3）。放行两类之一，否则 401/403：
 *   1) admin token（= WORKBENCH_TOKEN）——hack5 server-to-server / 本地测试全通；
 *   2) 作用域 token（HMAC 签发，claim 含 client/project）且 claim 与请求项目**一致**。
 * 头统一用 `x-workbench-token`。都没配（无 admin & 无 secret）→ 视为仅本机使用，放行。
 * 越权（claim 与请求项目不符）→ 403，实现「每个参赛者只能访问自己的 project」。
 */
export function scopedAuthError(
  req: Request,
  clientSlug: string,
  projectSlug: string,
): NextResponse | null {
  const admin = process.env.WORKBENCH_TOKEN?.trim();
  const secret = process.env.WORKBENCH_SCOPED_SECRET?.trim();
  // 都没配 → 仅本机使用，放行（与 authError 语义一致）
  if (!admin && !secret) return null;

  const got = req.headers.get("x-workbench-token");
  if (!got) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // admin 全通
  if (admin && safeEqual(got, admin)) return null;

  // 作用域 token：验签 + 比对路径子树
  if (secret) {
    const claims = verifyScopedToken(got, secret);
    if (claims) {
      if (claims.client === clientSlug && claims.project === projectSlug) return null;
      return NextResponse.json(
        { error: "forbidden：token 作用域与请求项目不符" },
        { status: 403 },
      );
    }
  }
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
