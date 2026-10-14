import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

export type PageInfo = {
  index: number; // 0-based
  imagePath: string; // full-resolution PNG used for rendering
  thumbPath: string; // small JPEG sent to the model
  width: number;
  height: number;
  text: string;
};

/**
 * Renders every page of the PDF to PNG (for video) and JPEG (for the model),
 * and extracts the text layer per page with poppler.
 */
export async function ingestPdf(
  pdfPath: string,
  outDir: string,
  opts: { renderDpi?: number; modelMaxPx?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<PageInfo[]> {
  const renderDpi = opts.renderDpi ?? 110;
  const modelMaxPx = opts.modelMaxPx ?? 1400;

  const { stdout: info } = await run("pdfinfo", [pdfPath]);
  const pageCount = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
  if (!pageCount) throw new Error("Could not read page count. Is this a valid PDF?");

  await fs.mkdir(outDir, { recursive: true });

  // Full-res PNGs for the video camera. Plan sheets are big; 110 dpi on a
  // 36x24 sheet is ~4000x2600 which is plenty for zooming into details.
  await run("pdftoppm", ["-r", String(renderDpi), "-png", pdfPath, path.join(outDir, "page")], {
    maxBuffer: 1024 * 1024 * 64,
  });

  // Smaller JPEGs for the model (keeps tokens and upload size sane).
  await run(
    "pdftoppm",
    ["-scale-to", String(modelMaxPx), "-jpeg", "-jpegopt", "quality=70", pdfPath, path.join(outDir, "thumb")],
    { maxBuffer: 1024 * 1024 * 64 },
  );

  const files = await fs.readdir(outDir);
  const pngs = files.filter((f) => /^page-\d+\.png$/.test(f)).sort(naturalSort);
  const jpgs = files.filter((f) => /^thumb-\d+\.jpg$/.test(f)).sort(naturalSort);
  if (pngs.length !== pageCount || jpgs.length !== pageCount) {
    throw new Error(`Rendered ${pngs.length}/${jpgs.length} pages, expected ${pageCount}`);
  }

  const pages: PageInfo[] = [];
  for (let i = 0; i < pageCount; i++) {
    const { stdout: text } = await run("pdftotext", [
      "-f",
      String(i + 1),
      "-l",
      String(i + 1),
      "-layout",
      pdfPath,
      "-",
    ]);
    const imagePath = path.join(outDir, pngs[i]);
    const { width, height } = await pngSize(imagePath);
    pages.push({
      index: i,
      imagePath,
      thumbPath: path.join(outDir, jpgs[i]),
      width,
      height,
      text: text.replace(/\f/g, "").trim(),
    });
    opts.onProgress?.(i + 1, pageCount);
  }
  return pages;
}

function naturalSort(a: string, b: string) {
  const na = Number(/\d+/.exec(a)?.[0]);
  const nb = Number(/\d+/.exec(b)?.[0]);
  return na - nb;
}

async function pngSize(file: string) {
  const fh = await fs.open(file);
  try {
    const buf = Buffer.alloc(24);
    await fh.read(buf, 0, 24, 0);
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    await fh.close();
  }
}
