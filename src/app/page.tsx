import { listJobs } from "@/lib/jobs";
import Uploader from "./uploader";

export const dynamic = "force-dynamic";

export default async function Home() {
  const jobs = await listJobs(12);
  return (
    <>
      <h1>Turn any bid package into a video you can actually follow.</h1>
      <p className="lead">
        Drop in an RFP, RFQ, drawing set or spec book. PlanBrief reads every page, writes a plain-English script from the
        big picture down to the details, narrates it, and films a walkthrough over the real pages with a pointer and
        highlights on what is being discussed.
      </p>
      <Uploader />
      {jobs.length > 0 && (
        <div className="list">
          {jobs.map((j) => (
            <a key={j.id} className="job" href={`/jobs/${j.id}`}>
              <div style={{ minWidth: 0 }}>
                <div className="name">{j.brief?.projectName || j.originalName}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {new Date(j.createdAt).toLocaleString()} {j.pageCount ? `· ${j.pageCount} pages` : ""}
                </div>
              </div>
              <span className={`pill ${j.status === "done" ? "done" : j.status === "error" ? "error" : "live"}`}>
                {j.status === "done" ? "Ready" : j.status === "error" ? "Failed" : j.message}
              </span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}
