import { NextResponse } from "next/server";
import { listClients, listProjects, readClient } from "@/lib/clients";
import { authError } from "@/lib/auth";
import { addUsage, ZERO_USAGE } from "@/lib/types";
import type { Usage } from "@/lib/types";

export const runtime = "nodejs";

/**
 * 用量 / 出账数据（W6 · 契约 v2 C4：v1 只记录用量，成本模型 Phase 2）。
 *
 * - `GET /api/usage`               → 全局累计 + perProject + **perClient 汇总**（按 hackathon 聚合）
 * - `GET /api/usage?client=<slug>` → **该 hackathon 各 participant 的 token 汇总** + client 小计
 */
export async function GET(req: Request) {
  const denied = authError(req);
  if (denied) return denied;

  const clientSlug = new URL(req.url).searchParams.get("client");

  // —— 单 client 视图：某黑客松下各 participant 的 token 汇总 ——
  if (clientSlug) {
    const c = await readClient(clientSlug);
    if (!c) return NextResponse.json({ error: "客户不存在" }, { status: 404 });
    let subtotal: Usage = ZERO_USAGE;
    const perParticipant: Array<{ project: string; projectName: string; usage: Usage }> = [];
    for (const p of await listProjects(c.slug)) {
      const u = p.usage ?? ZERO_USAGE;
      subtotal = addUsage(subtotal, u);
      perParticipant.push({ project: p.slug, projectName: p.name, usage: u });
    }
    return NextResponse.json({
      client: c.slug,
      clientName: c.name,
      participants: perParticipant.length,
      subtotal,
      perParticipant,
      at: new Date().toISOString(),
    });
  }

  // —— 全局视图：所有客户所有项目累计之和 + 按 client 聚合 ——
  const clients = await listClients();
  let global: Usage = ZERO_USAGE;
  const perProject: Array<{ client: string; project: string; usage: Usage }> = [];
  const perClient: Array<{ client: string; clientName: string; participants: number; subtotal: Usage }> = [];
  for (const c of clients) {
    let subtotal: Usage = ZERO_USAGE;
    let participants = 0;
    for (const p of await listProjects(c.slug)) {
      const u = p.usage ?? ZERO_USAGE;
      global = addUsage(global, u);
      subtotal = addUsage(subtotal, u);
      participants += 1;
      perProject.push({ client: c.name, project: p.name, usage: u });
    }
    perClient.push({ client: c.slug, clientName: c.name, participants, subtotal });
  }
  return NextResponse.json({ global, perProject, perClient, at: new Date().toISOString() });
}
