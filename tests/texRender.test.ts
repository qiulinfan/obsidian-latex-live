// TexRender: one ProjectMath per root over Obsidian's MathJax (tests/support/mathjax.ts), on a
// temporary copy of the synthetic elegantbook fixture: loading, the hover's rendering and
// failures, the render cache, rebuilds after saves and definition edits, label numbers after
// compiles (never a rebuild), stylesheets in the main window and popouts, live preview's
// renderer (preload, epochs, subscribers, flush), and the refs chips read (labels, bibliography).
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
import { TexCrops, TexFragments, TexRender, fragmentBody } from "../src/editor/texRender";
import { NOTE_CHANGED, NOTE_NO_PREVIEW } from "../src/preview/blockCrop";
import { obsidianMathJax } from "./support/mathjax";
import { emptyDefinitions } from "../src/tex/macros";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const glyphs = (el: Element): string[] => [...el.querySelectorAll("mjx-c")].map((c) => c.className.split(" ")[0]);
const chars = (el: Element): string => glyphs(el).map((c) => String.fromCodePoint(parseInt(c.slice(5), 16))).join("");

test("TexRender source cards: committed definitions stay private, reuse the root input, and install glyph styles in a popout", async () => {
  const t = await setup();
  const counter = await countTexInputs();
  try {
    await t.render.load();
    const defs = emptyDefinitions();
    defs.statements.push(String.raw`\newcommand{\cardMacro}{a}`);
    const refs = t.render.refsOf(t.root);
    const popout = new JSDOM("<html><head></head><body></body></html>").window.document;
    const first = t.render.sourceMath(t.root, String.raw`\cardMacro`, false, popout, defs, refs);
    assert.equal(chars(first), "𝑎");
    assert.equal(first.ownerDocument, popout);
    assert.ok(popout.head.querySelector("style"));
    t.render.sourceMath(t.root, String.raw`\cardMacro+1`, false, popout, defs, refs);
    assert.equal(counter.count, 1);
    const changed = { ...defs, statements: [String.raw`\newcommand{\cardMacro}{b}`] };
    assert.equal(chars(t.render.sourceMath(t.root, String.raw`\cardMacro`, false, popout, changed, refs)), "𝑏");
    assert.equal(counter.count, 2);
    // The public Obsidian renderer still has no project cardMacro definition.
    const global = t.MathJax.tex2chtml!(String.raw`\cardMacro`, { display: false }) as Element;
    assert.notEqual(chars(global), "𝑏");
  } finally { counter.restore(); t.done(); }
});

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

/**
 * `finish` as Obsidian's finishRenderMath: its stylesheet goes into the main head (after 100 ms
 * when `debounced`). `documents`: the windows with LaTeX editors.
 */
