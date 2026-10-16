/**
 * Takeoff with receipts. Phase 1: every countable quantity the set already prints
 * (schedules, areas, dimensions, volumes, counts, allowances), each with the sheet it came
 * from, the exact source text, the method (printed / counted / derived) and a confidence,
 * then checked mechanically against the sheet text and by an independent estimator pass.
 * Measured takeoff from vector geometry (wall LF, floor SF) is phase 2.
 */
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import type { PageInfo } from "./ingest";
import type { Brief } from "./types";
import { askJson } from "./llm";
import { norm, has } from "./verify";

export type TakeoffMethod = "printed" | "counted" | "derived";
export type TakeoffItem = {
  id: string;
  category: string;
  description: string;
  quantity: number | null;
  unit: string;
  method: TakeoffMethod;
  /** 0-based page */
  sheet: number;
  location: string;
  sourceText: string;
  note?: string;
  confidence: "high" | "medium" | "low";
  /** set by verification */
  status?: "verified" | "unverified" | "derived" | "flagged";
  flag?: string;
};
export type NotCountable = { what: string; why: string; where: string };
export type Takeoff = {
  items: TakeoffItem[];
  notCountable: NotCountable[];
  checks: { mechanical: { verified: number; derived: number; unverified: number }; estimator: { ran: boolean; findings: number; error?: string } };
};

const CATEGORIES = ["Site and demolition", "Concrete", "Masonry", "Framing and structure", "Envelope and roofing", "Doors and hardware", "Windows and storefront", "Finishes", "Millwork and specialties", "Plumbing fixtures and equipment", "Mechanical", "Electrical", "Fire protection", "Equipment", "Areas and occupancy", "Allowances and alternates", "Other"];

const SYSTEM = `You are a senior construction estimator with 25 years of takeoff experience on commercial and residential work. You are producing the FIRST PASS of a quantity takeoff from a document package: every quantity that the sheets themselves state or that can be counted or derived from what they state. You are not measuring with a scale in this pass.

Rules, in order of importance:
1. Only record what is on the sheets. Each item must quote the exact printed text it comes from (sourceText), verbatim, as it appears in the extracted text or legibly in the image. If you cannot quote it, do not record it.
2. method = "printed" when the number is printed on the sheet (schedule quantity, area table, dimension string, volume calc). method = "counted" when you counted symbols, tags or rows yourself (say what you counted in note). method = "derived" when you computed it from printed numbers (show the arithmetic in note).
3. Capture schedules row by row: door, window, finish, fixture, equipment, lighting and hardware schedules. One item per row or type, with the printed size, type and any printed quantity. If a schedule has no quantity column, record the type with quantity null and say "no quantity printed" in note.
4. Capture every printed area, length, volume, count, occupant load, floor area, lot area, R-value, PSI, thickness, spacing (e.g. 2x6 at 16" o.c.), and every allowance or alternate amount.
5. Units: use SF, LF, CY, CF, EA, SY, LB, TON, GAL, %, PSI, HR, or the unit as printed. Keep feet-inches as printed in sourceText and convert to decimal feet for quantity when it is a length.
6. Keep descriptions specific and estimator-ready: "Door D-2, 3'-0" x 7'-0", HM, 90 min, closer, kickplate" not "door".
7. confidence: high = printed and legible; medium = counted from symbols or partially legible; low = derived with assumptions or hard to read.
8. In notCountable, list the quantities an estimator will need that this package cannot give (no door tags on plan, no RCP, no MEP sheets, no dimensions on plan, scale missing), each with the sheet that would normally carry it.
Never invent a number. A missing number recorded honestly is worth more than a guess.`;

