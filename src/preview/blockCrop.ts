import type { ChildProcess } from "child_process";
import type { RenderResult } from "../editor/shared/livePreview";
import type { CompiledPdf, SessionEvent } from "../session";
import { PdfBox, forwardSearchAll, synctexStamp } from "../tex/synctex";
import type { PdfDoc } from "./pdfRenderer";

// PDF crops (design 4.6): a block MathJax cannot draw (a TikZ picture, a table, a formula it
// rejects) or that the hover shows as printed (a theorem box, a figure) is cut out of the last
// compile's PDF. Free of the obsidian module: main.ts passes Obsidian's pdf.js in, and tests
// run the SyncTeX part against real TeX.
//   Fresh     a crop exists only while the block's text is the one compiled: the session keeps
//             the files a compile read (CompiledPdf.source: from disk at its start, or later
//             while unchanged since), and the block's text is searched there, the occurrence
//             nearest to its current line giving the compiled lines (`compiledLines`; a search,
//             not change mapping: lines inserted above must not pick the neighbouring block).
//             Changed, a file written while the compile ran, no preview (no session): no crop.
//   Lines     SyncTeX (`forwardSearchAll`, every record) over the block's lines without its
//             \begin line (`queryLines`: at most QUERY_LINES inside, the first and last ones, and
//             the \end line), plus the nearest lines above and below it that are not blank or a
//             comment. A line that typesets nothing reports its neighbour's boxes, usually the
//             line before's (a \begin line; an align row continued on the next line), for an
//             \end line sometimes the line after's (a float's): those records are dropped. A
//             formula's \begin line (one that only opens it) is asked too, as a line before: the
//             last line of a paragraph a display ends is tagged with the line that ended it.
//   Geometry  measured on the synthetic books (`cropRegion`, by CropKind). A formula, a block of
//             running text or a float takes every record left (an equation's \end line holds its
//             number); a TikZ picture or table takes its lines' records and the enclosing box its
//             \end line reports (tikz-cd's cells sit where TeX set them, not where pgf drew them;
//             the picture box holds them), never the paragraph line around one in running text;
//             a tcolorbox (elegantbook's theorems) takes its \end line's records alone: they are
//             the box with its title, while pgf moved everything inside it (SyncTeX reports it
//             ~20 pt low), so nothing inside such a box is cropped by itself (latexLive's
//             cropKindOf). Running text (a tcolorbox too) starts below the line before it:
//             records above that line are what a page shipped out while the block was read left
//             behind (a box broken over pages: its \end line reports that page whole). The union
//             on the first page (one holding a strip under THIN_PT is such a leftover), padded
//             and clipped to the page and to the lines around the block; records on a later page
//             add a "continues" note. A formula spans the text width (its records may miss a
//             side). The drawing is then trimmed to its ink (plus the padding): a table centred
//             in a full-width line comes out as the table.
//   Spawns    at most MAX_SPAWNS `synctex view` at once, SPAWN_TIMEOUT_MS each; one that times
//             out or fails fails its region (asked again on the next render), never "no records".
//             Queries of the last result also run while a compile runs: TeX (XeLaTeX and pdfLaTeX
//             checked) writes `<job>.synctex(busy)` and replaces `<job>.synctex.gz` only when a pass
//             ends. A query spanning that replacement fails quietly: the .synctex.gz's mtime is
//             taken when the result lands (CompiledPdf.synctex) and checked after every query.
//             Running ones are killed on dispose.
//   Cache     per result (CompiledPdf.seq, in every request): regions per (file, compiled
//             lines, kind), drawings per region (a drawn crop renders synchronously), one pdf.js
//             document loaded on first use from a copy of the result's bytes (pdf.js takes the
//             buffer) and destroyed with the next result or the session. Drawings are PNG blob
//             URLs (not data URLs: live preview's cache keeps up to 2000 renders), revoked one
//             result later: a block keeps its last crop on screen (`previous`) until the new
//             result's lands.
//   Theme     a white paper card (`lsp-lp-paper`), inverted in a dark theme when the preview's
//             "Invert preview colors" says so (`is-inverted`, part of the request).

/**
 * How a block's records make its crop (see Geometry): a formula, a TikZ picture or table, a
 * tcolorbox, a block of running text (a theorem-like environment), a figure or table float.
 */
