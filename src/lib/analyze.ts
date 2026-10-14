import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import type { Brief, Segment, Box } from "./types";
import type { PageInfo } from "./ingest";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_IMAGES = Number(process.env.ANALYZE_MAX_IMAGES || 40);
const MAX_TEXT_PER_PAGE = Number(process.env.ANALYZE_MAX_TEXT_PER_PAGE || 6000);

const SYSTEM = `You are a senior preconstruction manager who explains construction documents to people who have never read one: owners, new estimators, subcontractors, investors.

You will receive every page of a document package (an RFP, RFQ, bid set, drawings, specs, or a mix) as page images plus the extracted text of each page. Produce a script for a narrated video that walks through the package TOP DOWN: start with what this project is and who is asking for what, then work from the big picture down to the details, page by page, and finish with what a bidder must do, by when, and what could go wrong.

Rules for the script:
- Plain English. Define every term of art the first time you use it (e.g. "a grade beam, which is a concrete beam at ground level that ties the foundations together").
- Be concrete. Quote real numbers, dates, sheet numbers, room names, dimensions, materials and section references from the document. Never invent anything that is not in the document; if something is missing say that it is missing.
- Cover every page that carries real content. Skip blank, cover-only or repeated pages but say when you are skipping and why.
- One segment per idea. A segment is filmed on ONE page. Use 6 to 14 segments for small packages and up to 40 for large plan sets. Each narration should be 2 to 6 sentences (roughly 15 to 45 seconds spoken).
- The camera: give a "focus" box (fractions of the page: x, y from the top-left, w, h) for the region the viewer should be looking at. Use the whole page {x:0,y:0,w:1,h:1} for overviews, and tight boxes (w and h between 0.15 and 0.5) for details like a schedule, a detail callout, a note block or a dimension string.
- Callouts: for each segment list 1 to 5 things the on-screen pointer should land on while you talk about them. Each callout has a short label, a box on the page (fractions, inside or near the focus box) and a "cue": a short phrase copied VERBATIM from that segment's narration. The pointer jumps to the callout when the narration reaches the cue, so the cue must appear exactly in the narration text.
- Order: overview first, then site / existing conditions, then structure, then envelope, then interiors and finishes, then MEP and fire protection, then schedule and phasing, then bid requirements and commercial terms, then red flags and questions to ask. Adapt the order to what is actually in the package.
- Also fill the summary lists (scope, key dates, requirements, risks, questions to ask) in short bullet phrases.`;

