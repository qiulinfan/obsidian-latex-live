// TexRender: one ProjectMath per root over Obsidian's MathJax (tests/support/mathjax.ts), on a
// temporary copy of the synthetic elegantbook fixture: loading, the hover's rendering and
// failures, the render cache, rebuilds after saves and definition edits, label numbers after
// compiles (never a rebuild), and stylesheets in the main window and popouts.
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import { mathAt } from "../src/editor/latexScan";
import { TexRender } from "../src/editor/texRender";
import { obsidianMathJax } from "./support/mathjax";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const glyphs = (el: Element): string[] => [...el.querySelectorAll("mjx-c")].map((c) => c.className.split(" ")[0]);
const chars = (el: Element): string => glyphs(el).map((c) => String.fromCodePoint(parseInt(c.slice(5), 16))).join("");

/** TeX inputs MathJax builds from now on (each one a ProjectMath (re)build). */
async function countTexInputs(): Promise<{ count: number; restore(): void }> {
  const { MathJax } = await obsidianMathJax();
  const ns = (MathJax._ as { input: { tex_ts: { TeX: new (o: object) => object } } }).input.tex_ts;
  const TeX = ns.TeX;
  const counter = {
    count: 0,
    restore: () => void (ns.TeX = TeX),
  };
  ns.TeX = new Proxy(TeX, {
    construct(target, args) {
      counter.count++;
      return Reflect.construct(target, args);
    },
  });
  return counter;
}

/** `finish` as Obsidian's finishRenderMath: its stylesheet goes into the main head (after 100 ms when `debounced`). */
async function setup(opts: { debounced?: boolean } = {}) {
  const { window: mw, MathJax } = await obsidianMathJax();
  const dir = mkdtempSync(join(tmpdir(), "ll-render-"));
  const book = join(dir, "book");
  cpSync(resolve("tests/fixtures/elegantbook"), book, { recursive: true });
  const outDir = join(dir, "out");
  mkdirSync(join(outDir, "chapters"), { recursive: true });
  const buffers = new Map<string, string>();
  const calls = { load: 0, finish: 0, collect: 0, labels: 0 };
  let loaded = false;
  const render = new TexRender({
    outDirFor: () => (calls.labels++, outDir),
    buffers: () => (calls.collect++, buffers),
    mathJax: {
      load: async () => {
        calls.load++;
        loaded = true;
      },
      global: () => (loaded ? MathJax : undefined),
      finish: async () => {
        calls.finish++;
        if (opts.debounced) await sleep(100);
        const sheet = MathJax.chtmlStylesheet();
        if (!sheet.isConnected) mw.document.head.appendChild(sheet);
      },
      document: mw.document,
    },
  });
  const root = join(book, "main.tex");
  const ch2 = join(book, "chapters", "ch2.tex");
  /** The hover's element for the formula at `|` in `text`, in a view of the window `doc`. */
  const hover = (text: string, doc: Document = mw.document) => {
    const pos = Math.max(text.indexOf("|"), 1);
    const state = EditorState.create({ doc: text.replace("|", "") });
    const m = mathAt(state.doc, pos);
    assert.ok(m, `a formula at ${pos}`);
    const view = { state, dom: { ownerDocument: doc } } as unknown as EditorView;
    return render.hover(m, view, root);
  };
  const done = () => {
    render.dispose();
    rmSync(dir, { recursive: true, force: true });
  };
  return { MathJax, mainDocument: mw.document, render, book, root, ch2, outDir, buffers, calls, hover, done };
}

