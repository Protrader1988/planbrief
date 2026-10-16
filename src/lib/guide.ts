/**
 * The "Plan Reader's Guide": a printable PDF built from the same verified brief as the
 * video. One page per part, showing the real sheet with the discussed areas boxed and
 * numbered, next to the plain-English explanation. Then the written brief, a glossary
 * of every term the guide explains, and the verification page.
 */
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Brief, Segment } from "./types";
import type { PageInfo } from "./ingest";
import type { VerificationReport } from "./review";
import { viewForBox } from "./render";

const PAGE = { w: 792, h: 612, m: 40 }; // US Letter, landscape
const INK = "#0b1220";
const MUTED = "#5b6472";
const ACCENT = "#d98c0f";
const RULE = "#d9dee6";
const PAPER = "#f4f6f9";

export type GuideOptions = {
  outFile: string;
  workDir: string;
  verification?: VerificationReport;
  onProgress?: (frac: number) => void;
};

type Doc = InstanceType<typeof PDFDocument>;

export async function renderGuide(brief: Brief, pages: PageInfo[], opts: GuideOptions): Promise<{ pages: number }> {
  await fs.mkdir(opts.workDir, { recursive: true });
  const doc = new PDFDocument({ size: [PAGE.w, PAGE.h], margin: PAGE.m, autoFirstPage: false, info: { Title: `${brief.projectName}: Plan Reader's Guide`, Author: "PlanBrief" } });
  const out = createWriteStream(opts.outFile);
  doc.pipe(out);

  cover(doc, brief, pages.length, opts.verification);
  howToRead(doc, brief);

  for (let i = 0; i < brief.segments.length; i++) {
    const seg = brief.segments[i];
    const page = pages[seg.page];
    const img = await cropWithHighlights(seg, page, path.join(opts.workDir, `guide-${i}.jpg`));
    partPage(doc, brief, seg, i, img);
    opts.onProgress?.((i + 1) / brief.segments.length);
  }

  writtenBrief(doc, brief);
  glossary(doc, brief);
  if (opts.verification) verificationPage(doc, opts.verification);
  footerAll(doc, brief);

  doc.end();
  await new Promise<void>((res, rej) => { out.on("finish", () => res()); out.on("error", rej); });
  return { pages: doc.bufferedPageRange().count };
}

// ---------- pages ----------

function cover(doc: Doc, brief: Brief, sheetCount: number, v?: VerificationReport) {
  doc.addPage();
  doc.rect(0, 0, PAGE.w, PAGE.h).fill(INK);
  doc.rect(PAGE.m, PAGE.m, 14, 14).fill(ACCENT);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10).text("PLAN READER'S GUIDE", PAGE.m + 24, PAGE.m + 1, { characterSpacing: 1.5 });
  doc.font("Helvetica-Bold").fontSize(34).fillColor("#ffffff").text(brief.projectName, PAGE.m, 150, { width: PAGE.w - PAGE.m * 2, lineGap: 2 });
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(14).fillColor("rgba(255,255,255,0.78)").fillOpacity(0.8).text(brief.oneLiner, { width: 560, lineGap: 3 });
  doc.fillOpacity(1);
  const m = v?.mechanicalAfterFix ?? v?.mechanical;
  const line = [`${sheetCount} sheets`, `${brief.segments.length} parts`, m ? `${m.totals.verified + m.totals.cited} of ${m.totals.claims} figures checked against the sheets` : null]
    .filter(Boolean).join("   ·   ");
  doc.font("Helvetica").fontSize(10).fillColor("#ffffff").fillOpacity(0.6).text(line, PAGE.m, PAGE.h - PAGE.m - 40);
  doc.text("Read the sheet on the left, the explanation on the right. Numbered boxes on the sheet match the numbered notes.", PAGE.m, PAGE.h - PAGE.m - 24, { width: 600 });
  doc.fillOpacity(1);
}

