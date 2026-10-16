import fs from "node:fs/promises";
import path from "node:path";
import { ingestPdf } from "../src/lib/ingest";
import { normalizeBrief } from "../src/lib/analyze";
import { buildTradePackages, renderTradePackagesPdf } from "../src/lib/trades";
async function main() {
  const [pdf, briefFile, takeoffFile, out] = process.argv.slice(2);
  const work = path.resolve("data", "trades-work");
  await fs.mkdir(path.join(work, "pages"), { recursive: true });
  const pages = await ingestPdf(pdf, path.join(work, "pages"), {});
  const raw = JSON.parse(await fs.readFile(briefFile, "utf8"));
  const brief = normalizeBrief(raw.brief ?? raw, pages.length);
  const takeoff = takeoffFile ? JSON.parse(await fs.readFile(takeoffFile, "utf8")) : null;
  const t0 = Date.now();
  const pk = await buildTradePackages(brief, takeoff, pages, path.join(work, "llm"));
  console.log(pk.map((p) => `${p.trade} (${p.csi}): ${p.scope.length} scope, ${p.quantities.length} qty, ${p.questions.length} q`).join("\n"), `${Math.round((Date.now() - t0) / 1000)}s`);
  await fs.writeFile(out.replace(/\.pdf$/, ".json"), JSON.stringify(pk, null, 1));
  await renderTradePackagesPdf(brief, pk, out);
  console.log("wrote", out);
}
main();