async function setup(opts: { debounced?: boolean; documents?: Document[]; crops?: TexCrops; fragments?: TexFragments; fallback?: () => boolean } = {}) {
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
    documents: () => opts.documents ?? [],
    crops: opts.crops,
    fragments: opts.fragments,
    fragmentFallback: opts.fallback,
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
    // Formulas always render (MathJax or its message) without crops.
    return render.hover(m, view, root) as HTMLElement | Promise<HTMLElement>;
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
    assert.equal(t.calls.collect, 2, "one renderer for the root, and its refs read once");
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
    assert.equal(t.calls.collect, 2, "nor re-read the definitions or the bibliography (the first hover read both)");
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

test("TexRender live: preload loads MathJax once and warms it up; the renderer renders prepared sources", async () => {
  const t = await setup();
  try {
    assert.equal(t.render.ready, false);
    const a = t.render.preload(t.root);
    assert.equal(t.render.preload(t.ch2), a, "one preload for every root");
    assert.equal(await a, true);
    assert.equal(t.render.ready, true);
    assert.deepEqual([t.calls.load, t.calls.collect], [1, 1], "the warm-up built the root's instance");
    assert.ok(t.calls.finish >= 1, "finishRenderMath before the first live mount");
    const r = t.render.rendererFor(t.root);
    assert.equal(t.render.rendererFor(t.root), r, "one renderer per root: its views share their renders");
    assert.notEqual(t.render.rendererFor(t.ch2), r);
    const req = (src: string, display = false) => ({ key: src, src, display, kind: "math", pos: 0 });
    const ok = r.render(req("\\E[Q]{X} + \\Lip")) as { ok: true; node: Element };
    assert.equal(ok.ok, true);
    assert.equal(ok.node.nodeName, "MJX-CONTAINER");
    assert.ok(chars(ok.node).includes("𝐿"));
    assert.deepEqual(r.render(req("\\foo")), { ok: false, message: "Undefined control sequence \\foo" });
    // latexLive prepares the numbers (`\label` -> `\tag`): the renderer draws the source as is.
    const tagged = r.render(req("\\begin{equation}x\\tag{2.5}\\end{equation}", true)) as { ok: true; node: Element };
    assert.ok(chars(tagged.node).endsWith("(2.5)"));
  } finally {
    t.done();
  }
});

test("TexRender live: without MathJax preload fails and nothing renders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-render-"));
  const render = new TexRender({
    outDirFor: () => dir,
    buffers: () => new Map(),
    mathJax: { load: async () => {}, global: () => undefined, finish: async () => {}, document },
  });
  try {
    assert.equal(await render.preload(join(dir, "main.tex")), false);
    assert.equal(render.ready, false);
    const r = render.rendererFor(join(dir, "main.tex"));
    assert.equal(r.epoch, 0);
    assert.deepEqual(r.render({ key: "x", src: "x", display: false, kind: "math", pos: 0 }), {
      ok: false,
      message: "MathJax is not available.",
    });
  } finally {
    render.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TexRender live: the epoch is the definitions' hash; subscribers hear of new definitions and new numbers", async () => {
  const t = await setup();
  try {
    await t.render.preload(t.root);
    const r = t.render.rendererFor(t.root);
    const heard: number[] = [];
    const off = r.subscribe!(() => heard.push(r.epoch));
    const first = r.epoch;
    assert.notEqual(first, 0);
    assert.equal(t.render.labelsOf(t.root).size, 0, "nothing compiled yet");

    // New label numbers: the epoch stays (only the formulas whose numbers changed re-render).
    const aux = join(t.outDir, "chapters", "ch1.aux");
    writeFileSync(aux, "\\newlabel{eq:var-def}{{1.2}{1}{}{equation.1.2}{}}\n");
    t.render.compiled(t.root);
    await sleep(5);
    assert.deepEqual(heard, [first]);
    assert.equal(t.render.labelsOf(t.root).get("eq:var-def"), "1.2");
    t.render.compiled(t.root);
    await sleep(5);
    assert.deepEqual(heard, [first], "the same numbers: no rebuild");

    // A saved definition: a new instance and epoch.
    writeFileSync(t.ch2, readFileSync(t.ch2, "utf8").replace("\\newcommand{\\Lip}{L}", "\\newcommand{\\Lip}{K}"));
    t.render.fileModified(t.ch2);
    await sleep(350);
    assert.equal(heard.length, 2);
    assert.notEqual(heard[1], first);
    assert.equal(r.epoch, heard[1]);
    off();
    t.render.fileModified(t.ch2);
    writeFileSync(t.ch2, readFileSync(t.ch2, "utf8").replace("\\newcommand{\\Lip}{K}", "\\newcommand{\\Lip}{M}"));
    await sleep(350);
    assert.equal(heard.length, 2, "unsubscribed");
  } finally {
    t.done();
  }
});

test("TexRender live: flush puts the glyph CSS into the main window and copies it to popouts with editors", async () => {
  const popout = new JSDOM("<!doctype html><html><head></head><body></body></html>").window.document;
  const t = await setup({ documents: [popout] });
  try {
    await t.render.preload(t.root);
    const r = t.render.rendererFor(t.root);
    r.render({ key: "a", src: "\\mathfrak{Y}", display: false, kind: "math", pos: 0 });
    r.flush!();
    const has = (doc: Document, glyph: string) =>
      [...doc.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule.cssText.includes(glyph)));
    assert.ok(has(t.mainDocument, "mjx-c1D51C"), "\\mathfrak{Y} in the main window at once");
    assert.equal(popout.head.querySelectorAll("style").length, 1);
    assert.match(popout.head.textContent ?? "", /mjx-c1D51C/, "and in the popout");
    const other = new JSDOM("<!doctype html><html><head></head><body></body></html>").window.document;
    t.render.stylesFor(other);
    assert.match(other.head.textContent ?? "", /mjx-c1D51C/, "a live editor mounted in another window");
  } finally {
    t.done();
  }
});

