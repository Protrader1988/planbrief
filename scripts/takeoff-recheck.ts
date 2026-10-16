import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mechanicalTakeoffCheck } from "../src/lib/takeoff";
const run = promisify(execFile);
async function main() {
  const t = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
  const pdf = process.argv[3];
  const n = Math.max(...t.items.map((i: any) => i.sheet)) + 1;
  const pages: any[] = [];
  for (let i = 0; i < n; i++) {
    const { stdout } = await run("pdftotext", ["-layout", "-f", String(i + 1), "-l", String(i + 1), pdf, "-"]);
    pages.push({ index: i, text: stdout });
  }
  const before = { verified: t.items.filter((i: any) => i.status === "verified").length, flagged: t.items.filter((i: any) => i.status === "flagged").length };
  const m = mechanicalTakeoffCheck(t.items, pages);
  console.log("before", before, "after", m);
  for (const i of t.items.filter((x: any) => x.status === "unverified").slice(0, 12)) console.log(i.id, "|", i.description.slice(0, 50), "|", i.quantity, i.unit, "| s", i.sheet + 1, "|", i.sourceText.slice(0, 50));
}
main();
