import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Job, JobStatus } from "./types";

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
export const JOBS_DIR = path.join(DATA_DIR, "jobs");

export function jobDir(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("bad job id");
  return path.join(JOBS_DIR, id);
}

export async function createJob(originalName: string, pdf: Buffer): Promise<Job> {
  const id = randomUUID();
  const dir = jobDir(id);
  await fs.mkdir(path.join(dir, "pages"), { recursive: true });
  await fs.mkdir(path.join(dir, "audio"), { recursive: true });
  await fs.writeFile(path.join(dir, "input.pdf"), pdf);
  const now = new Date().toISOString();
  const job: Job = {
    id,
    createdAt: now,
    updatedAt: now,
    originalName,
    status: "queued",
    progress: 0,
    message: "Queued",
  };
  await saveJob(job);
  return job;
}

export async function saveJob(job: Job) {
  job.updatedAt = new Date().toISOString();
  const file = path.join(jobDir(job.id), "job.json");
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(job, null, 2));
  await fs.rename(tmp, file);
}

export async function getJob(id: string): Promise<Job | null> {
  try {
    const raw = await fs.readFile(path.join(jobDir(id), "job.json"), "utf8");
    return JSON.parse(raw) as Job;
  } catch {
    return null;
  }
}

export async function listJobs(limit = 20): Promise<Job[]> {
  let ids: string[] = [];
  try {
    ids = await fs.readdir(JOBS_DIR);
  } catch {
    return [];
  }
  const jobs = (await Promise.all(ids.map((id) => getJob(id).catch(() => null)))).filter(
    (j): j is Job => !!j,
  );
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return jobs.slice(0, limit);
}

export async function updateJob(
  id: string,
  patch: Partial<Job> & { status?: JobStatus },
): Promise<Job> {
  const job = await getJob(id);
  if (!job) throw new Error("job not found");
  Object.assign(job, patch);
  await saveJob(job);
  return job;
}