test("TexRender refs: labels with kinds, the project's bibliography and reference names; re-read on the right events only", async () => {
  const t = await setup();
  try {
    const r = t.render.rendererFor(t.root);
    let heard = 0;
    const off = r.subscribe!(() => heard++);
    const first = t.render.refsOf(t.root);
    assert.equal(t.render.refsOf(t.root), first, "read once");
    assert.equal(first.labels.size, 0, "nothing compiled yet");
    assert.deepEqual([...first.cites.keys()], ["zhang2020notes", "li2019lln"], "main.tex's \\addbibresource{refs.bib}");
    assert.equal(first.names.autoref.get("equation"), "Equation", "hyperref's names: elegantbook with lang=cn prints English ones");
    assert.deepEqual(first.names.cref.get("equation"), ["eq.", "eqs."], "cleveref's defaults");

    cpSync(resolve("tests/fixtures/aux/book"), t.outDir, { recursive: true });
    t.render.compiled(t.root);
    await sleep(5);
    const compiled = t.render.refsOf(t.root);
    assert.equal(compiled.labels.get("thm:total-exp")?.kind, "theorem");
    assert.equal(compiled.numbers.get("eq:var-def"), "1.2");
    assert.equal(compiled.cites, first.cites, "a compile re-reads the labels only");
    assert.equal(heard, 1);
    const hovered = (await t.hover("$\\text{见 \\autoref{thm:total-exp}、\\cref{eq:var-def}}|$")) as HTMLElement;
    assert.match(hovered.textContent ?? "", /见.*、/);
    assert.equal(chars(hovered).trim(), "1.1eq. (1.2)", "the hover reads references as the chips do (\\autoref: hyperref names no tcolorbox theorem)");
    t.render.compiled(t.root);
    await sleep(5);
    assert.equal(t.render.refsOf(t.root), compiled, "the same labels: nothing changes, nobody hears");
    assert.equal(heard, 1);

    // An unsaved .bib buffer (500 ms); the numbers keep their identity (prepared formulas stay).
    const bib = join(t.book, "refs.bib");
    const typed = readFileSync(bib, "utf8").replace("Li, Wei and Doe, Jane and Roe, Richard", "Zhou, Kai");
    t.buffers.set(bib, typed);
    const tr = EditorState.create({ doc: readFileSync(bib, "utf8") }).update({ changes: { from: 0, insert: " " } });
    t.render.edited(bib, tr.changes, tr.startState.doc, tr.state.doc);
    await sleep(300);
    assert.equal(heard, 1, "debounced");
    await sleep(300);
    const edited = t.render.refsOf(t.root);
    assert.deepEqual(edited.cites.get("li2019lln")?.names, ["Zhou"]);
    assert.equal(edited.numbers, compiled.numbers);
    assert.equal(heard, 2);

    // A text edit in a project file re-reads nothing; one on the \documentclass line does.
    const main = readFileSync(t.root, "utf8");
    const edit = (from: string, to: string) => {
      const at = main.indexOf(from);
      const e = EditorState.create({ doc: main }).update({ changes: { from: at, to: at + from.length, insert: to } });
      t.buffers.set(t.root, e.state.doc.toString());
      t.render.edited(t.root, e.changes, e.startState.doc, e.state.doc);
    };
    edit("合成测试书", "合成测试书 typed");
    await sleep(600);
    assert.equal(heard, 2);
    assert.equal(edited.theorems.get("theorem")?.name, "定理", "the theorem map: elegantbook lang=cn");
    edit("lang=cn", "lang=en");
    await sleep(600);
    assert.equal(heard, 3, "a \\documentclass line is re-read: elegantbook's theorems are named in English now");
    const english = t.render.refsOf(t.root);
    assert.deepEqual([english.theorems.get("theorem")?.name, english.names.autoref.get("equation")], ["Theorem", "Equation"]);
    edit("lang=cn", "lang=en ");
    await sleep(600);
    assert.equal(heard, 3, "nothing changed: nobody hears");
    assert.equal(t.render.refsOf(t.root), english);
    edit("\\author{测试作者}", "\\author{测试作者}\\crefname{equation}{式}{式}");
    await sleep(600);
    assert.deepEqual(t.render.refsOf(t.root).names.cref.get("equation"), ["式", "式"], "a \\crefname line");
    assert.equal(heard, 4);
    t.render.fileModified(join(t.book, "elsewhere.tex"));
    await sleep(350);
    assert.equal(heard, 4, "a file the project does not read");
    off();
  } finally {
    t.done();
  }
});

