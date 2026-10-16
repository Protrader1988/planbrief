import fs from "node:fs/promises";
import path from "node:path";
import { ingestPdf } from "../src/lib/ingest";
import { renderGuide, extractGlossary } from "../src/lib/guide";
import { normalizeBrief } from "../src/lib/analyze";

async function main() {
  const pdf = process.argv[2], briefFile = process.argv[3], out = process.argv[4] || "data/guide-test.pdf";
  const work = path.resolve("data", "guide-work");
  await fs.mkdir(path.join(work, "pages"), { recursive: true });
  const pages = await ingestPdf(pdf, path.join(work, "pages"), {});
  const raw = JSON.parse(await fs.readFile(briefFile, "utf8"));
  const brief = normalizeBrief(raw.brief ?? raw, pages.length);
  console.log("glossary terms:", extractGlossary(brief).length);
  const r = await renderGuide(brief, pages, { outFile: out, workDir: path.join(work, "guide") });
  console.log("pages", r.pages, out);
}
main();
