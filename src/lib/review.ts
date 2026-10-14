/**
 * Checks 2 and 3 of 3, plus the correction pass.
 *
 * Each check is a FRESH model session that never sees the writer's reasoning, only the
 * drawings and the finished script. They get different briefs on purpose:
 *   - reviewer: a veteran architect/engineer/builder auditing claims against the sheets
 *   - auditor:  a consistency and plain-English fidelity auditor working across the script
 * Then a correction pass rewrites only the flagged segments, and the mechanical check runs again.
 */
import path from "node:path";
import type { Brief, Segment } from "./types";
import type { PageInfo } from "./ingest";
import { askJson } from "./llm";
import { mechanicalCheck, type MechanicalReport } from "./verify";

export type Severity = "critical" | "major" | "minor";
export type Issue = {
  check: "reviewer" | "auditor" | "mechanical";
  segmentId: string;
  severity: Severity;
  kind: string;
  claim: string;
  problem: string;
  correction: string;
  evidence: string;
  fixed?: boolean;
};

export type VerificationReport = {
  mechanical: MechanicalReport;
  mechanicalAfterFix?: MechanicalReport;
  reviewer: { ran: boolean; issues: Issue[]; coverage: string[]; error?: string };
  auditor: { ran: boolean; issues: Issue[]; error?: string };
  fixes: { applied: number; segments: string[] };
  summary: { critical: number; major: number; minor: number; verdict: "pass" | "pass-with-notes" | "needs-review" };
};

const ISSUE_SCHEMA = {
  type: "object",
  required: ["issues"],
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["segmentId", "severity", "kind", "claim", "problem", "correction", "evidence"],
        properties: {
          segmentId: { type: "string" },
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          kind: { type: "string" },
          claim: { type: "string", description: "The exact words in the script that are wrong or unsupported." },
          problem: { type: "string" },
          correction: { type: "string", description: "What the script should say instead, as it would read on screen." },
          evidence: { type: "string", description: "Sheet number and the exact text or feature on the drawing that proves it." },
        },
      },
    },
    coverage: { type: "array", items: { type: "string" }, description: "Important items on the sheets the script never mentions." },
  },
};

const REVIEWER_SYSTEM = `You are a licensed architect and professional engineer with 25 years in the field, who also ran a general contracting business. You are doing a document QA review before a bid goes out. You are rigorous, specific and unimpressed by confident writing: a claim is right only if the sheet shows it.

You will get the page images and extracted text of a construction document set, plus a video script that explains the set. Audit the script against the sheets. Report every place where the script:
- states a number, dimension, material, rating, date, sheet reference, room name, code section or quantity that the cited sheet does not show, or shows differently (misread, rounded wrong, transposed, wrong units, wrong sheet);
- derives a figure (a sum, a difference, a conversion) and gets it wrong;
- puts a callout box or label on something other than what the label says;
- mislabels a building element (calls a footing a foundation wall, a joist a beam, CMU "concrete", a U-factor an R-value, and so on);
- explains a construction concept incorrectly in its plain-English definition;
- omits something on these sheets that a bidder would be hurt by not knowing (list those under coverage).
Severity: critical = would change a price or a decision; major = factually wrong but low cost; minor = imprecise wording.
Do NOT report style, length, or things that are correct. If the sheet itself contains an error (a typo on the drawing), say so in evidence and set the correction to what the script should say to be honest about it.`;

const AUDITOR_SYSTEM = `You are a senior technical editor and estimator who checks explanatory material for internal consistency and for fidelity between the technical statement and its plain-English simplification.

You will get a video script about a construction document set (and the extracted text of the sheets for reference). Check, across the WHOLE script:
- numbers and facts that are stated more than once must agree (occupant loads, areas, dimensions, dates, counts);
- every recap bullet and every summary bullet (scope, key dates, requirements, risks, questions) must trace back to something a segment actually says; flag any that do not;
- every simplification must preserve the technical meaning (e.g. "fixed price" for stipulated sum is fine; "the owner pays for extras" for an allowance is wrong); flag distortions;
- defined terms must be defined correctly and used consistently;
- the top-down order must hold: overview before detail, existing before proposed, and nothing refers to something explained later as if the viewer already knew it;
- the "questions to ask" must be real gaps in the documents, not things the documents already answer.
Report issues only. Severity: critical = a reader would act on a wrong fact; major = inconsistent or misleading; minor = imprecise.`;

const FIX_SYSTEM = `You are the original script writer, a senior preconstruction manager, revising specific segments after a QA review. Apply each correction faithfully. Keep the voice: professional, plain English, define terms, say it as the sheet says it, then what it means, then why it matters to the bidder. Keep every callout cue as a verbatim phrase of the new narration; if a cue no longer appears, update the cue. Do not change segments that were not flagged. Return the full corrected segment objects.`;

