/**
 * Trade packages: one scope sheet per trade from the verified brief and the takeoff,
 * ready to send to a sub for pricing. Each package quotes the sheets, keynotes and
 * schedule items that bind that trade, lists its quantities, exclusions, the questions
 * it should raise, and the dates, plus a short email the GC can paste.
 */
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { Brief } from "./types";
import type { PageInfo } from "./ingest";
import type { Takeoff } from "./takeoff";
import { askJson } from "./llm";

export type TradePackage = {
  trade: string;
  csi: string;
  summary: string;
  scope: string[];
  sheets: { sheet: number; why: string }[];
  quantities: { item: string; quantity: number | null; unit: string; sheet: number; method: string }[];
  specs: string[];
  exclusions: string[];
  coordination: string[];
  questions: string[];
  dates: string[];
  email: { subject: string; body: string };
};

const SYSTEM = `You are a general contractor's chief estimator with 25 years of bid-day experience. From a verified document brief and a first-pass takeoff, write the TRADE PACKAGES a GC sends to subcontractors for pricing: one per trade that has real work in this package.

Rules:
- Only include trades with actual scope in the documents. Typical trades: Demolition, Concrete, Masonry, Rough Carpentry/Framing, Drywall & Ceilings, Doors/Frames/Hardware, Storefront & Glazing, Flooring & Tile, Painting, Millwork, Plumbing, HVAC, Electrical, Fire Protection/Sprinkler, Roofing & Waterproofing, Kitchen Equipment, Site/Excavation. Merge or split as the documents warrant.
- Every scope line must come from the sheets or the RFP: quote sheet numbers, keynote numbers, schedule marks, wall types and spec references. No generic boilerplate.
- scope: what the sub must price, specific to this project, as an estimator writes it ("Furnish and install 2-hr rated demising wall type 2, UL U419, basement through 2nd floor, approx 95 LF at 9'-0" and 8'-2"").
- quantities: pull the lines from the takeoff that belong to this trade (keep the item text, quantity, unit, sheet and method). Do not invent quantities; where the set gives none, say so in scope ("count doors from plan; no quantities printed").
- exclusions: what is explicitly NIC or by others in the documents (asbestos abatement by owner, sprinkler under separate filing, owner-furnished cooler), plus what is missing from the set that the sub cannot price (no RCP, no MEP sheets).
- coordination: what this trade must coordinate with (slab cuts for the plumber, blocking for grab bars, hood penetrations).
- questions: the RFIs this trade should raise before bid, with the sheet reference.
- dates: walkthrough, RFI deadline, bid due, NTP, completion, as printed in the brief.
- email: a short, plain email the GC pastes to invite the sub to price: project, what is attached, scope in two or three lines, due date for their number, walkthrough date. Warm, direct, no filler, no em dashes.
- csi: the CSI MasterFormat division, e.g. "09 - Finishes".`;

const SCHEMA = {
  type: "object",
  required: ["packages"],
  properties: {
    packages: {
      type: "array",
      items: {
        type: "object",
        required: ["trade", "csi", "summary", "scope", "sheets", "quantities", "specs", "exclusions", "coordination", "questions", "dates", "email"],
        properties: {
          trade: { type: "string" }, csi: { type: "string" }, summary: { type: "string" },
          scope: { type: "array", items: { type: "string" } },
          sheets: { type: "array", items: { type: "object", required: ["sheet", "why"], properties: { sheet: { type: "integer", description: "0-based page index" }, why: { type: "string" } } } },
          quantities: { type: "array", items: { type: "object", required: ["item", "quantity", "unit", "sheet", "method"], properties: { item: { type: "string" }, quantity: { type: ["number", "null"] }, unit: { type: "string" }, sheet: { type: "integer" }, method: { type: "string" } } } },
          specs: { type: "array", items: { type: "string" } },
          exclusions: { type: "array", items: { type: "string" } },
          coordination: { type: "array", items: { type: "string" } },
          questions: { type: "array", items: { type: "string" } },
          dates: { type: "array", items: { type: "string" } },
          email: { type: "object", required: ["subject", "body"], properties: { subject: { type: "string" }, body: { type: "string" } } },
        },
      },
    },
  },
};

export async function buildTradePackages(brief: Brief, takeoff: Takeoff | null, pages: PageInfo[], workDir: string): Promise<TradePackage[]> {
  await fs.mkdir(workDir, { recursive: true });
  const script = brief.segments.map((s, i) => `[Part ${i + 1}, sheet ${s.page + 1}] ${s.title}\n${s.narration}`).join("\n\n");
  const tk = takeoff ? takeoff.items.map((i) => `${i.id} | ${i.category} | ${i.description} | ${i.quantity ?? "n/a"} ${i.unit} | ${i.method} | sheet ${i.sheet + 1}${i.flag ? " | FLAG: " + i.flag : ""}`).join("\n") : "(no takeoff)";
  const user = `Project: ${brief.projectName}\n${brief.oneLiner}\n\nBrief summary:\n${JSON.stringify(brief.summary, null, 1)}\n\nVerified walkthrough script (sheet numbers are 1-based here; use 0-based page indexes in your answer):\n${script}\n\nFirst-pass takeoff lines:\n${tk}\n\nPage text excerpts:\n${pages.map((p) => `=== PAGE ${p.index} (sheet ${p.index + 1}) ===\n${p.text.slice(0, 2500)}`).join("\n\n")}`;
  const res = await askJson<{ packages: TradePackage[] }>({ system: SYSTEM, user, schema: SCHEMA, name: "trade_packages", workDir, maxTokens: 20000 });
  return (res.packages || []).map((p) => ({
    ...p,
    sheets: (p.sheets || []).map((s) => ({ ...s, sheet: Math.min(pages.length - 1, Math.max(0, Number(s.sheet) || 0)) })),
    quantities: (p.quantities || []).map((q) => ({ ...q, sheet: Math.min(pages.length - 1, Math.max(0, Number(q.sheet) || 0)) })),
  }));
}

