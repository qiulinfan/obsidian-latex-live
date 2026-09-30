import { ChildProcess, execFile } from "child_process";
import { statSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { texEnv, texTool } from "./binaries";

/** A box on a PDF page, in PDF points from the page's top-left corner. */
export interface PdfBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceLocation {
  file: string;
  /** 1-based. */
  line: number;
}

/** Source line/column -> PDF box, via `synctex view`. */
export async function forwardSearch(
  binDir: string,
  pdfPath: string,
  file: string,
  line: number,
  column: number,
): Promise<PdfBox | null> {
  const out = await runSynctex(binDir, dirname(pdfPath), [
    "view",
    "-i",
    `${line}:${Math.max(column, 0)}:${file}`,
    "-o",
    pdfPath,
  ]).catch(() => null);
  return out ? parseView(out) : null;
}

/** PDF point -> source location, via `synctex edit`. */
export async function inverseSearch(
  binDir: string,
  pdfPath: string,
  page: number,
  x: number,
  y: number,
  rootDir: string,
  toLogical: (p: string) => string = resolve,
): Promise<SourceLocation | null> {
  const out = await runSynctex(binDir, dirname(pdfPath), [
    "edit",
    "-o",
    `${page}:${x.toFixed(2)}:${y.toFixed(2)}:${pdfPath}`,
  ]).catch(() => null);
  const loc = out ? parseEdit(out, rootDir) : null;
  return loc ? { ...loc, file: toLogical(loc.file) } : null;
}

/** How a SyncTeX query runs: its time limit, and a set that holds it while it runs (to kill it). */
export interface SynctexRun {
  /** Default 5000 ms. */
  timeoutMs?: number;
  children?: Set<ChildProcess>;
}

/**
 * Every box `synctex view` lists for a source line, in its order (duplicates dropped). A line
 * that typeset nothing gets the boxes of the nearest line that did (SyncTeX's own fallback),
 * usually the line before. Rejects when the query times out, is killed or cannot start (`synctex
 * view` exits 0 when it knows no records, even for a file or PDF it does not know): a caller must
 * not take a failed query for a line without records.
 */
export async function forwardSearchAll(
  binDir: string,
  pdfPath: string,
  file: string,
  line: number,
  run: SynctexRun = {},
): Promise<PdfBox[]> {
  const out = await runSynctex(
    binDir,
    dirname(pdfPath),
    ["view", "-i", `${line}:0:${file}`, "-o", pdfPath],
    run,
  );
  return parseViewAll(out);
}

export function parseView(out: string): PdfBox | null {
  // Only the first record: synctex lists every box on the line.
  const rec = recordFields(out);
  const page = Number(rec.get("Page"));
  const h = Number(rec.get("h"));
  const v = Number(rec.get("v"));
  const W = Number(rec.get("W"));
  const H = Number(rec.get("H"));
  if (!Number.isFinite(page) || !Number.isFinite(h) || !Number.isFinite(v)) {
    return null;
  }
  return {
    page,
    x: h,
    y: v - (Number.isFinite(H) ? H : 0),
    width: Number.isFinite(W) ? W : 0,
    height: Number.isFinite(H) ? H : 0,
  };
}

/**
 * All records of `synctex view` output. `v` is the bottom of a box (baseline plus depth) and
 * `H` its height plus depth, in points from the page's top-left corner.
 */
export function parseViewAll(out: string): PdfBox[] {
  const boxes: PdfBox[] = [];
  const seen = new Set<string>();
  for (const rec of out.split(/^Output:/m).slice(1)) {
    const fields = recordFields(rec);
    const page = Number(fields.get("Page"));
    const h = Number(fields.get("h"));
    const v = Number(fields.get("v"));
    const W = Number(fields.get("W"));
    const H = Number(fields.get("H"));
    if (![page, h, v, W, H].every(Number.isFinite)) continue;
    const box = { page, x: h, y: v - H, width: W, height: H };
    const key = `${page}|${h}|${v}|${W}|${H}`;
    if (seen.has(key)) continue;
    seen.add(key);
    boxes.push(box);
  }
  return boxes;
}

export function parseEdit(out: string, rootDir: string): SourceLocation | null {
  const rec = recordFields(out);
  const input = rec.get("Input");
  const line = Number(rec.get("Line"));
  if (!input || !Number.isFinite(line) || line < 1) return null;
  return {
    file: isAbsolute(input) ? resolve(input) : resolve(rootDir, input),
    line,
  };
}

function recordFields(out: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const raw of out.split(/\r?\n/)) {
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    const key = raw.slice(0, idx);
    if (!fields.has(key)) fields.set(key, raw.slice(idx + 1));
  }
  return fields;
}

/** `synctex` with `args`: its output; rejects when it times out, is killed, fails or cannot start. */
function runSynctex(
  binDir: string,
  cwd: string,
  args: string[],
  run: SynctexRun = {},
): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(
      texTool(binDir, "synctex"),
      args,
      { cwd, env: texEnv(binDir), timeout: run.timeoutMs ?? 5000, windowsHide: true },
      (err, stdout) => {
        run.children?.delete(child);
        if (err) fail(new Error(`SyncTeX did not answer: ${err.message}`));
        else done(stdout);
      },
    );
    run.children?.add(child);
  });
}

/**
 * The mtime of the .synctex.gz next to a PDF, or null without one: TeX replaces the file when a
 * pass ends, so another value is another pass's (PDF crops check it around their queries).
 */
export function synctexStamp(pdfPath: string): number | null {
  try {
    return statSync(pdfPath.replace(/\.pdf$/i, "") + ".synctex.gz").mtimeMs;
  } catch {
    return null;
  }
}
