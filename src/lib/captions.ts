/** Splits narration into caption-sized chunks that are also the TTS units, so timing is exact. */

export type Chunk = { text: string; charStart: number };

const CAPTION_MAX = 95; // characters that fit comfortably in two caption lines

export function chunkNarration(narration: string): Chunk[] {
  // split after sentence punctuation followed by whitespace (2.02 and 47.66 stay whole)
  const sentences = narration.split(/(?<=[.!?]["')\]]*)\s+/).filter((x) => x.trim());
  const out: Chunk[] = [];
  let idx = 0;
  for (const s of sentences) {
    const text = s.trim();
    const start = narration.indexOf(text, idx);
    idx = start + text.length;
    for (const [chunk, off] of splitLong(text)) out.push({ text: chunk, charStart: start + off });
  }
  return out.length ? out : [{ text: narration, charStart: 0 }];
}

/** Splits a long sentence at clause boundaries; returns [text, offset-in-sentence]. */
function splitLong(text: string, base = 0): [string, number][] {
  if (text.length <= CAPTION_MAX) return [[text, base]];
  const mid = text.length / 2;
  const candidates = [...text.matchAll(/,\s|;\s|:\s|\s(?:and|but|so|which|then|with)\s/g)]
    .map((m) => m.index! + (m[0].startsWith(" ") ? 0 : m[0].length - 1))
    .filter((i) => i > 20 && i < text.length - 20);
  let cut = -1;
  let best = Infinity;
  for (const i of candidates) if (Math.abs(i - mid) < best) { best = Math.abs(i - mid); cut = i; }
  if (cut < 0) {
    const sp = [...text.matchAll(/\s/g)].map((m) => m.index!).filter((i) => i > 20 && i < text.length - 20);
    for (const i of sp) if (Math.abs(i - mid) < best) { best = Math.abs(i - mid); cut = i; }
    if (cut < 0) return [[text, base]];
  }
  const left = text.slice(0, cut + 1).trim();
  const rightStart = text.slice(cut + 1).search(/\S/) + cut + 1;
  const right = text.slice(rightStart).trim();
  return [...splitLong(left, base), ...splitLong(right, base + rightStart)];
}
