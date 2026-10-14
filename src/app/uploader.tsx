"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export default function Uploader() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!file) return;
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(data.error || "Upload failed");
      setBusy(false);
      return;
    }
    router.push(`/jobs/${data.id}`);
  }

  return (
    <div className="card">
      <div
        className={`drop ${over ? "over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}
      >
        <strong>{file ? file.name : "Drop a PDF here or tap to choose"}</strong>
        <span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : "RFP · RFQ · drawings · specs · addenda, up to 200 MB"}</span>
        <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </div>
      <div className="row" style={{ marginTop: 16, justifyContent: "space-between" }}>
        <span className="muted" style={{ fontSize: 13 }}>Typical run: 2 to 8 minutes depending on page count.</span>
        <button className="btn" disabled={!file || busy} onClick={submit}>{busy ? "Uploading…" : "Make the video"}</button>
      </div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
