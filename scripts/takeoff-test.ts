import fs from "node:fs/promises";
import path from "node:path";
import { ingestPdf } from "../src/lib/ingest";
import { normalizeBrief } from "../src/lib/analyze";
import { extractTakeoff, writeTakeoffXlsx } from "../src/lib/takeoff";

async function main() {
  const pdf = process.argv[2], briefFile = process.argv[3], out = process.argv[4] || "data/takeoff-test.xlsx";
  const work = path.resolve("data", "takeoff-work");
  await fs.mkdir(path.join(work, "pages"), { recursive: true });
  const pages = await ingestPdf(pdf, path.join(work, "pages"), {});
  const raw = JSON.parse(await fs.readFile(briefFile, "utf8"));
  const brief = normalizeBrief(raw.brief ?? raw, pages.length);
  const t0 = Date.now();
  const t = await extractTakeoff(pages, brief, path.join(work, "takeoff"), (m) => console.log(m));
  console.log(`items ${t.items.length}, notCountable ${t.notCountable.length}, checks ${JSON.stringify(t.checks)}, ${Math.round((Date.now() - t0) / 1000)}s`);
  await fs.writeFile(out.replace(/\.xlsx$/, ".json"), JSON.stringify(t, null, 1));
  await writeTakeoffXlsx(t, brief, out);
  console.log("wrote", out);
}
main();
