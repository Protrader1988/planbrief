import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage, GlobalFonts, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { Brief, Box, Segment } from "./types";
import type { PageInfo } from "./ingest";
import type { Narration } from "./tts";
import { chunkNarration } from "./captions";

const run = promisify(execFile);

export type RenderOptions = {
  width?: number;
  height?: number;
  fps?: number;
  /** per-segment narration audio with chunk timing, same order as brief.segments */
  audio: Narration[];
  outFile: string;
  workDir: string;
  /** burn captions into the lower third (default true) */
  captions?: boolean;
  onProgress?: (fraction: number) => void;
};

// ---------- theme ----------
const C = {
  ink: "#0b1220",
  chrome: "rgba(11,18,32,0.82)",
  paper: "#f4f6f9",
  accent: "#f5a524",
  accentSoft: "rgba(245,165,36,0.14)",
  accentLine: "rgba(245,165,36,0.95)",
  pointer: "#e5484d",
  white: "#ffffff",
  muted: "rgba(255,255,255,0.72)",
  track: "rgba(255,255,255,0.12)",
};

let FONT = "sans-serif";
let FONT_BOLD = "sans-serif";
(function registerFonts() {
  const tryReg = (file: string, name: string) => {
    try {
      return GlobalFonts.registerFromPath(file, name);
    } catch {
      return false;
    }
  };
  const sets: [string, string, string][] = [
    ["/usr/share/fonts/opentype/inter/Inter-Medium.otf", "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf", "Inter"],
    ["/usr/share/fonts/truetype/inter/Inter-Medium.ttf", "/usr/share/fonts/truetype/inter/Inter-SemiBold.ttf", "Inter"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVu Sans"],
    ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "Arial"],
  ];
  for (const [reg, bold, name] of sets) {
    if (tryReg(reg, name)) {
      FONT = name;
      FONT_BOLD = tryReg(bold, name + " Bold") ? name + " Bold" : name;
      return;
    }
  }
})();

// ---------- camera math ----------
type View = { cx: number; cy: number; w: number; h: number }; // page-pixel space

