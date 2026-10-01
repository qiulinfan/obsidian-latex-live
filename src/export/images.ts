import { promises as fsp, readFileSync } from "fs";
import { basename, extname, resolve } from "path";
import { findGraphics } from "../tex/graphics";
import { literalTexPath, resolveFileReference } from "../tex/project";
import { abortError, isAbortError } from "../tex/run";
import { isFileInput, visitNodes, type ExportPlan, type PlanFile } from "./plan";
import { argText, given, type TexArg, type TexNode } from "./texTree";

// Images of the HTML export (design S6): every `\includegraphics` and `\includepdf` of the files
// the document visits, found as graphicx finds them (graphics.ts: the root's folder, the last
// \graphicspath, graphicx's extensions), read before the emit (the emitter is synchronous) and
// embedded as data URIs, so the page stays one file:
//   - PNG, JPEG, GIF and SVG as they are, with their natural size (TeX's: pixels at the resolution
//     the file records, else 72 dpi) for an image the document does not size;
//   - PDF pages (`\includegraphics[page=n]` of a PDF, pdfpages' `\includepdf[pages=..]`) as PNG
//     drawn at 2x by the host's `pdfImages` (Obsidian's pdf.js; tests may leave it out, and the
//     page then says what is missing, with a report item);
//   - EPS is not exported (a report item; the document can include a PDF or PNG instead).

/** A PDF page drawn by the host: PNG bytes, the page's size in big points, its number. */
export interface PdfPageImage {
  page: number;
  png: Uint8Array;
  width: number;
  height: number;
}

/** The host's PDF renderer: the pages `want` picks from the document's page count, each drawn at 2x. */
export type PdfImages = (abs: string, want: (count: number) => number[], signal: AbortSignal) => Promise<PdfPageImage[]>;

/** An image for the page: its data URI and natural size in big points (null when unknown). */
export interface Picture {
  src: string;
  width: number | null;
  height: number | null;
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml" };

/** A bitmap file (PNG, JPEG, GIF) as a data URI; null for another format or a file that cannot be read. */
export function bitmapDataUri(path: string): string | null {
  const ext = extname(path).slice(1).toLowerCase();
  if (!MIME[ext] || ext === "svg") return null;
  try {
    return `data:${MIME[ext]};base64,${readFileSync(path).toString("base64")}`;
  } catch {
    return null;
  }
}

/** TeX points per unit. */
const UNITS: Record<string, number> = {
  pt: 1, bp: 72.27 / 72, in: 72.27, cm: 72.27 / 2.54, mm: 72.27 / 25.4, pc: 12, dd: 1238 / 1157, cc: (12 * 1238) / 1157, sp: 1 / 65536,
};
const round = (x: number) => Number(x.toFixed(3));

/**
 * A TeX length as CSS: a fraction of the line (`0.55\linewidth`, `\textwidth`) as a percentage, an
 * absolute length (`5cm`, `120pt`) in em of the document's font size `fontPt`, `em`/`ex` as em;
 * null for anything else (`\dimexpr`, a macro).
 */
export function cssLength(tex: string, fontPt: number): string | null {
  const s = tex.replace(/\s+/g, "");
  const line = /^([+-]?(?:\d+\.?\d*|\.\d+))?\\(?:linewidth|textwidth|columnwidth|hsize)$/.exec(s);
  if (line) return `${round((line[1] === undefined ? 1 : Number(line[1])) * 100)}%`;
  const abs = /^([+-]?(?:\d+\.?\d*|\.\d+))(pt|bp|in|cm|mm|pc|dd|cc|sp|em|ex)$/.exec(s);
  if (!abs) return null;
  const v = Number(abs[1]);
  if (abs[2] === "em") return `${round(v)}em`;
  if (abs[2] === "ex") return `${round(v * 0.43)}em`;
  return `${round((v * UNITS[abs[2]]) / fontPt)}em`;
}

/** A key=value list (`width=0.5\linewidth, page=2, keepaspectratio`): braces around a value go. */
export function keyValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let start = 0;
  const add = (part: string) => {
    const eq = part.indexOf("=");
    const key = (eq < 0 ? part : part.slice(0, eq)).trim();
    const value = eq < 0 ? "" : part.slice(eq + 1).trim().replace(/^\{([\s\S]*)\}$/, "$1");
    if (key) out.set(key, value);
  };
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if ((c === "," && depth === 0) || i === text.length) {
      add(text.slice(start, i));
      start = i + 1;
    }
  }
  return out;
}