const SCHEMA = {
  type: "object",
  required: ["items", "notCountable"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["category", "description", "quantity", "unit", "method", "sheet", "location", "sourceText", "confidence"],
        properties: {
          category: { type: "string", enum: CATEGORIES },
          description: { type: "string" },
          quantity: { type: ["number", "null"] },
          unit: { type: "string" },
          method: { type: "string", enum: ["printed", "counted", "derived"] },
          sheet: { type: "integer", description: "0-based page index" },
          location: { type: "string", description: "Where on the sheet, e.g. 'door schedule, row D-2' or 'floor area table, residential total'" },
          sourceText: { type: "string", description: "Exact printed text the item comes from" },
          note: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
    notCountable: { type: "array", items: { type: "object", required: ["what", "why", "where"], properties: { what: { type: "string" }, why: { type: "string" }, where: { type: "string" } } } },
  },
};

const CHECK_SYSTEM = `You are a second, independent senior estimator checking another estimator's first-pass takeoff against the sheets. For each item decide whether the quantity, unit and description are what the sheet actually says. Report only real problems: a number that is not on the sheet, a wrong unit, a row misread, a quantity attributed to the wrong sheet, a derived figure whose arithmetic is wrong, or a double count. Do not report style. For each problem give the item id, what is wrong, and the correction with the sheet evidence.`;

const CHECK_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: { type: "object", required: ["id", "problem", "correction", "evidence"], properties: { id: { type: "string" }, problem: { type: "string" }, correction: { type: "string" }, evidence: { type: "string" }, correctedQuantity: { type: ["number", "null"] }, correctedUnit: { type: "string" } } },
    },
  },
};

const GROUP = Number(process.env.TAKEOFF_PAGES_PER_CALL || 4);