function howToRead(doc: Doc, brief: Brief) {
  doc.addPage();
  heading(doc, "How to read this guide", "Start to finish takes about " + Math.max(5, Math.round(brief.segments.length * 1.2)) + " minutes");
  const tips = [
    ["Top down", "The guide runs in the order a veteran would read the set: what the project is, then the site, structure, envelope, interiors, systems, schedule, bid terms, and finally the red flags and questions."],
    ["Every number is from the sheet", "Figures are quoted the way the drawing or RFP prints them, with the sheet number. Where a figure is calculated from printed ones, the guide says so."],
    ["Plain English, no dumbing down", "Each trade term is explained the first time it appears, and the Terms Explained section at the back collects them all."],
    ["Boxes and numbers", "On each sheet image, the areas being discussed are boxed and numbered. The numbered notes under the image tell you what each box is."],
    ["Why it matters", "Each part ends with what the information means for a bidder, owner or builder: cost, risk, schedule or a question to ask."],
  ];
  let y = 120;
  for (const [t, body] of tips) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(t, PAGE.m, y, { width: 170 });
    doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(body, PAGE.m + 180, y, { width: PAGE.w - PAGE.m * 2 - 180, lineGap: 2 });
    y = Math.max(y + 18, doc.y) + 14;
    doc.moveTo(PAGE.m, y - 7).lineTo(PAGE.w - PAGE.m, y - 7).lineWidth(0.5).strokeColor(RULE).stroke();
  }
  // contents
  y += 6;
  doc.font("Helvetica-Bold").fontSize(10).fillColor(MUTED).text("CONTENTS", PAGE.m, y, { characterSpacing: 1.2 });
  y += 18;
  const colW = (PAGE.w - PAGE.m * 2 - 20) / 2;
  const perCol = Math.ceil(brief.segments.length / 2);
  brief.segments.forEach((s, i) => {
    const col = Math.floor(i / perCol);
    const row = i % perCol;
    const yy = y + row * 15;
    if (yy > PAGE.h - PAGE.m - 10) return;
    const x = PAGE.m + col * (colW + 20);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(ACCENT).text(String(i + 1).padStart(2, "0"), x, yy, { width: 20 });
    doc.font("Helvetica").fontSize(9).fillColor(INK).text(s.title, x + 22, yy, { width: colW - 70, lineBreak: false, ellipsis: true });
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`sheet ${s.page + 1}`, x + colW - 44, yy, { width: 44, align: "right" });
  });
}