/**
 * The pages `\includepdf[pages=spec]` inserts from a document of `count` pages, as pdfpages reads
 * the spec: a comma list of pages and ranges (`3-5`, open `3-` and `-3`, reversed `5-3`, `-` for
 * all), `last` for the last page; `{}` (a blank page) and pages out of range are left out. Without
 * a spec, the first page.
 */
export function pdfPageList(spec: string | null, count: number): number[] {
  if (spec === null || !spec.trim()) return count > 0 ? [1] : [];
  const page = (s: string, dflt: number) => {
    const t = s.trim();
    if (!t) return dflt;
    const last = /^last(?:\s*-\s*(\d+))?$/.exec(t);
    if (last) return count - Number(last[1] ?? 0);
    return /^\d+$/.test(t) ? Number(t) : NaN;
  };
  const out: number[] = [];
  for (const item of spec.replace(/^\{([\s\S]*)\}$/, "$1").split(",")) {
    const t = item.trim();
    if (!t || t === "{}") continue;
    const dash = /^(.*?[^\s-]|)\s*-\s*(.*)$/.exec(t);
    const [a, b] = dash && !/^last\s*-\s*\d+$/.test(t) ? [page(dash[1], 1), page(dash[2], count)] : [page(t, NaN), page(t, NaN)];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const step = a <= b ? 1 : -1;
    for (let p = a; step > 0 ? p <= b : p >= b; p += step) if (p >= 1 && p <= count) out.push(p);
  }
  return out;
}

/** A bitmap's size in pixels and the resolution it records (dpi), for PNG, JPEG and GIF; null when unreadable. */
export function bitmapSize(data: Uint8Array, ext: string): { width: number; height: number; dpi: number | null } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ascii = (at: number, n: number) => String.fromCharCode(...data.subarray(at, at + n));
  try {
    if (ext === "png" && ascii(1, 3) === "PNG") {
      const size = { width: view.getUint32(16), height: view.getUint32(20), dpi: null as number | null };
      for (let at = 8; at + 8 <= data.length; ) {
        const len = view.getUint32(at);
        const type = ascii(at + 4, 4);
        if (type === "pHYs" && data[at + 16] === 1) size.dpi = view.getUint32(at + 8) * 0.0254;
        if (type === "IDAT" || type === "IEND") break;
        at += 12 + len;
      }
      return size;
    }
    if (ext === "gif" && ascii(0, 3) === "GIF") return { width: view.getUint16(6, true), height: view.getUint16(8, true), dpi: null };
    if ((ext === "jpg" || ext === "jpeg") && data[0] === 0xff && data[1] === 0xd8) {
      let dpi: number | null = null;
      for (let at = 2; at + 4 <= data.length; ) {
        if (data[at] !== 0xff) return null;
        const marker = data[at + 1];
        const len = view.getUint16(at + 2);
        if (marker === 0xe0 && ascii(at + 4, 5) === "JFIF\0") {
          const unit = data[at + 11];
          const x = view.getUint16(at + 12);
          if (unit === 1 && x) dpi = x;
          else if (unit === 2 && x) dpi = x * 2.54;
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: view.getUint16(at + 7), height: view.getUint16(at + 5), dpi };
        }
        at += 2 + len;
      }
    }
  } catch {
    // truncated
  }
  return null;
}

