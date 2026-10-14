/**
 * Check 1 of 3: mechanical verification. No model involved.
 *
 * Every factual token in the script (numbers with units, dimensions, sheet numbers,
 * code sections, dates, dollar amounts, room/area tags) is looked for in the text
 * extracted from the cited page, then anywhere in the set. Also validates the
 * script's structure: page indexes, boxes in bounds, cues present in narration,
 * recaps on existing segments.
 */
import type { Brief, Segment } from "./types";
import type { PageInfo } from "./ingest";

export type ClaimStatus = "verified" | "cited" | "derived" | "elsewhere" | "unverified";
export type Claim = { text: string; kind: string; status: ClaimStatus; foundOnPage?: number };
export type SegmentCheck = { id: string; title: string; page: number; claims: Claim[]; structural: string[] };
export type MechanicalReport = {
  segments: SegmentCheck[];
  totals: { claims: number; verified: number; cited: number; derived: number; elsewhere: number; unverified: number; structural: number };
};

// ---------- claim extraction ----------
type Pattern = { kind: string; re: RegExp };
const PATTERNS: Pattern[] = [
  // R/U values first so R-38 isn't read as a sheet number
  { kind: "rvalue", re: /\b[RU]\s?-?\s?(?:factor\s?(?:of\s?)?|value\s?(?:of\s?)?)?\d+(?:\.\d+)?\b/g },
  // sheet numbers: A-101, A-101.00, DM-100, EN-100, P-100, S2.1, T-100.00
  { kind: "sheet", re: /\b[A-Z]{1,3}-?\d{1,3}(?:\.\d{1,2})?\b/g },
  // code sections: BC 1704.4, ZR 35-24, 27-531(h), Table 6-1, Section 303.1
  { kind: "code", re: /\b(?:BC|ZR|FC|MC|PC|LL|NYCECC|IBC|IRC|NEC|ASTM|ANSI|UL)\s?(?:DES\s)?[A-Z]?\s?\d+[\w.()-]*/g },
  // dimensions: 46'-4", 27'-9 1/2", 2'-0" x 1'-0", 12 inch, 5/8 inch
  { kind: "dimension", re: /\b\d+\s?(?:'|ft|feet|foot)\s?-?\s?\d*\s?(?:\d\/\d)?\s?(?:"|in\.|inch(?:es)?)?/g },
  { kind: "dimension", re: /\b\d+(?:\s\d\/\d)?\s?(?:"|inch(?:es)?|in\.)/g },
  { kind: "fraction", re: /\b\d\/\d\s?(?:"|inch)/g },
  // money
  { kind: "money", re: /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|M|k))?/gi },
  // dates
  { kind: "date", re: /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s\d{1,2}(?:st|nd|rd|th)?,?\s?\d{0,4}\b/g },
  { kind: "date", re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g },
  // areas, loads, ratios, percentages, PSI, R/U values, cubic yards, linear feet
  { kind: "quantity", re: /\b\d[\d,]*(?:\.\d+)?\s?(?:square\s?f(?:ee|oo)t|sq\.?\s?ft\.?|SF|sf|cubic\s?yards?|CY|cu\.?\s?yd|linear\s?f(?:ee|oo)t|LF|psi|PSI|percent|%|people|persons|occupants|seats|units|stories|dwelling units|gallons?|gal|cfm|CFM|amps?|volts?|kW|tons?|BTU)\b/g },
  { kind: "ratio", re: /\b\d+(?:\.\d+)?\s?(?:to|:)\s?\d+(?:\.\d+)?\b/g },
  // zoning / lot identifiers
  { kind: "zoning", re: /\b[CRM]\d(?:-\d)?[A-Z]?\b/g },
  { kind: "lot", re: /\b(?:block|lot|map)\s?#?\s?\d+[A-Z]?\b/gi },
  // occupancy groups and UL designs
  { kind: "class", re: /\b(?:group\s)?[A-Z]-\d\b/g },
  { kind: "ul", re: /\bUL\s?(?:DES\s?)?U?\s?\d{3,4}\b/g },
  // plain numbers with 2+ digits or decimals (catch-all, lower weight)
  { kind: "number", re: /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{2,}(?:\.\d+)?\b|\b\d+\.\d+\b/g },
];

const WORD_NUMBERS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", twenty: "20", thirty: "30",
  forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100",
};

/** Lowercase, collapse whitespace, normalize unit words and punctuation for matching. */
export function norm(s: string): string {
  let t = s.toLowerCase();
  t = t.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  t = t.replace(/\b(\w+)\b/g, (w) => WORD_NUMBERS[w] ?? w);
  t = t
    .replace(/\bsquare\s?f(?:ee|oo)t\b/g, "sf").replace(/\bsq\.?\s?ft\.?/g, "sf")
    .replace(/\bcubic\s?yards?\b/g, "cy").replace(/\bcu\.?\s?yd\.?/g, "cy")
    .replace(/\blinear\s?f(?:ee|oo)t\b/g, "lf")
    .replace(/\bfeet\b|\bfoot\b|\bft\.?\b/g, "'").replace(/\binch(?:es)?\b|\bin\.\b/g, '"')
    .replace(/\bpercent\b/g, "%").replace(/\bnumber\s?(\d)/g, "#$1").replace(/\bno\.?\s?(\d)/g, "#$1")
    .replace(/\bpounds? per square inch\b/g, "psi").replace(/\bp\.\s?s\.\s?i\.?/g, "psi")
    .replace(/\b([ru])\s*-\s*(factor|value)/g, "$1-$2");
  t = t.replace(/(\d),(\d{3})/g, "$1$2"); // 3,974 -> 3974
  t = t.replace(/(\d)\s+(['"])/g, "$1$2"); // 7 ' -> 7'
  t = t.replace(/(\d)\s*'\s*-?\s*(\d)/g, "$1'$2"); // 46 ' - 4 -> 46'4
  t = t.replace(/(\d)\s*-\s*(\d)/g, "$1-$2"); // 112 -114 -> 112-114
  t = t.replace(/(block|lot|map)\s*#?\s*:?\s*(\d)/g, "$1 $2"); // block:886 -> block 886
  t = t.replace(/\s+/g, " ").replace(/[–—]/g, "-");
  return t;
}

function uniq<T>(xs: T[], key: (x: T) => string) {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

export function extractClaims(text: string): { text: string; kind: string; start: number }[] {
  const out: { text: string; kind: string; start: number; end: number }[] = [];
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const t = m[0].trim();
      if (!t || /^\d{1,2}$/.test(t)) continue; // drop bare small ints (step numbers etc.)
      if (p.kind === "number" && /^\d{1,2}\.$/.test(t)) continue;
      out.push({ text: t, kind: p.kind, start: m.index!, end: m.index! + m[0].length });
    }
  }
  // prefer the more specific (longer) match when spans overlap
  out.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: typeof out = [];
  for (const c of out) {
    const last = kept[kept.length - 1];
    if (last && c.start < last.end) continue;
    kept.push(c);
  }
  return uniq(kept, (c) => c.kind + "|" + norm(c.text)).map(({ text, kind, start }) => ({ text, kind, start }));
}

/** The sheet number printed in a page's title block (last sheet-like token in the layout text). */
export function sheetIdOf(text: string): string | null {
  const m = text.match(/\b[A-Z]{1,3}-\d{2,3}(?:\.\d{1,2})?\b/g);
  if (!m) return null;
  return m[m.length - 1].replace(/\.00$/, "");
}

const DERIVED_WORDS = /\b(about|roughly|approximately|around|derived|together|total(?:s|ing)?|adds? up to|equals|that is|comes to|which is|leaving|difference|sum)\b/;

/** True when the words just before the claim mark it as derived or approximate. */
function isDerived(text: string, start: number): boolean {
  return DERIVED_WORDS.test(text.slice(Math.max(0, start - 45), start).toLowerCase());
}

/** True when the sentence containing the claim names the sheet it was found on. */
function citesSheet(text: string, start: number, sheetId: string | null): boolean {
  if (!sheetId) return false;
  const a = text.lastIndexOf(".", start) + 1;
  let b = text.indexOf(".", start);
  if (b < 0) b = text.length;
  const sentence = text.slice(a, b).toUpperCase();
  const base = sheetId.replace(/\.\d+$/, "");
  return sentence.includes(base) || sentence.includes(base.replace("-", ""));
}

/** Variants of a claim that would count as a match in the page text. */
function variants(claim: string, kind: string): string[] {
  const n = norm(claim);
  const v = new Set<string>([n]);
  const digits = n.replace(/[^\d.]/g, "");
  if (kind === "sheet") {
    v.add(n.replace(/\.00$/, "")); // A-101.00 vs A-101
    v.add(n.replace(/^([a-z]+)(\d)/, "$1-$2")); // A101 vs A-101
    v.add(n.replace(/-/, "")); // A-101 vs A101
    v.add(n + ".00");
  }
  if (kind === "dimension" || kind === "fraction") {
    v.add(n.replace(/"/g, "").trim());
    v.add(n.replace(/'/g, "'-"));
    if (/^\d+'\d+/.test(n)) v.add(n.replace(/'(\d)/, "'-$1"));
    if (/^\d+'$/.test(n)) v.add(n.replace("'", "'-0"));
    if (/^\d+ \d\/\d"/.test(n)) v.add(n.replace(" ", "-"));
  }
  if (kind === "quantity") {
    // keep the unit attached; bare numbers are only accepted by the unit-nearby rule in findIn
    v.add(n.replace(/\s+/g, " "));
    v.add(n.replace(/\s+/g, ""));
  }
  if (kind === "number" || kind === "money") {
    if (digits) {
      v.add(digits);
      if (/\.\d+$/.test(digits)) v.add(digits.replace(/\.?0+$/, ""));
      if (!/\./.test(digits)) v.add(digits + ".00");
      // 75 people -> "75"; $1,500 -> 1500
    }
  }
  if (kind === "rvalue") {
    const m = /^([ru])\s?-?\s?(?:factor\s?(?:of\s?)?)?(\d+(?:\.\d+)?)/.exec(n);
    if (m) {
      const [, L, N] = m;
      for (const f of [`${L}-${N}`, `${L}=${N}`, `${L} = ${N}`, `${L} ${N}`, `${L}${N}`, `${L}-value ${N}`, `${L}-value : ${N}`, `${L}-value: ${N}`, `${L}-factor : ${L} = ${N}`, `${L}-factor :${L} = ${N}`, `${L}-factor ${N}`, `${L} factor ${N}`, `${L}-factor: ${N}`, `${L}-factor : ${N}`, `${L}-factor :${N}`]) v.add(f);
    }
  }
  if (kind === "ratio") { v.add(n.replace(/\s?(to|:)\s?/, ":")); v.add(n.replace(/\s?(to|:)\s?/, " to ")); v.add(n.replace(/\s?(to|:)\s?/, "-")); }
  if (kind === "lot") { const d = /\d+[a-z]?$/.exec(n); if (d) v.add(d[0]); }
  if (kind === "dimension" || kind === "fraction") {
    if (/^\d+'$/.test(n)) { v.add(n + "0"); v.add(n + "-0"); }
    if (/^\d+'\d+$/.test(n)) v.add(n.replace("'", "'-"));
    const nf = n.replace(/\s\d\/\d"?$/, "").replace(/"$/, "");
    if (nf !== n) { v.add(nf); v.add(nf.replace("'", "'-")); }
    v.add(n.replace(/"/g, "''"));
  }
  if (kind === "code") { v.add(n.replace(/\s+/g, " ")); v.add(n.replace(/\s+/g, "")); v.add(n.replace(/^\w+\s/, "")); }
  if (kind === "class") v.add(n.replace(/^group\s/, ""));
  if (kind === "date") {
    const m = /^(\w{3})\w*\.?\s(\d{1,2})(?:st|nd|rd|th)?,?\s?(\d{4})?/.exec(n);
    if (m) {
      const mi = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1]) + 1;
      if (mi && m[3]) { v.add(`${mi}/${m[2]}/${m[3]}`); v.add(`${String(mi).padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3]}`); }
      v.add(`${m[1]} ${m[2]}`);
    }
  }
  return [...v].filter(Boolean);
}

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Boundary-aware search: "130" must not match "130.55" or "1300". */
function has(text: string, v: string, opts: { rounding?: boolean; fraction?: boolean } = {}): boolean {
  const startsDigit = /^\d/.test(v);
  const endsDigit = /\d$/.test(v);
  // rounding: "3974" may match "3974.69", "46'4" may match "46'4 1/4" (extracted as 46'44")
  let tail = endsDigit ? (opts.rounding ? "(?:\\.\\d+)?(?!\\d)" : "(?!\\d|\\.\\d)") : "(?![a-z0-9])";
  if (endsDigit && opts.rounding && /\.\d+$/.test(v)) tail = "\\d*(?!\\d)"; // 4.0 matches 4.00
  if (opts.fraction) tail = "(?:\\s?\\d\\/\\d)?\\d?(?=[\"'\\s]|$)"; // 46'4 matches 46'4 1/4 (extracted as 46'44")
  const re = new RegExp(`${startsDigit ? "(?<![\\d.])" : "(?<![a-z0-9])"}${esc(v)}${tail}`);
  return re.test(text);
}

const UNIT_WORDS: Record<string, string[]> = {
  sf: ["sf", "sq ft", "sq. ft", "square"], cy: ["cy", "cu yd", "cu. yd", "cubic"], lf: ["lf", "linear"],
  psi: ["psi", "p.s.i"], people: ["people", "persons", "occupant"], persons: ["persons", "people", "occupant"],
  seats: ["seats"], units: ["units", "dwelling"], "%": ["%", "percent"], gal: ["gal", "gallon"], cfm: ["cfm"],
};

function findIn(text: string, claim: string, kind: string): boolean {
  const rounding = kind === "quantity" || kind === "number" || kind === "dimension" || kind === "money" || kind === "ratio";
  for (const v of variants(claim, kind)) {
    if (v.length < 2) continue;
    if (has(text, v, { rounding })) return true;
    if (kind === "dimension" && /^\d+'\d+$/.test(v) && has(text, v, { fraction: true })) return true;
  }
  if (kind === "quantity") {
    // unit may precede the number on the sheet ("LINEAR FEET OF WALL = 117.02"): accept the
    // number (with rounding) when the unit word is on the same page.
    const n = norm(claim);
    const num = /\d+(?:\.\d+)?/.exec(n)?.[0];
    const unit = n.replace(/[\d.,\s]+/, "").trim();
    const singular = unit.replace(/s$/, "");
    const words = UNIT_WORDS[unit] ?? UNIT_WORDS[singular] ?? (unit ? [unit, singular] : []);
    if (num) {
      for (const w of words) {
        const near = new RegExp(`(?<![\\d.])${esc(num)}(?:\\.\\d+)?(?!\\d)[^\\n]{0,40}?${esc(w)}|${esc(w)}[^\\n]{0,60}?(?<![\\d.])${esc(num)}(?:\\.\\d+)?(?!\\d)`);
        if (near.test(text)) return true;
      }
    }
  }
  if (kind === "ratio") {
    const nums = norm(claim).match(/\d+(?:\.\d+)?/g) ?? [];
    if (nums.length === 2 && nums.every((x) => has(text, x))) return true;
  }
  return false;
}

export function mechanicalCheck(brief: Brief, pages: PageInfo[]): MechanicalReport {
  const pageText = pages.map((p) => norm(p.text || ""));
  const allText = pageText.join("\n");
  const segs: SegmentCheck[] = [];
  const totals = { claims: 0, verified: 0, cited: 0, derived: 0, elsewhere: 0, unverified: 0, structural: 0 };
  const sheetIds = pages.map((p) => sheetIdOf(p.text || ""));

  for (const s of brief.segments) {
    const structural = structuralIssues(s, pages.length);
    const claims: Claim[] = [];
    const check = (text: string, recap: boolean) => {
      for (const c of extractClaims(text)) {
        let status: ClaimStatus = "unverified";
        let foundOnPage: number | undefined;
        if (findIn(pageText[s.page] ?? "", c.text, c.kind)) status = "verified";
        else if (findIn(allText, c.text, c.kind)) {
          foundOnPage = pageText.findIndex((t) => findIn(t, c.text, c.kind));
          if (recap) status = "verified"; // a recap summarizes several sheets
          else if (c.kind === "sheet") status = "verified"; // naming another sheet is a citation, not a claim about this page
          else if (citesSheet(text, c.start, sheetIds[foundOnPage])) status = "cited";
          else status = "elsewhere";
        } else if (isDerived(text, c.start)) status = "derived";
        claims.push({ text: c.text, kind: c.kind, status, foundOnPage });
        totals.claims++;
        totals[status]++;
      }
    };
    check(s.narration, false);
    for (const r of s.recap ?? []) check(r, true);
    totals.structural += structural.length;
    segs.push({ id: s.id, title: s.title, page: s.page, claims, structural });
  }
  return { segments: segs, totals };
}

function structuralIssues(s: Segment, pageCount: number): string[] {
  const out: string[] = [];
  if (s.page < 0 || s.page >= pageCount) out.push(`page ${s.page} is out of range`);
  for (const b of [s.focus, ...s.callouts.map((c) => c.box)]) {
    if (b.x < 0 || b.y < 0 || b.x + b.w > 1.0001 || b.y + b.h > 1.0001) out.push("a box is outside the page");
  }
  const lower = s.narration.toLowerCase();
  for (const c of s.callouts) {
    if (!c.cue || !lower.includes(c.cue.toLowerCase())) out.push(`cue "${c.cue}" is not in the narration (pointer will fall back to spacing)`);
  }
  const words = s.narration.split(/\s+/).length;
  if (words < 15) out.push("narration is very short");
  if (words > 190) out.push("narration is over ~75 seconds; consider splitting");
  return out;
}
