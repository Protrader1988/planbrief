"use client";
import { useEffect, useRef, useState } from "react";
import type { Job } from "@/lib/types";

const STEPS: { key: Job["status"][]; label: string }[] = [
  { key: ["queued", "ingesting"], label: "1 · Read pages" },
  { key: ["analyzing", "needs_script"], label: "2 · Write script" },
  { key: ["verifying"], label: "3 · Verify ×3" },
  { key: ["narrating"], label: "4 · Narrate" },
  { key: ["rendering"], label: "5 · Film" },
];
const ORDER: Job["status"][] = ["queued", "ingesting", "analyzing", "needs_script", "verifying", "narrating", "rendering", "done"];

export default function JobView({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [active, setActive] = useState(0);
  const [script, setScript] = useState("");
  const [scriptErr, setScriptErr] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [copied, setCopied] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  async function submitScript() {
    setScriptErr(null);
    const res = await fetch(`/api/jobs/${id}/script`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ script }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setScriptErr(data.error || "Could not read that script"); return; }
    setShowEdit(false);
    setJob((j) => (j ? { ...j, status: "narrating", progress: 45, message: "Script received" } : j));
    // restart polling
    const tick = async () => {
      const r = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
      if (r.ok) { const j: Job = await r.json(); setJob(j); if (j.status === "done" || j.status === "error") return; }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 1500);
  }

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
      if (res.ok) {
        const j: Job = await res.json();
        if (!stop) setJob(j);
        if (j.status === "done" || j.status === "error") return;
      }
      if (!stop) setTimeout(tick, 2000);
    };
    tick();
    return () => { stop = true; };
  }, [id]);

  // keep the script list in sync with playback
  useEffect(() => {
    const v = video.current;
    if (!v || !job?.segmentStarts) return;
    const starts = job.segmentStarts;
    const onTime = () => {
      let i = 0;
      for (let k = 0; k < starts.length; k++) if (v.currentTime >= starts[k]) i = k;
      setActive(i);
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [job?.segmentStarts, job?.status]);

  if (!job) return <p className="muted">Loading…</p>;

  const idx = ORDER.indexOf(job.status);
  const seek = (i: number) => {
    const v = video.current;
    const t = job.segmentStarts?.[i];
    if (v && t != null) { v.currentTime = t + 0.05; v.play(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  };

  return (
    <>
      <h1 style={{ fontSize: 28 }}>{job.brief?.projectName || job.originalName}</h1>
      {job.brief?.oneLiner && <p className="lead" style={{ marginBottom: 16 }}>{job.brief.oneLiner}</p>}

      {job.status === "done" && job.videoUrl ? (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <video ref={video} src={job.videoUrl} controls playsInline preload="metadata" />
          <div className="row" style={{ padding: 14, justifyContent: "space-between" }}>
            <span className="muted" style={{ fontSize: 13 }}>
              {fmt(job.durationSec || 0)} · {job.pageCount} pages · {job.brief?.segments.length} parts
            </span>
            <a className="btn ghost" href={job.videoUrl} download>Download MP4</a>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{job.status === "error" ? "Something went wrong" : job.message}</strong>
            <span className="muted">{job.progress}%</span>
          </div>
          <div className="progress"><div style={{ width: `${job.progress}%` }} /></div>
          {job.status === "error" ? (
            <p className="err" style={{ fontSize: 14 }}>{job.error}</p>
          ) : (
            <div className="steps">
              {STEPS.map((s, i) => {
                const first = ORDER.indexOf(s.key[0]);
                const on = s.key.includes(job.status);
                const ok = idx > ORDER.indexOf(s.key[s.key.length - 1]) && first >= 0;
                return <div key={i} className={`step ${on ? "on" : ""} ${ok ? "ok" : ""}`}>{ok ? "✓ " : ""}{s.label}</div>;
              })}
            </div>
          )}
          {job.status !== "error" && <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>You can leave this page; the job keeps running. Come back to this link when it is done.</p>}
        </div>
      )}

      {job.status === "needs_script" && job.prompt && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Write the script in Claude</h2>
          <p className="muted" style={{ fontSize: 14 }}>
            Pages are ready. Open a Claude chat, attach the same PDF, paste this prompt, then paste Claude's JSON answer below.
            This uses your Claude subscription instead of API credits.
          </p>
          <div className="row">
            <button className="btn ghost" onClick={async () => { await navigator.clipboard.writeText(job.prompt!); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
              {copied ? "Copied" : "Copy prompt"}
            </button>
            <a className="btn ghost" href="https://claude.ai/new" target="_blank" rel="noreferrer">Open Claude</a>
          </div>
          <textarea value={script} onChange={(e) => setScript(e.target.value)} placeholder='Paste the JSON script here: {"projectName": ...}' rows={8}
            style={{ width: "100%", marginTop: 14, background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 10, padding: 12, fontFamily: "ui-monospace, monospace", fontSize: 13 }} />
          <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
            {scriptErr ? <span className="err" style={{ fontSize: 13 }}>{scriptErr}</span> : <span />}
            <button className="btn" disabled={!script.trim()} onClick={submitScript}>Narrate and film</button>
          </div>
        </div>
      )}

      {job.verification && <Verification v={job.verification} />}

      {job.brief && (
        <>
          <div className="row" style={{ justifyContent: "space-between", marginTop: 32 }}>
            <h2 style={{ margin: 0 }}>Walkthrough</h2>
            {(job.status === "done" || job.status === "error") && (
              <button className="btn ghost" onClick={() => { setScript(JSON.stringify(job.brief, null, 2)); setShowEdit((v) => !v); }}>
                {showEdit ? "Close editor" : "Edit script and re-film"}
              </button>
            )}
          </div>
          {showEdit && (
            <div className="card" style={{ marginBottom: 14 }}>
              <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={16}
                style={{ width: "100%", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 10, padding: 12, fontFamily: "ui-monospace, monospace", fontSize: 13 }} />
              <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
                {scriptErr ? <span className="err" style={{ fontSize: 13 }}>{scriptErr}</span> : <span className="muted" style={{ fontSize: 13 }}>Fix a sentence, a page number or a highlight box, then re-film.</span>}
                <button className="btn" onClick={submitScript}>Re-film</button>
              </div>
            </div>
          )}
          {job.brief.segments.map((s, i) => (
            <div key={s.id} className={`seg ${i === active && job.status === "done" ? "on" : ""}`} onClick={() => seek(i)}>
              <img src={`/api/jobs/${id}/page/${s.page}`} alt={`Page ${s.page + 1}`} loading="lazy" />
              <div>
                <div className="t">
                  <span>{s.title}</span>
                  <small>{job.segmentStarts ? fmt(job.segmentStarts[i]) + " · " : ""}sheet {s.page + 1}</small>
                </div>
                <p>{s.narration}</p>
                {s.callouts.length > 0 && (
                  <div className="tags">{s.callouts.map((c, k) => <span key={k} className="tag">{c.label}</span>)}</div>
                )}
              </div>
            </div>
          ))}

          <h2>Written brief</h2>
          <div className="grid2">
            {(["scope", "keyDates", "requirements", "risks", "questionsToAsk"] as const).map((k) =>
              job.brief!.summary[k].length ? (
                <div className="card sum" key={k}>
                  <h3>{LABELS[k]}</h3>
                  <ul>{job.brief!.summary[k].map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              ) : null,
            )}
          </div>
        </>
      )}
    </>
  );
}

function Verification({ v }: { v: NonNullable<Job["verification"]> }) {
  const [open, setOpen] = useState(false);
  const m = v.mechanicalAfterFix ?? v.mechanical;
  const issues = [...v.reviewer.issues, ...v.auditor.issues];
  const verdictClass = v.summary.verdict === "pass" ? "done" : v.summary.verdict === "pass-with-notes" ? "live" : "error";
  const verdictText = v.summary.verdict === "pass" ? "Passed" : v.summary.verdict === "pass-with-notes" ? "Passed with notes" : "Needs review";
  const unverified = m.segments.flatMap((s) => s.claims.filter((c) => c.status === "unverified" || c.status === "elsewhere").map((c) => ({ ...c, seg: s.title, page: s.page })));
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>Triple verification</strong>
          <div className="muted" style={{ fontSize: 13 }}>Three independent checks on the script before it was narrated.</div>
        </div>
        <span className={`pill ${verdictClass}`}>{verdictText}</span>
      </div>
      <div className="steps" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="step ok">
          ✓ 1 · Figures vs. sheets
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{m.totals.verified + m.totals.cited} of {m.totals.claims} figures found on the sheets{m.totals.derived ? `, ${m.totals.derived} derived` : ""}{m.totals.elsewhere ? `, ${m.totals.elsewhere} on another sheet` : ""}{m.totals.unverified ? `, ${m.totals.unverified} not found` : ""}</div>
        </div>
        <div className={`step ${v.reviewer.ran ? "ok" : ""}`}>
          {v.reviewer.ran ? "✓" : "–"} 2 · Architect/engineer review
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{v.reviewer.ran ? `${v.reviewer.issues.length} finding${v.reviewer.issues.length === 1 ? "" : "s"}${v.reviewer.coverage.length ? `, ${v.reviewer.coverage.length} coverage note${v.reviewer.coverage.length === 1 ? "" : "s"}` : ""}` : v.reviewer.error ? "failed: " + v.reviewer.error.slice(0, 80) : "skipped (no model in manual mode)"}</div>
        </div>
        <div className={`step ${v.auditor.ran ? "ok" : ""}`}>
          {v.auditor.ran ? "✓" : "–"} 3 · Consistency and plain-English
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{v.auditor.ran ? `${v.auditor.issues.length} finding${v.auditor.issues.length === 1 ? "" : "s"}` : v.auditor.error ? "failed: " + v.auditor.error.slice(0, 80) : "skipped (no model in manual mode)"}</div>
        </div>
      </div>
      {v.fixes.applied > 0 && <p className="muted" style={{ fontSize: 13, margin: "12px 0 0" }}>{v.fixes.applied} segment{v.fixes.applied === 1 ? "" : "s"} corrected and re-checked before narration.</p>}
      {(issues.length > 0 || unverified.length > 0 || v.reviewer.coverage.length > 0) && (
        <>
          <button className="btn ghost" style={{ marginTop: 12 }} onClick={() => setOpen((o) => !o)}>{open ? "Hide details" : "Show details"}</button>
          {open && (
            <div style={{ marginTop: 12, fontSize: 14 }}>
              {issues.map((i, k) => (
                <div key={k} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                  <span className={`pill ${i.severity === "critical" ? "error" : i.severity === "major" ? "live" : ""}`}>{i.severity}</span>{" "}
                  <span className="pill">{i.check === "reviewer" ? "review" : "audit"}</span>{" "}
                  {i.fixed && <span className="pill done">fixed</span>}
                  <div style={{ marginTop: 6 }}><strong>{i.segmentId}</strong> · “{i.claim}” — {i.problem}</div>
                  {i.correction && <div className="muted">Correction: {i.correction}</div>}
                  {i.evidence && <div className="muted" style={{ fontSize: 13 }}>Evidence: {i.evidence}</div>}
                </div>
              ))}
              {unverified.map((c, k) => (
                <div key={"u" + k} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                  <span className={`pill ${c.status === "unverified" ? "live" : ""}`}>{c.status === "unverified" ? "not on sheets" : `on sheet ${(c.foundOnPage ?? 0) + 1}`}</span>
                  <div style={{ marginTop: 6 }}>“{c.text}” in <strong>{c.seg}</strong> (sheet {c.page + 1})</div>
                </div>
              ))}
              {v.reviewer.coverage.map((c, k) => (
                <div key={"c" + k} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                  <span className="pill">not covered</span>
                  <div style={{ marginTop: 6 }}>{c}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const LABELS = { scope: "Scope", keyDates: "Key dates", requirements: "Bid requirements", risks: "Risks and red flags", questionsToAsk: "Questions to ask" };

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}
