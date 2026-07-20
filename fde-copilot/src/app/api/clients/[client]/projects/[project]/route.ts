import { NextResponse } from "next/server";
import { readClient, readProjectState, readAllDocs, readConversation } from "@/lib/clients";
import { scopedAuthError } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ client: string; project: string }> },
) {
  const { client, project } = await params;
  // B3：参赛者可用作用域 token 读自己的项目；越权读他人项目 → 403
  const denied = scopedAuthError(req, client, project);
  if (denied) return denied;
  const [c, state] = await Promise.all([readClient(client), readProjectState(client, project)]);
  if (!c || !state) return NextResponse.json({ error: "客户或项目不存在" }, { status: 404 });
  const [docs, conversation] = await Promise.all([
    readAllDocs(client, project),
    readConversation(client, project),
  ]);
  return NextResponse.json({ client: c, state, docs, conversation });
}
