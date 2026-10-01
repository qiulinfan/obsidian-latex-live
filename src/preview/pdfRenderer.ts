import { loadPdfJs } from "obsidian";
import type { PdfBox } from "../tex/synctex";
import { abortError } from "../tex/run";

// The slice of the pdf.js API (bundled with Obsidian) used here and by PDF crops.
export interface Viewport {
  width: number;
  height: number;
}
interface RenderTask {
  promise: Promise<void>;
  cancel(): void;
}
export interface PdfPage {
  /** `offsetX`/`offsetY` shift the page on the canvas (CSS pixels of this scale). */
  getViewport(p: { scale: number; offsetX?: number; offsetY?: number }): Viewport;
  render(p: {
    canvasContext: CanvasRenderingContext2D;
    canvas: HTMLCanvasElement;
    viewport: Viewport;
  }): RenderTask;
}
export interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface PdfJs {
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
  /** Generation the displayed canvas was rendered for; -1 when blank. */
  renderedGen: number;
  /** Generation currently being rendered; -1 when idle. */
  renderingGen: number;
  task: RenderTask | null;
}

export interface PdfPoint {
  page: number;
  x: number;
  y: number;
}

const PAGE_GAP = 12;
const PADDING = 12;
/** Rendered canvases kept alive; offscreen ones beyond this are dropped. */
const MAX_RENDERED = 10;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;

/**
 * Renders a PDF into a scrollable stack of page canvases. Reloads keep the
 * scroll position and swap each page's canvas only once its new rendering
 * is complete, so recompiles do not flicker. Pages render lazily when near
 * the viewport.
 */
export class PdfRenderer {
  readonly scrollEl: HTMLDivElement;
  private pagesEl: HTMLDivElement;
  private emptyEl: HTMLDivElement;
  private doc: PdfDoc | null = null;
  private sizes: { w: number; h: number }[] = [];
  private slots: Slot[] = [];
  private visible = new Set<number>();
  private gen = 0;
  private loadSeq = 0;
  private zoom: number | "fit" = "fit";
  private scale = 1;
  private lastWidth = 0;
  private observer: IntersectionObserver;
  private resizeObserver: ResizeObserver;
  private resizeTimer: number | null = null;