/** Fits a page box into the frame aspect with padding, clamped to the page. */
function viewForBox(box: Box, page: { width: number; height: number }, aspect: number, pad: number, minWidthFrac: number): View {
  let w = box.w * page.width * (1 + pad * 2);
  let h = box.h * page.height * (1 + pad * 2);
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  const minW = page.width * minWidthFrac;
  if (w < minW) {
    w = minW;
    h = w / aspect;
  }
  const maxW = Math.max(page.width, page.height * aspect) * 1.02;
  if (w > maxW) {
    w = maxW;
    h = w / aspect;
  }
  let cx = (box.x + box.w / 2) * page.width;
  let cy = (box.y + box.h / 2) * page.height;
  // keep the view on the page when the page is bigger than the view
  if (w < page.width) cx = Math.min(page.width - w / 2, Math.max(w / 2, cx));
  else cx = page.width / 2;
  if (h < page.height) cy = Math.min(page.height - h / 2, Math.max(h / 2, cy));
  else cy = page.height / 2;
  return { cx, cy, w, h };
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function ease(t: number) {
  t = Math.max(0, Math.min(1, t));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function lerpView(a: View, b: View, t: number): View {
  const w = Math.exp(lerp(Math.log(a.w), Math.log(b.w), t));
  return { cx: lerp(a.cx, b.cx, t), cy: lerp(a.cy, b.cy, t), w, h: w * (b.h / b.w) };
}

// ---------- timeline ----------
type TimedCallout = Segment["callouts"][number] & { at: number; view: View };
type Caption = { at: number; text: string };
type Shot = {
  seg: Segment;
  page: PageInfo;
  start: number;
  duration: number;
  narr: number;
  from: View; // where the camera is when the shot starts
  focus: View; // the segment's establishing view
  callouts: TimedCallout[];
  captions: Caption[];
  recap: string[];
  recapAt: number; // local time the recap card starts (= duration when none)
};

const INTRO = 3.4;
const OUTRO = 4.5;
const MOVE = 1.0; // camera travel time
const GAP = 0.7; // breathing room after narration ends
const CALLOUT_MIN_SPACING = 2.2;
const RECAP = 4.5; // seconds a recap card stays up

function buildTimeline(brief: Brief, pages: PageInfo[], audio: RenderOptions["audio"], aspect: number) {
  const shots: Shot[] = [];
  let t = INTRO;
  let prev: View | null = null;
  let prevPage = -1;
  brief.segments.forEach((seg, i) => {
    const page = pages[seg.page] ?? pages[0];
    const focus = viewForBox(seg.focus, page, aspect, 0.06, 0.2);
    const full = viewForBox({ x: 0, y: 0, w: 1, h: 1 }, page, aspect, 0.01, 0);
    const from = prev && prevPage === page.index ? prev : full;
    const a = audio[i] ?? { file: "", duration: 5, chunks: chunkNarration(seg.narration).map((c) => ({ ...c, start: 0, duration: 5 })) };
    const narr = a.duration;
    const recap = (seg.recap ?? []).map((r) => String(r).trim()).filter(Boolean).slice(0, 4);
    const recapAt = narr + MOVE + GAP;
    const duration = recapAt + (recap.length ? RECAP : 0);
    const callouts = timeCallouts(seg, a, page, aspect);
    const captions = a.chunks.map((c) => ({ at: MOVE + c.start, text: c.text }));
    shots.push({ seg, page, start: t, duration, narr, from, focus, callouts, captions, recap, recapAt });
    t += duration;
    prev = callouts.length ? callouts[callouts.length - 1].view : focus;
    prevPage = page.index;
  });
  return { shots, total: t + OUTRO };
}

/** When a character offset of the narration is spoken, from the real chunk timings. */
function spokenTime(a: Narration, charIdx: number, textLen: number) {
  const ch = a.chunks;
  let k = 0;
  for (let i = 0; i < ch.length; i++) if (charIdx >= ch[i].charStart) k = i;
  const c = ch[k];
  const cLen = (k + 1 < ch.length ? ch[k + 1].charStart : textLen) - c.charStart;
  const frac = cLen > 0 ? Math.min(1, Math.max(0, (charIdx - c.charStart) / cLen)) : 0;
  return MOVE + c.start + frac * c.duration;
}

function timeCallouts(seg: Segment, a: Narration, page: PageInfo, aspect: number): TimedCallout[] {
  const n = seg.narration;
  const lower = n.toLowerCase();
  const out = seg.callouts.map((c, i) => {
    const idx = c.cue ? lower.indexOf(c.cue.toLowerCase()) : -1;
    const at = idx >= 0 ? spokenTime(a, idx, n.length) : MOVE + ((i + 1) / (seg.callouts.length + 1)) * a.duration;
    // Zoom so the detail is legible: pad the box, never tighter than 26% of the page width.
    const view = viewForBox(c.box, page, aspect, 0.45, 0.26);
    return { ...c, at: Math.max(at, MOVE + 0.6), view };
  });
  out.sort((x, y) => x.at - y.at);
  for (let i = 1; i < out.length; i++) {
    if (out[i].at < out[i - 1].at + CALLOUT_MIN_SPACING) out[i].at = out[i - 1].at + CALLOUT_MIN_SPACING;
  }
  return out;
}

/** Camera view for a shot at local time lt. */
function cameraAt(shot: Shot, lt: number): View {
  // keyframes: establishing view at 0, then each callout
  const keys: { at: number; view: View }[] = [{ at: 0, view: shot.focus }, ...shot.callouts.map((c) => ({ at: c.at, view: c.view }))];
  let k = 0;
  for (let i = 0; i < keys.length; i++) if (lt >= keys[i].at) k = i;
  const cur = keys[k];
  const prevView = k === 0 ? shot.from : keys[k - 1].view;
  const moveT = ease((lt - cur.at) / MOVE);
  const base = lerpView(prevView, cur.view, moveT);
  // slow push-in while holding so the picture never feels frozen
  const holdT = Math.max(0, lt - cur.at - MOVE);
  const drift = Math.min(0.035, holdT * 0.004);
  return { ...base, w: base.w * (1 - drift), h: base.h * (1 - drift) };
}

// ---------- drawing ----------
function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function pill(ctx: SKRSContext2D, text: string, x: number, y: number, size: number, bg: string, fg: string, opts: { maxW?: number; bold?: boolean } = {}) {
  ctx.font = `${size}px ${opts.bold ? FONT_BOLD : FONT}`;
  let label = text;
  if (opts.maxW) while (label.length > 4 && ctx.measureText(label).width > opts.maxW - size * 1.6) label = label.slice(0, -2) + "…";
  const tw = ctx.measureText(label).width;
  const padX = size * 0.8;
  const h = size * 1.9;
  roundRect(ctx, x, y, tw + padX * 2, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + padX, y + h / 2 + size * 0.04);
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

function toFrame(box: Box, page: PageInfo, view: View, W: number) {
  const s = W / view.w;
  const ox = view.cx - view.w / 2;
  const oy = view.cy - view.h / 2;
  return { x: (box.x * page.width - ox) * s, y: (box.y * page.height - oy) * s, w: box.w * page.width * s, h: box.h * page.height * s };
}

function drawPage(ctx: SKRSContext2D, img: Image, page: PageInfo, view: View, W: number, H: number, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);
  const s = W / view.w;
  const ox = view.cx - view.w / 2;
  const oy = view.cy - view.h / 2;
  // soft shadow so the sheet reads as a sheet when it doesn't fill the frame
  ctx.shadowColor = "rgba(0,0,0,0.18)";
  ctx.shadowBlur = 24 * (H / 720);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(-ox * s, -oy * s, page.width * s, page.height * s);
  ctx.shadowBlur = 0;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, -ox * s, -oy * s, page.width * s, page.height * s);
  ctx.restore();
}

function drawChrome(ctx: SKRSContext2D, W: number, H: number, u: number, title: string, right: string, progress: number) {
  pill(ctx, title, 26 * u, 22 * u, 21 * u, C.chrome, C.white, { maxW: W * 0.62, bold: true });
  ctx.font = `${16 * u}px ${FONT}`;
  const tw = ctx.measureText(right).width + 16 * u * 1.6;
  pill(ctx, right, W - tw - 26 * u, 26 * u, 16 * u, C.chrome, C.muted);
  ctx.fillStyle = C.track;
  ctx.fillRect(0, H - 5 * u, W, 5 * u);
  ctx.fillStyle = C.accent;
  ctx.fillRect(0, H - 5 * u, W * progress, 5 * u);
}

function drawHighlight(ctx: SKRSContext2D, u: number, r: { x: number; y: number; w: number; h: number }, alpha: number, label?: string, labelAlpha = 1) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.save();
  ctx.globalAlpha = alpha;
  const minSize = 54 * u;
  const w = Math.max(r.w, minSize) + 12 * u;
  const h = Math.max(r.h, minSize) + 12 * u;
  const x = r.x - (w - r.w) / 2;
  const y = r.y - (h - r.h) / 2;
  roundRect(ctx, x, y, w, h, 8 * u);
  ctx.fillStyle = C.accentSoft;
  ctx.fill();
  ctx.lineWidth = 3 * u;
  ctx.strokeStyle = C.accentLine;
  ctx.stroke();
  // corner ticks make the box read as a deliberate frame, not a smudge
  const tick = 14 * u;
  ctx.lineWidth = 4 * u;
  ctx.beginPath();
  for (const [px, py, dx, dy] of [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1],
  ]) {
    ctx.moveTo(px + dx * tick, py);
    ctx.lineTo(px, py);
    ctx.lineTo(px, py + dy * tick);
  }
  ctx.stroke();
  if (label) {
    ctx.globalAlpha = alpha * labelAlpha;
    const size = 19 * u;
    ctx.font = `${size}px ${FONT_BOLD}`;
    const pw = ctx.measureText(label).width + size * 1.6;
    const ph = size * 1.9;
    let lx = x;
    let ly = y + h + 12 * u;
    if (ly + ph > H - 120 * u) ly = y - ph - 12 * u; // keep clear of captions
    if (ly < 70 * u) ly = y + h + 12 * u;
    if (lx + pw > W - 24 * u) lx = W - 24 * u - pw;
    if (lx < 24 * u) lx = 24 * u;
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = 10 * u;
    ctx.shadowOffsetY = 3 * u;
    pill(ctx, label, lx, ly, size, C.accent, C.ink, { bold: true });
  }
  ctx.restore();
}

