import path from "node:path";
import fs from "node:fs/promises";
import { getJob, jobDir, updateJob } from "./jobs";
import { ingestPdf, type PageInfo } from "./ingest";
import { analyzePages } from "./analyze";
import { synthesize } from "./tts";
import { renderVideo } from "./render";

/** Simple in-process queue: one render at a time keeps CPU and memory sane. */
let chain: Promise<void> = Promise.resolve();
const running = new Set<string>();

export function enqueue(jobId: string) {
  if (running.has(jobId)) return;
  running.add(jobId);
  chain = chain.then(() => processJob(jobId)).catch(() => {}).finally(() => running.delete(jobId));
}

export async function processJob(jobId: string) {
  const job = await getJob(jobId);
  if (!job) return;
  const dir = jobDir(jobId);
  try {
    // 1. ingest
    await updateJob(jobId, { status: "ingesting", progress: 2, message: "Reading pages" });
    const pages = await ingestPdf(path.join(dir, "input.pdf"), path.join(dir, "pages"), {
      onProgress: (done, total) =>
        updateJob(jobId, { progress: 2 + Math.round((done / total) * 18), message: `Reading page ${done} of ${total}`, pageCount: total }),
    });
    await fs.writeFile(path.join(dir, "pages.json"), JSON.stringify(pages.map(stripPage)));

    // 2. analyze
    await updateJob(jobId, { status: "analyzing", progress: 22, message: "Reading the whole package and writing the script" });
    const brief = await analyzePages(pages, job.originalName);
    await updateJob(jobId, { progress: 45, message: "Script ready", brief });

    // 3. narrate
    await updateJob(jobId, { status: "narrating", progress: 46, message: "Recording narration" });
    const audio: { file: string; duration: number }[] = [];
    for (let i = 0; i < brief.segments.length; i++) {
      const file = path.join(dir, "audio", `seg-${i}.mp3`);
      const duration = await synthesize(brief.segments[i].narration, file);
      audio.push({ file, duration });
      await updateJob(jobId, {
        progress: 46 + Math.round(((i + 1) / brief.segments.length) * 14),
        message: `Narrating part ${i + 1} of ${brief.segments.length}`,
      });
    }

    // 4. render
    await updateJob(jobId, { status: "rendering", progress: 60, message: "Filming the walkthrough" });
    const work = path.join(dir, "work");
    await fs.mkdir(work, { recursive: true });
    const outFile = path.join(dir, "brief.mp4");
    const { total: durationSec, starts } = await renderVideo(brief, pages, {
      audio,
      outFile,
      workDir: work,
      width: Number(process.env.VIDEO_WIDTH || 1280),
      height: Number(process.env.VIDEO_HEIGHT || 720),
      fps: Number(process.env.VIDEO_FPS || 24),
      onProgress: (f) => updateJob(jobId, { progress: 60 + Math.round(f * 39), message: `Filming… ${Math.round(f * 100)}%` }),
    });
    await fs.rm(work, { recursive: true, force: true });

    await updateJob(jobId, {
      status: "done",
      progress: 100,
      message: "Done",
      videoUrl: `/api/jobs/${jobId}/video`,
      durationSec,
      segmentStarts: starts,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[job ${jobId}]`, err);
    await updateJob(jobId, { status: "error", message: "Failed", error: msg });
  }
}

function stripPage(p: PageInfo) {
  return { index: p.index, width: p.width, height: p.height, textChars: p.text.length };
}