test("TexRender: MathJax loads on first use; formulas render with the project's macros", async () => {
  const t = await setup();
  try {
    const first = t.hover("$\\E[Q]{X} + \\Lip$");
    assert.ok(first instanceof Promise, "waits for MathJax the first time");
    const el = await first;
    assert.equal(el.nodeName, "MJX-CONTAINER");
    assert.ok(chars(el).includes("𝐿"), "ch2's \\Lip");
    const again = t.hover("$\\N$");
    assert.ok(!(again instanceof Promise), "synchronous once loaded");
    assert.equal(chars(again as HTMLElement), "ℕ0", "main.tex's \\renewcommand{\\N}");
    assert.equal(t.calls.load, 1);
    assert.equal(t.calls.collect, 1, "one renderer for the root");
    assert.equal(t.calls.finish, 2, "finishRenderMath after each render");
    const err = (await t.hover("text $\\foo|{x}$")) as HTMLElement;
    assert.ok(err.classList.contains("lsp-render-hover-error"));
    assert.equal(err.querySelector(".lsp-render-hover-message")?.textContent, "Undefined control sequence \\foo");
    assert.equal(err.querySelector(".lsp-render-hover-source")?.textContent, "$\\foo{x}$");
    const set = (await t.hover("$\\set{M}[M = 1]$")) as HTMLElement;
    assert.match(set.querySelector(".lsp-render-hover-message")?.textContent ?? "", /\\set: \\NewDocumentCommand/, "no braket \\set");
  } finally {
    t.done();
  }
});

test("TexRender: a formula renders once and is handed out as clones until the renderer changes", async () => {
  const t = await setup();
  try {
    const first = (await t.hover("$\\E[Q]{X}$")) as HTMLElement;
    const finished = t.calls.finish;
    const again = t.hover("$\\E[Q]{X}$") as HTMLElement;
    assert.notEqual(again, first, "a clone: the first node lives in its tooltip");
    assert.equal(again.outerHTML, first.outerHTML);
    assert.equal(t.calls.finish, finished, "no second MathJax render");
    assert.equal((t.hover("\\[\\E[Q]{X}\\]") as HTMLElement).nodeName, "MJX-CONTAINER");
    assert.equal(t.calls.finish, finished + 1, "display math is its own entry");
    const err1 = t.hover("$\\foo$") as HTMLElement;
    const err2 = t.hover("$\\foo$") as HTMLElement;
    assert.notEqual(err1, err2);
    assert.equal(err2.querySelector(".lsp-render-hover-message")?.textContent, "Undefined control sequence \\foo");
  } finally {
    t.done();
  }
});

test("TexRender: the first hover of a new glyph already has its CSS (finishRenderMath waits 100 ms)", async () => {
  const t = await setup({ debounced: true });
  try {
    await t.render.load();
    const has = (glyph: string) =>
      [...t.mainDocument.styleSheets].some((sheet) => [...sheet.cssRules].some((r) => r.cssText.includes(glyph)));
    assert.equal(has("mjx-c1D514"), false, "\\mathfrak{Q} not drawn yet in this window");
    const el = t.hover("$\\mathfrak{Q} \\oint$");
    assert.equal((el as HTMLElement).nodeName, "MJX-CONTAINER");
    assert.ok(has("mjx-c1D514") && has("mjx-c222E"), "the glyph rules are in the main window before the hover shows");
    await sleep(120);
    assert.equal(
      [...t.mainDocument.head.querySelectorAll("style")].filter((s) => s === t.MathJax.chtmlStylesheet()).length,
      1,
      "finishRenderMath adopts the same element: one stylesheet",
    );
  } finally {
    t.done();
  }
});