test("TexRender hover: a block formula shows its PDF crop, else MathJax; a block its crop or why not; inline math never crops", async () => {
  const asked: string[] = [];
  let answer: HTMLElement | { note: string } = { note: NOTE_NO_PREVIEW };
  const crops: TexCrops = {
    locate: () => ({ note: NOTE_NO_PREVIEW }),
    render: async () => ({ ok: false, message: "unused", quiet: true }),
    hover: async (_root, file, text, line, kind, wait) => {
      asked.push(`${file.split("/").pop()}:${line}:${kind}:${wait}:${text.split("\n")[0]}`);
      return answer;
    },
  };
  const t = await setup({ crops });
  try {
    await t.render.load();
    const doc = [
      "Inline $x$ here.", // 1
      "\\[", // 2-4: a block formula
      "  \\E[Q]{X}",
      "\\]",
      "\\begin{theorem}{Title}{t}", // 5-9: elegantbook's tcolorbox
      "  Text with $y$.",
      "  \\[ z \\]",
      "\\end{theorem}",
      "\\begin{tabular}{l}", // 9-11
      "  a \\\\",
      "\\end{tabular}",
      "\\begin{minipage}{3cm}", // 12-14: crops nothing
      "  m",
      "\\end{minipage}",
    ].join("\n");
    const state = EditorState.create({ doc });
    const view = { state, dom: { ownerDocument: t.mainDocument } } as unknown as EditorView;
    const at = (line: number, col: number) => t.render.hoverTarget(state.doc, state.doc.line(line).from + col, t.root);
    const file = join(t.book, "chapters", "ch1.tex");
    const show = async (line: number, col: number) => {
      const target = at(line, col);
      return target && (await t.render.hover(target, view, t.root, file));
    };

    // A display formula owning its lines: the crop when there is one, else MathJax (no waiting).
    const card = t.mainDocument.createElement("div");
    card.className = "lsp-lp-paper ll-crop";
    answer = card;
    assert.equal(await show(3, 3), card);
    answer = { note: NOTE_CHANGED };
    assert.equal((await show(3, 3))!.nodeName, "MJX-CONTAINER");
    assert.deepEqual(asked, ["ch1.tex:2:math:false:\\[", "ch1.tex:2:math:false:\\["]);
    // Inline math, and math inside elegantbook's tcolorbox: MathJax, never a crop.
    asked.length = 0;
    assert.equal((await show(1, 8))!.nodeName, "MJX-CONTAINER");
    assert.equal((await show(7, 5))!.nodeName, "MJX-CONTAINER");
    assert.deepEqual(asked, []);

    // Text in a theorem box or a table: the block's crop (waiting for a running compile), or the note.
    assert.deepEqual(at(6, 3), { kind: "block", from: state.doc.line(5).from, to: state.doc.line(8).to, env: "theorem" });
    answer = card;
    assert.equal(await show(6, 3), card);
    answer = { note: NOTE_CHANGED };
    assert.equal((await show(10, 3))!.textContent, NOTE_CHANGED);
    answer = { note: NOTE_NO_PREVIEW };
    assert.equal(await show(10, 3), null, "no preview: no section (texlab's hover alone)");
    assert.deepEqual(asked, ["ch1.tex:5:box:true:\\begin{theorem}{Title}{t}", "ch1.tex:9:picture:true:\\begin{tabular}{l}", "ch1.tex:9:picture:true:\\begin{tabular}{l}"]);
    assert.equal(at(13, 1), null, "an environment without a crop");
    assert.equal(at(1, 2), null, "plain text");
  } finally {
    t.done();
  }
});