export type CropKind = "math" | "picture" | "box" | "block" | "float";

/** Where a block's crop comes from (a request source), or why there is none (for the hover). */
export type CropLocation = { src: string; previous: string | null } | { note: string };

/** The part of a session crops read. */
export interface CropSession {
  readonly compiling: unknown;
  readonly compiled: CompiledPdf | null;
  onEvent(cb: (e: SessionEvent) => void): () => void;
}

export interface CropHost {
  /** The session previewing `root`: sessions live while a preview shows them. */
  session(root: string): CropSession | null;
  binDir(): string | null;
  /** Obsidian's pdf.js with its assets (pdfRenderer's `openPdf`); the buffer is transferred. */
  openPdf(data: Uint8Array): Promise<PdfDoc>;
  /** Paper cards invert: "Invert preview colors" with a dark theme. */
  inverted(): boolean;
  /** The document canvases and cards are made in (its window's devicePixelRatio). */
  document: Document;
}

/**
 * A region of a PDF page in points from its top-left corner; `continues` on a later page. The
 * padding stays within `top` and `bottom` (where the lines around a formula begin).
 */
export interface CropRegion extends PdfBox {
  continues: boolean;
  top?: number;
  bottom?: number;
}

/** The boxes SyncTeX gives for a block's lines and the lines around it (see Lines). */
export interface CropRecords {
  before: readonly PdfBox[];
  /** A formula's \begin line (asked for "math" only): never its own records. */
  begin?: readonly PdfBox[];
  inside: readonly (readonly PdfBox[])[];
  end: readonly PdfBox[];
  after: readonly PdfBox[];
}

const MAX_SPAWNS = 4;
const SPAWN_TIMEOUT_MS = 2000;
/** Lines inside a block asked at most: the first and the last half of them. */
const QUERY_LINES = 12;
/** Padding above and below a region, and at its sides (a picture's neighbours in its line). */
const PAD_PT = 4;
const PAD_X_PT = 1.5;
/** A box encloses the lines' union when it reaches within this of each side. */
const TOLERANCE_PT = 4;
/** A first page holding less than this of a block is a shipout's leftover (onFirstPage). */
const THIN_PT = 12;
/** A PDF at 100%: CSS pixels per point. */
const CSS_PER_PT = 4 / 3;
/** A pixel is ink below this on some channel (drawn on white). */
const INK = 250;
/** A hover waits this long at most for the first compile to end. */
const IDLE_WAIT_MS = 60_000;

export const NOTE_NO_PREVIEW = "Open the preview to show this block from the PDF.";
export const NOTE_NOT_COMPILED = "Not in the last compile yet.";
export const NOTE_COMPILING = "Compiling…";
export const NOTE_CHANGED = "Changed since the last compile.";

/**
 * The lines (1-based, inclusive) `text` had in `source`: of its occurrences, the one starting
 * nearest to `line` (where it starts now); null when the compile never saw this text.
 */
export function compiledLines(source: string, text: string, line: number): { from: number; to: number } | null {
  const found = compiledOccurrence(source, text, line);
  return found && { from: found.from, to: found.to };
}

/** The occurrence stays distinct when a later compile shifts identical blocks' lines. */
function compiledOccurrence(source: string, text: string, line: number): { from: number; to: number; occurrence: number } | null {
  if (!text) return null;
  let best: number | null = null;
  let occurrence = 0;
  let bestOccurrence = 0;
  let at = 1;
  let scanned = 0;
  for (let i = source.indexOf(text); i >= 0; i = source.indexOf(text, i + 1)) {
    for (let k = source.indexOf("\n", scanned); k >= 0 && k < i; k = source.indexOf("\n", k + 1)) at++;
    scanned = i;
    if (best === null || Math.abs(at - line) < Math.abs(best - line)) {
      best = at;
      bestOccurrence = occurrence;
    }
    occurrence++;
    if (at > line) break; // later ones are further away
  }
  if (best === null) return null;
  let lines = 0;
  for (let k = text.indexOf("\n"); k >= 0; k = text.indexOf("\n", k + 1)) lines++;
  return { from: best, to: best + lines, occurrence: bestOccurrence };
}

