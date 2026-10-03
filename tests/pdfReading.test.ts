import "./support/dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dom } from "./support/dom";
import { Notice, WorkspaceLeaf, testApp, setPdfJsForTest } from "./support/obsidian";
import { PdfRenderer, PDFJS_ASSETS } from "../src/preview/pdfRenderer";
import { LatexPreviewView } from "../src/preview/previewView";
import type LatexLivePlugin from "../src/main";
import { atomicPdfWrite, externalPdfUrl, savePdfSnapshot } from "../src/preview/pdfReading";

new Notice("");
Object.assign(dom.window.HTMLElement.prototype, { toggleClass(this: HTMLElement, cls: string, on: boolean) { this.classList.toggle(cls, on); }, removeClass(this: HTMLElement, ...cls: string[]) { this.classList.remove(...cls); } });
let observer: FakeObserver;
class FakeObserver {
  els = new Set<Element>();
  constructor(private callback: (entries: unknown[]) => void) { observer = this; }
  observe(el: Element) { this.els.add(el); }
  unobserve(el: Element) { this.els.delete(el); }
  disconnect() { this.els.clear(); }
  show(...indexes: number[]) { this.callback([...this.els].map((target) => ({ target, isIntersecting: indexes.includes(Number((target as HTMLElement).dataset.index)) }))); }
}
Object.assign(dom.window, { IntersectionObserver: FakeObserver, ResizeObserver: class { observe() {} disconnect() {} } });
const context = dom.window.HTMLCanvasElement.prototype.getContext;
dom.window.HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as typeof context;
const renderers: PdfRenderer[] = [];
afterEach(() => { renderers.splice(0).forEach((renderer) => renderer.destroy()); setPdfJsForTest(undefined); document.body.replaceChildren(); });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function defer<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(pages = 65) {
  let opens = 0, destroyed = 0, textRenders = 0;
  const got: number[] = [];
  const api = {
    TextLayer: class {
      constructor(private args: { container: HTMLElement }) {}
      async render() {
        assert.equal(this.args.container.isConnected, false, "font geometry is prepared before the text layer is attached");
        assert.equal(this.args.container.style.getPropertyValue("--scale-round-x"), "1px");
        assert.equal(this.args.container.style.getPropertyValue("--scale-round-y"), "1px");
        assert.ok(Number(this.args.container.style.getPropertyValue("--total-scale-factor")) > 0);
        textRenders++; const span = this.args.container.appendChild(document.createElement("span")); span.textContent = "Copy 中文 text";
      }
      cancel() {}
      update() {}
    },
    getDocument(src: { data: Uint8Array }) {
      opens++;
      assert.deepEqual(Object.keys(src).sort(), Object.keys({ data: 1, isEvalSupported: false, ...PDFJS_ASSETS }).sort());
      const doc = {
        numPages: pages,
        getPage: async (n: number) => {
          got.push(n);
          return {
            getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 600 * scale,
              convertToViewportRectangle: (rect: number[]) => [rect[0] * scale, (600 - rect[1]) * scale, rect[2] * scale, (600 - rect[3]) * scale],
              convertToViewportPoint: (x: number, y: number) => [x * scale, (600 - y) * scale] }),
            getTextContent: async () => ({}),
            getAnnotations: async () => [
              { subtype: "Link", rect: [0, 20, 50, 40], url: "https://example.com/read" },
              { annotationType: 2, rect: [0, 20, 50, 40], dest: "chapter" },
              { annotationType: 2, rect: [0, 20, 50, 40], url: "javascript:alert(1)" },
            ],
            render: () => ({ promise: Promise.resolve(), cancel() {} }),
          };
        },
        getDestination: async () => [{ num: 42, gen: 0 }, { name: "XYZ" }, 0, 500],
        getPageIndex: async () => 2,
        destroy: async () => { destroyed++; },
      };
      return { promise: Promise.resolve(doc), destroy: doc.destroy };
    },
  };
  setPdfJsForTest(api);
  const host = document.body.appendChild(document.createElement("div"));
  const urls: string[] = [];
  const renderer = new PdfRenderer(host, { openExternal: async (url) => { urls.push(url); } }); renderers.push(renderer);
  Object.defineProperties(renderer.scrollEl, { clientWidth: { value: 424 }, clientHeight: { value: 500 } });
  return { renderer, host, got, urls, api, counts: () => ({ opens, destroyed, textRenders }) };
}

