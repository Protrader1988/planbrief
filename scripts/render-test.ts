/**
 * End-to-end test of ingest -> (mock script) -> narration -> render, without API keys.
 *   npx tsx scripts/render-test.ts path/to/sample.pdf out.mp4
 * Set ANTHROPIC_API_KEY to use the real analysis step instead of the mock script.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { ingestPdf } from "../src/lib/ingest";
import { analyzePages, normalizeBrief } from "../src/lib/analyze";
import { synthesizeNarration } from "../src/lib/tts";
import { renderVideo } from "../src/lib/render";
import type { Brief } from "../src/lib/types";

async function main() {
const pdf = process.argv[2];
const out = path.resolve(process.argv[3] || "test-out.mp4");
if (!pdf) throw new Error("usage: tsx scripts/render-test.ts file.pdf out.mp4");

const work = path.resolve("data/_test");
await fs.rm(work, { recursive: true, force: true });
await fs.mkdir(path.join(work, "audio"), { recursive: true });

console.time("ingest");
const pages = await ingestPdf(pdf, path.join(work, "pages"));
console.timeEnd("ingest");
console.log(pages.map((p) => `page ${p.index}: ${p.width}x${p.height}, ${p.text.length} chars`).join("\n"));

let brief: Brief;
if (process.env.ANTHROPIC_API_KEY) {
  console.time("analyze");
  brief = await analyzePages(pages, path.basename(pdf));
  console.timeEnd("analyze");
} else {
  brief = normalizeBrief(mockBrief(), pages.length);
}
await fs.writeFile(path.join(work, "brief.json"), JSON.stringify(brief, null, 2));

const audio = [];
for (let i = 0; i < brief.segments.length; i++) {
  const file = path.join(work, "audio", `seg-${i}.mp3`);
  audio.push(await synthesizeNarration(brief.segments[i].narration, file));
}

console.time("render");
const r = await renderVideo(brief, pages, {
  audio,
  outFile: out,
  workDir: work,
  onProgress: (f) => process.stdout.write(`\r${Math.round(f * 100)}%  `),
});
console.log();
console.timeEnd("render");
console.log("duration", r.total.toFixed(1), "s; segment starts", r.starts.map((s) => s.toFixed(1)).join(", "));
console.log("wrote", out);
}
main().catch((e) => { console.error(e); process.exit(1); });

function mockBrief(): Brief {
  return {
    projectName: "Harbor Street Lounge Build-Out",
    documentType: "RFP",
    oneLiner: "A 3,850 square foot ground-floor cocktail lounge fit-out in Greenwich, bidding as a stipulated-sum contract.",
    segments: [
      {
        id: "s1",
        title: "1. What this project is",
        page: 0,
        focus: { x: 0.05, y: 0.08, w: 0.9, h: 0.4 },
        narration:
          "This is a request for proposal, meaning the owner is asking contractors to price the job. The project is the Harbor Street Lounge build-out at 212 Harbor Street in Greenwich. The scope is an interior fit-out of a 3,850 square foot tenant space into a cocktail lounge with a new bar, kitchen, two ADA restrooms, finishes, lighting, HVAC and sprinklers.",
        callouts: [
          { label: "RFP", box: { x: 0.1, y: 0.09, w: 0.35, h: 0.04 }, cue: "request for proposal" },
          { label: "Address", box: { x: 0.1, y: 0.145, w: 0.6, h: 0.03 }, cue: "212 Harbor Street" },
          { label: "Scope", box: { x: 0.1, y: 0.22, w: 0.75, h: 0.06 }, cue: "interior fit-out" },
        ],
      },
      {
        id: "s2",
        title: "2. Dates and commercial terms",
        page: 0,
        focus: { x: 0.05, y: 0.33, w: 0.9, h: 0.4 },
        narration:
          "Bids are due November 14th at 2 PM. There is a mandatory pre-bid walkthrough on October 28th, so if you miss it you cannot bid. Questions, called RFIs, are due November 4th. The contract is an AIA A101 stipulated sum, which means a fixed price, and there are liquidated damages of $1,500 per day for finishing late. You also need 100 percent performance and payment bonds.",
        callouts: [
          { label: "Bid due Nov 14", box: { x: 0.1, y: 0.34, w: 0.6, h: 0.03 }, cue: "Bids are due" },
          { label: "Mandatory walkthrough", box: { x: 0.1, y: 0.375, w: 0.55, h: 0.03 }, cue: "mandatory pre-bid" },
          { label: "LDs $1,500/day", box: { x: 0.1, y: 0.44, w: 0.65, h: 0.03 }, cue: "liquidated damages" },
          { label: "Bonds", box: { x: 0.1, y: 0.505, w: 0.5, h: 0.03 }, cue: "performance and payment bonds" },
        ],
      },
      {
        id: "s3",
        title: "3. Site and general notes",
        page: 1,
        focus: { x: 0, y: 0, w: 1, h: 1 },
        narration:
          "Sheet A-001 is the site plan. The building sits on Harbor Street and the tenant space is this box in the middle. The general notes on the right carry real cost: work hours are 7 to 6 on weekdays only, deliveries must come through the rear alley, and the existing slab stays, so plumbing means saw-cutting concrete.",
        callouts: [
          { label: "Tenant space", box: { x: 0.22, y: 0.42, w: 0.2, h: 0.21 }, cue: "tenant space" },
          { label: "Work hours", box: { x: 0.61, y: 0.17, w: 0.36, h: 0.03 }, cue: "work hours" },
          { label: "Slab to remain", box: { x: 0.61, y: 0.2, w: 0.36, h: 0.045 }, cue: "existing slab" },
        ],
      },
      {
        id: "s4",
        title: "4. Floor plan",
        page: 2,
        focus: { x: 0.1, y: 0.1, w: 0.7, h: 0.75 },
        narration:
          "Sheet A-101 is the floor plan, the view from above. The lounge is the big room with seating for 96. The kitchen is top left at 620 square feet, the two ADA restrooms sit next to it, and the bar runs along the bottom at 42 feet long. Keynote 3 is a grease interceptor below the slab, which ties back to that saw-cutting note.",
        callouts: [
          { label: "Lounge, 96 seats", box: { x: 0.27, y: 0.35, w: 0.25, h: 0.06 }, cue: "lounge is the big room" },
          { label: "Kitchen 620 SF", box: { x: 0.14, y: 0.3, w: 0.25, h: 0.21 }, cue: "kitchen is top left" },
          { label: "ADA restrooms", box: { x: 0.42, y: 0.3, w: 0.24, h: 0.21 }, cue: "ADA restrooms" },
          { label: "Bar 42 ft", box: { x: 0.14, y: 0.75, w: 0.5, h: 0.09 }, cue: "bar runs along" },
        ],
      },
      {
        id: "s5",
        title: "5. Finish schedule",
        page: 3,
        focus: { x: 0.03, y: 0.15, w: 0.8, h: 0.3 },
        narration:
          "Sheet A-601 is the finish schedule, a table that says what goes on every floor, wall and ceiling. The lounge gets porcelain tile floors and walnut base with plaster and wood panel walls. The kitchen gets quarry tile with a coved base, which is what the health department expects. Restroom walls get tile to seven feet.",
        callouts: [
          { label: "Lounge finishes", box: { x: 0.05, y: 0.22, w: 0.75, h: 0.03 }, cue: "lounge gets porcelain" },
          { label: "Kitchen quarry tile", box: { x: 0.05, y: 0.243, w: 0.75, h: 0.03 }, cue: "kitchen gets quarry" },
          { label: "Tile to 7 ft", box: { x: 0.38, y: 0.264, w: 0.15, h: 0.03 }, cue: "tile to seven feet" },
        ],
      },
    ],
    summary: {
      scope: ["3,850 SF cocktail lounge fit-out", "New bar, kitchen, 2 ADA restrooms", "Finishes, lighting, HVAC, sprinklers"],
      keyDates: ["Pre-bid walkthrough Oct 28 (mandatory)", "RFIs due Nov 4", "Bid due Nov 14, 2 PM", "Substantial completion Apr 15, 2027"],
      requirements: ["AIA A101 stipulated sum", "100% P&P bonds", "GL $2M/$4M, umbrella $5M"],
      risks: ["LDs $1,500/day on a 4.5 month schedule", "Slab saw-cutting for plumbing and grease interceptor", "Rear alley deliveries only"],
      questionsToAsk: ["Who carries the walk-in cooler install?", "Is the asbestos survey available before bid?"],
    },
  };
}