/** A line that only opens a block: `\begin{env}` with its arguments, `\[` or `$$`, and a \label or a comment. */
const OPENING = /^\s*(?:\\begin\s*\{[^{}]*\}(?:\s*\[[^\]]*\]|\s*\{[^{}]*\})*|\\\[|\$\$)\s*(?:\\label\s*\{[^{}]*\}\s*)?(?:%.*)?$/;

/**
 * The lines to ask SyncTeX about (see Lines): the lines next to the block (the nearest above and
 * below it that are not blank or a comment), its \begin line when that only opens it, the lines
 * inside, and its last line. A block of one line is all inside; of two, its first line is inside
 * unless it only opens the block.
 */
export function queryLines(
  source: string,
  from: number,
  to: number,
): { before: number | null; begin: number | null; inside: number[]; end: number | null; after: number | null } {
  const text = source.split("\n");
  const code = (l: number) => !/^\s*(%.*)?$/.test(text[l - 1]);
  let before: number | null = null;
  for (let l = from - 1; l >= 1 && before === null; l--) if (code(l)) before = l;
  let after: number | null = null;
  for (let l = to + 1; l <= text.length && after === null; l++) if (code(l)) after = l;
  if (from === to) return { before, begin: null, inside: [from], end: null, after };
  const begin = OPENING.test(text[from - 1] ?? "") ? from : null;
  const first = to - from === 1 && begin === null ? from : from + 1;
  let inside: number[] = [];
  for (let l = first; l < to; l++) inside.push(l);
  if (inside.length > QUERY_LINES) inside = [...inside.slice(0, QUERY_LINES / 2), ...inside.slice(-QUERY_LINES / 2)];
  return { before, begin, inside, end: to, after };
}

const boxKey = (b: PdfBox) => `${b.page}|${b.x}|${b.y}|${b.width}|${b.height}`;
const bottom = (b: PdfBox) => b.y + b.height;

