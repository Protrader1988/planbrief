/**
 * Self-test for the mechanical verifier: plants wrong figures in a known-good script and
 * confirms they are caught.  npx tsx scripts/verify-selftest.ts
 */
import fs from "node:fs";
import { mechanicalCheck } from "../src/lib/verify";
const brief = JSON.parse(fs.readFileSync("data/e31/brief.json","utf8"));
const pages = JSON.parse(fs.readFileSync("data/e31/pages.json","utf8"));
const base = mechanicalCheck(brief, pages).totals;
const plants: [string, string, string][] = [
  ["s15","75 people","85 people"], ["s10","C4-5A","C4-4A"], ["s14","47.66 cubic yards","57.66 cubic yards"],
  ["s2","UL DES U 407","UL DES U 417"], ["s18","65.94","66.94"], ["s19","46 feet 4","48 feet 4"],
  ["s21","1.6 gallons","1.8 gallons"], ["s6","3604970201F","3604970202F"], ["s1","block 886","block 866"],
  ["s5","0.35","0.32"], ["s12","ADA","ADA"], ["s17","451 square foot","415 square foot"], ["s16","9 foot 10","9 foot 8"],
  ["s3","BC 1704.4","BC 1704.6"], ["s7","six foot ceiling","seven foot ceiling"], ["s20","U-factor of 0.60","U-factor of 0.50"],
];
let caught=0, total=0;
for (const [id, from, to] of plants) {
  const b = JSON.parse(JSON.stringify(brief));
  const seg = b.segments.find((s: any)=>s.id===id);
  if (!seg.narration.includes(from)) { console.log("SKIP (phrase not in narration):", id, from); continue; }
  if (from===to) continue;
  seg.narration = seg.narration.replace(from, to);
  total++;
  const r = mechanicalCheck(b, pages);
  const segR = r.segments.find(s=>s.id===id)!;
  const flagged = segR.claims.filter(c=>c.status!=="verified").map(c=>c.text);
  const ok = r.totals.verified < base.verified;
  caught += ok?1:0;
  console.log(ok?"CAUGHT ":"MISSED ", id, `${from} -> ${to}`, ok?"":"  flagged:"+JSON.stringify(flagged));
}
console.log(`\n${caught}/${total} planted errors caught`);
