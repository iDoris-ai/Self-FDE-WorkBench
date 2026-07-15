import { NextResponse } from "next/server";
import { readState } from "@/lib/clients";
import { commitClient } from "@/lib/git";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { slug, push } = (await req.json()) as { slug?: string; push?: boolean };
  if (!slug) {
    return NextResponse.json({ error: "缺少 slug" }, { status: 400 });
  }
  const state = await readState(slug);
  if (!state) {
    return NextResponse.json({ error: "客户不存在" }, { status: 404 });
  }
  try {
    const r = await commitClient(
      slug,
      `docs(${slug}): 手动提交 spec（第 ${state.rounds} 轮）`,
      push === true,
    );
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