test("PDF reading loads only nearby pages and bounds canvas/text/link layers to ten", async () => {
  const f = fixture();
  const bytes = new Uint8Array([1, 2, 3]);
  await f.renderer.load(bytes);
  assert.deepEqual(f.got, [1]);
  observer.show(...Array.from({ length: 65 }, (_, i) => i));
  await tick(); await tick();
  assert.equal(f.host.querySelectorAll("canvas").length, 10);
  assert.equal(f.host.querySelectorAll(".ll-pdf-text").length, 10);
  assert.equal(f.host.querySelectorAll(".ll-pdf-links").length, 10);
  assert.ok(f.got.length <= 11);
  observer.show(40, 41, 42);
  f.renderer.goToPage(42);
  await tick(); await tick();
  assert.ok(f.host.querySelectorAll("canvas").length <= 10);
  assert.ok(f.host.querySelectorAll(".ll-pdf-text").length <= 10);
  assert.equal(f.renderer.status.page, 42);
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test("text selection remains ordinary DOM text; links open safely/navigate and avoid inverse SyncTeX", async () => {
  const f = fixture(); await f.renderer.load(new Uint8Array([1])); observer.show(0); await tick();
  const span = f.host.querySelector(".ll-pdf-text span")!;
  const range = document.createRange(); range.selectNodeContents(span);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  assert.equal(document.getSelection()!.toString(), "Copy 中文 text");
  const links = [...f.host.querySelectorAll(".ll-pdf-link")]; assert.equal(links.length, 2);
  links[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await tick();
  assert.deepEqual(f.urls, ["https://example.com/read"]);
  links[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await tick();
  assert.equal(f.renderer.status.page, 3);
  assert.equal(f.renderer.pointFromEvent({ target: links[0], clientX: 40, clientY: 50 } as unknown as MouseEvent), null);
  assert.equal(f.renderer.pointFromEvent({ target: span, clientX: 40, clientY: 50 } as unknown as MouseEvent)?.page, 1);
});

test("pinch coalesces at animation frames without reopening the PDF or recreating text; normal scroll untouched", async () => {
  const f = fixture(); await f.renderer.load(new Uint8Array([1])); observer.show(0); await tick();
  const normal = new dom.window.WheelEvent("wheel", { deltaY: 10, cancelable: true }); f.renderer.scrollEl.dispatchEvent(normal);
  assert.equal(normal.defaultPrevented, false);
  for (let i = 0; i < 12; i++) {
    const event = new dom.window.WheelEvent("wheel", { deltaY: -10, ctrlKey: true, cancelable: true, clientX: 100, clientY: 100 });
    f.renderer.scrollEl.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  }
  await wait(180); await tick();
  assert.ok(f.renderer.status.scale > 1.5);
  assert.equal(f.counts().opens, 1);
  assert.equal(f.counts().textRenders, 1);
});

test("display density changes redraw backing pixels at unchanged width and preserve text selection", async () => {
  const originalMatch = dom.window.matchMedia;
  const originalDpr = Object.getOwnPropertyDescriptor(dom.window, "devicePixelRatio")!;
  const queries: { listeners: Set<() => void> }[] = [];
  dom.window.matchMedia = (() => {
    const query = { listeners: new Set<() => void>(),
      addEventListener(_event: string, listener: () => void) { this.listeners.add(listener); },
      removeEventListener(_event: string, listener: () => void) { this.listeners.delete(listener); } };
    queries.push(query); return query;
  }) as unknown as typeof dom.window.matchMedia;
  const density = (value: number) => {
    Object.defineProperty(dom.window, "devicePixelRatio", { value, configurable: true });
    [...queries].forEach((query) => [...query.listeners].forEach((listener) => listener()));
  };
  try {
    density(1);
    const f = fixture(2); await f.renderer.load(new Uint8Array([1])); observer.show(0); await tick();
    const old = f.host.querySelector("canvas")!, text = f.host.querySelector(".ll-pdf-text")!;
    const range = document.createRange(); range.selectNodeContents(text);
    document.getSelection()!.addRange(range);
    const status = f.renderer.status, selected = document.getSelection()!.toString();
    density(2); await tick();
    const retina = f.host.querySelector("canvas")!;
    assert.notEqual(retina, old); assert.equal(retina.width, old.width * 2);
    assert.equal(f.host.querySelector(".ll-pdf-text"), text);
    assert.equal(document.getSelection()!.toString(), selected);
    assert.deepEqual(f.renderer.status, status);
    assert.equal(f.counts().opens, 1); assert.equal(f.counts().textRenders, 1);
    density(1); await tick(); assert.equal(f.host.querySelector("canvas")!.width, old.width);
    assert.equal(queries.reduce((total, query) => total + query.listeners.size, 0), 1);
    f.renderer.destroy();
    assert.equal(queries.reduce((total, query) => total + query.listeners.size, 0), 0);
  } finally {
    dom.window.matchMedia = originalMatch;
    Object.defineProperty(dom.window, "devicePixelRatio", originalDpr);
  }
});

test("superseded PDF loads and disposal cannot install an old document", async () => {
  const f = fixture(2), first = defer<unknown>();
  const original = f.api.getDocument;
  let calls = 0, cancelled = 0;
  f.api.getDocument = ((src: { data: Uint8Array }) => {
    if (++calls === 1) return { promise: first.promise, destroy: async () => { cancelled++; } };
    return original(src);
  }) as typeof original;
  const slow = f.renderer.load(new Uint8Array([1])); await tick();
  await f.renderer.load(new Uint8Array([2])); assert.equal(f.renderer.status.pages, 2); assert.equal(cancelled, 1);
  let staleDestroyed = 0;
  first.resolve({ numPages: 99, getPage: async () => { throw new Error("stale getPage must not run"); }, destroy: async () => { staleDestroyed++; } });
  await slow; assert.equal(staleDestroyed, 1); assert.equal(f.renderer.status.pages, 2);
  f.renderer.destroy(); await f.renderer.load(new Uint8Array([3])); assert.equal(f.renderer.hasDocument, false);
});

test("PDF page navigation clamps invalid/out-of-range values", async () => {
  const f = fixture(3); await f.renderer.load(new Uint8Array([1]));
  f.renderer.goToPage(999); assert.equal(f.renderer.status.page, 3);
  f.renderer.goToPage(-42); assert.equal(f.renderer.status.page, 1);
  f.renderer.goToPage(NaN); assert.equal(f.renderer.status.page, 1);
});

test("PDF links accept only external web/mail/telephone protocols", () => {
  for (const value of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "obsidian://open", "bad"]) assert.equal(externalPdfUrl(value), null);
  for (const value of ["https://example.com/a", "mailto:a@example.com", "tel:+1234"]) assert.equal(externalPdfUrl(value), value);
});

test("Save as PDF snapshots bytes before the dialog and writes atomically; cancel leaves target untouched", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ll-save-pdf-"));
  try {
    const target = join(folder, "chosen.pdf"), bytes = new Uint8Array([37, 80, 68, 70, 1]);
    await writeFile(target, "existing");
    assert.equal(await savePdfSnapshot(join(folder, "main.tex"), bytes, { choose: async () => null, write: () => assert.fail("cancel wrote data") }), null);
    assert.equal(await readFile(target, "utf8"), "existing");
    const chosen = await savePdfSnapshot(join(folder, "main.tex"), bytes, { choose: async (proposed) => {
      assert.equal(proposed, join(folder, "main.pdf")); bytes.fill(9); return target.slice(0, -4);
    }, write: atomicPdfWrite });
    assert.equal(chosen, target);
    assert.deepEqual([...await readFile(target)], [37, 80, 68, 70, 1]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});


test("new compile retains the rendered page until its replacement is ready and load failure retains success", async () => {
  const f = fixture(2); await f.renderer.load(new Uint8Array([1])); observer.show(0); await tick();
  const oldCanvas = f.host.querySelector("canvas"), oldText = f.host.querySelector(".ll-pdf-text");
  const original = f.api.getDocument, rendering = defer<void>();
  f.api.getDocument = ((src: { data: Uint8Array }) => {
    const loading = original(src);
    return { ...loading, promise: loading.promise.then((doc) => {
      const getPage = doc.getPage;
      return { ...doc, getPage: async (n: number) => {
        const page = await getPage(n);
        return { ...page, render: () => ({ promise: rendering.promise, cancel: () => rendering.reject(new Error("cancelled")) }) };
      } };
    }) };
  }) as typeof original;
  await f.renderer.load(new Uint8Array([2])); await tick();
  assert.equal(f.host.querySelector("canvas"), oldCanvas);
  assert.equal(f.host.querySelector(".ll-pdf-text"), oldText);
  rendering.resolve(); await tick();
  assert.notEqual(f.host.querySelector("canvas"), oldCanvas);
  assert.notEqual(f.host.querySelector(".ll-pdf-text"), oldText);
  const successful = f.host.querySelector("canvas");
  f.api.getDocument = (() => ({ promise: Promise.reject(new Error("invalid PDF")), destroy: async () => {} })) as typeof original;
  await f.renderer.load(new Uint8Array([3]));
  assert.equal(f.renderer.hasDocument, true);
  assert.equal(f.host.querySelector("canvas"), successful);
});

test("preview controls navigate pages and text double-click retains inverse SyncTeX while links bypass it", async () => {
  const f = fixture(3), session = {
    lastPdf: new Uint8Array([1]), last: null, compiling: null, failure: null, engine: "pdflatex",
    onEvent: () => () => {}, request: () => {},
  };
  const opened: unknown[] = [], inverses: unknown[] = [];
  const app = testApp();
  const plugin = { app, acquireSession: () => session, releaseSession: () => {}, vaultBase: () => "/vault", vaultPath: (path: string) => path,
    invertsPaper: () => false, inverseSearch: async (...args: unknown[]) => { inverses.push(args); return { file: "/vault/main.tex", line: 3 }; },
    openLocation: async (...args: unknown[]) => { opened.push(args); },
  } as unknown as LatexLivePlugin;
  const view = new LatexPreviewView(new WorkspaceLeaf(app) as never, plugin);
  // The view creates its own renderer; the unused fixture renderer can leave immediately.
  f.renderer.destroy();
  await view.onOpen();
  Object.defineProperties(view.contentEl.querySelector(".ll-scroll")!, { clientWidth: { value: 424 }, clientHeight: { value: 500 } });
  view.setRoot("/vault/main.tex"); await tick();
  observer.show(0); await tick();
  const input = view.contentEl.querySelector<HTMLInputElement>('input[aria-label="Go to PDF page"]')!;
  input.value = "2"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert.equal(input.value, "2");
  assert.equal(view.contentEl.querySelector<HTMLButtonElement>('button[aria-label="Save the last successful build as PDF"]')!.disabled, false);
  const text = view.contentEl.querySelector(".ll-pdf-text span")!;
  text.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })); await tick();
  assert.equal(inverses.length, 1); assert.deepEqual(opened, [["/vault/main.tex", 3]]);
  const link = view.contentEl.querySelector(".ll-pdf-link")!;
  link.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); await tick();
  assert.equal(inverses.length, 1);
  const details = view.contentEl.querySelector("details")!;
  assert.equal(details.open, false);
  await view.onClose();
  assert.equal(view.contentEl.querySelectorAll(".ll-page").length, 0);
});
