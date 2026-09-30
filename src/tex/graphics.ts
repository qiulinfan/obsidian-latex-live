import { statSync } from "fs";
import { extname, isAbsolute, join, resolve } from "path";

// Where `\includegraphics{name}` finds its file (design 4.4 #13), as graphicx does: for each
// name to try, the name relative to the root's folder (TeX's working directory), then under
// each \graphicspath prefix (the last \graphicspath counts). A name with a graphics extension
// is read as given first; otherwise, and when that is missing, graphicx's list is appended (pdf,
// png, jpg, jpeg, then in capitals). A name whose extension is none of graphicx's (`loss_lr0.01`,
// `v1.2`) is read as given only when no appended name exists (checked with pdfLaTeX: an empty
// `weird.01` next to `weird.01.png` loses). Live preview shows png, jpg, jpeg, gif, svg and the
// first page of a pdf.

/** The formats live preview shows (lower-case extensions without the dot). */
export const IMAGE_FORMATS = new Set(["png", "jpg", "jpeg", "gif", "svg", "pdf"]);

const TRIED = [".pdf", ".png", ".jpg", ".jpeg", ".PDF", ".PNG", ".JPG", ".JPEG"];
/** Extensions graphicx has a rule for (a name ending in another is no graphics name yet). */
const GRAPHICS_EXTS = new Set([...IMAGE_FORMATS, "eps", "ps", "mps"]);
const GRAPHICSPATH = /\\graphicspath\s*\{((?:\s*\{[^{}]*\})*)\s*\}/g;

/** The prefixes of the last `\graphicspath{{figures/}{img/}}` in comment-free sources (document order). */
export function graphicsPaths(sources: readonly string[]): string[] {
  let out: string[] = [];
  for (const src of sources) {
    for (const m of src.matchAll(GRAPHICSPATH)) out = [...m[1].matchAll(/\{([^{}]*)\}/g)].map((p) => p[1].trim()).filter(Boolean);
  }
  return out;
}

/** The file `\includegraphics{name}` reads in a project rooted in `rootDir`, with its mtime; null when none exists. */
export function findGraphics(name: string, rootDir: string, paths: readonly string[]): { path: string; mtime: number } | null {
  const ext = extname(name).slice(1).toLowerCase();
  const tried = TRIED.map((e) => name + e);
  const names = !ext ? tried : GRAPHICS_EXTS.has(ext) ? [name, ...tried] : [...tried, name];
  const dirs = [rootDir, ...paths.map((p) => resolve(rootDir, p))];
  for (const n of names) {
    for (const dir of isAbsolute(n) ? [""] : dirs) {
      const path = isAbsolute(n) ? n : join(dir, n);
      try {
        const st = statSync(path);
        if (st.isFile()) return { path, mtime: st.mtimeMs };
      } catch {
        // not there
      }
    }
  }
  return null;
}
