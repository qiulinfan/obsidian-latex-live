import { loadPdfJs } from "obsidian";
import type { PdfBox } from "../tex/synctex";
import { abortError } from "../tex/run";
import { externalPdfUrl, openPdfExternal } from "./pdfReading";

// The slice of the pdf.js API (bundled with Obsidian) used here and by PDF crops.
export interface Viewport {
  width: number;
  height: number;
  convertToViewportRectangle?(rect: number[]): number[];
  convertToViewportPoint?(x: number, y: number): number[];
}
interface RenderTask {
  promise: Promise<void>;
  cancel(): void;
}
export interface PdfPage {
  /** `offsetX`/`offsetY` shift the page on the canvas (CSS pixels of this scale). */
  getViewport(p: { scale: number; offsetX?: number; offsetY?: number }): Viewport;
  getTextContent?(): Promise<unknown>;
  getAnnotations?(options?: { intent: string }): Promise<PdfLink[]>;
  render(p: {
    canvasContext: CanvasRenderingContext2D;
    canvas: HTMLCanvasElement;
    viewport: Viewport;
  }): RenderTask;
}
export interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  getDestination?(name: string): Promise<unknown[] | null>;
  getPageIndex?(ref: unknown): Promise<number>;
  destroy(): Promise<void>;
}
interface PdfLink {
  subtype?: string;
  annotationType?: number;
  rect?: number[];
  url?: string;
  dest?: unknown[] | string;
  action?: string;
}
interface TextLayerTask {
  render(): Promise<void>;
  cancel(): void;
  update(options: { viewport: Viewport }): void;
}
interface PdfJs {
  TextLayer?: new (options: { textContentSource: unknown; container: HTMLElement; viewport: Viewport }) => TextLayerTask;
  getDocument(src: {
    data: Uint8Array;
    isEvalSupported?: boolean;
    cMapUrl?: string;
    cMapPacked?: boolean;
    standardFontDataUrl?: string;
    wasmUrl?: string;
    iccUrl?: string;
  }): {
    promise: Promise<PdfDoc>;
    destroy(): Promise<void>;
  };
}

/**
 * Where Obsidian serves its pdf.js assets, as its own PDF viewer passes them
 * (app.js; the folders are in obsidian.asar under lib/pdfjs). Without the
 * CMaps, the Chinese glyphs of XeLaTeX PDFs (ctex, Fandol) are not drawn.
 */
export const PDFJS_ASSETS = {
  cMapUrl: "/lib/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/lib/pdfjs/standard_fonts/",
  wasmUrl: "/lib/pdfjs/wasm/",
  iccUrl: "/lib/pdfjs/iccs/",
};

/** pdf.js draws PDF points at this many CSS pixels each (96 / 72). */
const CSS_PER_PT = 4 / 3;

/** A PDF document for crops, through Obsidian's pdf.js with its assets. The data buffer is transferred (pass a copy). */
export async function openPdf(data: Uint8Array): Promise<PdfDoc> {
  const pdfjs = (await loadPdfJs()) as PdfJs;
  return pdfjs.getDocument({ data, isEvalSupported: false, ...PDFJS_ASSETS }).promise;
}

/**
 * The first page of a PDF (an \includegraphics figure in live preview) as a PNG data URL, at
 * its size in CSS pixels, scaled down to at most `maxHeight`, drawn for `dpr`: the image's URL
 * and its display width. The data buffer is transferred to pdf.js (pass a copy).
 */
