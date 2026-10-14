import fs from "node:fs";
import path from "node:path";
import { jobDir } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams the MP4 with Range support so the browser can seek. */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  let file: string;
  try {
    file = path.join(jobDir(params.id), "brief.mp4");
  } catch {
    return new Response("Bad id", { status: 400 });
  }
  if (!fs.existsSync(file)) return new Response("Not ready", { status: 404 });
  const size = fs.statSync(file).size;
  const range = req.headers.get("range");
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": `inline; filename="brief-${params.id.slice(0, 8)}.mp4"`,
  };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
    const stream = fs.createReadStream(file, { start, end });
    return new Response(stream as unknown as ReadableStream, { status: 206, headers });
  }
  headers["Content-Length"] = String(size);
  return new Response(fs.createReadStream(file) as unknown as ReadableStream, { status: 200, headers });
}
