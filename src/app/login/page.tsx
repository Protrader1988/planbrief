"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (res.ok) router.replace(params.get("next") || "/");
    else { setErr("Wrong password"); setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="card" style={{ maxWidth: 420, margin: "40px auto" }}>
      <h1 style={{ fontSize: 24, marginBottom: 6 }}>Sign in</h1>
      <p className="muted" style={{ marginTop: 0 }}>This PlanBrief is private.</p>
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" autoFocus
        style={{ width: "100%", padding: 14, fontSize: 16, borderRadius: 10, border: "1px solid var(--line)", background: "var(--panel-2)", color: "var(--text)" }} />
      <div className="row" style={{ marginTop: 14, justifyContent: "space-between" }}>
        {err ? <span className="err">{err}</span> : <span />}
        <button className="btn" disabled={busy || !pw}>{busy ? "Checking…" : "Enter"}</button>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