const TOOL: Anthropic.Tool = {
  name: "write_brief",
  description: "Return the finished video script and summary.",
  input_schema: {
    type: "object",
    required: ["projectName", "documentType", "oneLiner", "segments", "summary"],
    properties: {
      projectName: { type: "string" },
      documentType: { type: "string", enum: ["RFP", "RFQ", "Plans", "Specs", "Mixed", "Other"] },
      oneLiner: { type: "string", description: "One sentence: what is this project." },
      segments: {
        type: "array",
        items: {
          type: "object",
          required: ["title", "page", "focus", "narration", "callouts"],
          properties: {
            title: { type: "string", description: "Short heading, numbered, e.g. '3. Structural system'" },
            page: { type: "integer", description: "0-based page index" },
            focus: boxSchema("Camera target on the page."),
            narration: { type: "string" },
            callouts: {
              type: "array",
              items: {
                type: "object",
                required: ["label", "box", "cue"],
                properties: {
                  label: { type: "string" },
                  box: boxSchema("Where the pointer lands."),
                  cue: { type: "string", description: "Verbatim phrase from narration." },
                },
              },
            },
          },
        },
      },
      summary: {
        type: "object",
        required: ["scope", "keyDates", "requirements", "risks", "questionsToAsk"],
        properties: {
          scope: { type: "array", items: { type: "string" } },
          keyDates: { type: "array", items: { type: "string" } },
          requirements: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          questionsToAsk: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

function boxSchema(desc: string) {
  return {
    type: "object",
    description: desc + " Fractions of page size, origin top-left.",
    required: ["x", "y", "w", "h"],
    properties: {
      x: { type: "number" },
      y: { type: "number" },
      w: { type: "number" },
      h: { type: "number" },
    },
  };
}

export type AnalyzeProvider = "api" | "claude-code" | "manual" | "mock";

export const ANALYZE_PROVIDER: AnalyzeProvider =
  (process.env.ANALYZE_PROVIDER as AnalyzeProvider) ||
  (process.env.ANALYZE_MOCK === "1" ? "mock" : process.env.ANTHROPIC_API_KEY ? "api" : "claude-code");

/** The task description shared by every provider (and shown to the person in manual mode). */
export function analysisPrompt(pages: PageInfo[], originalName: string) {
  return `${SYSTEM}

Document file name: ${originalName}
Total pages: ${pages.length} (page indexes are 0-based)

Return ONLY a JSON object with this shape, no prose before or after:
{
  "projectName": string, "documentType": "RFP"|"RFQ"|"Plans"|"Specs"|"Mixed"|"Other", "oneLiner": string,
  "segments": [{ "title": string, "page": number, "focus": {"x","y","w","h"}, "narration": string,
                 "callouts": [{ "label": string, "box": {"x","y","w","h"}, "cue": string }] }],
  "summary": { "scope": string[], "keyDates": string[], "requirements": string[], "risks": string[], "questionsToAsk": string[] }
}`;
}

export async function analyzePages(pages: PageInfo[], originalName: string): Promise<Brief> {
  if (ANALYZE_PROVIDER === "mock") return mockBrief(pages, originalName);
  if (ANALYZE_PROVIDER === "claude-code") return analyzeWithClaudeCode(pages, originalName);
  if (ANALYZE_PROVIDER === "manual") throw new Error("manual provider is handled by the pipeline");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic();

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text: `Document file name: ${originalName}\nTotal pages: ${pages.length}\n\nBelow is every page. Page indexes are 0-based.`,
    },
  ];

  // Spread the image budget across the document so long sets still get
  // visual coverage of later sheets instead of only the first N pages.
  const imageIdx = pickSpread(pages.length, MAX_IMAGES);
  for (const p of pages) {
    content.push({ type: "text", text: `\n=== PAGE ${p.index} (sheet ${p.index + 1} of ${pages.length}) ===` });
    if (imageIdx.has(p.index)) {
      const data = (await fs.readFile(p.thumbPath)).toString("base64");
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
    }
    const text = p.text.length > MAX_TEXT_PER_PAGE ? p.text.slice(0, MAX_TEXT_PER_PAGE) + "\n[text truncated]" : p.text;
    content.push({ type: "text", text: text ? `Extracted text:\n${text}` : "(no text layer on this page)" });
  }
  content.push({ type: "text", text: "Now write the brief with the write_brief tool." });

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "write_brief" },
    messages: [{ role: "user", content }],
  });

  const toolUse = res.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
  if (!toolUse) throw new Error("Model did not return a brief");
  return normalizeBrief(toolUse.input as Brief, pages.length);
}

function pickSpread(n: number, max: number): Set<number> {
  if (n <= max) return new Set(Array.from({ length: n }, (_, i) => i));
  const set = new Set<number>();
  for (let k = 0; k < max; k++) set.add(Math.round((k * (n - 1)) / (max - 1)));
  return set;
}