function partPage(doc: Doc, brief: Brief, seg: Segment, i: number, img: { file: string; w: number; h: number }) {
  doc.addPage();
  const ix = PAGE.m, iy = 62;
  const notesH = seg.callouts.length ? 10 + seg.callouts.length * 13 : 0;
  const imgW = 430, imgMaxH = PAGE.h - PAGE.m - 12 - iy - notesH;
  const scale = Math.min(imgW / img.w, imgMaxH / img.h);
  const w = img.w * scale, h = img.h * scale;
  doc.rect(ix - 1, iy - 1, w + 2, h + 2).lineWidth(0.8).strokeColor(RULE).stroke();
  doc.image(img.file, ix, iy, { width: w, height: h });

  // numbered notes under the image
  let ny = iy + h + 10;
  seg.callouts.forEach((c, k) => {
    if (ny + 12 > PAGE.h - PAGE.m) return;
    badge(doc, ix, ny - 1, k + 1, 7);
    doc.font("Helvetica").fontSize(8.5).fillColor(INK).text(c.label, ix + 16, ny, { width: w - 16, lineBreak: false, ellipsis: true });
    ny += 13;
  });

  // right column
  const rx = PAGE.m + imgW + 22, rw = PAGE.w - PAGE.m - rx;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(ACCENT).text(`PART ${i + 1} OF ${brief.segments.length}   ·   SHEET ${seg.page + 1}`, rx, PAGE.m - 4, { characterSpacing: 1 });
  doc.font("Helvetica-Bold").fontSize(15).fillColor(INK).text(seg.title, rx, PAGE.m + 12, { width: rw, lineGap: 1 });
  let ty = doc.y + 8;
  doc.moveTo(rx, ty - 2).lineTo(rx + rw, ty - 2).lineWidth(0.6).strokeColor(ACCENT).stroke();
  ty += 6;

  const paras = seg.narration.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const recapH = seg.recap?.length ? 26 + seg.recap.length * 24 : 0;
  const bottom = PAGE.h - PAGE.m - recapH - 6;
  doc.font("Helvetica").fontSize(9.6).fillColor(INK);
  let size = 9.6;
  const totalH = () => paras.reduce((a, p) => a + doc.heightOfString(p, { width: rw, lineGap: 1.6 }) + 6, 0);
  while (ty + totalH() > bottom && size > 7.6) { size -= 0.4; doc.fontSize(size); }
  let tx = rx, tw = rw, limit = bottom;
  for (const p of paras) {
    if (ty + doc.heightOfString(p, { width: tw, lineGap: 1.6 }) > limit) {
      // overflow: continue on a text-only page
      doc.addPage();
      doc.font("Helvetica-Bold").fontSize(9).fillColor(ACCENT).text(`PART ${i + 1}, CONTINUED`, PAGE.m, PAGE.m - 4, { characterSpacing: 1 });
      ty = PAGE.m + 16; tx = PAGE.m; tw = 560; limit = PAGE.h - PAGE.m - recapH - 6;
      doc.font("Helvetica").fontSize(10.5).fillColor(INK);
    }
    doc.text(p, tx, ty, { width: tw, lineGap: 1.6 });
    ty = doc.y + 6;
  }

  if (seg.recap?.length) {
    const ry = PAGE.h - PAGE.m - recapH;
    doc.roundedRect(rx, ry, rw, recapH, 6).fill(PAPER);
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(ACCENT).text((seg.recapTitle || "Key points").toUpperCase(), rx + 10, ry + 8, { characterSpacing: 1 });
    let yy = ry + 24;
    for (const b of seg.recap) {
      doc.circle(rx + 14, yy + 5, 2).fill(ACCENT);
      doc.font("Helvetica").fontSize(8.8).fillColor(INK).text(b, rx + 22, yy, { width: rw - 32, height: 22, ellipsis: true, lineGap: 1 });
      yy += 24;
    }
  }
}

function writtenBrief(doc: Doc, brief: Brief) {
  const L: [keyof Brief["summary"], string][] = [["scope", "Scope"], ["keyDates", "Key dates"], ["requirements", "Bid requirements"], ["risks", "Risks and red flags"], ["questionsToAsk", "Questions to ask before pricing"]];
  doc.addPage();
  heading(doc, "The written brief", "Everything a bidder needs on one spread");
  const colW = (PAGE.w - PAGE.m * 2 - 24) / 2;
  let col = 0, y = 110;
  for (const [k, title] of L) {
    const items = brief.summary[k];
    if (!items?.length) continue;
    const needed = 20 + items.reduce((a, s) => a + doc.font("Helvetica").fontSize(9.5).heightOfString(s, { width: colW - 14 }) + 5, 0);
    if (y + needed > PAGE.h - PAGE.m) {
      if (col === 0) { col = 1; y = 110; } else { doc.addPage(); heading(doc, "The written brief (continued)", ""); col = 0; y = 110; }
    }
    const x = PAGE.m + col * (colW + 24);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(ACCENT).text(title.toUpperCase(), x, y, { characterSpacing: 1 });
    y += 16;
    for (const s of items) {
      doc.circle(x + 3, y + 5, 1.8).fill(INK);
      doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(s, x + 12, y, { width: colW - 14, lineGap: 1.2 });
      y = doc.y + 5;
    }
    y += 10;
  }
}