export async function pdfPageImage(data: Uint8Array, maxHeight: number, dpr: number): Promise<{ url: string; width: number }> {
  const pdfjs = (await loadPdfJs()) as PdfJs;
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, ...PDFJS_ASSETS }).promise;
  try {
    const page = await doc.getPage(1);
    const css = page.getViewport({ scale: CSS_PER_PT });
    const fit = Math.min(1, maxHeight / css.height);
    const viewport = page.getViewport({ scale: CSS_PER_PT * fit * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas to draw the PDF on.");
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    return { url: canvas.toDataURL("image/png"), width: css.width * fit };
  } finally {
    void doc.destroy();
  }
}

/**
 * Pages of a PDF (the HTML export's images, `\includepdf`) as PNG bytes drawn at `scale` times
 * their CSS size: `want` picks the pages from the page count. Each comes with its size in PDF
 * points. The data buffer is transferred to pdf.js (pass a copy). Cancellation stops the
 * loading/render task and rejects without waiting for pending page or encoding promises.
 */
export async function pdfPagePngs(
  data: Uint8Array,
  want: (count: number) => number[],
  scale: number,
  signal?: AbortSignal,
): Promise<{ page: number; png: Uint8Array; width: number; height: number }[]> {
  if (signal?.aborted) throw abortError("The export was cancelled.");
  let loading: ReturnType<PdfJs["getDocument"]> | null = null;
  let rendering: RenderTask | null = null;
  let destroyed = false;
  const destroy = () => {
    if (loading && !destroyed) {
      destroyed = true;
      void loading.destroy().catch(() => undefined);
    }
  };
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      rendering?.cancel();
      destroy();
      reject(abortError("The export was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, cancelled]);
  try {
    const pdfjs = (await wait(loadPdfJs())) as PdfJs;
    if (signal?.aborted) throw abortError("The export was cancelled.");
    loading = pdfjs.getDocument({ data, isEvalSupported: false, ...PDFJS_ASSETS });
    const doc = await wait(loading.promise);
    const out: { page: number; png: Uint8Array; width: number; height: number }[] = [];
    for (const n of want(doc.numPages)) {
      if (signal?.aborted) throw abortError("The export was cancelled.");
      const page = await wait(doc.getPage(n));
      if (signal?.aborted) throw abortError("The export was cancelled.");
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: CSS_PER_PT * scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No canvas to draw the PDF on.");
      rendering = page.render({ canvasContext: ctx, canvas, viewport });
      await wait(rendering.promise);
      rendering = null;
      const blob = await wait(new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")));
      if (!blob) throw new Error(`Page ${n} could not be encoded.`);
      out.push({ page: n, png: new Uint8Array(await wait(blob.arrayBuffer())), width: size.width, height: size.height });
    }
    return out;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    destroy();
  }
}

interface Slot {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  text: HTMLDivElement | null;
  textTask: TextLayerTask | null;
  links: HTMLDivElement | null;
  page: PdfPage | null;
  renderedDoc: number;
  renderedGen: number;
  renderingGen: number;
  task: RenderTask | null;
  pendingText: TextLayerTask | null;
  failedGen: number;
}

export interface PdfPoint { page: number; x: number; y: number }
export interface PdfReadingStatus { page: number; pages: number; scale: number; fit: boolean }
export interface PdfReadingOptions {
  onStatus?(status: PdfReadingStatus): void;
  openExternal?(url: string): Promise<void>;
}
interface Anchor { page: number; x: number; y: number; clientX: number; clientY: number }
const PAGE_GAP = 12;
const PADDING = 12;
const MAX_RENDERED = 10;
const MAX_RENDERING = 2;
const MAX_CANVAS_PIXELS = 8_000_000;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;

/** Lazy canvas, selectable text and link layers; all three are evicted together. */
export class PdfRenderer {
  readonly scrollEl: HTMLDivElement;
  private pagesEl: HTMLDivElement;
  private emptyEl: HTMLDivElement;
  private win: Window & typeof globalThis;
  private pdfjs: PdfJs | null = null;
  private doc: PdfDoc | null = null;
  private loading: ReturnType<PdfJs["getDocument"]> | null = null;
  private sizes: { w: number; h: number }[] = [];
  private tops: number[] = [];
  private slots: Slot[] = [];
  private visible = new Set<number>();
  private gen = 0;
  private docGen = 0;
  private loadSeq = 0;
  private disposed = false;
  private zoom: number | "fit" = "fit";
  private scale = 1;
  private lastWidth = 0;
  private observer: IntersectionObserver;
  private resizeObserver: ResizeObserver;
  private resolutionQuery: MediaQueryList | null = null;
  private resizeTimer: number | null = null;
  private renderTimer: number | null = null;
  private frame: number | null = null;
  private pendingZoom: { scale: number; x: number; y: number } | null = null;
  private inFlight = 0;
  private lastStatus = "";

  constructor(parent: HTMLElement, private options: PdfReadingOptions = {}) {
    this.win = parent.ownerDocument.defaultView as Window & typeof globalThis;
    this.scrollEl = parent.createDiv({ cls: "ll-scroll" });
    this.scrollEl.tabIndex = 0;
    this.scrollEl.setAttribute("aria-label", "PDF preview");
    this.emptyEl = this.scrollEl.createDiv({ cls: "ll-empty" });
    this.pagesEl = this.scrollEl.createDiv({ cls: "ll-pages" });
    this.observer = new this.win.IntersectionObserver((entries) => {
      for (const e of entries) {
        const idx = Number((e.target as HTMLElement).dataset.index);
        if (e.isIntersecting) this.visible.add(idx);
        else this.visible.delete(idx);
      }
      this.renderVisible();
    }, { root: this.scrollEl, rootMargin: "50% 0px" });
    this.resizeObserver = new this.win.ResizeObserver(() => {
      if (this.resizeTimer !== null) this.win.clearTimeout(this.resizeTimer);
      this.resizeTimer = this.win.setTimeout(() => {
        this.resizeTimer = null;
        if (this.zoom === "fit" && this.scrollEl.clientWidth !== this.lastWidth) this.relayout();
      }, 80);
    });
    this.resizeObserver.observe(this.scrollEl);
    this.watchResolution();
    this.scrollEl.addEventListener("wheel", this.onWheel, { passive: false });
    this.scrollEl.addEventListener("scroll", this.onScroll, { passive: true });
    this.setEmpty("No PDF yet.");
    this.notifyStatus();
  }

  get hasDocument(): boolean { return this.doc !== null; }
  get status(): PdfReadingStatus {
    return { page: this.doc ? this.pageAt(this.scrollEl.scrollTop + this.scrollEl.clientHeight * 0.3) + 1 : 0,
      pages: this.sizes.length, scale: this.scale, fit: this.zoom === "fit" };
  }
  setEmpty(message: string | null): void {
    this.emptyEl.toggleClass("is-hidden", message === null);
    this.emptyEl.setText(message ?? "");
  }

  /** Keep the last document on a load failure; kill superseded loads and ignore all stale results. */
  async load(data: Uint8Array): Promise<void> {
    if (this.disposed) return;
    const seq = ++this.loadSeq;
    this.cancelLoading();
    let loading: ReturnType<PdfJs["getDocument"]> | null = null;
    let doc: PdfDoc | null = null;
    try {
      const pdfjs = (await loadPdfJs()) as PdfJs;
      if (seq !== this.loadSeq || this.disposed) return;
      this.pdfjs = pdfjs;
      loading = pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, ...PDFJS_ASSETS });
      this.loading = loading;
      doc = await loading.promise;
      if (seq !== this.loadSeq || this.disposed) return;
      const first = await doc.getPage(1);
      if (seq !== this.loadSeq || this.disposed) return;
      const vp = first.getViewport({ scale: 1 });
      const sizes = Array.from({ length: doc.numPages }, (_, i) =>
        this.doc && this.sizes[i] ? this.sizes[i] : { w: vp.width, h: vp.height });
      sizes[0] = { w: vp.width, h: vp.height };
      this.cancelRenders();
      const old = this.doc;
      this.doc = doc;
      doc = null;
      this.loading = null;
      this.sizes = sizes;
      this.docGen++;
      this.gen++;
      this.setEmpty(null);
      this.layout();
      this.renderVisible();
      this.notifyStatus();
      void old?.destroy().catch(() => undefined);
    } catch (error) {
      void loading?.destroy().catch(() => undefined);
      if (seq === this.loadSeq && !this.disposed && !this.doc) this.setEmpty(`Could not open PDF: ${String(error)}`);
    } finally {
      if (doc) void doc.destroy().catch(() => undefined);
      if (this.loading === loading) this.loading = null;
    }
  }

  clear(message: string): void {
    this.loadSeq++;
    this.cancelLoading();
    this.cancelRenders();
    this.cancelScheduled();
    for (const slot of this.slots) { this.dropSlot(slot); this.observer.unobserve(slot.el); slot.el.remove(); }
    this.slots = [];
    this.visible.clear();
    this.sizes = [];
    this.tops = [];
    void this.doc?.destroy().catch(() => undefined);
    this.doc = null;
    this.docGen++;
    this.gen++;
    this.scrollEl.scrollTop = this.scrollEl.scrollLeft = 0;
    this.setEmpty(message);
    this.notifyStatus();
  }

  zoomIn(): void { this.setZoom(this.scale * 1.2); }
  zoomOut(): void { this.setZoom(this.scale / 1.2); }
  fitWidth(): void { this.setZoom("fit"); }
  setInverted(on: boolean): void { this.scrollEl.toggleClass("ll-invert", on); }

  goToPage(number: number): void {
    if (!this.doc || !Number.isFinite(number)) return;
    const idx = Math.max(0, Math.min(this.slots.length - 1, Math.round(number) - 1));
    this.scrollEl.scrollTop = this.tops[idx] - PADDING;
    this.visible.add(idx);
    this.renderVisible();
    this.notifyStatus();
  }

  /** Link double-clicks stay links; text/canvas double-clicks retain SyncTeX. */
  pointFromEvent(ev: MouseEvent): PdfPoint | null {
    const target = ev.target as Element | null;
    if (target?.closest?.(".ll-pdf-link")) return null;
    const pageEl = target?.closest?.(".ll-page") as HTMLElement | null;
    if (!pageEl || !this.pagesEl.contains(pageEl)) return null;
    const idx = Number(pageEl.dataset.index);
    const rect = pageEl.getBoundingClientRect();
    return { page: idx + 1, x: (ev.clientX - rect.left) / this.scale, y: (ev.clientY - rect.top) / this.scale };
  }

  reveal(box: PdfBox, onlyIfHidden: boolean): void {
    const slot = this.slots[box.page - 1];
    if (!slot) return;
    const top = this.tops[box.page - 1] + box.y * this.scale;
    const bottom = top + Math.max(box.height, 10) * this.scale;
    const margin = this.scrollEl.clientHeight * 0.1;
    const hidden = top < this.scrollEl.scrollTop + margin || bottom > this.scrollEl.scrollTop + this.scrollEl.clientHeight - margin;
    if (hidden || !onlyIfHidden) this.scrollEl.scrollTo({
      top: Math.max(0, top - this.scrollEl.clientHeight / 3), behavior: onlyIfHidden ? "auto" : "smooth" });
    if (onlyIfHidden && !hidden) return;
    const mark = slot.el.createDiv({ cls: "ll-sync-mark" });
    mark.style.left = `${Math.max(0, box.x - 2) * this.scale}px`;
    mark.style.top = `${Math.max(0, box.y - 2) * this.scale}px`;
    mark.style.width = `${Math.max(box.width + 4, 24) * this.scale}px`;
    mark.style.height = `${Math.max(box.height + 4, 12) * this.scale}px`;
    this.win.setTimeout(() => mark.remove(), 1500);
  }

  destroy(): void {
    if (this.disposed) return;
    this.clear("No PDF yet.");
    this.disposed = true;
    this.observer.disconnect();
    this.resizeObserver.disconnect();
    this.resolutionQuery?.removeEventListener("change", this.onResolutionChange);
    this.resolutionQuery = null;
    if (this.resizeTimer !== null) this.win.clearTimeout(this.resizeTimer);
    this.scrollEl.removeEventListener("wheel", this.onWheel);
    this.scrollEl.removeEventListener("scroll", this.onScroll);
  }

  private watchResolution(): void {
    this.resolutionQuery?.removeEventListener("change", this.onResolutionChange);
    this.resolutionQuery = this.win.matchMedia?.(`(resolution: ${this.win.devicePixelRatio || 1}dppx)`) ?? null;
    this.resolutionQuery?.addEventListener("change", this.onResolutionChange);
  }
  private onResolutionChange = (): void => {
    if (this.disposed) return;
    this.watchResolution();
    // A move between Retina/external displays need not change the pane's CSS width.
    // Refresh backing pixels without moving the page, reloading the PDF or rebuilding text.
    this.cancelRenders();
    this.gen++;
    this.renderVisible();
  };

  private onWheel = (event: WheelEvent): void => {
    // Chromium/macOS delivers trackpad pinch as a ctrl-wheel. Ordinary scrolling is untouched.
    if (!event.ctrlKey || !this.doc) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.scrollEl.clientHeight : 1);
    const base = this.pendingZoom?.scale ?? this.scale;
    this.pendingZoom = { scale: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, base * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.005))),
      x: event.clientX, y: event.clientY };
    this.scheduleFrame();
  };
  private onScroll = (): void => { this.scheduleFrame(); };
  private scheduleFrame(): void {
    if (this.frame !== null) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = null;
      const zoom = this.pendingZoom;
      this.pendingZoom = null;
      if (zoom) this.setZoom(zoom.scale, zoom.x, zoom.y, true);
      this.notifyStatus();
    });
  }
  private setZoom(zoom: number | "fit", x?: number, y?: number, defer = false): void {
    this.zoom = zoom === "fit" ? zoom : Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    this.relayout(x, y, defer);
  }
  private anchor(x?: number, y?: number): Anchor {
    const scroll = this.scrollEl.getBoundingClientRect();
    const clientX = x ?? scroll.left + this.scrollEl.clientWidth / 2;
    const clientY = y ?? scroll.top + this.scrollEl.clientHeight / 2;
    const page = this.pageAt(this.scrollEl.scrollTop + clientY - scroll.top);
    const rect = this.slots[page].el.getBoundingClientRect();
    return { page, x: (clientX - rect.left) / this.scale, y: (clientY - rect.top) / this.scale,
      clientX: clientX - scroll.left, clientY: clientY - scroll.top };
  }
  private relayout(x?: number, y?: number, defer = false): void {
    if (!this.doc) return;
    const anchor = this.anchor(x, y);
    this.cancelRenders();
    this.gen++;
    this.layout();
    const scroll = this.scrollEl.getBoundingClientRect();
    const page = this.slots[anchor.page].el.getBoundingClientRect();
    this.scrollEl.scrollLeft += page.left - scroll.left + anchor.x * this.scale - anchor.clientX;
    this.scrollEl.scrollTop = this.tops[anchor.page] + anchor.y * this.scale - anchor.clientY;
    if (this.renderTimer !== null) this.win.clearTimeout(this.renderTimer);
    if (defer) this.renderTimer = this.win.setTimeout(() => { this.renderTimer = null; this.renderVisible(); }, 140);
    else { this.renderTimer = null; this.renderVisible(); }
    this.notifyStatus();
  }
  private layout(): void {
    this.lastWidth = this.scrollEl.clientWidth;
    const maxW = Math.max(...this.sizes.map((s) => s.w), 1);
    this.scale = this.zoom === "fit" ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (this.lastWidth - 2 * PADDING) / maxW)) : this.zoom;
    this.pagesEl.style.padding = `${PADDING}px`;
    this.pagesEl.style.gap = `${PAGE_GAP}px`;
    while (this.slots.length > this.sizes.length) {
      const slot = this.slots.pop()!;
      this.dropSlot(slot); this.observer.unobserve(slot.el); this.visible.delete(this.slots.length); slot.el.remove();
    }
    while (this.slots.length < this.sizes.length) {
      const el = this.pagesEl.createDiv({ cls: "ll-page" });
      el.dataset.index = String(this.slots.length);
      this.slots.push({ el, canvas: null, text: null, textTask: null, links: null, page: null,
        renderedDoc: -1, renderedGen: -1, renderingGen: -1, task: null, pendingText: null, failedGen: -1 });
      this.observer.observe(el);
    }
    let top = PADDING;
    this.tops = this.sizes.map((size, index) => { const at = top; top += size.h * this.scale + PAGE_GAP; this.sizeSlot(index, size); return at; });
  }
  private sizeSlot(idx: number, size: { w: number; h: number }): void {
    const slot = this.slots[idx];
    slot.el.style.width = `${Math.floor(size.w * this.scale)}px`;
    slot.el.style.height = `${Math.floor(size.h * this.scale)}px`;
    // pdf.js TextLayer consumes these variables; original glyph geometry stays its responsibility.
    slot.el.setCssProps({
      "--total-scale-factor": String(this.scale),
      "--scale-round-x": "1px",
      "--scale-round-y": "1px",
    });
    // CSS rescales existing glyph positions during a gesture. Font measurement is deferred
    // until the final canvas lands, rather than repeating it for every cached page per wheel.
  }
  private pageAt(y: number): number {
    let low = 0, high = Math.max(0, this.tops.length - 1);
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (this.tops[middle] <= y) low = middle; else high = middle - 1; }
    return low;
  }
  private notifyStatus(): void {
    const status = this.status;
    const key = `${status.page}|${status.pages}|${status.scale}|${status.fit}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.options.onStatus?.(status);
  }
  private renderVisible(): void {
    if (!this.doc || this.renderTimer !== null || this.disposed) return;
    const center = this.pageAt(this.scrollEl.scrollTop + this.scrollEl.clientHeight / 2);
    const wanted = [...this.visible].filter((idx) => this.slots[idx]).sort((a, b) => Math.abs(a - center) - Math.abs(b - center)).slice(0, MAX_RENDERED);
    for (const idx of wanted) {
      if (this.inFlight >= MAX_RENDERING) break;
      const slot = this.slots[idx];
      if (slot.renderedGen !== this.gen && slot.renderingGen !== this.gen && slot.failedGen !== this.gen) void this.renderSlot(idx);
    }
    this.evictOffscreen(new Set(wanted));
  }
  private async renderSlot(idx: number): Promise<void> {
    const doc = this.doc, pdfjs = this.pdfjs, slot = this.slots[idx];
    if (!doc || !pdfjs || !slot) return;
    const gen = this.gen, docGen = this.docGen;
    slot.renderingGen = gen;
    this.inFlight++;
    let task: RenderTask | null = null, textTask: TextLayerTask | null = null;
    const current = () => gen === this.gen && doc === this.doc && !this.disposed && this.slots[idx] === slot;
    try {
      const page = slot.renderedDoc === docGen && slot.page ? slot.page : await doc.getPage(idx + 1);
      if (!current()) return;
      const base = page.getViewport({ scale: 1 });
      const size = this.sizes[idx];
      if (Math.abs(base.width - size.w) > 0.5 || Math.abs(base.height - size.h) > 0.5) {
        this.sizes[idx] = { w: base.width, h: base.height }; this.layout();
      }
      const css = page.getViewport({ scale: this.scale });
      const dpr = Math.min(this.win.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (css.width * css.height)));
      const viewport = page.getViewport({ scale: this.scale * dpr });
      const canvas = this.scrollEl.ownerDocument.createElement("canvas");
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("No canvas to draw the PDF on.");
      task = page.render({ canvasContext: ctx, canvas, viewport }); slot.task = task;
      void task.promise.catch(() => undefined);
      const reuse = slot.renderedDoc === docGen;
      let text: HTMLDivElement | null = null, links: HTMLDivElement | null = null;
      if (!reuse && page.getTextContent && pdfjs.TextLayer) {
        const content = await page.getTextContent();
        if (!current()) return;
        text = this.scrollEl.ownerDocument.createElement("div"); text.className = "ll-pdf-text textLayer";
        textTask = new pdfjs.TextLayer({ textContentSource: content, container: text, viewport: css });
        slot.pendingText = textTask;
        // The off-DOM layer inherits none of the page's variables until it is committed.
        text.setCssProps({
          "--total-scale-factor": String(this.scale),
          "--scale-round-x": "1px",
          "--scale-round-y": "1px",
        });
        await textTask.render();
      }
      if (!reuse && page.getAnnotations) {
        const annotations = await page.getAnnotations({ intent: "display" });
        if (!current()) return;
        links = this.createLinks(annotations, base, doc, docGen);
      }
      await task.promise;
      if (!current()) return;
      if (reuse) slot.textTask?.update({ viewport: css });
      if (slot.canvas) slot.canvas.replaceWith(canvas); else slot.el.prepend(canvas);
      slot.canvas = canvas;
      if (!reuse) {
        slot.textTask?.cancel(); slot.text?.remove(); slot.links?.remove();
        slot.text = text; slot.textTask = textTask; slot.links = links;
        if (text) {
          slot.el.append(text);
          text.style.removeProperty("--total-scale-factor");
          text.style.removeProperty("--scale-round-x"); text.style.removeProperty("--scale-round-y");
        }
        if (links) slot.el.append(links);
        textTask = null;
      }
      slot.page = page; slot.renderedDoc = docGen; slot.renderedGen = gen;
    } catch (error) {
      if (current()) { slot.failedGen = gen; console.warn(`LaTeX Live: could not render PDF page ${idx + 1}`, error); }
      // A superseded render cannot replace the last successful page.
    }
    finally {
      // Observe rejections immediately even if an awaited text/annotation operation fails first.
      void task?.promise.catch(() => undefined);
      textTask?.cancel();
      if (slot.pendingText === textTask || slot.renderedGen === gen) slot.pendingText = null;
      if (slot.task === task) slot.task = null;
      if (slot.renderingGen === gen) slot.renderingGen = -1;
      this.inFlight--;
      this.renderVisible();
    }
  }
  private createLinks(annotations: PdfLink[], viewport: Viewport, doc: PdfDoc, docGen: number): HTMLDivElement {
    const layer = this.scrollEl.ownerDocument.createElement("div"); layer.className = "ll-pdf-links";
    for (const annotation of annotations) {
      if (annotation.subtype !== "Link" && annotation.annotationType !== 2) continue;
      if (!annotation.rect || annotation.rect.length !== 4 || !viewport.convertToViewportRectangle) continue;
      const rect = viewport.convertToViewportRectangle(annotation.rect);
      if (!rect.every(Number.isFinite)) continue;
      const left = Math.max(0, Math.min(viewport.width, Math.min(rect[0], rect[2])));
      const top = Math.max(0, Math.min(viewport.height, Math.min(rect[1], rect[3])));
      const right = Math.max(0, Math.min(viewport.width, Math.max(rect[0], rect[2])));
      const bottom = Math.max(0, Math.min(viewport.height, Math.max(rect[1], rect[3])));
      if (right <= left || bottom <= top) continue;
      const url = externalPdfUrl(annotation.url);
      const internal = annotation.dest || ["NextPage", "PrevPage", "FirstPage", "LastPage"].includes(annotation.action ?? "");
      if (!url && !internal) continue;
      const link = this.scrollEl.ownerDocument.createElement("a");
      link.className = "ll-pdf-link";
      link.href = url ?? "#";
      link.setAttribute("aria-label", url ?? "Go to PDF destination");
      if (url) { link.title = url; link.rel = "noopener noreferrer"; }
      link.style.left = `${left / viewport.width * 100}%`;
      link.style.top = `${top / viewport.height * 100}%`;
      link.style.width = `${(right - left) / viewport.width * 100}%`;
      link.style.height = `${(bottom - top) / viewport.height * 100}%`;
      link.addEventListener("click", (event) => {
        event.preventDefault(); event.stopPropagation();
        if (doc !== this.doc || docGen !== this.docGen || this.disposed) return;
        if (url) void (this.options.openExternal ?? openPdfExternal)(url).catch(() => undefined);
        else void this.followDestination(annotation, doc, docGen).catch(() => undefined);
      });
      link.addEventListener("dblclick", (event) => event.stopPropagation());
      layer.append(link);
    }
    return layer;
  }
  private async followDestination(annotation: PdfLink, doc: PdfDoc, docGen: number): Promise<void> {
    if (annotation.action) {
      const page = this.status.page;
      this.goToPage(annotation.action === "FirstPage" ? 1 : annotation.action === "LastPage" ? doc.numPages : annotation.action === "NextPage" ? page + 1 : page - 1);
      return;
    }
    const dest = typeof annotation.dest === "string" ? await doc.getDestination?.(annotation.dest) : annotation.dest;
    if (!Array.isArray(dest)) return;
    const idx = typeof dest[0] === "number" ? dest[0] : await doc.getPageIndex?.(dest[0]);
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= doc.numPages || doc !== this.doc || docGen !== this.docGen || this.disposed) return;
    const page = await doc.getPage(idx + 1);
    if (doc !== this.doc || docGen !== this.docGen || this.disposed) return;
    const type = (dest[1] as { name?: string } | undefined)?.name;
    let y = 0;
    const viewport = page.getViewport({ scale: 1 });
    if (viewport.convertToViewportPoint) {
      const top = type === "XYZ" ? dest[3] : type === "FitH" || type === "FitBH" ? dest[2] : undefined;
      if (typeof top === "number") y = viewport.convertToViewportPoint(0, top)[1];
    }
    this.goToPage(idx + 1);
    this.scrollEl.scrollTop = this.tops[idx] + Math.max(0, y) * this.scale - PADDING;
    this.notifyStatus();
  }
  private evictOffscreen(wanted: Set<number>): void {
    const selection = this.scrollEl.ownerDocument.getSelection();
    const protectedPage = (slot: Slot) => !!selection && !selection.isCollapsed &&
      (slot.el.contains(selection.anchorNode) || slot.el.contains(selection.focusNode));
    const held = this.slots.filter((slot) => slot.canvas || slot.text);
    const center = this.pageAt(this.scrollEl.scrollTop + this.scrollEl.clientHeight / 2);
    held.sort((a, b) => Math.abs(Number(b.el.dataset.index) - center) - Math.abs(Number(a.el.dataset.index) - center));
    let count = held.length;
    for (const slot of held) {
      if (count <= MAX_RENDERED) break;
      if (!wanted.has(Number(slot.el.dataset.index)) && !protectedPage(slot)) { this.dropSlot(slot); count--; }
    }
  }
  private dropSlot(slot: Slot): void {
    slot.task?.cancel(); slot.pendingText?.cancel(); slot.textTask?.cancel(); slot.canvas?.remove(); slot.text?.remove(); slot.links?.remove();
    slot.task = null; slot.pendingText = null; slot.textTask = null; slot.canvas = null; slot.text = null; slot.links = null; slot.page = null;
    slot.renderedDoc = slot.renderedGen = slot.failedGen = -1;
  }
  private cancelRenders(): void { for (const slot of this.slots) { slot.task?.cancel(); slot.pendingText?.cancel(); } }
  private cancelLoading(): void { const loading = this.loading; this.loading = null; void loading?.destroy().catch(() => undefined); }
  private cancelScheduled(): void {
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    if (this.renderTimer !== null) this.win.clearTimeout(this.renderTimer);
    this.frame = this.renderTimer = null; this.pendingZoom = null;
  }
}
