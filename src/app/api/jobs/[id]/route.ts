import { NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  try {
    const job = await getJob(params.id);
    if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(job, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }
}