test("TexRender hover: what MathJax rejects goes to a fragment compile (not an unbalanced brace); blocks without a crop too", async () => {
  const asked: { body: string; inline: boolean }[] = [];
  let answer: HTMLElement | { error: string } | null = null;
  const fragments: TexFragments = {
    render: async (_root, body, inline) => (asked.push({ body, inline }), answer),
  };
  let crop: HTMLElement | { note: string } = { note: NOTE_CHANGED };
  const crops: TexCrops = {
    locate: () => ({ note: NOTE_NO_PREVIEW }),
    render: async () => ({ ok: false, message: "unused", quiet: true }),
    hover: async () => crop,
  };
  let fallback = true;
  const t = await setup({ crops, fragments, fallback: () => fallback });
  try {
    await t.render.load();
    const card = t.mainDocument.createElement("div");
    card.className = "lsp-lp-paper ll-fragment";
    const doc = [
      "Inline $\\intertext{x}$ and $\\frac{a}{$ and $\\alpha$.", // 1
      "\\begin{align}", // 2-5
      "  a &= b \\label{eq:var-def} \\\\",
      "  \\intertext{so} c &= d \\eqref{eq:var-def}",
      "\\end{align}",
      "\\begin{tabular}{l}", // 6-8
      "  a \\\\",
      "\\end{tabular}",
    ].join("\n");
    writeFileSync(join(t.outDir, "main.aux"), "\\newlabel{eq:var-def}{{1.2}{3}{}{equation.1.2}{}}\n");
    const state = EditorState.create({ doc });
    const view = { state, dom: { ownerDocument: t.mainDocument } } as unknown as EditorView;
    const file = join(t.book, "chapters", "ch1.tex");
    const show = async (line: number, col: number) => {
      const target = t.render.hoverTarget(state.doc, state.doc.line(line).from + col, t.root);
      return target && (await t.render.hover(target, view, t.root, file));
    };
    const message = (el: HTMLElement | null) => el?.querySelector(".lsp-render-hover-message")?.textContent;

    // Inline math MathJax rejects: the fragment's card; a TeX failure or none shows MathJax's message.
    answer = card;
    assert.equal(await show(1, 9), card);
    assert.deepEqual(asked, [{ body: "$\\intertext{x}$", inline: true }]);
    answer = { error: "Undefined control sequence." };
    assert.match(message(await show(1, 9)) ?? "", /intertext/, "MathJax's message, as without fragments");
    answer = null;
    assert.match(message(await show(1, 9)) ?? "", /intertext/);
    // MathJax renders it, or an unbalanced brace: no fragment compile.
    asked.length = 0;
    assert.equal((await show(1, 50))!.nodeName, "MJX-CONTAINER");
    assert.equal(message(await show(1, 30)), "Missing close brace");
    assert.deepEqual(asked, []);
    // The setting off: MathJax's message.
    fallback = false;
    assert.match(message(await show(1, 9)) ?? "", /intertext/);
    assert.deepEqual(asked, []);
    fallback = true;

    // A numbered display: its starred form with the .aux's number; references stay for TeX.
    answer = card;
    assert.equal(await show(3, 3), card);
    assert.deepEqual(asked, [
      { body: "\\begin{align*}\n  a &= b  \\tag{1.2}\\\\\n  \\intertext{so} c &= d \\eqref{eq:var-def}\n\\end{align*}", inline: false },
    ]);

    // A block: its crop; changed since the compile, the fragment; TeX's message when that fails;
    // the note when there is no fragment.
    asked.length = 0;
    crop = card;
    assert.equal(await show(7, 3), card);
    assert.deepEqual(asked, []);
    crop = { note: NOTE_CHANGED };
    const fragmentCard = t.mainDocument.createElement("div");
    answer = fragmentCard;
    assert.equal(await show(7, 3), fragmentCard);
    assert.deepEqual(asked, [{ body: "\\begin{tabular}{l}\n  a \\\\\n\\end{tabular}", inline: false }]);
    answer = { error: "Misplaced alignment tab character &." };
    assert.equal(message(await show(7, 3)), "Misplaced alignment tab character &.");
    answer = null;
    assert.equal((await show(7, 3))!.textContent, NOTE_CHANGED);
    crop = { note: NOTE_NO_PREVIEW };
    assert.equal(await show(7, 3), null, "no preview, no fragment: no section");
  } finally {
    t.done();
  }
});