function union(boxes: readonly PdfBox[]): PdfBox | null {
  if (!boxes.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, bottom(b));
  }
  return { page: boxes[0].page, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const encloses = (outer: PdfBox, inner: PdfBox): boolean =>
  outer.page === inner.page &&
  outer.x <= inner.x + TOLERANCE_PT &&
  outer.y <= inner.y + TOLERANCE_PT &&
  outer.x + outer.width >= inner.x + inner.width - TOLERANCE_PT &&
  bottom(outer) >= bottom(inner) - TOLERANCE_PT;

/**
 * The union of `boxes` on their first page, and whether any lie on a later one. A first page
 * with a strip thinner than THIN_PT is what a page shipped out while the block was read left
 * there: the block starts on the next page.
 */
function onFirstPage(boxes: readonly PdfBox[]): CropRegion | null {
  let page = boxes[0]?.page;
  if (page === undefined) return null;
  let u = union(boxes.filter((b) => b.page === page))!;
  const later = boxes.filter((b) => b.page > page);
  if (u.height < THIN_PT && later.length) {
    page = Math.min(...later.map((b) => b.page));
    u = union(later.filter((b) => b.page === page))!;
  }
  return { ...u, continues: boxes.some((b) => b.page > page) };
}

/** The region a block's records give (see Geometry), unpadded; null without records. */
export function cropRegion(kind: CropKind, records: CropRecords): CropRegion | null {
  // Points (a kern at the page's origin) add nothing.
  const real = (boxes: readonly PdfBox[]) => boxes.filter((b) => b.width > 0 || b.height > 0);
  const keys = (boxes: readonly PdfBox[]) => new Set(boxes.map(boxKey));
  const end = real(records.end);
  const all = real(records.inside.flat());
  // A formula's \begin line is one more line before it (see Lines).
  const around = [...real(records.before), ...real(records.begin ?? [])];
  let inside: PdfBox[];
  let last: PdfBox[];
  if (kind === "box") {
    inside = end.length ? [] : all;
    last = end;
  } else {
    // Lines that typeset nothing report their neighbours: the line before (the block's \end
    // line has its own), or, for an \end line, the line after (unless the lines inside have them).
    const [inEnd, inAll] = [keys(end), keys(all)];
    const before = keys(around.filter((b) => !inEnd.has(boxKey(b))));
    const after = keys(real(records.after).filter((b) => !inAll.has(boxKey(b))));
    inside = all.filter((b) => !before.has(boxKey(b)));
    last = end.filter((b) => !after.has(boxKey(b)));
  }
  // The lines around the block, where they are not the block's own. A tcolorbox's \end line also
  // reports the page shipped out while the box was read (a box broken over pages), the line
  // before included: those count as the line before's.
  const kept = keys([...inside, ...last]);
  const beforeOwn = around.filter((b) => kind === "box" || !kept.has(boxKey(b)));
  const afterOwn = real(records.after).filter((b) => !kept.has(boxKey(b)));
  if ((kind === "math" || kind === "block" || kind === "box") && beforeOwn.length) {
    // Running text starts below the line before it: what lies above it is a shipout's (a page
    // finished while the block was read tags its boxes with the block's lines).
    const page = beforeOwn[0].page;
    const top = Math.max(...beforeOwn.filter((b) => b.page === page).map(bottom));
    const below = (b: PdfBox) => b.page > page || (b.page === page && bottom(b) > top + 0.5);
    inside = inside.filter(below);
    last = last.filter(below);
  }
  let region: CropRegion | null;
  if (kind === "picture" && inside.length) {
    const lines = onFirstPage(inside)!;
    // The enclosing box its \end line reports, never the full-width line of a paragraph.
    const widest = Math.max(...[...records.before, ...all, ...end].map((b) => b.width));
    const around = last.filter((b) => encloses(b, lines)).sort((a, b) => b.width * b.height - a.width * a.height);
    const box = around.find((b) => b.width < widest - 1) ?? around[0];
    region = box ? { ...union([lines, box])!, continues: lines.continues } : lines;
  } else region = onFirstPage([...inside, ...last]);
  if (!region) return null;
  const on = (b: PdfBox) => b.page === region.page;
  if (kind === "math") {
    // A formula's line is the text's width: its number is at the right, its records may miss
    // a side.
    const line = [...beforeOwn, ...all, ...end, ...afterOwn].filter(on).sort((a, b) => b.width - a.width)[0];
    const x1 = Math.max(region.x + region.width, line ? line.x + line.width : 0);
    region.x = Math.min(region.x, line?.x ?? region.x);
    region.width = x1 - region.x;
  }
  // A block ends where the lines around it begin: the padding would take their descenders, a
  // tikz-cd picture box reaches ~20 pt above its ink, and a scaled graphic's box has the size of
  // the unscaled file (graphicx scales it with a PDF transformation SyncTeX does not see).
  const middle = region.y + region.height / 2;
  const above = beforeOwn.filter((b) => on(b) && bottom(b) < middle).map(bottom);
  const under = afterOwn.filter((b) => on(b) && b.y > middle).map((b) => b.y);
  if (above.length) region.top = Math.max(...above);
  if (under.length) region.bottom = Math.min(...under);
  return region;
}

/** A drawn crop: a blob URL and its size in CSS pixels. */
interface CropImage {
  url: string;
  width: number;
  height: number;
  continues: boolean;
}

/** One result's crops of a root (see Cache). */
interface RootCrops {
  compiled: CompiledPdf;
  doc: Promise<PdfDoc> | null;
  regions: Map<string, Promise<CropRegion | null>>;
  images: Map<string, Promise<CropImage | null>>;
  /** The drawings done (render answers from here synchronously). */
  done: Map<string, CropImage>;
  /** compiledLines per file, current line and text (the nearest occurrence is the line's). */
  lines: Map<string, { from: number; to: number; occurrence: number } | null>;
  /** A request source -> its block (file, kind, text, occurrence), for `previous`. */
  blocks: Map<string, string>;
  urls: string[];
  /** The current result of its root (drawings finishing after it was retired are revoked at once). */
  live: boolean;
}

/** PDF crops for the plugin's sessions (see the header). */
export class CropService {
  private roots = new Map<string, RootCrops>();
  /** Blob URLs of each root's result before the current one, revoked with the next. */
  private retired = new Map<string, string[]>();
  /** Per root: the last request source that drew each block's distinct occurrence. */
  private drawn = new Map<string, Map<string, string>>();
  private readonly children = new Set<ChildProcess>();
  private running = 0;
  private waiting: (() => void)[] = [];
  /** Hovers waiting for the first compile to end. */
  private idlers = new Map<string, Set<() => void>>();
  private disposed = false;

  constructor(private readonly host: CropHost) {}

  /**
   * Where `text` (a block of `file`, starting on `line` now) is in the last compile of `root`:
   * the crop's request source (and the source that drew this block before, while that crop
   * still shows), or why there is none.
   */
  locate(root: string, file: string, text: string, line: number, kind: CropKind): CropLocation {
    if (this.disposed) return { note: NOTE_NO_PREVIEW };
    const session = this.host.session(root);
    if (!session) return { note: NOTE_NO_PREVIEW };
    const r = this.current(root, session);
    if (!r) return { note: session.compiling ? NOTE_COMPILING : NOTE_NOT_COMPILED };
    const source = r.compiled.source(file);
    if (source === undefined) return { note: NOTE_NOT_COMPILED };
    const memo = `${file}\u0000${line}\u0000${text}`;
    let lines = r.lines.get(memo);
    if (lines === undefined) r.lines.set(memo, (lines = compiledOccurrence(source, text, line)));
    if (!lines) return { note: NOTE_CHANGED };
    const src = [r.compiled.seq, lines.from, lines.to, kind, this.host.inverted() ? 1 : 0, file].join("|");
    const block = `${file}\u0000${kind}\u0000${lines.occurrence}\u0000${text}`;
    r.blocks.set(src, block);
    const was = this.drawn.get(root)?.get(block);
    return { src, previous: was && was !== src ? was : null };
  }

  /**
   * A crop request's card (a live widget's template), or a quiet failure: the block stays source.
   * Synchronous once the drawing exists (a new epoch, the inverted card, the hover), so live
   * preview's scheduler never waits on it.
   */
  render(root: string, src: string): RenderResult | Promise<RenderResult> {
    if (this.disposed) return { ok: false, message: "The preview was closed.", quiet: true };
    const parts = src.split("|");
    const [seq, from, to] = parts.slice(0, 3).map(Number);
    const kind = parts[3] as CropKind;
    const inverted = parts[4] === "1";
    const file = parts.slice(5).join("|");
    const r = this.roots.get(root);
    if (!r || r.compiled.seq !== seq) return { ok: false, message: "A newer compile replaced this one.", quiet: true };
    const key = regionKey(file, from, to, kind);
    const done = r.done.get(key);
    if (done) return this.shown(root, r, src, done, inverted);
    let image = r.images.get(key);
    if (!image) r.images.set(key, (image = this.draw(r, file, from, to, kind)));
    return image.then(
      (drawn) => {
        if (!drawn) return { ok: false, message: "SyncTeX has no position for this block.", quiet: true };
        r.done.set(key, drawn);
        return this.shown(root, r, src, drawn, inverted);
      },
      (e: unknown) => {
        r.images.delete(key);
        return { ok: false, message: e instanceof Error ? e.message : String(e), quiet: true };
      },
    );
  }

  /** A drawing's card; its block now shows this request (`previous` for the next result's). */
  private shown(root: string, r: RootCrops, src: string, drawn: CropImage, inverted: boolean): RenderResult {
    const block = r.blocks.get(src);
    if (block && this.roots.get(root) === r) {
      let last = this.drawn.get(root);
      if (!last) this.drawn.set(root, (last = new Map()));
      last.set(block, src);
    }
    return { ok: true, node: this.card(drawn, inverted) };
  }

  /**
   * The render hover's crop of a block: its card, or why there is none. While the session's
   * first compile runs (no result yet), `wait` waits for its result (or failure) and looks again;
   * a later compile is not waited for (the last result crops meanwhile).
   */
  async hover(root: string, file: string, text: string, line: number, kind: CropKind, wait: boolean): Promise<HTMLElement | { note: string }> {
    let where = this.locate(root, file, text, line, kind);
    const session = this.host.session(root);
    if (wait && "note" in where && where.note === NOTE_COMPILING && session) {
      await this.idle(root, session);
      where = this.locate(root, file, text, line, kind);
    }
    if ("note" in where) return where;
    const r = await this.render(root, where.src);
    return r.ok ? (r.node as HTMLElement) : { note: r.message };
  }

  /** Until the session's compile ends (a result or a failure), its release, or IDLE_WAIT_MS. */
  private idle(root: string, session: CropSession): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((done) => {
      const finish = () => {
        off();
        clearTimeout(timer);
        const pending = this.idlers.get(root);
        pending?.delete(finish);
        if (!pending?.size) this.idlers.delete(root);
        done();
      };
      const off = session.onEvent((e) => {
        if (e !== "start") finish();
      });
      const timer = setTimeout(finish, IDLE_WAIT_MS);
      let pending = this.idlers.get(root);
      if (!pending) this.idlers.set(root, (pending = new Set()));
      pending.add(finish);
    });
  }

  /** The session of `root` went away (preview closed): its document, drawings and blocks go. */
  release(root: string): void {
    for (const finish of [...(this.idlers.get(root) ?? [])]) finish();
    const r = this.roots.get(root);
    this.roots.delete(root);
    if (r) this.drop(r);
    for (const url of this.retired.get(root) ?? []) URL.revokeObjectURL(url);
    this.retired.delete(root);
    this.drawn.delete(root);
  }

  /** Plugin unload: running SyncTeX queries are killed, every document and drawing goes. */
  dispose(): void {
    this.disposed = true;
    for (const child of this.children) child.kill();
    this.children.clear();
    for (const root of new Set([...this.roots.keys(), ...this.retired.keys(), ...this.idlers.keys()])) this.release(root);
    for (const wake of this.waiting.splice(0)) wake();
  }

  /** The pids of SyncTeX queries still running (tests). */
  get runningPids(): number[] {
    return [...this.children].map((c) => c.pid ?? -1);
  }

  /** The root's crops for its session's last PDF (a new result retires the last one's). */
  private current(root: string, session: CropSession): RootCrops | null {
    const compiled = session.compiled;
    const old = this.roots.get(root);
    if (!compiled) return null;
    if (old?.compiled.seq === compiled.seq) return old;
    const r: RootCrops = {
      compiled,
      doc: null,
      regions: new Map(),
      images: new Map(),
      done: new Map(),
      lines: new Map(),
      blocks: new Map(),
      urls: [],
      live: true,
    };
    this.roots.set(root, r);
    if (old) {
      for (const url of this.retired.get(root) ?? []) URL.revokeObjectURL(url);
      this.retired.set(root, old.urls);
      old.urls = [];
      this.drop(old);
      // Drawings of the result retired now stay one more result; older ones are gone.
      const drawn = this.drawn.get(root);
      if (drawn) for (const [block, src] of drawn) if (!src.startsWith(`${old.compiled.seq}|`)) drawn.delete(block);
    }
    return r;
  }

  private drop(r: RootCrops): void {
    r.live = false;
    void r.doc?.then(
      (d) => d.destroy(),
      () => {},
    );
    r.doc = null;
    for (const url of r.urls) URL.revokeObjectURL(url);
    r.urls = [];
  }

  private region(r: RootCrops, file: string, from: number, to: number, kind: CropKind): Promise<CropRegion | null> {
    const key = regionKey(file, from, to, kind);
    let hit = r.regions.get(key);
    if (!hit) {
      r.regions.set(key, (hit = this.query(r, file, from, to, kind)));
      void hit.catch(() => r.regions.delete(key));
    }
    return hit;
  }

  /** SyncTeX's records for the block's lines (see Lines), as a region (see Geometry). */
  private async query(r: RootCrops, file: string, from: number, to: number, kind: CropKind): Promise<CropRegion | null> {
    const binDir = this.host.binDir();
    const source = r.compiled.source(file);
    if (!binDir || source === undefined || r.compiled.synctex === null) return null;
    const lines = queryLines(source, from, to);
    const ask = (line: number | null): Promise<PdfBox[]> =>
      line === null
        ? Promise.resolve([])
        : this.spawn(() => forwardSearchAll(binDir, r.compiled.pdfPath, file, line, { timeoutMs: SPAWN_TIMEOUT_MS, children: this.children }));
    // A tcolorbox is its \end line's records (and the lines around it).
    const box = kind === "box" && lines.end !== null;
    const [before, begin, end, after, ...inside] = await Promise.all([
      ask(lines.before),
      ask(kind === "math" ? lines.begin : null),
      ask(lines.end),
      ask(lines.after),
      ...(box ? [] : lines.inside.map(ask)),
    ]);
    if (synctexStamp(r.compiled.pdfPath) !== r.compiled.synctex) throw new Error("The PDF changed during the query.");
    return cropRegion(kind, { before, begin, inside, end, after });
  }

  /** At most MAX_SPAWNS queries run at once. */
  private async spawn<T>(f: () => Promise<T>): Promise<T> {
    while (this.running >= MAX_SPAWNS && !this.disposed) await new Promise<void>((wake) => this.waiting.push(wake));
    if (this.disposed) throw new Error("Crops are disposed.");
    this.running++;
    try {
      return await f();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** The block's region drawn by pdf.js (see Geometry, Cache). */
  private async draw(r: RootCrops, file: string, from: number, to: number, kind: CropKind): Promise<CropImage | null> {
    const region = await this.region(r, file, from, to, kind);
    if (!region) return null;
    if (!r.live) throw new Error("A newer compile replaced this one.");
    r.doc ??= this.host.openPdf(r.compiled.pdf.slice());
    const page = await (await r.doc).getPage(region.page);
    const size = page.getViewport({ scale: 1 });
    const x0 = Math.max(0, region.x - PAD_X_PT);
    const y0 = Math.max(0, region.top ?? 0, region.y - PAD_PT);
    const x1 = Math.min(size.width, region.x + region.width + PAD_X_PT);
    const y1 = Math.min(size.height, region.bottom ?? Infinity, region.y + region.height + PAD_PT);
    const dpr = this.host.document.defaultView?.devicePixelRatio || 1;
    const scale = CSS_PER_PT * dpr;
    const canvas = this.host.document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil((x1 - x0) * scale));
    canvas.height = Math.max(1, Math.ceil((y1 - y0) * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas to draw the PDF on.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const viewport = page.getViewport({ scale, offsetX: -x0 * scale, offsetY: -y0 * scale });
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    const out = trimToInk(canvas, Math.round(PAD_PT * scale));
    const blob = await new Promise<Blob | null>((done) => out.toBlob(done, "image/png"));
    if (!blob) throw new Error("The crop could not be encoded.");
    const url = URL.createObjectURL(blob);
    // Revoked with its result; one retired meanwhile shows nothing any more.
    if (r.live) r.urls.push(url);
    else URL.revokeObjectURL(url);
    return { url, width: out.width / dpr, height: out.height / dpr, continues: region.continues };
  }

  /** The paper card of a drawing. */
  private card(image: CropImage, inverted: boolean): HTMLElement {
    const doc = this.host.document;
    const card = doc.createElement("div");
    card.className = inverted ? "lsp-lp-paper ll-crop is-inverted" : "lsp-lp-paper ll-crop";
    const img = card.appendChild(doc.createElement("img"));
    img.src = image.url;
    img.width = Math.round(image.width);
    img.height = Math.round(image.height);
    img.alt = "";
    if (image.continues) {
      const more = card.appendChild(doc.createElement("div"));
      more.className = "ll-crop-continues";
      more.textContent = "Continues on the next page";
    }
    return card;
  }
}

const regionKey = (file: string, from: number, to: number, kind: CropKind) => `${kind}|${from}-${to}|${file}`;

/** `canvas` cut to its ink (non-white pixels) plus `pad` pixels, within the canvas (fragment cards too). */
export function trimToInk(canvas: HTMLCanvasElement, pad: number): HTMLCanvasElement {
  const { width, height } = canvas;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const ink = (i: number) => data[i] < INK || data[i + 1] < INK || data[i + 2] < INK;
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (!ink(row + x * 4)) continue;
      if (y < top) top = y;
      bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (bottom < 0) return canvas;
  const x0 = Math.max(0, left - pad);
  const y0 = Math.max(0, top - pad);
  const x1 = Math.min(width, right + 1 + pad);
  const y1 = Math.min(height, bottom + 1 + pad);
  if (x0 === 0 && y0 === 0 && x1 === width && y1 === height) return canvas;
  const out = canvas.ownerDocument.createElement("canvas");
  out.width = x1 - x0;
  out.height = y1 - y0;
  out.getContext("2d")?.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
  return out;
}
