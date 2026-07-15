import { NextResponse } from "next/server";
import { listClients, createClient } from "@/lib/clients";

export const runtime = "nodejs";

export async function GET() {
  const clients = await listClients();
  return NextResponse.json({ clients });
}

export async function POST(req: Request) {
  try {
    const { name } = (await req.json()) as { name?: string };
    if (!name || !name.trim()) {
      return NextResponse.json({ error: "缺少客户名称" }, { status: 400 });
    }
    const state = await createClient(name.trim());
    return NextResponse.json({ client: state }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
