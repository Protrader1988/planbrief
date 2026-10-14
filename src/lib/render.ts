import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage, GlobalFonts, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { Brief, Box, Segment } from "./types";
import type { PageInfo } from "./ingest";

const run = promisify(execFile);

export type RenderOptions = {
  width?: number;
  height?: number;
  fps?: number;
  /** per-segment audio files and durations, same order as brief.segments */
  audio: { file: string; duration: number }[];
  outFile: string;
  workDir: string;
  onProgress?: (fraction: number) => void;
};

// ---------- theme ----------
const C = {
  ink: "#0f172a",
  inkSoft: "rgba(15,23,42,0.78)",
  paper: "#f8fafc",
  accent: "#f59e0b", // highlight amber
  accentSoft: "rgba(245,158,11,0.16)",
  pointer: "#ef4444",
  white: "#ffffff",
  bar: "rgba(15,23,42,0.18)",
};

let FONT = "sans-serif";
(function registerFonts() {
  const candidates = [
    ["/usr/share/fonts/opentype/inter/Inter-Medium.otf", "Inter"],
    ["/usr/share/fonts/truetype/inter/Inter-Medium.ttf", "Inter"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans"],
    ["/usr/share/fonts/dejavu/DejaVuSans.ttf", "DejaVu Sans"],
  ];
  for (const [file, name] of candidates) {
    try {
      if (GlobalFonts.registerFromPath(file, name)) {
        FONT = name;
        return;
      }
    } catch {
      /* try next */
    }
  }
})();

// ---------- camera math ----------
type View = { cx: number; cy: number; w: number; h: number }; // page-pixel space

function viewForBox(box: Box, page: { width: number; height: number }, aspect: number, pad = 0.09): View {
  let w = box.w * page.width * (1 + pad * 2);
  let h = box.h * page.height * (1 + pad * 2);
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  // never zoom out past the page, never zoom in absurdly
  const maxW = Math.max(page.width, page.height * aspect);
  if (w > maxW) {
    w = maxW;
    h = w / aspect;
  }
  const minW = page.width * 0.08;
  if (w < minW) {
    w = minW;
    h = w / aspect;
  }
  return { cx: (box.x + box.w / 2) * page.width, cy: (box.y + box.h / 2) * page.height, w, h };
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function easeInOut(t: number) {
  t = Math.max(0, Math.min(1, t));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function lerpView(a: View, b: View, t: number): View {
  // interpolate zoom in log space so motion feels even
  const w = Math.exp(lerp(Math.log(a.w), Math.log(b.w), t));
  return { cx: lerp(a.cx, b.cx, t), cy: lerp(a.cy, b.cy, t), w, h: w * (a.h / a.w) };
}

// ---------- timeline ----------
type TimedCallout = Segment["callouts"][number] & { at: number };
type Shot = {
  seg: Segment;
  page: PageInfo;
  start: number;
  duration: number;
  from: View;
  to: View;
  callouts: TimedCallout[];
};

const INTRO = 3.2;
const OUTRO = 4.0;
const MOVE = 1.1; // seconds the camera takes to travel
const GAP = 0.6; // breathing room after narration ends

function buildTimeline(brief: Brief, pages: PageInfo[], audio: RenderOptions["audio"], aspect: number) {
  const shots: Shot[] = [];
  let t = INTRO;
  let prev: View | null = null;
  let prevPage = -1;
  brief.segments.forEach((seg, i) => {
    const page = pages[seg.page] ?? pages[0];
    const to = viewForBox(seg.focus, page, aspect);
    const full = viewForBox({ x: 0, y: 0, w: 1, h: 1 }, page, aspect, 0.02);
    const from = prev && prevPage === page.index ? prev : full;
    const narr = audio[i]?.duration ?? 5;
    const duration = narr + GAP;
    shots.push({ seg, page, start: t, duration, from, to, callouts: timeCallouts(seg, narr) });
    t += duration;
    prev = to;
    prevPage = page.index;
  });
  return { shots, total: t + OUTRO };
}

function timeCallouts(seg: Segment, narr: number): TimedCallout[] {
  const n = seg.narration;
  const lower = n.toLowerCase();
  const out: TimedCallout[] = seg.callouts.map((c, i) => {
    let frac: number;
    const idx = c.cue ? lower.indexOf(c.cue.toLowerCase()) : -1;
    if (idx >= 0) frac = idx / Math.max(1, n.length);
    else frac = (i + 1) / (seg.callouts.length + 1);
    // the audio starts after the camera move; keep callouts in the spoken window
    return { ...c, at: MOVE + 0.3 + frac * Math.max(0, narr - MOVE - 1.0) };
  });
  out.sort((a, b) => a.at - b.at);
  // enforce a minimum spacing so labels can be read
  for (let i = 1; i < out.length; i++) if (out[i].at < out[i - 1].at + 1.6) out[i].at = out[i - 1].at + 1.6;
  return out;
}

// ---------- drawing ----------
function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function pill(ctx: SKRSContext2D, text: string, x: number, y: number, size: number, bg: string, fg: string, maxW?: number) {
  ctx.font = `${size}px ${FONT}`;
  let label = text;
  if (maxW) while (label.length > 4 && ctx.measureText(label).width > maxW - size * 1.4) label = label.slice(0, -2) + "…";
  const tw = ctx.measureText(label).width;
  const padX = size * 0.7;
  const h = size * 1.8;
  roundRect(ctx, x, y, tw + padX * 2, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + padX, y + h / 2 + 1);
  return { w: tw + padX * 2, h };
}

function wrap(ctx: SKRSContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Converts a page box into frame coordinates under the given view. */
function toFrame(box: Box, page: PageInfo, view: View, W: number, H: number) {
  const s = W / view.w;
  const ox = view.cx - view.w / 2;
  const oy = view.cy - view.h / 2;
  return {
    x: (box.x * page.width - ox) * s,
    y: (box.y * page.height - oy) * s,
    w: box.w * page.width * s,
    h: box.h * page.height * s,
  };
}

function drawPage(ctx: SKRSContext2D, img: Image, page: PageInfo, view: View, W: number, H: number, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);
  const s = W / view.w;
  const ox = view.cx - view.w / 2;
  const oy = view.cy - view.h / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, -ox * s, -oy * s, page.width * s, page.height * s);
  ctx.restore();
}

function drawChrome(ctx: SKRSContext2D, W: number, H: number, title: string, sheetLabel: string, progress: number) {
  const u = H / 720;
  pill(ctx, title, 24 * u, 22 * u, 22 * u, C.inkSoft, C.white, W * 0.6);
  ctx.font = `${17 * u}px ${FONT}`;
  const tw = ctx.measureText(sheetLabel).width;
  pill(ctx, sheetLabel, W - tw - 24 * u - 17 * u * 1.4, 26 * u, 17 * u, C.inkSoft, C.white);
  ctx.fillStyle = C.bar;
  ctx.fillRect(0, H - 6 * u, W, 6 * u);
  ctx.fillStyle = C.accent;
  ctx.fillRect(0, H - 6 * u, W * progress, 6 * u);
}

function drawHighlight(ctx: SKRSContext2D, r: { x: number; y: number; w: number; h: number }, alpha: number, u: number, label?: string, labelAlpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  // pad small boxes so the ring is visible around tiny targets
  const minSize = 46 * u;
  const w = Math.max(r.w, minSize);
  const h = Math.max(r.h, minSize);
  const x = r.x - (w - r.w) / 2;
  const y = r.y - (h - r.h) / 2;
  roundRect(ctx, x, y, w, h, 10 * u);
  ctx.fillStyle = C.accentSoft;
  ctx.fill();
  ctx.lineWidth = 3.5 * u;
  ctx.strokeStyle = C.accent;
  ctx.stroke();
  if (label) {
    ctx.globalAlpha = alpha * labelAlpha;
    const size = 18 * u;
    ctx.font = `${size}px ${FONT}`;
    const pw = ctx.measureText(label).width + size * 1.4;
    const ph = size * 1.8;
    // place label below the box, or above if there is no room
    let lx = x;
    let ly = y + h + 10 * u;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    if (ly + ph > H - 30 * u) ly = y - ph - 10 * u;
    if (lx + pw > W - 20 * u) lx = W - 20 * u - pw;
    if (lx < 20 * u) lx = 20 * u;
    pill(ctx, label, lx, ly, size, C.accent, C.ink);
  }
  ctx.restore();
}

function drawPointer(ctx: SKRSContext2D, x: number, y: number, t: number, u: number) {
  const pulse = 1 + 0.12 * Math.sin(t * 6);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 16 * u * pulse, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(239,68,68,0.25)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 7 * u, 0, Math.PI * 2);
  ctx.fillStyle = C.pointer;
  ctx.fill();
  ctx.lineWidth = 2.5 * u;
  ctx.strokeStyle = C.white;
  ctx.stroke();
  ctx.restore();
}

function drawCard(ctx: SKRSContext2D, W: number, H: number, kicker: string, title: string, lines: string[], alpha: number) {
  const u = H / 720;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.accent;
  ctx.fillRect(64 * u, 92 * u, 56 * u, 6 * u);
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `${20 * u}px ${FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(kicker.toUpperCase(), 64 * u, 140 * u);
  ctx.fillStyle = C.white;
  ctx.font = `${46 * u}px ${FONT}`;
  const tl = wrap(ctx, title, W - 128 * u).slice(0, 2);
  tl.forEach((l, i) => ctx.fillText(l, 64 * u, (200 + i * 56) * u));
  ctx.font = `${22 * u}px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  let y = (200 + tl.length * 56 + 20) * u;
  for (const line of lines) {
    for (const l of wrap(ctx, line, W - 128 * u).slice(0, 2)) {
      if (y > H - 60 * u) break;
      ctx.fillText(l, 64 * u, y);
      y += 34 * u;
    }
  }
  ctx.restore();
}

// ---------- main ----------
export async function renderVideo(brief: Brief, pages: PageInfo[], opts: RenderOptions): Promise<{ total: number; starts: number[] }> {
  const W = opts.width ?? 1280;
  const H = opts.height ?? 720;
  const FPS = opts.fps ?? 24;
  const aspect = W / H;
  const u = H / 720;

  const { shots, total } = buildTimeline(brief, pages, opts.audio, aspect);
  const totalFrames = Math.ceil(total * FPS);

  // audio track: intro silence + narrations (each padded to shot length) + outro silence
  const audioFile = await buildAudioTrack(shots, opts.audio, opts.workDir);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const imgCache = new Map<number, Image>();
  const img = async (p: PageInfo) => {
    let im = imgCache.get(p.index);
    if (!im) {
      im = await loadImage(p.imagePath);
      imgCache.set(p.index, im);
      if (imgCache.size > 6) imgCache.delete(imgCache.keys().next().value as number);
    }
    return im;
  };

  const ff = spawn(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
      "-i", audioFile,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-shortest",
      opts.outFile,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let ffErr = "";
  ff.stderr.on("data", (d) => (ffErr += d.toString()));
  const done = new Promise<void>((resolve, reject) => {
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${ffErr}`))));
    ff.on("error", reject);
  });
  let stdinErr: Error | null = null;
  ff.stdin.on("error", (e) => (stdinErr = e));
  const write = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (stdinErr) return reject(stdinErr);
      if (ff.stdin.write(buf)) resolve();
      else ff.stdin.once("drain", resolve);
    });

  const intro = [brief.oneLiner, `${brief.segments.length} parts · ${pages.length} pages`];
  const outro = [
    ...brief.summary.risks.slice(0, 3).map((r) => "Risk: " + r),
    ...brief.summary.questionsToAsk.slice(0, 2).map((q) => "Ask: " + q),
  ];

  let shotIdx = 0;
  for (let f = 0; f < totalFrames; f++) {
    const t = f / FPS;
    ctx.fillStyle = C.ink;
    ctx.fillRect(0, 0, W, H);

    if (t < INTRO) {
      drawCard(ctx, W, H, brief.documentType + " walkthrough", brief.projectName, intro, 1);
      if (t > INTRO - 0.4 && shots[0]) {
        const s = shots[0];
        drawPage(ctx, await img(s.page), s.page, s.from, W, H, (t - (INTRO - 0.4)) / 0.4);
      }
    } else if (t >= total - OUTRO) {
      const a = Math.min(1, (t - (total - OUTRO)) / 0.5);
      const last = shots[shots.length - 1];
      if (last && a < 1) drawPage(ctx, await img(last.page), last.page, last.to, W, H, 1);
      drawCard(ctx, W, H, "Before you bid", brief.projectName, outro.length ? outro : ["See the written brief for details."], a);
    } else {
      while (shotIdx < shots.length - 1 && t >= shots[shotIdx + 1].start) shotIdx++;
      const s = shots[shotIdx];
      const lt = t - s.start; // local time in shot
      const moveT = easeInOut(lt / MOVE);
      const drift = Math.min(1, lt / s.duration) * 0.03; // slow push-in while holding
      const base = lerpView(s.from, s.to, moveT);
      const view = { ...base, w: base.w * (1 - drift), h: base.h * (1 - drift) };

      // crossfade when the previous shot was on a different page
      const prevShot = shots[shotIdx - 1];
      if (prevShot && prevShot.page.index !== s.page.index && lt < 0.45) {
        drawPage(ctx, await img(prevShot.page), prevShot.page, prevShot.to, W, H, 1);
        drawPage(ctx, await img(s.page), s.page, view, W, H, lt / 0.45);
      } else {
        drawPage(ctx, await img(s.page), s.page, view, W, H, 1);
      }

      // highlights + pointer
      let active = -1;
      for (let i = 0; i < s.callouts.length; i++) if (lt >= s.callouts[i].at) active = i;
      for (let i = 0; i <= active; i++) {
        const c = s.callouts[i];
        const age = lt - c.at;
        const fade = Math.min(1, age / 0.35);
        const alpha = i === active ? fade : 0.35;
        drawHighlight(ctx, toFrame(c.box, s.page, view, W, H), alpha, u, i === active ? c.label : undefined, fade);
      }
      // pointer position: ease from previous target to current
      const target = active >= 0 ? s.callouts[active] : null;
      const prevTarget = active > 0 ? s.callouts[active - 1] : null;
      if (target) {
        const cur = center(toFrame(target.box, s.page, view, W, H));
        let px = cur.x;
        let py = cur.y;
        const age = lt - target.at;
        if (age < 0.55) {
          const from = prevTarget ? center(toFrame(prevTarget.box, s.page, view, W, H)) : { x: W * 0.5, y: H * 0.92 };
          const k = easeInOut(age / 0.55);
          px = lerp(from.x, cur.x, k);
          py = lerp(from.y, cur.y, k);
        }
        drawPointer(ctx, px, py, lt, u);
      }

      drawChrome(ctx, W, H, s.seg.title, `Sheet ${s.page.index + 1} / ${pages.length}`, t / total);
    }

    await write(Buffer.from(ctx.getImageData(0, 0, W, H).data.buffer));
    if (f % 48 === 0) opts.onProgress?.(f / totalFrames);
  }
  ff.stdin.end();
  await done;
  opts.onProgress?.(1);
  return { total, starts: shots.map((s) => s.start) };
}

function center(r: { x: number; y: number; w: number; h: number }) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

async function buildAudioTrack(shots: Shot[], audio: RenderOptions["audio"], workDir: string) {
  const parts: string[] = [];
  const silence = async (name: string, dur: number) => {
    const f = path.join(workDir, name);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", dur.toFixed(3), "-c:a", "aac", f]);
    return f;
  };
  parts.push(await silence("intro.m4a", INTRO));
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const a = audio[i];
    // delay narration by the camera move, pad to shot length
    const f = path.join(workDir, `seg-${i}.m4a`);
    const delayMs = Math.round(MOVE * 1000);
    await run("ffmpeg", [
      "-y", "-loglevel", "error", "-i", a.file,
      "-af", `adelay=${delayMs}|${delayMs},apad,aresample=44100,aformat=channel_layouts=mono`,
      "-t", s.duration.toFixed(3), "-c:a", "aac", f,
    ]);
    parts.push(f);
  }
  parts.push(await silence("outro.m4a", OUTRO));
  const list = path.join(workDir, "audio.txt");
  await fs.writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const out = path.join(workDir, "track.m4a");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
  return out;
}
