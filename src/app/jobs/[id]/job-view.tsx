"use client";
import { useEffect, useRef, useState } from "react";
import type { Job } from "@/lib/types";

const STEPS: { key: Job["status"][]; label: string }[] = [
  { key: ["queued", "ingesting"], label: "1 · Read pages" },
  { key: ["analyzing"], label: "2 · Write script" },
  { key: ["narrating"], label: "3 · Narrate" },
  { key: ["rendering"], label: "4 · Film" },
];
const ORDER: Job["status"][] = ["queued", "ingesting", "analyzing", "narrating", "rendering", "done"];

export default function JobView({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [active, setActive] = useState(0);
  const video = useRef<HTMLVideoElement>(null);

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

      {job.brief && (
        <>
          <h2>Walkthrough</h2>
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

const LABELS = { scope: "Scope", keyDates: "Key dates", requirements: "Bid requirements", risks: "Risks and red flags", questionsToAsk: "Questions to ask" };

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}