const INK = "#0b1220", MUTED = "#5b6472", ACCENT = "#d98c0f", RULE = "#d9dee6";
const PAGE = { w: 612, h: 792, m: 48 }; // portrait letter

export async function renderTradePackagesPdf(brief: Brief, packages: TradePackage[], outFile: string): Promise<number> {
  const doc = new PDFDocument({ size: [PAGE.w, PAGE.h], margin: PAGE.m, autoFirstPage: false, info: { Title: `${brief.projectName}: Trade packages`, Author: "PlanBrief" } });
  const out = createWriteStream(outFile);
  doc.pipe(out);
  for (const p of packages) tradePage(doc, brief, p);
  doc.end();
  await new Promise<void>((res, rej) => { out.on("finish", () => res()); out.on("error", rej); });
  return packages.length;
}

export async function renderOneTradePdf(brief: Brief, p: TradePackage, outFile: string) {
  const doc = new PDFDocument({ size: [PAGE.w, PAGE.h], margin: PAGE.m, autoFirstPage: false, info: { Title: `${brief.projectName}: ${p.trade}`, Author: "PlanBrief" } });
  const out = createWriteStream(outFile);
  doc.pipe(out);
  tradePage(doc, brief, p);
  doc.end();
  await new Promise<void>((res, rej) => { out.on("finish", () => res()); out.on("error", rej); });
}

type Doc = InstanceType<typeof PDFDocument>;
function tradePage(doc: Doc, brief: Brief, p: TradePackage) {
  doc.addPage();
  const W = PAGE.w - PAGE.m * 2;
  doc.rect(PAGE.m, PAGE.m - 6, 10, 10).fill(ACCENT);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(ACCENT).text(`TRADE PACKAGE  ·  ${p.csi.toUpperCase()}`, PAGE.m + 16, PAGE.m - 8, { characterSpacing: 1 });
  doc.font("Helvetica-Bold").fontSize(20).fillColor(INK).text(p.trade, PAGE.m, PAGE.m + 10, { width: W });
  doc.font("Helvetica").fontSize(10.5).fillColor(MUTED).text(brief.projectName, { width: W });
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(p.summary, { width: W, lineGap: 2 });
  const section = (title: string, items: string[], opts: { numbered?: boolean } = {}) => {
    if (!items?.length) return;
    ensure(doc, 40);
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(ACCENT).text(title.toUpperCase(), { characterSpacing: 1 });
    doc.moveDown(0.15);
    items.forEach((it, i) => {
      ensure(doc, 24);
      const y = doc.y; const x = PAGE.m;
      doc.font("Helvetica").fontSize(9.5).fillColor(INK);
      if (opts.numbered) doc.text(`${i + 1}.`, x, y, { width: 16, lineBreak: false });
      else doc.circle(x + 3, y + 5, 1.7).fill(INK);
      doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(it, x + 16, y, { width: W - 16, lineGap: 1.4 });
      doc.y += 3;
    });
  };
  section("Scope of work", p.scope);
  if (p.quantities?.length) {
    ensure(doc, 40);
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(ACCENT).text("QUANTITIES FROM THE SHEETS (first pass; verify before pricing)", { characterSpacing: 1 });
    doc.moveDown(0.2);
    for (const q of p.quantities) {
      ensure(doc, 16);
      const y = doc.y;
      doc.font("Helvetica").fontSize(9).fillColor(INK).text(q.item, PAGE.m, y, { width: W - 175, height: 11, lineBreak: false, ellipsis: true });
      doc.font("Helvetica-Bold").fontSize(9).text(q.quantity == null ? "n/a" : String(q.quantity), PAGE.m + W - 165, y, { width: 55, align: "right", lineBreak: false });
      doc.font("Helvetica").fontSize(9).text(q.unit, PAGE.m + W - 105, y, { width: 30, lineBreak: false });
      doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`${q.method} · sheet ${q.sheet + 1}`, PAGE.m + W - 72, y, { width: 72, align: "right", lineBreak: false });
      doc.y = y + 13;
      doc.moveTo(PAGE.m, doc.y - 2).lineTo(PAGE.m + W, doc.y - 2).lineWidth(0.3).strokeColor(RULE).stroke();
    }
  }
  section("Sheets that bind this trade", p.sheets.map((s) => `Sheet ${s.sheet + 1}: ${s.why}`));
  section("Specifications and schedule items", p.specs);
  section("Exclusions and by others", p.exclusions);
  section("Coordinate with", p.coordination);
  section("Questions to raise before bid", p.questions, { numbered: true });
  section("Dates", p.dates);
  ensure(doc, 120);
  doc.moveDown(0.8);
  const y0 = doc.y;
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(ACCENT).text("INVITATION EMAIL (COPY AND SEND)", { characterSpacing: 1 });
  doc.moveDown(0.2);
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text(`Subject: ${p.email.subject}`, { width: W });
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(p.email.body, { width: W, lineGap: 1.6 });
  doc.roundedRect(PAGE.m - 8, y0 - 6, W + 16, doc.y - y0 + 12, 6).lineWidth(0.6).strokeColor(RULE).stroke();
  doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text("Prepared by PlanBrief from the bid documents. Price from the sheets and specifications; this package is a guide to them.", PAGE.m, PAGE.h - 34, { width: W, lineBreak: false });
}
function ensure(doc: Doc, h: number) {
  if (doc.y + h > PAGE.h - PAGE.m - 10) doc.addPage();
}
