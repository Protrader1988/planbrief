import { NextResponse } from "next/server";
import { createJob } from "@/lib/jobs";
import { enqueue } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 200);

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    return NextResponse.json({ error: "Upload a PDF (RFP, RFQ, drawings or specs)." }, { status: 400 });
  }
  if (file.size > MAX_MB * 1024 * 1024) {
    return NextResponse.json({ error: `File is over ${MAX_MB} MB` }, { status: 413 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const job = await createJob(file.name, buf);
  enqueue(job.id);
  return NextResponse.json({ id: job.id });
}