/** An `\includegraphics`/`\includepdf` of the document: the file it names and the pages it needs. */
interface Request {
  site: string;
  inputDirs: readonly string[];
  paths: readonly string[];
  name: string;
  /** \includegraphics' page (1 by default), or \includepdf's pages spec (null: its default). */
  page: number | null;
  spec: string | null;
  pdfpages: boolean;
  listing?: true;
}

export type ListingSource = { text: string } | { error: string };

/** An optional argument's key=value options (`\includegraphics[..]`, `\includepdf[..]`, `\lstinputlisting[..]`). */
export function optionArg(src: string, arg: TexArg | undefined): Map<string, string> {
  return given(arg) ? keyValues(argText(src, arg)) : new Map();
}

/** The images of a plan (see the file comment): read once, before the emit; then looked up by name. */
export class ExportImages {
  /** Bitmaps by path; PDFs by path: their page count and drawn pages; or why none. */
  private bitmaps = new Map<string, Picture | string>();
  private pdfs = new Map<string, { count: number; pages: Map<number, Picture> } | string>();
  /** The file each name found when `load` read them: the emit touches no file system. */
  private found = new Map<string, string | { error: string }>();
  private listings = new Map<string, ListingSource>();

  constructor(
    private rootDir: string,
    private paths: readonly string[],
    private pdf: PdfImages | undefined,
  ) {}

  /** Every `\includegraphics` and `\includepdf` in the files the plan visits. */
  static requests(plan: ExportPlan, initialPaths: readonly string[] = []): Request[] {
    const out: Request[] = [];
    const byPath = new Map([...plan.files.values()].map((file) => [file.abs, file]));
    // subfiles wraps graphicspath with subfix; import itself temporarily restores Ginput@path.
    const subfiles = plan.visits.some((v, i) => i > 0 && v.bodyOnly) || [...plan.files.values()].some((f) => /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\bsubfiles\b/.test(f.src));
    const scan = (file: PlanFile, nodes: readonly TexNode[], index: number | null, dirs: readonly string[], state: { paths: string[] }, depth: number) => {
      if (depth > 64) return;
      for (const n of nodes) {
        if (n.t === "group") { scan(file, n.body, index, dirs, { paths: [...state.paths] }, depth + 1); continue; }
        if (n.t === "env") {
          const local = { paths: [...state.paths] };
          for (const arg of n.args) if (arg.body) scan(file, arg.body, index, dirs, local, depth + 1);
          scan(file, n.body, index, dirs, local, depth + 1);
          continue;
        }
        if (n.t !== "macro" || n.code) continue;
        if (isFileInput(n)) {
          let child: PlanFile | undefined;
          let childIndex: number | null = null;
          let childDirs: readonly string[] = dirs;
          let bodyOnly = false;
          if (index !== null) {
            const target = plan.inputTargets.get(`${index}@${n.from}`);
            if (target !== undefined) {
              childIndex = target;
              child = plan.files.get(plan.visits[target].key);
              childDirs = plan.visits[target].inputDirs;
              bodyOnly = plan.visits[target].bodyOnly;
            }
          } else {
            const imported = /^(?:sub)?(?:import|inputfrom|includefrom)$/.test(n.name);
            const ref = resolveFileReference(plan.rootDir, n.name, argText(file.src, n.args[n.args.length - 1]), imported ? argText(file.src, n.args[n.args.length - 2]) : null, dirs, (path) => byPath.has(path));
            if (ref) { child = byPath.get(ref.path); childDirs = ref.inputDirs; bodyOnly = ref.bodyOnly; }
          }
          if (child) {
            const scoped = bodyOnly || /^(?:sub)?(?:import|inputfrom|includefrom)$/.test(n.name);
            const childState = scoped ? { paths: [...state.paths] } : state;
            const nodes = childIndex === null ? child.nodes : visitNodes(plan, childIndex);
            scan(child, nodes, childIndex, childDirs, childState, depth + 1);
          }
          continue;
        }
        if (n.name === "graphicspath") {
          state.paths = [...argText(file.src, n.args[0]).matchAll(/\{([^{}]*)\}/g)].map((m) => resolve(subfiles ? (dirs[0] ?? plan.rootDir) : plan.rootDir, literalTexPath(m[1])));
          continue;
        }
        const place = { site: index === null ? `pre:${file.key}@${n.from}` : `${index}@${n.from}`, inputDirs: dirs, paths: [...state.paths] };
        if (n.name === "includegraphics") {
          const page = Number(optionArg(file.src, n.args[1]).get("page"));
          out.push({ ...place, name: argText(file.src, n.args[3]).trim(), page: Number.isInteger(page) && page > 0 ? page : 1, spec: null, pdfpages: false });
        } else if (n.name === "includepdf") out.push({ ...place, name: argText(file.src, n.args[1]).trim(), page: null, spec: optionArg(file.src, n.args[0]).get("pages") ?? null, pdfpages: true });
        else if (n.name === "lstinputlisting") out.push({ ...place, name: argText(file.src, n.args[1]).trim(), page: null, spec: null, pdfpages: false, listing: true });
        else for (const arg of n.args) if (arg.body) scan(file, arg.body, index, dirs, state, depth + 1);
      }
    };
    const root = plan.files.get(plan.rootKey);
    if (root) {
      const state = { paths: initialPaths.map((p) => resolve(plan.rootDir, p)) };
      const document = root.nodes.find((n) => n.t === "env" && n.name === "document");
      const start = document?.from ?? 0;
      scan(root, root.nodes.filter((n) => n.to <= start), null, [plan.rootDir], state, 0);
      scan(root, visitNodes(plan, 0), 0, [plan.rootDir], state, 0);
    }
    return out;
  }

