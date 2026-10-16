/**
 * Headless pipeline for CI (GitHub Actions). Pulls a job from Supabase, runs the full
 * ingest → script → triple-verify → narrate → film pipeline, uploads the video and brief,
 * and updates the job row as it goes.
 *
 *   npx tsx scripts/run-job.ts <job_id>
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, plus the usual pipeline env (ANALYZE_PROVIDER,
 * CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, TTS_PROVIDER, PIPER_MODEL, PIPER_PY).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ingestPdf } from "../src/lib/ingest";
import { analyzePages } from "../src/lib/analyze";
import { verifyBrief } from "../src/lib/review";
import { synthesizeNarration, type Narration } from "../src/lib/tts";
import { renderVideo } from "../src/lib/render";
import { renderGuide } from "../src/lib/guide";

const run = promisify(execFile);
const SUPABASE_URL = process.env.SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_KEY!;
if (!SUPABASE_URL || !KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function rest(pathname: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, { ...init, headers: { ...H, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${pathname}: ${res.status} ${await res.text()}`);
  return res.json();
}
async function patch(id: string, data: Record<string, unknown>) {
  data.updated_at = new Date().toISOString();
  await rest(`jobs?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(data) });
  const s = data.status ? `[${data.status}] ` : "";
  console.log(`${s}${data.message ?? ""}${data.progress != null ? ` (${data.progress}%)` : ""}`);
}
async function download(bucket: string, objectPath: string, to: string) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`, { headers: H });
  if (!res.ok) throw new Error(`download ${objectPath}: ${res.status}`);
  await fs.writeFile(to, Buffer.from(await res.arrayBuffer()));
}
async function upload(bucket: string, objectPath: string, file: string, contentType: string) {
  const body = await fs.readFile(file);
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`, {
    method: "POST", headers: { ...H, "Content-Type": contentType, "x-upsert": "true" }, body,
  });
  if (!res.ok) throw new Error(`upload ${objectPath}: ${res.status} ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${objectPath}`;
}

/**
 * Where finished files live. Supabase's free tier caps a file at 50 MB, which a real
 * drawing set's video exceeds, so inside GitHub Actions outputs go to a GitHub Release on
 * this repo (2 GB per file, no storage quota on a public repo). Outside Actions, or if the
 * release fails, files under the cap fall back to Supabase storage.
 */