/** Clamp boxes, drop broken segments, make cues safe. */
export function normalizeBrief(raw: Brief, pageCount: number): Brief {
  const segments: Segment[] = [];
  (raw.segments || []).forEach((s, i) => {
    if (!s || typeof s.narration !== "string" || !s.narration.trim()) return;
    const page = clampInt(Number(s.page), 0, pageCount - 1);
    const focus = clampBox(s.focus);
    const callouts = (s.callouts || [])
      .filter((c) => c && c.label && c.box)
      .slice(0, 6)
      .map((c) => ({ label: String(c.label).slice(0, 60), box: clampBox(c.box), cue: String(c.cue || "") }));
    segments.push({
      id: `s${i + 1}`,
      title: String(s.title || `Part ${i + 1}`).slice(0, 80),
      page,
      focus,
      narration: s.narration.trim(),
      callouts,
    });
  });
  if (!segments.length) throw new Error("Brief had no usable segments");
  return {
    projectName: String(raw.projectName || "Untitled project").slice(0, 120),
    documentType: raw.documentType || "Other",
    oneLiner: String(raw.oneLiner || ""),
    segments,
    summary: {
      scope: arr(raw.summary?.scope),
      keyDates: arr(raw.summary?.keyDates),
      requirements: arr(raw.summary?.requirements),
      risks: arr(raw.summary?.risks),
      questionsToAsk: arr(raw.summary?.questionsToAsk),
    },
  };
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 20) : [];
}
function clampInt(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Number.isFinite(v) ? Math.round(v) : lo));
}
function clamp01(v: unknown, d: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d;
}
function clampBox(b: Partial<Box> | undefined): Box {
  const x = clamp01(b?.x, 0);
  const y = clamp01(b?.y, 0);
  const w = Math.max(0.04, Math.min(1 - x, clamp01(b?.w, 1)));
  const h = Math.max(0.04, Math.min(1 - y, clamp01(b?.h, 1)));
  return { x, y, w, h };
}

/** Keyless stand-in used for smoke tests (ANALYZE_MOCK=1): one plain segment per page. */
function mockBrief(pages: PageInfo[], originalName: string): Brief {
  return normalizeBrief(
    {
      projectName: originalName.replace(/\.pdf$/i, ""),
      documentType: "Other",
      oneLiner: `A ${pages.length}-page document, read page by page.`,
      segments: pages.map((p, i) => ({
        id: `s${i + 1}`,
        title: `${i + 1}. Page ${i + 1}`,
        page: i,
        focus: { x: 0, y: 0, w: 1, h: 1 },
        narration: p.text ? p.text.split(/\s+/).slice(0, 50).join(" ") : "This page has no readable text layer.",
        callouts: [],
      })),
      summary: { scope: [], keyDates: [], requirements: [], risks: [], questionsToAsk: [] },
    },
    pages.length,
  );
}

/**
 * Runs the analysis through the Claude Code CLI on this machine. Claude Code is
 * included in Claude Pro/Max subscriptions, so this path has no per-call API
 * cost. Requires `claude` installed and logged in (`claude login`).
 */
async function analyzeWithClaudeCode(pages: PageInfo[], originalName: string): Promise<Brief> {
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const dir = path.dirname(pages[0].imagePath);
  const textFile = path.join(dir, "pages-text.txt");
  await fs.writeFile(
    textFile,
    pages.map((p) => `=== PAGE ${p.index} ===\n${p.text || "(no text layer)"}`).join("\n\n"),
  );
  const outFile = path.join(dir, "brief.json");
  await fs.rm(outFile, { force: true });
  const imageIdx = pickSpread(pages.length, MAX_IMAGES);
  const imageList = pages.filter((p) => imageIdx.has(p.index)).map((p) => `  page ${p.index}: ${p.thumbPath}`).join("\n");
  const prompt = `${analysisPrompt(pages, originalName)}

Materials on disk:
- Extracted text of every page: ${textFile}
- Page images (open each with the Read tool and look at it carefully; the boxes you return must match what you see):
${imageList}

Read the text file and every listed image, then write the JSON object to ${outFile} with the Write tool. Write nothing else.`;

  const bin = process.env.CLAUDE_CODE_BIN || "claude";
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      bin,
      ["-p", prompt, "--allowedTools", "Read,Write", "--permission-mode", "acceptEdits", "--output-format", "text"],
      { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CLAUDECODE: "" } },
    );
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.stdout.on("data", () => {});
    p.on("error", (e) => reject(new Error(`Could not start Claude Code (${bin}): ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Claude Code exited ${code}: ${err.slice(-2000)}`))));
  });
  const raw = await fs.readFile(outFile, "utf8").catch(() => {
    throw new Error("Claude Code finished but did not write brief.json");
  });
  return normalizeBrief(parseJsonLoose(raw), pages.length);
}

/** Accepts JSON possibly wrapped in a code fence or prose. */
export function parseJsonLoose(raw: string): Brief {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = /\{[\s\S]*\}/.exec(trimmed);
    if (!m) throw new Error("No JSON object found in the script");
    return JSON.parse(m[0]);
  }
}