  /** Resolve during load only; repeated names can denote different files in different imports. */
  private resolveImage(name: string, dirs: readonly string[], graphics: readonly string[]): string | { error: string } {
    name = literalTexPath(name);
    const subfix = /^\\subfix\{([^{}\\#]*)\}$/.exec(name);
    if (subfix) name = subfix[1];
    const macros = !name || /[\\#]/.test(name);
    const paths = [...dirs.slice(1), ...graphics];
    const file = macros ? null : findGraphics(name, dirs[0] ?? this.rootDir, paths);
    return file ? file.path : { error: `${name}: ${macros ? "a file name with macros" : "file not found"}` };
  }

  /** Prepared lookup only: the emit never probes the filesystem. */
  private find(name: string, site?: string): string | { error: string } {
    return this.found.get(site === undefined ? `name:${name}` : `site:${site}`) ?? { error: `${name}: not read` };
  }

  /** Read the plan's images (PDF pages through the host's cancellable renderer). */
  async load(plan: ExportPlan, signal: AbortSignal, sites?: ReadonlySet<string>): Promise<void> {
    const pdfPages = new Map<string, Request[]>();
    for (const r of ExportImages.requests(plan, this.paths)) {
      // Interactive source cards only read the images their selected source slice uses.
      // The context walk still sees preceding graphicspath/import declarations.
      if (sites && !sites.has(r.site)) continue;
      if (signal.aborted) throw abortError("The export was cancelled.");
      if (r.listing) {
        const name = literalTexPath(r.name).replace(/^\\subfix\{([^{}\\#]*)\}$/, "$1");
        let result: ListingSource = { error: `${r.name}: file not found` };
        if (!name || /[\\#]/.test(name)) result = { error: `${r.name}: a file name with macros` };
        else for (const dir of r.inputDirs) {
          try { result = { text: (await fsp.readFile(resolve(dir, name), "utf8")).replace(/\r\n?/g, "\n") }; break; } catch { /* next input path */ }
        }
        this.listings.set(r.site, result);
        continue;
      }
      const path = this.resolveImage(r.name, r.inputDirs, r.paths);
      this.found.set(`site:${r.site}`, path);
      const previous = this.found.get(`name:${r.name}`);
      const same = previous === path || (typeof previous === "object" && typeof path === "object" && previous.error === path.error);
      this.found.set(`name:${r.name}`, previous === undefined || same ? path : { error: `${r.name}: ambiguous without a source visit` });
      if (typeof path !== "string") continue;
      const ext = extname(path).slice(1).toLowerCase();
      if (ext === "pdf") pdfPages.set(path, [...(pdfPages.get(path) ?? []), r]);
      else if (!this.bitmaps.has(path)) this.bitmaps.set(path, await this.bitmap(path, ext));
    }
    for (const [path, requests] of pdfPages) {
      if (signal.aborted) throw abortError("The export was cancelled.");
      if (!this.pdf) {
        this.pdfs.set(path, "PDF pages need Obsidian's pdf.js, which this export has not");
        continue;
      }
      let count = 0;
      const want = (n: number) => {
        count = n;
        const pages = new Set<number>();
        for (const r of requests) for (const p of r.pdfpages ? pdfPageList(r.spec, n) : [r.page ?? 1]) if (p >= 1 && p <= n) pages.add(p);
        return [...pages].sort((a, b) => a - b);
      };
      try {
        const drawn = await this.pdf(path, want, signal);
        const pages = new Map<number, Picture>();
        for (const d of drawn) pages.set(d.page, { src: `data:image/png;base64,${Buffer.from(d.png).toString("base64")}`, width: d.width, height: d.height });
        this.pdfs.set(path, { count, pages });
      } catch (e) {
        if (signal.aborted || isAbortError(e)) throw e;
        this.pdfs.set(path, `${basename(path)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** A bitmap or SVG file as a picture, or why it is not one. */
  private async bitmap(path: string, ext: string): Promise<Picture | string> {
    if (ext === "eps" || ext === "ps") return `${basename(path)}: EPS images are not exported (include a PDF or PNG version)`;
    const mime = MIME[ext];
    if (!mime) return `${basename(path)}: .${ext} images are not exported`;
    let data: Uint8Array;
    try {
      data = await fsp.readFile(path);
    } catch (e) {
      return `${basename(path)}: ${e instanceof Error ? e.message : String(e)}`;
    }
    const size = bitmapSize(data, ext);
    const bp = (px: number) => (size?.dpi ? (px * 72) / size.dpi : px);
    return { src: `data:${mime};base64,${Buffer.from(data).toString("base64")}`, width: size ? bp(size.width) : null, height: size ? bp(size.height) : null };
  }

  /** `\includegraphics{name}` (a PDF's `page`), or why there is no picture. */
  graphic(name: string, page = 1, site?: string): Picture | string {
    const path = this.find(name, site);
    if (typeof path !== "string") return path.error;
    if (extname(path).toLowerCase() !== ".pdf") return this.bitmaps.get(path) ?? `${name}: not read`;
    const pdf = this.pdfs.get(path);
    if (typeof pdf === "string") return pdf;
    return pdf?.pages.get(page) ?? `${name}: no page ${page}`;
  }

  /** `\includepdf[pages=spec]{name}`: its pages, or why there are none. */
  pdfPages(name: string, spec: string | null, site?: string): Picture[] | string {
    const path = this.find(name, site);
    if (typeof path !== "string") return path.error;
    const pdf = this.pdfs.get(path);
    if (!pdf || typeof pdf === "string") return pdf ?? `${name}: not read`;
    const pages = pdfPageList(spec, pdf.count).map((p) => pdf.pages.get(p)).filter((p): p is Picture => !!p);
    return pages.length ? pages : `${name}: no pages for ${spec ?? "the default"}`;
  }

  /** A listing read in its source visit; null for a synthetic or unplanned request. */
  listingAt(site?: string): ListingSource | null {
    return site === undefined ? null : (this.listings.get(site) ?? null);
  }
}
