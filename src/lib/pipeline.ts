import path from "node:path";
import fs from "node:fs/promises";
import { getJob, jobDir, updateJob } from "./jobs";
import { ingestPdf, type PageInfo } from "./ingest";
import { analyzePages, analysisPrompt, ANALYZE_PROVIDER, normalizeBrief, parseJsonLoose } from "./analyze";
import { verifyBrief } from "./review";
import type { Brief } from "./types";
import { synthesizeNarration, type Narration } from "./tts";
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
    if (ANALYZE_PROVIDER === "manual") {
      await updateJob(jobId, {
        status: "needs_script",
        progress: 22,
        message: "Waiting for a script",
        prompt: analysisPrompt(pages, job.originalName),
      });
      return; // resumed by resumeWithScript()
    }
    await updateJob(jobId, { status: "analyzing", progress: 22, message: "Reading the whole package and writing the script" });
    const draft = await analyzePages(pages, job.originalName);
    await updateJob(jobId, { progress: 38, message: "Script drafted", brief: draft });
    const brief = await verifyStage(jobId, draft, pages, ANALYZE_PROVIDER !== "mock");
    await narrateAndRender(jobId, brief);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[job ${jobId}]`, err);
    await updateJob(jobId, { status: "error", message: "Failed", error: msg });
  }
}

/** Manual mode: the person pasted a script; also used to re-render an edited script. */
export async function resumeWithScript(jobId: string, rawScript: string) {
  const job = await getJob(jobId);
  if (!job) throw new Error("job not found");
  const draft = normalizeBrief(parseJsonLoose(rawScript), job.pageCount || 1);
  await updateJob(jobId, { brief: draft, error: undefined, prompt: undefined, status: "verifying", progress: 40, message: "Script received" });
  running.add(jobId);
  chain = chain
    .then(async () => {
      const pages = await loadPages(jobId);
      // manual mode has no model available; the mechanical check still runs
      const brief = await verifyStage(jobId, draft, pages, ANALYZE_PROVIDER === "api" || ANALYZE_PROVIDER === "claude-code");
      await narrateAndRender(jobId, brief);
    })
    .catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      await updateJob(jobId, { status: "error", message: "Failed", error: msg });
    })
    .finally(() => running.delete(jobId));
  return draft;
}

async function verifyStage(jobId: string, draft: Brief, pages: PageInfo[], modelChecks: boolean): Promise<Brief> {
  await updateJob(jobId, { status: "verifying", progress: 40, message: "Verifying the script" });
  const { brief, report } = await verifyBrief(draft, pages, path.join(jobDir(jobId), "verify"), {
    modelChecks,
    onProgress: async (m) => { await updateJob(jobId, { message: m }); },
  });
  await updateJob(jobId, { brief, verification: report, progress: 45, message: `Verified: ${report.summary.verdict}` });
  return brief;
}

async function narrateAndRender(jobId: string, brief: Brief) {
  const dir = jobDir(jobId);
  const pages = await loadPages(jobId);
  try {

    // 3. narrate
    await updateJob(jobId, { status: "narrating", progress: 46, message: "Recording narration" });
    const audio: Narration[] = [];
    for (let i = 0; i < brief.segments.length; i++) {
      const file = path.join(dir, "audio", `seg-${i}.mp3`);
      audio.push(await synthesizeNarration(brief.segments[i].narration, file));
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
    const v = (await getJob(jobId))?.verification;
    const m = v?.mechanicalAfterFix ?? v?.mechanical;
    const verificationLine = m
      ? `Verified: ${m.totals.verified} of ${m.totals.claims} figures matched to the sheets` +
        (v?.reviewer.ran && v?.auditor.ran ? "; independent architect/engineer review and consistency audit passed" : v?.reviewer.ran || v?.auditor.ran ? "; one independent review passed" : "")
      : undefined;
    const { total: durationSec, starts } = await renderVideo(brief, pages, {
      audio,
      verificationLine,
      outFile,
      workDir: work,
      width: Number(process.env.VIDEO_WIDTH || 1920),
      height: Number(process.env.VIDEO_HEIGHT || 1080),
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

function stripPage(p: PageInfo): PageInfo {
  return p; // text is kept so verification can re-run from disk
}

async function loadPages(jobId: string): Promise<PageInfo[]> {
  const raw = await fs.readFile(path.join(jobDir(jobId), "pages.json"), "utf8");
  return JSON.parse(raw) as PageInfo[];
}