async function publishFile(id: string, file: string, assetName: string, title: string, contentType: string) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (repo && token) {
    try {
      const tag = `job-${id}`;
      const env = { ...process.env, GH_TOKEN: token };
      const exists = await run("gh", ["release", "view", tag, "--repo", repo], { env }).then(() => true, () => false);
      if (!exists) await run("gh", ["release", "create", tag, "--repo", repo, "--title", `PlanBrief: ${title}`.slice(0, 120), "--notes", `Outputs for job ${id}.`], { env });
      await run("gh", ["release", "upload", tag, `${file}#${assetName}`, "--repo", repo, "--clobber"], { env });
      return `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
    } catch (e) {
      console.warn("GitHub release upload failed, falling back to Supabase:", e instanceof Error ? e.message : e);
    }
  }
  const size = (await fs.stat(file)).size;
  if (size > 49 * 1024 * 1024) throw new Error(`${assetName} is ${(size / 1048576).toFixed(0)} MB, over the 50 MB Supabase limit, and no GitHub release target is configured`);
  return upload("videos", `${id}/${assetName}`, file, contentType);
}

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("usage: run-job.ts <job_id>");
  const [job] = await rest(`jobs?id=eq.${id}&select=*`);
  if (!job) throw new Error(`job ${id} not found`);
  const work = path.resolve("data", "jobs", id);
  await fs.mkdir(path.join(work, "pages"), { recursive: true });
  await fs.mkdir(path.join(work, "audio"), { recursive: true });
  await fs.mkdir(path.join(work, "work"), { recursive: true });

  try {
    await patch(id, { status: "ingesting", progress: 2, message: "Downloading and reading pages" });
    const pdf = path.join(work, "input.pdf");
    await download("uploads", job.upload_path, pdf);
    const pages = await ingestPdf(pdf, path.join(work, "pages"), {
      onProgress: (d, t) => patch(id, { progress: 2 + Math.round((d / t) * 15), message: `Reading page ${d} of ${t}`, page_count: t }),
    });

    await patch(id, { status: "analyzing", progress: 18, message: "Reading the whole package and writing the script" });
    const draft = await analyzePages(pages, job.original_name);
    await patch(id, { progress: 35, message: "Script drafted", brief: draft });

    await patch(id, { status: "verifying", progress: 36, message: "Verifying the script (3 checks)" });
    const { brief, report } = await verifyBrief(draft, pages, path.join(work, "verify"), {
      modelChecks: true,
      onProgress: (m) => patch(id, { message: m }),
    });
    await patch(id, { progress: 50, message: `Verified: ${report.summary.verdict}`, brief, verification: report });

    // The printable guide comes from the same verified brief, before any narration.
    const guideOnly = job.outputs === "guide";
    await patch(id, { status: "guide", progress: guideOnly ? 55 : 50, message: "Laying out the Plan Reader's Guide" });
    const guideFile = path.join(work, "guide.pdf");
    const g = await renderGuide(brief, pages, { outFile: guideFile, workDir: path.join(work, "guide"), verification: report });
    const guideUrl = await publishFile(id, guideFile, "guide.pdf", job.original_name, "application/pdf");
    const thumbs: string[] = [];
    for (const p of pages) thumbs.push(await upload("videos", `${id}/page-${p.index}.jpg`, p.thumbPath, "image/jpeg"));
    await patch(id, { progress: guideOnly ? 95 : 51, message: `Guide ready (${g.pages} pages)`, guide_url: guideUrl, page_urls: thumbs });
    if (guideOnly) {
      await patch(id, { status: "done", progress: 100, message: "Done" });
      return;
    }

    await patch(id, { status: "narrating", progress: 51, message: "Recording narration" });
    const audio: Narration[] = [];
    for (let i = 0; i < brief.segments.length; i++) {
      audio.push(await synthesizeNarration(brief.segments[i].narration, path.join(work, "audio", `seg-${i}.mp3`)));
      await patch(id, { progress: 51 + Math.round(((i + 1) / brief.segments.length) * 9), message: `Narrating part ${i + 1} of ${brief.segments.length}` });
    }

    await patch(id, { status: "rendering", progress: 60, message: "Filming the walkthrough" });
    const master = path.join(work, "master.mp4");
    const m = report.mechanicalAfterFix ?? report.mechanical;
    const verificationLine = `Verified: ${m.totals.verified + m.totals.cited} of ${m.totals.claims} figures matched to the sheets` +
      (report.reviewer.ran && report.auditor.ran ? "; independent architect/engineer review and consistency audit passed" : "");
    let lastProgress = 0;
    const { total, starts } = await renderVideo(brief, pages, {
      audio, outFile: master, workDir: path.join(work, "work"), verificationLine,
      width: Number(process.env.VIDEO_WIDTH || 1920), height: Number(process.env.VIDEO_HEIGHT || 1080), fps: Number(process.env.VIDEO_FPS || 24),
      onProgress: (f) => { const p = 60 + Math.round(f * 32); if (p > lastProgress) { lastProgress = p; void patch(id, { progress: p, message: `Filming… ${Math.round(f * 100)}%` }); } },
    });

    await patch(id, { status: "uploading", progress: 93, message: "Compressing and uploading the video" });
    const web = path.join(work, "video.mp4");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", master, "-c:v", "libx264", "-preset", "veryfast", "-crf", String(process.env.WEB_CRF || 27), "-pix_fmt", "yuv420p", "-tune", "stillimage", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", web]);
    const videoUrl = await publishFile(id, web, "video.mp4", job.original_name, "video/mp4");
    await patch(id, { status: "done", progress: 100, message: "Done", video_url: videoUrl, duration_sec: total, segment_starts: starts });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err);
    await patch(id, { status: "error", message: "Failed", error: msg.slice(0, 2000) });
    process.exit(1);
  }
}
main();
