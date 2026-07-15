import { NextResponse } from "next/server";
import { readState, readAllDocs, readConversation } from "@/lib/clients";
import { authError } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const denied = authError(req);
  if (denied) return denied;
  const { slug } = await params;
  const state = await readState(slug);
  if (!state) {
    return NextResponse.json({ error: "客户不存在" }, { status: 404 });
  }
  const [docs, conversation] = await Promise.all([readAllDocs(slug), readConversation(slug)]);
  return NextResponse.json({ state, docs, conversation });
}
