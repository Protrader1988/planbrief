import OpenAI from "openai";
import fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type TtsProvider = "openai" | "piper" | "silent";

const PROVIDER =
  (process.env.TTS_PROVIDER as TtsProvider) ||
  (process.env.OPENAI_API_KEY ? "openai" : process.env.PIPER_MODEL ? "piper" : "silent");
const PIPER_MODEL = process.env.PIPER_MODEL || ""; // path to a .onnx voice; see README
const PIPER_BIN = process.env.PIPER_BIN || "python3 -m piper";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "onyx";
const WORDS_PER_SEC = 2.6; // used to estimate duration when no audio is produced

/** Synthesizes narration to an MP3 and returns its duration in seconds. */
export async function synthesize(text: string, outPath: string): Promise<number> {
  if (PROVIDER === "openai") {
    const client = new OpenAI();
    const res = await client.audio.speech.create({
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE as "alloy",
      input: text,
      response_format: "mp3",
      ...(OPENAI_TTS_MODEL.includes("gpt-4o")
        ? {
            instructions:
              "Calm, clear, confident construction professional explaining documents to a newcomer. Moderate pace, no filler.",
          }
        : {}),
    });
    await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    return probeDuration(outPath);
  }

  if (PROVIDER === "piper") {
    // Offline neural TTS (free). Needs `pip install piper-tts` and a voice .onnx.
    const wav = outPath.replace(/\.mp3$/, ".wav");
    const [bin, ...binArgs] = PIPER_BIN.split(" ");
    await new Promise<void>((resolve, reject) => {
      const p = spawn(bin, [...binArgs, "-m", PIPER_MODEL, "-f", wav], { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`piper exited ${code}: ${err}`))));
      p.on("error", reject);
      p.stdin.end(text);
    });
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-q:a", "4", outPath]);
    await fs.unlink(wav).catch(() => {});
    return probeDuration(outPath);
  }

  // Silent fallback (no API key, or TTS_PROVIDER=silent): make a silent track
  // of the estimated speaking length so the video still assembles.
  const words = text.trim().split(/\s+/).length;
  const dur = Math.max(3, words / WORDS_PER_SEC);
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", dur.toFixed(2), "-q:a", "9", outPath,
  ]);
  return dur;
}

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ]);
  const d = parseFloat(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`ffprobe could not read duration of ${file}`);
  return d;
}
