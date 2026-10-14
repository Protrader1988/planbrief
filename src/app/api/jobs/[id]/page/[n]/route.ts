import fs from "node:fs";
import path from "node:path";
import { jobDir } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves the model-sized JPEG of a page (0-based index) for the script view. */
export async function GET(_: Request, { params }: { params: { id: string; n: string } }) {
  const n = Number(params.n);
  if (!Number.isInteger(n) || n < 0) return new Response("Bad page", { status: 400 });
  let dir: string;
  try {
    dir = path.join(jobDir(params.id), "pages");
  } catch {
    return new Response("Bad id", { status: 400 });
  }
  if (!fs.existsSync(dir)) return new Response("Not found", { status: 404 });
  const files = fs.readdirSync(dir).filter((f) => /^thumb-\d+\.jpg$/.test(f)).sort((a, b) => num(a) - num(b));
  const file = files[n];
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(fs.createReadStream(path.join(dir, file)) as unknown as ReadableStream, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" },
  });
}
function num(s: string) { return Number(/\d+/.exec(s)?.[0]); }