function scriptText(brief: Brief) {
  return brief.segments
    .map((s) => `[${s.id}] ${s.title} (page ${s.page})\n${s.narration}\n` +
      (s.callouts.length ? `callouts: ${s.callouts.map((c) => `"${c.label}" at (${c.box.x.toFixed(2)},${c.box.y.toFixed(2)},${c.box.w.toFixed(2)},${c.box.h.toFixed(2)}) cue "${c.cue}"`).join("; ")}\n` : "") +
      (s.recap?.length ? `recap: ${s.recap.join(" | ")}\n` : ""))
    .join("\n");
}

function pagesText(pages: PageInfo[], max = 5000) {
  return pages.map((p) => `=== PAGE ${p.index} ===\n${(p.text || "(no text layer)").slice(0, max)}`).join("\n\n");
}

export async function runReviewer(brief: Brief, pages: PageInfo[], workDir: string): Promise<{ issues: Issue[]; coverage: string[] }> {
  const used = [...new Set(brief.segments.map((s) => s.page))].sort((a, b) => a - b);
  const images = used.map((n) => ({ label: `PAGE ${n}`, path: pages[n].thumbPath }));
  const user = `Script to audit:\n\n${scriptText(brief)}\n\nSummary lists:\n${JSON.stringify(brief.summary, null, 1)}\n\nExtracted text of every page:\n${pagesText(pages)}`;
  const res = await askJson<{ issues: Issue[]; coverage?: string[] }>({
    system: REVIEWER_SYSTEM, user, images, schema: ISSUE_SCHEMA, name: "qa_review", workDir: path.join(workDir, "review"), maxTokens: 12000,
  });
  return { issues: (res.issues ?? []).map((i) => ({ ...i, check: "reviewer" as const })), coverage: res.coverage ?? [] };
}

export async function runAuditor(brief: Brief, pages: PageInfo[], workDir: string): Promise<Issue[]> {
  const user = `Script to audit:\n\n${scriptText(brief)}\n\nSummary lists:\n${JSON.stringify(brief.summary, null, 1)}\n\nExtracted text of the sheets, for reference:\n${pagesText(pages, 2500)}`;
  const res = await askJson<{ issues: Issue[] }>({
    system: AUDITOR_SYSTEM, user, schema: ISSUE_SCHEMA, name: "consistency_audit", workDir: path.join(workDir, "audit"), maxTokens: 8000,
  });
  return (res.issues ?? []).map((i) => ({ ...i, check: "auditor" as const }));
}

const FIX_SCHEMA = {
  type: "object",
  required: ["segments"],
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "page", "focus", "narration", "callouts"],
        properties: {
          id: { type: "string" }, title: { type: "string" }, page: { type: "integer" },
          focus: { type: "object" }, narration: { type: "string" },
          callouts: { type: "array", items: { type: "object" } },
          recap: { type: "array", items: { type: "string" } }, recapTitle: { type: "string" },
        },
      },
    },
    summary: { type: "object", description: "Only if a summary bullet had to change." },
  },
};

export async function applyFixes(brief: Brief, pages: PageInfo[], issues: Issue[], workDir: string): Promise<{ brief: Brief; fixedSegments: string[] }> {
  const toFix = issues.filter((i) => i.severity !== "minor" || i.check === "mechanical");
  const ids = [...new Set(toFix.map((i) => i.segmentId))].filter((id) => brief.segments.some((s) => s.id === id));
  if (!ids.length) return { brief, fixedSegments: [] };
  const segs = brief.segments.filter((s) => ids.includes(s.id));
  const images = [...new Set(segs.map((s) => s.page))].map((n) => ({ label: `PAGE ${n}`, path: pages[n].thumbPath }));
  const user = `Segments to revise (JSON):\n${JSON.stringify(segs, null, 1)}\n\nIssues to fix:\n${toFix
    .map((i) => `- [${i.segmentId}] (${i.severity}, ${i.check}) "${i.claim}": ${i.problem}\n  Correction: ${i.correction}\n  Evidence: ${i.evidence}`)
    .join("\n")}\n\nSummary lists (change only if an issue requires it):\n${JSON.stringify(brief.summary, null, 1)}\n\nExtracted text of the pages involved:\n${pagesText(pages.filter((p) => segs.some((s) => s.page === p.index)))}`;
  const res = await askJson<{ segments: Segment[]; summary?: Brief["summary"] }>({
    system: FIX_SYSTEM, user, images, schema: FIX_SCHEMA, name: "apply_fixes", workDir: path.join(workDir, "fix"), maxTokens: 12000,
  });
  const byId = new Map((res.segments ?? []).map((s) => [s.id, s]));
  const segments = brief.segments.map((s) => (byId.has(s.id) ? { ...s, ...byId.get(s.id)!, id: s.id } : s));
  return { brief: { ...brief, segments, summary: res.summary ?? brief.summary }, fixedSegments: [...byId.keys()] };
}

