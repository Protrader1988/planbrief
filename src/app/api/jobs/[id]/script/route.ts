import { NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";
import { resumeWithScript } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Accepts a pasted or edited script (JSON) and narrates + films it. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const job = await getJob(params.id).catch(() => null);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!["needs_script", "done", "error"].includes(job.status)) {
    return NextResponse.json({ error: "Job is busy" }, { status: 409 });
  }
  const body = await req.json().catch(() => ({}));
  const script = typeof body.script === "string" ? body.script : JSON.stringify(body.script ?? "");
  if (!script.trim()) return NextResponse.json({ error: "Paste the script JSON" }, { status: 400 });
  try {
    const brief = await resumeWithScript(params.id, script);
    return NextResponse.json({ ok: true, segments: brief.segments.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
