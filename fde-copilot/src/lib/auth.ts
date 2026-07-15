import { NextResponse } from "next/server";

/**
 * 最小鉴权：若设了 WORKBENCH_TOKEN，则所有 API 需带 `x-workbench-token` 匹配头，否则 401。
 * 未设 token 时视为「仅本机使用」——配合默认 bind 127.0.0.1（见 package.json / README）。
 * 面向公网/无人值守部署务必设置 WORKBENCH_TOKEN。
 */
export function authError(req: Request): NextResponse | null {
  const token = process.env.WORKBENCH_TOKEN?.trim();
  if (!token) return null;
  const got = req.headers.get("x-workbench-token");
  if (!got || got !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