test("fragmentBody: numbered displays starred with their .aux tags, boxes and floats numbered from their labels' anchors", async () => {
  const t = await setup();
  try {
    writeFileSync(
      join(t.outDir, "chapters", "ch1.aux"),
      [
        "\\newlabel{thm:total-exp}{{1.1}{2}{}{tcb@cnt@theorem.1.1}{}}",
        "\\newlabel{eq:total-exp}{{1.1}{2}{}{equation.1.1}{}}",
        "\\newlabel{tab:decomp}{{2.1}{5}{}{table.caption.4}{}}",
        "",
      ].join("\n"),
    );
    const refs = t.render.refsOf(t.root);
    const doc = EditorState.create({
      doc: [
        "\\begin{theorem}{全期望公式}{total-exp}", // 1-6
        "  若",
        "  \\begin{equation}\\label{eq:total-exp}",
        "    \\E{X} = \\E{\\E{X \\mid Y}}.",
        "  \\end{equation}",
        "\\end{theorem}",
        "\\begin{table}[htbp]", // 7-11
        "  \\centering",
        "  \\begin{tabular}{ll} a & b \\end{tabular}",
        "  \\caption{矩阵分解}\\label{tab:decomp}",
        "\\end{table}",
        "$x$ and \\begin{equation} y \\end{equation}", // 12
        "\\begin{eqnarray}", // 13-15
        "  a &=& b \\label{eq:total-exp}",
        "\\end{eqnarray}",
        "\\begin{equation}", // 16-19
        "  y",
        "  \\label{eq:total-exp}",
        "\\end{equation}",
      ].join("\n"),
    }).doc;
    const target = (line: number, col = 2) => t.render.hoverTarget(doc, doc.line(line).from + col, t.root)!;
    assert.equal(
      fragmentBody(doc, target(2), refs),
      [
        "\\expandafter\\def\\csname thetcb@cnt@theorem\\endcsname{1.1}\\begin{theorem}{全期望公式}{total-exp}",
        "  若",
        "  \\begin{equation*}",
        "    \\E{X} = \\E{\\E{X \\mid Y}}.",
        "  \\tag{1.1}\\end{equation*}",
        "\\end{theorem}",
      ].join("\n"),
    );
    assert.equal(
      fragmentBody(doc, target(8), refs),
      [
        "\\expandafter\\def\\csname thetable\\endcsname{2.1}\\begin{minipage}{\\linewidth}\\expandafter\\def\\csname @captype\\endcsname{table}",
        "  \\centering",
        "  \\begin{tabular}{ll} a & b \\end{tabular}",
        "  \\caption{矩阵分解}\\label{tab:decomp}",
        "\\end{minipage}",
      ].join("\n"),
    );
    assert.equal(fragmentBody(doc, target(12, 1), refs), "$x$");
    assert.equal(fragmentBody(doc, target(12, 20), refs), "\\begin{equation*} y \\end{equation*}", "no label: no number");
    assert.equal(fragmentBody(doc, target(14), refs), doc.sliceString(doc.line(13).from, doc.line(15).to), "eqnarray takes no \\tag");
    assert.equal(fragmentBody(doc, target(17), refs), "\\begin{equation*}\n  y\n\\tag{1.1}\\end{equation*}", "no blank line (a paragraph break) where the label was");

    // A box without a label in an \include'd chapter: its counted number (the head's), on its counter.
    writeFileSync(
      join(t.outDir, "chapters", "ch2.aux"),
      "\\@writefile{toc}{\\contentsline {chapter}{\\numberline {第二章}线性代数}{2}{chapter.2}\\protected@file@percent }\n\\@setckpt{chapters/ch2}{\n\\setcounter{exam}{1}\n}\n",
    );
    t.render.compiled(t.root);
    await sleep(20);
    const chapter = EditorState.create({ doc: "\\chapter{线性代数}\n\\begin{example}[矩阵]\n  $A$\n\\end{example}" }).doc;
    const example = t.render.hoverTarget(chapter, chapter.line(3).from, t.root)!;
    const counted = t.render.refsOf(t.root);
    assert.equal(fragmentBody(chapter, example, counted, "chapters/ch2"), `\\expandafter\\def\\csname theexam\\endcsname{2.1}${chapter.sliceString(chapter.line(2).from)}`);
    assert.equal(fragmentBody(chapter, example, counted), chapter.sliceString(chapter.line(2).from), "without the file: no number (it prints 0.1)");
  } finally {
    t.done();
  }
});