/** Terms the narration explains inline ("X means ...", "X, or Y, is ..."), collected. */
export function extractGlossary(brief: Brief): { term: string; meaning: string; part: number }[] {
  const seen = new Set<string>();
  const out: { term: string; meaning: string; part: number }[] = [];
  brief.segments.forEach((s, i) => {
    const sentences = s.narration.split(/(?<=[.!?])\s+/);
    for (const sent of sentences) {
      const m = /^(?:An?|The)?\s*([A-Z][A-Za-z0-9\-/' ]{1,38}?)(?:,\s*(?:or|also called)\s+[^,]{1,40},)?\s+(?:means|is|are)\s+(?:the|a|an)?\s*(.{20,220}?)[.]$/.exec(sent.trim());
      if (!m) continue;
      const term = m[1].trim();
      if (term.split(" ").length > 5 || /^(This|That|It|There|Here|Note|Sheet|Page|Part)\b/.test(term)) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ term, meaning: sent.trim(), part: i + 1 });
    }
  });
  return out.sort((a, b) => a.term.localeCompare(b.term));
}

function glossary(doc: Doc, brief: Brief) {
  const terms = extractGlossary(brief);
  if (!terms.length) return;
  doc.addPage();
  heading(doc, "Terms explained", `${terms.length} terms, in the words of the guide`);
  const colW = (PAGE.w - PAGE.m * 2 - 24) / 2;
  let col = 0, y = 110;
  for (const t of terms) {
    const h = doc.font("Helvetica").fontSize(8.8).heightOfString(t.meaning, { width: colW }) + 16;
    if (y + h > PAGE.h - PAGE.m) {
      if (col === 0) { col = 1; y = 110; } else { doc.addPage(); heading(doc, "Terms explained (continued)", ""); col = 0; y = 110; }
    }
    const x = PAGE.m + col * (colW + 24);
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text(t.term, x, y, { width: colW - 50, lineBreak: false, ellipsis: true });
    doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(`part ${t.part}`, x + colW - 48, y + 1, { width: 48, align: "right" });
    y += 12;
    doc.font("Helvetica").fontSize(8.8).fillColor(INK).text(t.meaning, x, y, { width: colW, lineGap: 1 });
    y = doc.y + 9;
  }
}

function verificationPage(doc: Doc, v: VerificationReport) {
  doc.addPage();
  const m = v.mechanicalAfterFix ?? v.mechanical;
  const verdict = v.summary.verdict === "pass" ? "Passed" : v.summary.verdict === "pass-with-notes" ? "Passed with notes" : "Needs review";
  heading(doc, "How this guide was checked", `Triple verification: ${verdict}`);
  const rows: [string, string][] = [
    ["1. Figure by figure", `${m.totals.verified + m.totals.cited} of ${m.totals.claims} numbers, dimensions, dates and sheet references in the text were matched mechanically to the text printed on the sheets. ${m.totals.derived ? m.totals.derived + " are calculations from printed figures and are labelled as such." : ""}`],
    ["2. Independent review", v.reviewer.ran ? `A separate pass, with no memory of writing the text, read every part against the sheets as a 25-year architect, engineer and builder would and raised ${v.reviewer.issues.length} finding${v.reviewer.issues.length === 1 ? "" : "s"}.` : `Not run${v.reviewer.error ? ": " + v.reviewer.error : ""}.`],
    ["3. Consistency and plain-English audit", v.auditor.ran ? `A third pass checked that the parts agree with each other, that every term is explained, and that nothing is claimed beyond what the sheets show; ${v.auditor.issues.length} finding${v.auditor.issues.length === 1 ? "" : "s"}.` : `Not run${v.auditor.error ? ": " + v.auditor.error : ""}.`],
    ["Corrections", v.fixes.applied ? `${v.fixes.applied} part${v.fixes.applied === 1 ? "" : "s"} corrected before this guide was produced.` : "No corrections were needed."],
    ["Open items", `${v.summary.critical} critical, ${v.summary.major} major, ${v.summary.minor} minor finding${v.summary.minor === 1 ? "" : "s"} remain noted in the text where they apply, usually as a question for the design team.`],
  ];
  let y = 115;
  for (const [t, body] of rows) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(t, PAGE.m, y, { width: 190 });
    doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(body, PAGE.m + 200, y, { width: PAGE.w - PAGE.m * 2 - 200, lineGap: 2 });
    y = Math.max(y + 18, doc.y) + 16;
  }
  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text("This guide explains the documents; it does not replace them. Price from the sheets and the specifications, and send questions to the design team in writing.", PAGE.m, PAGE.h - PAGE.m - 30, { width: 600 });
}