  constructor(parent: HTMLElement) {
    this.scrollEl = parent.createDiv({ cls: "ll-scroll" });
    this.emptyEl = this.scrollEl.createDiv({ cls: "ll-empty" });
    this.pagesEl = this.scrollEl.createDiv({ cls: "ll-pages" });
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.index);
          if (e.isIntersecting) this.visible.add(idx);
          else this.visible.delete(idx);
        }
        this.renderVisible();
      },
      { root: this.scrollEl, rootMargin: "50% 0px" },
    );
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        this.resizeTimer = null;
        const w = this.scrollEl.clientWidth;
        if (this.zoom === "fit" && w !== this.lastWidth) this.relayout();
      }, 80);
    });
    this.resizeObserver.observe(this.scrollEl);
    this.setEmpty("No PDF yet.");
  }

  get hasDocument(): boolean {
    return this.doc !== null;
  }

  setEmpty(message: string | null): void {
    this.emptyEl.toggleClass("is-hidden", message === null);
    this.emptyEl.setText(message ?? "");
  }

  /** Show a new PDF. The data buffer is transferred to pdf.js. */
  async load(data: Uint8Array): Promise<void> {
    const seq = ++this.loadSeq;
    const pdfjs = (await loadPdfJs()) as PdfJs;
    const doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      ...PDFJS_ASSETS,
    }).promise;
    const first = await doc.getPage(1);
    if (seq !== this.loadSeq) {
      void doc.destroy();
      return;
    }
    const vp = first.getViewport({ scale: 1 });
    // Assume uniform pages; renderSlot corrects any page that differs.
    const sizes = Array.from({ length: doc.numPages }, (_, i) =>
      this.sizes[i] && this.doc ? this.sizes[i] : { w: vp.width, h: vp.height },
    );
    sizes[0] = { w: vp.width, h: vp.height };

    for (const slot of this.slots) slot.task?.cancel();
    const old = this.doc;
    this.doc = doc;
    this.sizes = sizes;
    this.gen++;
    this.setEmpty(null);
    this.layout();
    this.renderVisible();
    void old?.destroy();
  }

  /** Drop the current document (e.g. when switching to another root). */
  clear(message: string): void {
    this.loadSeq++;
    for (const slot of this.slots) {
      slot.task?.cancel();
      this.observer.unobserve(slot.el);
      slot.el.remove();
    }
    this.slots = [];
    this.visible.clear();
    this.sizes = [];
    void this.doc?.destroy();
    this.doc = null;
    this.gen++;
    this.scrollEl.scrollTop = 0;
    this.setEmpty(message);
  }

  zoomIn(): void {
    this.setZoom(this.scale * 1.2);
  }

  zoomOut(): void {
    this.setZoom(this.scale / 1.2);
  }

  fitWidth(): void {
    this.setZoom("fit");
  }

  setInverted(on: boolean): void {
    this.scrollEl.toggleClass("ll-invert", on);
  }

  /** Map a mouse event on a page to PDF points from the page's top-left. */
  pointFromEvent(ev: MouseEvent): PdfPoint | null {
    const pageEl = (ev.target as HTMLElement | null)?.closest?.(".ll-page");
    if (!(pageEl instanceof HTMLElement)) return null;
    const idx = Number(pageEl.dataset.index);
    const rect = pageEl.getBoundingClientRect();
    return {
      page: idx + 1,
      x: (ev.clientX - rect.left) / this.scale,
      y: (ev.clientY - rect.top) / this.scale,
    };
  }

  /** Scroll a SyncTeX box into view and flash it. */
  reveal(box: PdfBox, onlyIfHidden: boolean): void {
    const slot = this.slots[box.page - 1];
    if (!slot) return;
    const scrollRect = this.scrollEl.getBoundingClientRect();
    const pageTop =
      slot.el.getBoundingClientRect().top - scrollRect.top + this.scrollEl.scrollTop;
    const top = pageTop + box.y * this.scale;
    const bottom = top + Math.max(box.height, 10) * this.scale;
    const viewTop = this.scrollEl.scrollTop;
    const viewBottom = viewTop + this.scrollEl.clientHeight;
    const margin = this.scrollEl.clientHeight * 0.1;
    const hidden = top < viewTop + margin || bottom > viewBottom - margin;
    if (hidden || !onlyIfHidden) {
      this.scrollEl.scrollTo({
        top: Math.max(0, top - this.scrollEl.clientHeight / 3),
        behavior: onlyIfHidden ? "auto" : "smooth",
      });
    }
    if (onlyIfHidden && !hidden) return;
    const mark = slot.el.createDiv({ cls: "ll-sync-mark" });
    mark.style.left = `${Math.max(0, box.x - 2) * this.scale}px`;
    mark.style.top = `${Math.max(0, box.y - 2) * this.scale}px`;
    mark.style.width = `${Math.max(box.width + 4, 24) * this.scale}px`;
    mark.style.height = `${Math.max(box.height + 4, 12) * this.scale}px`;
    window.setTimeout(() => mark.remove(), 1500);
  }

  destroy(): void {
    this.loadSeq++;
    for (const slot of this.slots) slot.task?.cancel();
    this.observer.disconnect();
    this.resizeObserver.disconnect();
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    void this.doc?.destroy();
    this.doc = null;
    this.slots = [];
  }

  private setZoom(zoom: number | "fit"): void {
    this.zoom =
      zoom === "fit" ? "fit" : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    this.relayout();
  }

  /** Re-scale after a zoom or width change, keeping the view centered. */
  private relayout(): void {
    if (!this.doc) return;
    const el = this.scrollEl;
    const anchor =
      el.scrollHeight > 0 ? (el.scrollTop + el.clientHeight / 2) / el.scrollHeight : 0;
    this.gen++;
    this.layout();
    el.scrollTop = anchor * el.scrollHeight - el.clientHeight / 2;
    this.renderVisible();
  }

  private layout(): void {
    this.lastWidth = this.scrollEl.clientWidth;
    const maxW = Math.max(...this.sizes.map((s) => s.w), 1);
    this.scale =
      this.zoom === "fit"
        ? Math.max(MIN_ZOOM, (this.lastWidth - 2 * PADDING) / maxW)
        : this.zoom;
    this.pagesEl.style.padding = `${PADDING}px`;
    this.pagesEl.style.gap = `${PAGE_GAP}px`;

    while (this.slots.length > this.sizes.length) {
      const slot = this.slots.pop()!;
      slot.task?.cancel();
      this.observer.unobserve(slot.el);
      this.visible.delete(this.slots.length);
      slot.el.remove();
    }
    while (this.slots.length < this.sizes.length) {
      const el = this.pagesEl.createDiv({ cls: "ll-page" });
      el.dataset.index = String(this.slots.length);
      this.slots.push({
        el,
        canvas: null,
        renderedGen: -1,
        renderingGen: -1,
        task: null,
      });
      this.observer.observe(el);
    }
    this.sizes.forEach((s, i) => this.sizeSlot(i, s));
  }

  private sizeSlot(i: number, s: { w: number; h: number }): void {
    const el = this.slots[i].el;
    el.style.width = `${Math.floor(s.w * this.scale)}px`;
    el.style.height = `${Math.floor(s.h * this.scale)}px`;
  }

  private renderVisible(): void {
    for (const idx of this.visible) {
      const slot = this.slots[idx];
      if (slot && slot.renderedGen !== this.gen && slot.renderingGen !== this.gen) {
        void this.renderSlot(idx);
      }
    }
  }

  private async renderSlot(idx: number): Promise<void> {
    const doc = this.doc;
    const slot = this.slots[idx];
    if (!doc || !slot) return;
    const gen = this.gen;
    slot.renderingGen = gen;
    let task: RenderTask | null = null;
    try {
      const page = await doc.getPage(idx + 1);
      if (gen !== this.gen) return;
      const base = page.getViewport({ scale: 1 });
      const size = this.sizes[idx];
      if (Math.abs(base.width - size.w) > 0.5 || Math.abs(base.height - size.h) > 0.5) {
        this.sizes[idx] = { w: base.width, h: base.height };
        this.sizeSlot(idx, this.sizes[idx]);
      }
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: this.scale * dpr });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return;
      task = page.render({ canvasContext: ctx, canvas, viewport });
      slot.task = task;
      await task.promise;
      if (gen !== this.gen) return;
      // Swap only a finished rendering in: no blank frame between compiles.
      if (slot.canvas) slot.canvas.replaceWith(canvas);
      else slot.el.prepend(canvas);
      slot.canvas = canvas;
      slot.renderedGen = gen;
      this.evictOffscreen();
    } catch {
      // Cancelled by a newer document or zoom level.
    } finally {
      if (slot.task === task) slot.task = null;
      if (slot.renderingGen === gen) slot.renderingGen = -1;
    }
  }

  /** Free canvases of pages far from view to bound memory. */
  private evictOffscreen(): void {
    const rendered = this.slots
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.canvas !== null);
    if (rendered.length <= MAX_RENDERED) return;
    const vis = [...this.visible];
    const center = vis.length ? vis.reduce((a, b) => a + b, 0) / vis.length : 0;
    rendered
      .filter(({ i }) => !this.visible.has(i))
      .sort((a, b) => Math.abs(b.i - center) - Math.abs(a.i - center))
      .slice(0, rendered.length - MAX_RENDERED)
      .forEach(({ s }) => {
        s.canvas?.remove();
        s.canvas = null;
        s.renderedGen = -1;
      });
  }
}
