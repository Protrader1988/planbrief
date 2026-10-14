import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chunkNarration } from "./captions";

const run = promisify(execFile);

export type TtsProvider = "openai" | "piper" | "silent";

const PROVIDER =
  (process.env.TTS_PROVIDER as TtsProvider) ||
  (process.env.OPENAI_API_KEY ? "openai" : process.env.PIPER_MODEL ? "piper" : "silent");
const PIPER_MODEL = process.env.PIPER_MODEL || "";
const PIPER_PY = process.env.PIPER_PY || "python3";
const PIPER_BATCH = path.join(process.cwd(), "scripts", "piper_batch.py");
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "onyx";
const WORDS_PER_SEC = 2.6;
const PAUSE = 0.28; // seconds between sentences

/** A narration rendered as audio, with exact per-chunk timing for captions and pointer cues. */
export type Narration = {
  file: string;
  duration: number;
  chunks: { text: string; charStart: number; start: number; duration: number }[];
};

/**
 * Synthesizes one segment's narration as sentence-sized chunks, concatenates them with
 * short pauses, and returns where each chunk starts. Timing comes from the audio itself.
 */
export async function synthesizeNarration(text: string, outPath: string): Promise<Narration> {
  const chunks = chunkNarration(text);
  const dir = path.join(path.dirname(outPath), path.basename(outPath, ".mp3") + "-parts");
  await fs.mkdir(dir, { recursive: true });
  const files = chunks.map((_, i) => path.join(dir, `c${i}.wav`));

  if (PROVIDER === "piper") await piperBatch(chunks.map((c) => c.text), files);
  else if (PROVIDER === "openai") for (let i = 0; i < chunks.length; i++) await openaiOne(chunks[i].text, files[i]);
  else for (let i = 0; i < chunks.length; i++) await silentOne(chunks[i].text, files[i]);

  // durations + timeline
  const timed: Narration["chunks"] = [];
  let t = 0;
  for (let i = 0; i < chunks.length; i++) {
    const d = await probeDuration(files[i]);
    timed.push({ ...chunks[i], start: t, duration: d });
    t += d + (i < chunks.length - 1 ? PAUSE : 0);
  }

  // concat with pauses into one mp3
  const inputs: string[] = [];
  const filter: string[] = [];
  files.forEach((f, i) => {
    inputs.push("-i", f);
    filter.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono${i < files.length - 1 ? `,apad=pad_dur=${PAUSE}` : ""}[a${i}]`);
  });
  filter.push(`${files.map((_, i) => `[a${i}]`).join("")}concat=n=${files.length}:v=0:a=1[out]`);
  await run("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter.join(";"), "-map", "[out]", "-q:a", "3", outPath]);
  await fs.rm(dir, { recursive: true, force: true });
  const duration = await probeDuration(outPath);
  return { file: outPath, duration, chunks: timed };
}

/** Single-shot synthesis (kept for callers that don't need timing). */
export async function synthesize(text: string, outPath: string): Promise<number> {
  return (await synthesizeNarration(text, outPath)).duration;
}

async function piperBatch(texts: string[], files: string[]) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(PIPER_PY, [PIPER_BATCH, PIPER_MODEL], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`piper exited ${code}: ${err.slice(-1500)}`))));
    p.on("error", reject);
    p.stdin.end(texts.map((t, i) => JSON.stringify({ text: t, output_file: files[i] })).join("\n") + "\n");
  });
  for (const f of files) await fs.access(f).catch(() => { throw new Error(`piper did not write ${f}`); });
}

async function openaiOne(text: string, file: string) {
  const client = new OpenAI();
  const res = await client.audio.speech.create({
    model: OPENAI_TTS_MODEL,
    voice: OPENAI_TTS_VOICE as "alloy",
    input: text,
    response_format: "wav",
    ...(OPENAI_TTS_MODEL.includes("gpt-4o")
      ? { instructions: "Calm, clear, confident construction professional explaining documents to a newcomer. Moderate pace, no filler." }
      : {}),
  });
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
}

async function silentOne(text: string, file: string) {
  const words = text.trim().split(/\s+/).length;
  const dur = Math.max(1.2, words / WORDS_PER_SEC);
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", dur.toFixed(2), file]);
}

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const d = parseFloat(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`ffprobe could not read duration of ${file}`);
  return d;
}