/** Converts mechanical findings into issues the fixer can act on. */
export function mechanicalIssues(m: MechanicalReport): Issue[] {
  const out: Issue[] = [];
  for (const s of m.segments) {
    for (const c of s.claims) {
      if (c.status === "unverified") {
        out.push({ check: "mechanical", segmentId: s.id, severity: "major", kind: c.kind, claim: c.text,
          problem: `"${c.text}" was not found on sheet ${s.page + 1} or anywhere in the set.`,
          correction: "Use the value as printed on the sheet, or state plainly that it is derived (e.g. a sum) or not in the documents.",
          evidence: "text extraction of the set" });
      } else if (c.status === "elsewhere" && c.foundOnPage != null && c.kind !== "number") {
        out.push({ check: "mechanical", segmentId: s.id, severity: "minor", kind: c.kind, claim: c.text,
          problem: `"${c.text}" is not on sheet ${s.page + 1}; it appears on sheet ${c.foundOnPage + 1}.`,
          correction: "Name the sheet it comes from, or move the point to that sheet's segment.",
          evidence: `sheet ${c.foundOnPage + 1}` });
      }
    }
    for (const st of s.structural) {
      out.push({ check: "mechanical", segmentId: s.id, severity: "minor", kind: "structure", claim: "", problem: st, correction: "", evidence: "" });
    }
  }
  return out;
}

export type ProgressFn = (msg: string) => Promise<void> | void;

/** Full triple verification. Returns the (possibly corrected) brief and the report. */
export async function verifyBrief(
  brief: Brief, pages: PageInfo[], workDir: string, opts: { modelChecks: boolean; onProgress?: ProgressFn },
): Promise<{ brief: Brief; report: VerificationReport }> {
  const say = opts.onProgress ?? (() => {});
  await say("Check 1 of 3: matching every figure against the sheets");
  const mechanical = mechanicalCheck(brief, pages);
  let issues: Issue[] = mechanicalIssues(mechanical);

  const reviewer: VerificationReport["reviewer"] = { ran: false, issues: [], coverage: [] };
  const auditor: VerificationReport["auditor"] = { ran: false, issues: [] };
  if (opts.modelChecks) {
    await say("Check 2 of 3: independent architect/engineer review");
    try {
      const r = await runReviewer(brief, pages, workDir);
      reviewer.ran = true; reviewer.issues = r.issues; reviewer.coverage = r.coverage;
    } catch (e) { reviewer.error = e instanceof Error ? e.message : String(e); }
    await say("Check 3 of 3: consistency and plain-English audit");
    try {
      auditor.issues = await runAuditor(brief, pages, workDir);
      auditor.ran = true;
    } catch (e) { auditor.error = e instanceof Error ? e.message : String(e); }
    issues = [...issues, ...reviewer.issues, ...auditor.issues];
  }

  let fixed = brief;
  let fixedSegments: string[] = [];
  const actionable = issues.filter((i) => i.severity !== "minor" || i.check === "mechanical" && i.kind !== "structure");
  if (opts.modelChecks && actionable.length) {
    await say(`Correcting ${actionable.length} flagged item${actionable.length === 1 ? "" : "s"}`);
    try {
      const r = await applyFixes(brief, pages, actionable, workDir);
      fixed = r.brief; fixedSegments = r.fixedSegments;
      for (const i of issues) if (fixedSegments.includes(i.segmentId)) i.fixed = true;
    } catch (e) { auditor.error = (auditor.error ? auditor.error + "; " : "") + "fix pass failed: " + (e instanceof Error ? e.message : String(e)); }
  }
  const mechanicalAfterFix = fixedSegments.length ? mechanicalCheck(fixed, pages) : undefined;

  const count = (sev: Severity) => issues.filter((i) => i.severity === sev && !i.fixed).length;
  const critical = count("critical"), major = count("major"), minor = count("minor");
  const verdict = critical ? "needs-review" : major ? "pass-with-notes" : "pass";
  return {
    brief: fixed,
    report: { mechanical, mechanicalAfterFix, reviewer, auditor, fixes: { applied: fixedSegments.length, segments: fixedSegments }, summary: { critical, major, minor, verdict } },
  };
}