function drawPointer(ctx: SKRSContext2D, u: number, x: number, y: number, t: number) {
  const pulse = 1 + 0.15 * Math.sin(t * 5.5);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 18 * u * pulse, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(229,72,77,0.22)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 7.5 * u, 0, Math.PI * 2);
  ctx.fillStyle = C.pointer;
  ctx.fill();
  ctx.lineWidth = 2.5 * u;
  ctx.strokeStyle = C.white;
  ctx.stroke();
  ctx.restore();
}

function drawCaption(ctx: SKRSContext2D, W: number, H: number, u: number, text: string, alpha: number) {
  const size = 24 * u;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${size}px ${FONT}`;
  const lines = wrap(ctx, text, W * 0.78).slice(0, 2);
  const lh = size * 1.35;
  const padX = 22 * u;
  const padY = 14 * u;
  const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const bh = lines.length * lh + padY * 2;
  const bx = (W - bw) / 2;
  const by = H - bh - 28 * u;
  roundRect(ctx, bx, by, bw, bh, 10 * u);
  ctx.fillStyle = C.chrome;
  ctx.fill();
  ctx.fillStyle = C.white;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  lines.forEach((l, i) => ctx.fillText(l, W / 2, by + padY + lh * (i + 0.5)));
  ctx.restore();
}

function drawCard(ctx: SKRSContext2D, W: number, H: number, u: number, kicker: string, title: string, lines: string[], alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#0b1220");
  g.addColorStop(1, "#16213a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.accent;
  ctx.fillRect(72 * u, 100 * u, 64 * u, 6 * u);
  ctx.fillStyle = C.muted;
  ctx.font = `${19 * u}px ${FONT_BOLD}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(kicker.toUpperCase(), 72 * u, 148 * u);
  ctx.fillStyle = C.white;
  ctx.font = `${50 * u}px ${FONT_BOLD}`;
  const tl = wrap(ctx, title, W - 144 * u).slice(0, 2);
  tl.forEach((l, i) => ctx.fillText(l, 72 * u, (212 + i * 60) * u));
  ctx.font = `${23 * u}px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  let y = (212 + tl.length * 60 + 24) * u;
  for (const line of lines) {
    for (const l of wrap(ctx, line, W - 144 * u).slice(0, 2)) {
      if (y > H - 70 * u) break;
      ctx.fillText(l, 72 * u, y);
      y += 36 * u;
    }
  }
  ctx.restore();
}

function drawRecap(ctx: SKRSContext2D, W: number, H: number, u: number, title: string, bullets: string[], alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgba(11,18,32,0.72)";
  ctx.fillRect(0, 0, W, H);
  const cw = Math.min(W * 0.74, 980 * u);
  const padX = 44 * u;
  ctx.font = `${22 * u}px ${FONT}`;
  const lines: string[][] = bullets.map((b) => wrap(ctx, b, cw - padX * 2 - 34 * u).slice(0, 2));
  const lh = 32 * u;
  const bodyH = lines.reduce((n, l) => n + l.length * lh + 14 * u, 0);
  const ch = 118 * u + bodyH;
  const cx = (W - cw) / 2;
  const cy = (H - ch) / 2;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 40 * u;
  roundRect(ctx, cx, cy, cw, ch, 18 * u);
  ctx.fillStyle = "#121a2e";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = C.accent;
  ctx.fillRect(cx + padX, cy + 40 * u, 44 * u, 5 * u);
  ctx.fillStyle = C.muted;
  ctx.font = `${16 * u}px ${FONT_BOLD}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("KEY POINTS", cx + padX, cy + 72 * u);
  ctx.fillStyle = C.white;
  ctx.font = `${24 * u}px ${FONT_BOLD}`;
  ctx.fillText(title.replace(/^\d+\.\s*/, ""), cx + padX, cy + 104 * u);
  let y = cy + 118 * u + 24 * u;
  ctx.font = `${22 * u}px ${FONT}`;
  for (const l of lines) {
    ctx.fillStyle = C.accent;
    ctx.beginPath();
    ctx.arc(cx + padX + 8 * u, y - 8 * u, 5 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    l.forEach((line, i) => ctx.fillText(line, cx + padX + 34 * u, y + i * lh));
    y += l.length * lh + 14 * u;
  }
  ctx.restore();
}

// ---------- main ----------
export async function renderVideo(brief: Brief, pages: PageInfo[], opts: RenderOptions): Promise<{ total: number; starts: number[] }> {
  const W = opts.width ?? 1920;
  const H = opts.height ?? 1080;
  const FPS = opts.fps ?? 24;
  const aspect = W / H;
  const u = H / 720;
  const captionsOn = opts.captions ?? true;

  const { shots, total } = buildTimeline(brief, pages, opts.audio, aspect);
  const totalFrames = Math.ceil(total * FPS);
  const audioFile = await buildAudioTrack(shots, opts.audio, opts.workDir);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const imgCache = new Map<number, Image>();
  const img = async (p: PageInfo) => {
    let im = imgCache.get(p.index);
    if (!im) {
      im = await loadImage(p.imagePath);
      imgCache.set(p.index, im);
      if (imgCache.size > 3) imgCache.delete(imgCache.keys().next().value as number);
    }
    return im;
  };

  const ff = spawn(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
      "-i", audioFile,
      "-c:v", "libx264", "-preset", process.env.VIDEO_PRESET || "medium", "-crf", process.env.VIDEO_CRF || "18",
      "-pix_fmt", "yuv420p", "-profile:v", "high", "-tune", "stillimage",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest",
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

  const intro = [brief.oneLiner, `${brief.segments.length} parts · ${pages.length} sheets`];
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
      drawCard(ctx, W, H, u, brief.documentType + " walkthrough", brief.projectName, intro, 1);
      if (t > INTRO - 0.5 && shots[0]) {
        const s = shots[0];
        drawPage(ctx, await img(s.page), s.page, s.from, W, H, (t - (INTRO - 0.5)) / 0.5);
      }
    } else if (t >= total - OUTRO) {
      const a = Math.min(1, (t - (total - OUTRO)) / 0.6);
      const last = shots[shots.length - 1];
      if (last && a < 1) drawPage(ctx, await img(last.page), last.page, cameraAt(last, last.duration), W, H, 1);
      drawCard(ctx, W, H, u, "Before you bid", brief.projectName, outro.length ? outro : ["See the written brief for details."], a);
    } else {
      while (shotIdx < shots.length - 1 && t >= shots[shotIdx + 1].start) shotIdx++;
      const s = shots[shotIdx];
      const lt = t - s.start;
      const view = cameraAt(s, lt);

      const prevShot = shots[shotIdx - 1];
      if (prevShot && prevShot.page.index !== s.page.index && lt < 0.5) {
        drawPage(ctx, await img(prevShot.page), prevShot.page, cameraAt(prevShot, prevShot.duration), W, H, 1);
        drawPage(ctx, await img(s.page), s.page, view, W, H, lt / 0.5);
      } else {
        drawPage(ctx, await img(s.page), s.page, view, W, H, 1);
      }

      let active = -1;
      for (let i = 0; i < s.callouts.length; i++) if (lt >= s.callouts[i].at) active = i;
      for (let i = 0; i <= active; i++) {
        const c = s.callouts[i];
        const age = lt - c.at;
        const fade = Math.min(1, age / 0.35);
        const r = toFrame(c.box, s.page, view, W);
        if (r.x + r.w < -50 || r.y + r.h < -50 || r.x > W + 50 || r.y > H + 50) continue;
        drawHighlight(ctx, u, r, i === active ? fade : 0.3, i === active ? c.label : undefined, Math.min(1, Math.max(0, (age - MOVE * 0.6) / 0.3)));
      }
      const target = active >= 0 ? s.callouts[active] : null;
      if (target) {
        const cur = toFrame(target.box, s.page, view, W);
        const cx = cur.x + cur.w / 2;
        const cy = cur.y + cur.h / 2;
        let px = cx;
        let py = cy;
        const age = lt - target.at;
        if (age < 0.6) {
          const prevT = active > 0 ? s.callouts[active - 1] : null;
          const from = prevT ? toFrame(prevT.box, s.page, view, W) : { x: W * 0.5, y: H * 0.95, w: 0, h: 0 };
          const k = ease(age / 0.6);
          px = lerp(from.x + from.w / 2, cx, k);
          py = lerp(from.y + from.h / 2, cy, k);
        }
        drawPointer(ctx, u, px, py, lt);
      }

      if (captionsOn) {
        let ci = -1;
        for (let i = 0; i < s.captions.length; i++) if (lt >= s.captions[i].at) ci = i;
        if (ci >= 0 && lt < MOVE + s.narr + 0.4) {
          const age = lt - s.captions[ci].at;
          drawCaption(ctx, W, H, u, s.captions[ci].text, Math.min(1, age / 0.2));
        }
      }

      drawChrome(ctx, W, H, u, s.seg.title, `Sheet ${s.page.index + 1} of ${pages.length}`, t / total);
      if (s.recap.length && lt >= s.recapAt) {
        const age = lt - s.recapAt;
        const left = s.duration - lt;
        drawRecap(ctx, W, H, u, s.seg.recapTitle || "Recap", s.recap, Math.min(1, age / 0.35, left / 0.35));
      }
    }

    await write(Buffer.from(ctx.getImageData(0, 0, W, H).data.buffer));
    if (f % 48 === 0) opts.onProgress?.(f / totalFrames);
  }
  ff.stdin.end();
  await done;
  opts.onProgress?.(1);
  return { total, starts: shots.map((s) => s.start) };
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