test("TexRender: a saved project file (300 ms) and a definition edit (500 ms) rebuild the renderer", async () => {
  const t = await setup();
  try {
    const lip = async () => chars((await t.hover("$\\Lip$")) as HTMLElement);
    assert.equal(await lip(), "𝐿");
    const built = t.calls.collect;
    t.render.fileModified(join(t.book, "elsewhere.tex"));
    await sleep(350);
    assert.equal(t.calls.collect, built, "a file the project does not read");
    const disk = readFileSync(t.ch2, "utf8");
    writeFileSync(t.ch2, disk.replace("\\newcommand{\\Lip}{L}", "\\newcommand{\\Lip}{K}"));
    t.render.fileModified(t.ch2);
    await sleep(100);
    assert.equal(await lip(), "𝐿", "debounced");
    await sleep(300);
    assert.equal(await lip(), "𝐾");

    // Unsaved: an edit on a text line does not re-read; one on the definition line does.
    const collects = t.calls.collect;
    const saved = readFileSync(t.ch2, "utf8");
    const edit = (before: string, from: string, to: string) => {
      const at = before.indexOf(from);
      const tr = EditorState.create({ doc: before }).update({ changes: { from: at, to: at + from.length, insert: to } });
      t.buffers.set(t.ch2, tr.state.doc.toString());
      t.render.edited(t.ch2, tr.changes, tr.startState.doc, tr.state.doc);
      return tr.state.doc.toString();
    };
    const typed = edit(saved, "交换图", "交换图 typed");
    await sleep(600);
    assert.equal(t.calls.collect, collects, "a text edit");
    edit(typed, "\\newcommand{\\Lip}{K}", "\\newcommand{\\Lip}{M}");
    await sleep(300);
    assert.equal(await lip(), "𝐾", "debounced");
    await sleep(300);
    assert.equal(await lip(), "𝑀", "the unsaved definition");
    assert.equal(t.calls.collect, collects + 1);
  } finally {
    t.done();
  }
});

test("TexRender: label numbers come from the build folder and follow each compile, never rebuilding", async () => {
  const t = await setup();
  const inputs = await countTexInputs();
  try {
    const align = "\\begin{align}\n  a &= b \\label{eq:var-def}|\n\\end{align}";
    assert.ok(!chars((await t.hover(align)) as HTMLElement).includes("("), "nothing compiled yet");
    assert.equal(inputs.count, 1);
    const aux = join(t.outDir, "chapters", "ch1.aux");
    for (let n = 1; n <= 5; n++) {
      writeFileSync(aux, `\\newlabel{eq:var-def}{{1.${n}}{1}{}{equation.1.${n}}{}}\n`);
      t.render.compiled(t.root);
      await sleep(5);
      assert.ok(chars(t.hover(align) as HTMLElement).endsWith(`(1.${n})`), "the cached render follows the new number");
    }
    assert.equal(inputs.count, 1, "renumbering compiles build no TeX input (MathJax keeps each one alive)");
    assert.equal(t.calls.collect, 1, "nor re-read the definitions");
    const reads = t.calls.labels;
    t.render.compiled(t.root);
    t.render.dispose();
    await sleep(20);
    assert.equal(t.calls.labels, reads, "dispose cancels a pending label read");
  } finally {
    inputs.restore();
    t.done();
  }
});

test("TexRender: a popout window gets one copy of MathJax's stylesheet, refreshed after each render", async () => {
  const t = await setup();
  try {
    const popout = new JSDOM("<!doctype html><html><head></head><body></body></html>").window.document;
    await t.hover("$\\mathfrak{Z}$", popout);
    await sleep(0);
    const sheets = () => [...popout.head.querySelectorAll("style")];
    assert.equal(sheets().length, 1);
    assert.match(sheets()[0].textContent ?? "", /mjx-c\.mjx-c2128\.TEX-FR::before/, "\\mathfrak{Z}'s rule");
    await t.hover("$\\mathscr{Q}$", popout);
    await sleep(0);
    assert.equal(sheets().length, 1, "replaced, not added");
    assert.match(sheets()[0].textContent ?? "", /mjx-c1D4AC/, "the new glyph's rule, inserted after the first version");
    assert.doesNotMatch(t.MathJax.chtmlStylesheet().textContent ?? "", /mjx-c1D4AC/, "absent from the element's own text");
    const styles = () => [...t.mainDocument.head.querySelectorAll("style")];
    const before = styles();
    assert.ok(before.includes(t.MathJax.chtmlStylesheet()));
    await t.hover("$x$");
    await sleep(0);
    assert.deepEqual(styles(), before, "no copy in the main window: finishRenderMath's own sheet serves it");
  } finally {
    t.done();
  }
});