export async function extractTakeoff(pages: PageInfo[], brief: Brief, workDir: string, onProgress?: (m: string) => void): Promise<Takeoff> {
  await fs.mkdir(workDir, { recursive: true });
  const groups: PageInfo[][] = [];
  for (let i = 0; i < pages.length; i += GROUP) groups.push(pages.slice(i, i + GROUP));
  const all: TakeoffItem[] = [];
  const notCountable: NotCountable[] = [];
  const context = `Project: ${brief.projectName}. ${brief.oneLiner}\nScope summary: ${brief.summary.scope.join("; ")}`;

  // two groups at a time: the CLI/API handles it and it halves the wall time on big sets
  for (let g = 0; g < groups.length; g += 2) {
    const batch = groups.slice(g, g + 2);
    onProgress?.(`Takeoff: sheets ${batch[0][0].index + 1} to ${batch[batch.length - 1].at(-1)!.index + 1} of ${pages.length}`);
    const results = await Promise.all(batch.map((grp, k) => {
      const user = `${context}\n\nTake off the quantities on these sheets only (page indexes are 0-based):\n\n` +
        grp.map((p) => `=== PAGE ${p.index} (sheet ${p.index + 1} of ${pages.length}) ===\nExtracted text:\n${p.text.slice(0, 9000)}`).join("\n\n");
      return askJson<{ items: TakeoffItem[]; notCountable: NotCountable[] }>({
        system: SYSTEM, user, images: grp.map((p) => ({ label: `PAGE ${p.index}`, path: p.thumbPath })),
        schema: SCHEMA, name: `takeoff_${g + k}`, workDir: path.join(workDir, `g${g + k}`), maxTokens: 16000,
      });
    }));
    for (const r of results) {
      for (const it of r.items || []) all.push(it);
      for (const n of r.notCountable || []) notCountable.push(n);
    }
  }

  // normalize, dedupe, id
  const seen = new Set<string>();
  const items: TakeoffItem[] = [];
  for (const it of all) {
    if (!it || !it.description || !it.sourceText) continue;
    const sheet = Math.min(pages.length - 1, Math.max(0, Number(it.sheet) || 0));
    const key = `${sheet}|${norm(it.description)}|${it.quantity}|${(it.unit || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: `t${items.length + 1}`,
      category: CATEGORIES.includes(it.category) ? it.category : "Other",
      description: String(it.description).slice(0, 200),
      quantity: typeof it.quantity === "number" && Number.isFinite(it.quantity) ? it.quantity : null,
      unit: String(it.unit || "").slice(0, 12),
      method: (["printed", "counted", "derived"] as const).includes(it.method) ? it.method : "printed",
      sheet,
      location: String(it.location || "").slice(0, 120),
      sourceText: String(it.sourceText).slice(0, 300),
      note: it.note ? String(it.note).slice(0, 300) : undefined,
      confidence: (["high", "medium", "low"] as const).includes(it.confidence) ? it.confidence : "medium",
    });
  }

  // check 1: mechanical, against the sheet text
  const mech = mechanicalTakeoffCheck(items, pages);

  // check 2: independent estimator
  const estimator: Takeoff["checks"]["estimator"] = { ran: false, findings: 0 };
  try {
    const used = [...new Set(items.map((i) => i.sheet))].sort((a, b) => a - b);
    const user = `First-pass takeoff to check:\n${JSON.stringify(items.map(({ id, category, description, quantity, unit, method, sheet, location, sourceText, note }) => ({ id, category, description, quantity, unit, method, sheet, location, sourceText, note })), null, 0)}\n\nExtracted text of the sheets used:\n` +
      used.map((n) => `=== PAGE ${n} ===\n${pages[n].text.slice(0, 8000)}`).join("\n\n");
    const res = await askJson<{ findings: { id: string; problem: string; correction: string; evidence: string; correctedQuantity?: number | null; correctedUnit?: string }[] }>({
      system: CHECK_SYSTEM, user, images: used.map((n) => ({ label: `PAGE ${n}`, path: pages[n].thumbPath })),
      schema: CHECK_SCHEMA, name: "takeoff_check", workDir: path.join(workDir, "check"), maxTokens: 12000,
    });
    estimator.ran = true;
    for (const f of res.findings || []) {
      const it = items.find((i) => i.id === f.id);
      if (!it) continue;
      estimator.findings++;
      it.status = "flagged";
      it.flag = `${f.problem} Correction: ${f.correction} (${f.evidence})`;
      if (typeof f.correctedQuantity === "number") { it.note = `${it.note ? it.note + " " : ""}Was ${it.quantity} ${it.unit}; corrected by check.`; it.quantity = f.correctedQuantity; if (f.correctedUnit) it.unit = f.correctedUnit; }
    }
  } catch (e) {
    estimator.error = e instanceof Error ? e.message : String(e);
  }

  items.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.sheet - b.sheet);
  return { items, notCountable: dedupeNC(notCountable), checks: { mechanical: mech, estimator } };
}

/** Matches each line's quoted source text and quantity against the sheet's text layer. */
export function mechanicalTakeoffCheck(items: TakeoffItem[], pages: PageInfo[]) {
  const mech = { verified: 0, derived: 0, unverified: 0 };
  for (const it of items) {
    const text = norm(pages[it.sheet].text);
    if (it.method === "derived") { it.status = "derived"; mech.derived++; continue; }
    // quoted text may carry "..." gaps; every quoted piece must appear (most of its words, in order-free form)
    const pieces = norm(it.sourceText).split(/\s*(?:\.\.\.|…)\s*/).map((x) => x.trim()).filter((x) => x.length >= 2);
    const pieceOk = (pc: string) => {
      if (text.includes(pc)) return true;
      const words = pc.split(/\s+/).filter((w) => w.length > 1);
      const found = words.filter((w) => text.includes(w)).length;
      return words.length > 0 && found / words.length >= 0.8;
    };
    const srcOk = pieces.length > 0 && pieces.every(pieceOk);
    const qty = it.quantity;
    const qtyOk = qty == null || has(text, String(qty), { rounding: true }) || has(text, qty.toFixed(2), { rounding: true }) || hasFeetInches(text, qty) || hasFraction(text, qty);
    if (srcOk && qtyOk) { it.status = "verified"; mech.verified++; }
    else if (it.method === "counted" && srcOk) { it.status = "verified"; mech.verified++; }
    else { it.status = "unverified"; it.flag = !srcOk ? "Quoted text not found on the sheet's text layer (may be image-only); check the sheet." : "Quantity not found on the sheet as printed; check the sheet."; mech.unverified++; }
  }
  return mech;
}

/** 3.625 matches "3 5/8", 0.75 matches "3/4", 2.5 matches "2 1/2" or "2-1/2". */
function hasFraction(text: string, qty: number): boolean {
  const whole = Math.floor(qty);
  const frac = qty - whole;
  if (frac < 0.01) return false;
  for (const den of [2, 3, 4, 8, 16]) {
    const num = Math.round(frac * den);
    if (num > 0 && num < den && Math.abs(frac - num / den) < 0.002) {
      const f = `${num}/${den}`;
      const forms = whole > 0 ? [`${whole} ${f}`, `${whole}-${f}`, `${whole}${f}`] : [f];
      if (forms.some((v) => text.includes(v))) return true;
    }
  }
  return false;
}

/** 48.31 matches 48'-3 3/4" (also as the extractor garbles it, 48'-343"), 104.375 matches 104'-4 1/2", 60 matches 60'-0". */
function hasFeetInches(text: string, qty: number): boolean {
  const ft = Math.floor(qty);
  const inchesF = (qty - ft) * 12;
  let inch = Math.floor(inchesF + 1e-6);
  let rem = inchesF - inch;
  if (rem > 0.9) { inch += 1; rem = 0; }
  if (rem < 0.03) {
    if (Math.abs(qty - (ft + inch / 12)) > 0.01) return false;
    return has(text, `${ft}'${inch}`, { fraction: true }) || (inch === 0 && has(text, `${ft}'0`, { fraction: true }));
  }
  for (const den of [2, 4, 8, 16]) {
    const num = Math.round(rem * den);
    if (num > 0 && num < den && Math.abs(rem - num / den) < 0.03) {
      const forms = [`${ft}'${inch} ${num}/${den}`, `${ft}'${inch}-${num}/${den}`, `${ft}'${inch}${num}${den}`, `${ft}'${inch}${num}/${den}`];
      if (forms.some((v) => text.includes(v))) return true;
    }
  }
  return false;
}

function dedupeNC(xs: NotCountable[]): NotCountable[] {
  const seen = new Set<string>();
  return xs.filter((x) => { const k = norm(x.what); if (seen.has(k)) return false; seen.add(k); return true; });
}

export async function writeTakeoffXlsx(t: Takeoff, brief: Brief, outFile: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "PlanBrief";
  const ws = wb.addWorksheet("Takeoff", { views: [{ state: "frozen", ySplit: 4 }] });
  ws.columns = [
    { header: "#", key: "id", width: 6 }, { header: "Category", key: "category", width: 26 }, { header: "Description", key: "description", width: 54 },
    { header: "Qty", key: "quantity", width: 11 }, { header: "Unit", key: "unit", width: 7 }, { header: "Method", key: "method", width: 9 },
    { header: "Sheet", key: "sheet", width: 7 }, { header: "Where on sheet", key: "location", width: 30 }, { header: "Printed text", key: "sourceText", width: 48 },
    { header: "Check", key: "status", width: 11 }, { header: "Confidence", key: "confidence", width: 11 }, { header: "Notes / flags", key: "note", width: 60 },
  ];
  ws.spliceRows(1, 0, [`${brief.projectName}: first-pass takeoff`], [brief.oneLiner], [`Every line quotes the sheet it came from. Method: printed = on the sheet; counted = symbols or rows counted; derived = computed from printed figures. Check: verified = matched to the sheet text; flagged = the independent check found a problem (see notes). Price from the sheets; this is a starting point.`]);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.getRow(3).font = { italic: true, color: { argb: "FF5B6472" } };
  ws.getRow(4).font = { bold: true };
  ws.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5E6C8" } };
  for (const it of t.items) {
    const row = ws.addRow({ ...it, sheet: it.sheet + 1, note: [it.note, it.flag].filter(Boolean).join(" | ") });
    if (it.status === "flagged") row.getCell("status").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFD6D6" } };
    if (it.status === "unverified") row.getCell("status").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF1C2" } };
    row.getCell("quantity").numFmt = "#,##0.00";
  }
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + t.items.length, column: 12 } };

  const ws2 = wb.addWorksheet("Not countable from this set");
  ws2.columns = [{ header: "What an estimator needs", key: "what", width: 50 }, { header: "Why it cannot be taken off", key: "why", width: 60 }, { header: "Sheet that would carry it", key: "where", width: 40 }];
  ws2.getRow(1).font = { bold: true };
  for (const n of t.notCountable) ws2.addRow(n);

  const ws3 = wb.addWorksheet("By category");
  ws3.columns = [{ header: "Category", key: "c", width: 30 }, { header: "Lines", key: "n", width: 8 }, { header: "Verified", key: "v", width: 10 }, { header: "Flagged", key: "f", width: 10 }];
  ws3.getRow(1).font = { bold: true };
  for (const c of CATEGORIES) {
    const xs = t.items.filter((i) => i.category === c);
    if (xs.length) ws3.addRow({ c, n: xs.length, v: xs.filter((i) => i.status === "verified").length, f: xs.filter((i) => i.status === "flagged").length });
  }
  await wb.xlsx.writeFile(outFile);
}