function footerAll(doc: Doc, brief: Brief) {
  const range = doc.bufferedPageRange();
  for (let p = range.start + 1; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(`${brief.projectName}  ·  Plan Reader's Guide`, PAGE.m, PAGE.h - 22, { width: 500, lineBreak: false });
    doc.text(String(p + 1), PAGE.w - PAGE.m - 40, PAGE.h - 22, { width: 40, align: "right", lineBreak: false });
  }
}

// ---------- helpers ----------

function heading(doc: Doc, title: string, sub: string) {
  doc.rect(PAGE.m, PAGE.m - 2, 10, 10).fill(ACCENT);
  doc.font("Helvetica-Bold").fontSize(20).fillColor(INK).text(title, PAGE.m + 18, PAGE.m - 8);
  if (sub) doc.font("Helvetica").fontSize(10.5).fillColor(MUTED).text(sub, PAGE.m + 18, doc.y + 2);
}

function badge(doc: Doc, x: number, y: number, n: number, r: number) {
  doc.circle(x + r, y + r, r).fill(ACCENT);
  doc.font("Helvetica-Bold").fontSize(r * 1.25).fillColor(INK).text(String(n), x, y + r * 0.35, { width: r * 2, align: "center", lineBreak: false });
}

/** Crops the sheet to the part's focus and draws the numbered highlight boxes. */
async function cropWithHighlights(seg: Segment, page: PageInfo, outFile: string): Promise<{ file: string; w: number; h: number }> {
  const img = await loadImage(page.imagePath);
  const union = seg.callouts.length ? unionBox([seg.focus, ...seg.callouts.map((c) => c.box)]) : seg.focus;
  const aspect = Math.max(0.7, Math.min(1.6, (union.w * page.width) / Math.max(1, union.h * page.height)));
  const view = viewForBox(union, page, aspect, 0.12, 0.4);
  const scale = Math.min(1, 1700 / view.w);
  const W = Math.round(view.w * scale), H = Math.round(view.h * scale);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  const sx = view.cx - view.w / 2, sy = view.cy - view.h / 2;
  ctx.drawImage(img, sx, sy, view.w, view.h, 0, 0, W, H);
  const u = W / 1200;
  seg.callouts.forEach((c, k) => {
    const x = (c.box.x * page.width - sx) * scale, y = (c.box.y * page.height - sy) * scale;
    const w = Math.max(c.box.w * page.width * scale, 40 * u), h = Math.max(c.box.h * page.height * scale, 40 * u);
    const pad = 8 * u;
    ctx.fillStyle = "rgba(245,165,36,0.16)";
    ctx.fillRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
    ctx.lineWidth = 3.5 * u;
    ctx.strokeStyle = "rgba(217,140,15,0.95)";
    ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
    const r = 15 * u;
    const bx = Math.min(W - r - 4 * u, Math.max(r + 4 * u, x - pad)), by = Math.max(r + 4 * u, y - pad);
    ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fillStyle = "#d98c0f"; ctx.fill();
    ctx.lineWidth = 2 * u; ctx.strokeStyle = "#ffffff"; ctx.stroke();
    ctx.fillStyle = "#0b1220"; ctx.font = `bold ${r * 1.3}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(k + 1), bx, by + 1 * u);
  });
  await fs.writeFile(outFile, canvas.toBuffer("image/jpeg", 84));
  return { file: outFile, w: W, h: H };
}

function unionBox(boxes: { x: number; y: number; w: number; h: number }[]) {
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
