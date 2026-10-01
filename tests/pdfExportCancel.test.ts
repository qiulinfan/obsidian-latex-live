import "./support/dom";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ExportImages } from "../src/export/images";
import { planExport } from "../src/export/plan";
import { PDFJS_ASSETS, pdfPagePngs } from "../src/preview/pdfRenderer";
import { projectDefinitions } from "../src/tex/macros";
import { abortError } from "../src/tex/run";
import { dom } from "./support/dom";
import { setPdfJsForTest } from "./support/obsidian";

const canvas = dom.window.HTMLCanvasElement.prototype;
const originalContext = canvas.getContext;
const originalBlob = canvas.toBlob;
afterEach(() => {
  canvas.getContext = originalContext;
  canvas.toBlob = originalBlob;
  setPdfJsForTest(undefined);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("PDF export cancels a pending document load without waiting for its promise", { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let documents = 0, destroyed = 0;
  const started = deferred<void>();
  setPdfJsForTest({ getDocument: () => {
    documents++;
    started.resolve();
    return { promise: new Promise(() => {}), destroy: async () => { destroyed++; } };
  } });
  controller.abort();
  await assert.rejects(pdfPagePngs(new Uint8Array(), () => [1], 2, controller.signal), { name: "AbortError" });
  assert.equal(documents, 0, "an already cancelled export never starts pdf.js");

  const live = new AbortController();
  const drawing = pdfPagePngs(new Uint8Array(), () => [1], 2, live.signal);
  await started.promise;
  live.abort();
  await assert.rejects(drawing, { name: "AbortError" });
  assert.equal(destroyed, 1, "loading task destroyed once, even though its promise never settles");
});

test("PDF export cancels the current render and never starts the next requested page", { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  let cancelled = 0, destroyed = 0;
  const pages: number[] = [];
  canvas.getContext = (() => ({})) as unknown as typeof canvas.getContext;
  setPdfJsForTest({ getDocument: () => ({
    promise: Promise.resolve({ numPages: 3, getPage: async (n: number) => {
      pages.push(n);
      return { getViewport: () => ({ width: 100, height: 200 }), render: () => {
        started.resolve();
        return { promise: new Promise(() => {}), cancel: () => { cancelled++; } };
      } };
    } }),
    destroy: async () => { destroyed++; },
  }) });
  const drawing = pdfPagePngs(new Uint8Array(), () => [1, 2, 3], 2, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(drawing, { name: "AbortError" });
  assert.deepEqual(pages, [1]);
  assert.equal(cancelled, 1);
  assert.equal(destroyed, 1);
});

test("successful PDF export keeps assets, dimensions and selected pages, then destroys the loading task", async () => {
  let destroyed = 0;
  const pages: number[] = [];
  canvas.getContext = (() => ({})) as unknown as typeof canvas.getContext;
  canvas.toBlob = (callback) => callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  setPdfJsForTest({ getDocument: (src: unknown) => {
    assert.deepEqual(src, { data: new Uint8Array([9]), isEvalSupported: false, ...PDFJS_ASSETS });
    return {
      promise: Promise.resolve({ numPages: 3, getPage: async (n: number) => {
        pages.push(n);
        return { getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
          render: () => ({ promise: Promise.resolve(), cancel: () => assert.fail("successful render cancelled") }) };
      } }),
      destroy: async () => { destroyed++; },
    };
  } });
  const out = await pdfPagePngs(new Uint8Array([9]), () => [1, 3], 2, new AbortController().signal);
  assert.deepEqual(pages, [1, 3]);
  assert.deepEqual(out.map((p) => [p.page, [...p.png], p.width, p.height]), [[1, [1, 2, 3], 100, 200], [3, [1, 2, 3], 100, 200]]);
  assert.equal(destroyed, 1);
});

test("the image stage passes its export signal to the PDF host and propagates cancellation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-pdf-cancel-"));
  try {
    const root = join(dir, "main.tex");
    writeFileSync(root, "\\documentclass{article}\n\\begin{document}\n\\includepdf{doc.pdf}\n\\end{document}\n");
    writeFileSync(join(dir, "doc.pdf"), "%PDF-1.4 test host");
    const controller = new AbortController();
    const images = new ExportImages(dir, [], async (_abs, _want, signal) => {
      assert.equal(signal, controller.signal);
      controller.abort();
      throw abortError("Cancelled while drawing the PDF.");
    });
    const plan = planExport(root, { defs: projectDefinitions(root), theorems: new Map() });
    await assert.rejects(images.load(plan, controller.signal), { name: "AbortError" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
