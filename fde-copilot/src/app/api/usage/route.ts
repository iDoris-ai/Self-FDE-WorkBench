import { NextResponse } from "next/server";
import { listClients } from "@/lib/clients";
import { authError } from "@/lib/auth";
import { addUsage, ZERO_USAGE } from "@/lib/types";
import type { Usage } from "@/lib/types";

export const runtime = "nodejs";

/** 全局用量 = 各客户累计之和；附每客户明细，供界面每几分钟刷新 */
export async function GET(req: Request) {
  const denied = authError(req);
  if (denied) return denied;

  const clients = await listClients();
  let global: Usage = ZERO_USAGE;
  const perClient = clients.map((c) => {
    const u = c.usage ?? ZERO_USAGE;
    global = addUsage(global, u);
    return { slug: c.slug, name: c.name, usage: u };
  });

  return NextResponse.json({ global, perClient, at: new Date().toISOString() });
}
