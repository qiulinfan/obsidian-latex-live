import { execFile } from "child_process";
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
  ]);
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
  ]);
  const loc = out ? parseEdit(out, rootDir) : null;
  return loc ? { ...loc, file: toLogical(loc.file) } : null;
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

function runSynctex(
  binDir: string,
  cwd: string,
  args: string[],
): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      texTool(binDir, "synctex"),
      args,
      { cwd, env: texEnv(binDir), timeout: 5000, windowsHide: true },
      (err, stdout) => done(err ? null : stdout),
    );
  });
}
