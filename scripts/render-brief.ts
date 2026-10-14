/**
 * Render a video from an existing brief.json (skips the model step).
 *   npx tsx scripts/render-brief.ts input.pdf brief.json out.mp4
 */
import path from "node:path";
import fs from "node:fs/promises";
import { ingestPdf } from "../src/lib/ingest";
import { normalizeBrief } from "../src/lib/analyze";
import { synthesize } from "../src/lib/tts";
import { renderVideo } from "../src/lib/render";

async function main() {
  const [pdf, briefFile, outArg] = process.argv.slice(2);
  if (!pdf || !briefFile) throw new Error("usage: tsx scripts/render-brief.ts file.pdf brief.json out.mp4");
  const out = path.resolve(outArg || "brief.mp4");
  const work = path.join(path.dirname(path.resolve(briefFile)), "work");
  await fs.mkdir(path.join(work, "audio"), { recursive: true });

  const pages = await ingestPdf(pdf, path.join(work, "pages"));
  const brief = normalizeBrief(JSON.parse(await fs.readFile(briefFile, "utf8")), pages.length);

  const audio = [];
  for (let i = 0; i < brief.segments.length; i++) {
    const file = path.join(work, "audio", `seg-${i}.mp3`);
    audio.push({ file, duration: await synthesize(brief.segments[i].narration, file) });
    process.stdout.write(`narrated ${i + 1}/${brief.segments.length} (${audio[i].duration.toFixed(1)}s)\n`);
  }
  const r = await renderVideo(brief, pages, {
    audio, outFile: out, workDir: work,
    onProgress: (f) => process.stdout.write(`\rfilming ${Math.round(f * 100)}%  `),
  });
  console.log(`\nduration ${r.total.toFixed(0)}s -> ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
