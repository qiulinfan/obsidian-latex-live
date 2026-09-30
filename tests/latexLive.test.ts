// T-L5, T-L8 and T-L9: LaTeX's live preview (latexLive.ts, design 4.4 #1-#4, #5-#11, #12 and
// #13, and P5's crops #4 and #14) on the real editor stack (texEditorExtensions, keyArbiter
// first) with TexRender's live renderer over Obsidian's MathJax (tests/support/mathjax.ts), on a
// temporary copy of the synthetic elegantbook fixture; chips and theorem numbers read static
// .aux excerpts (tests/fixtures/aux) and its refs.bib; images resolve in the copy (a stand-in for
// Obsidian's resource URLs and pdf.js); crops come from a stand-in for blockCrop's CropService
// (tests/crop.test.ts runs that on real TeX).
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EditorSelection, EditorState, SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLiveLanguage } from "../src/editor/latexLive";
import { DEFAULT_REF_NAMES, LatexRefs, refNames } from "../src/editor/latexRefs";
import { livePreview, renderStats } from "../src/editor/shared/livePreview";
import { showTexDiagnostics, texEditorExtensions } from "../src/editor/texExtensions";
import { TexCrops, TexRender } from "../src/editor/texRender";
import { NOTE_CHANGED } from "../src/preview/blockCrop";
import { readAuxLabels } from "../src/tex/aux";
import { theoremMap } from "../src/tex/theorems";
import { press, sleep, waitFor } from "./support/keyMatrix";
import { obsidianMathJax } from "./support/mathjax";

// jsdom has no layout: CodeMirror's vertical motion runs past the (empty) content rectangle
// there, and that branch returns a cursor without the goal column every real line move
// carries. `enterBlocks` corrects only line moves (those with a goal column): give it one.
const moveVertically = EditorView.prototype.moveVertically;
EditorView.prototype.moveVertically = function (this: EditorView, start: SelectionRange, forward: boolean, distance?: number) {
  const r = moveVertically.call(this, start, forward, distance);
  return r.goalColumn === undefined && r.head !== start.head ? EditorSelection.cursor(r.head, r.assoc, undefined, 0) : r;
};

/** The characters MathJax drew (its glyph classes `mjx-c<hex>`). */
const chars = (el: Element): string =>
  [...el.querySelectorAll("mjx-c")].map((c) => String.fromCodePoint(parseInt(c.className.split(" ")[0].slice(5), 16))).join("");

/** A copy of the fixture book with TexRender over Obsidian's MathJax (and `crops`), preloaded. */
async function project(crops?: TexCrops) {
  const { window: mw, MathJax } = await obsidianMathJax();
  const dir = mkdtempSync(join(tmpdir(), "ll-live-"));
  const book = join(dir, "book");
  cpSync(resolve("tests/fixtures/elegantbook"), book, { recursive: true });
  const outDir = join(dir, "out");
  mkdirSync(join(outDir, "chapters"), { recursive: true });
  const pdfPages: string[] = [];
  const render = new TexRender({
    outDirFor: () => outDir,
    buffers: () => new Map(),
    images: {
      url: (abs) => (abs.startsWith(book) ? `app://local${abs}` : null),
      pdfPage: async (abs, maxHeight) => {
        pdfPages.push(abs);
        await sleep(5);
        return { url: `data:image/png;base64,page1-${maxHeight}`, width: 120 };
      },
    },
    crops,
    mathJax: {
      load: async () => {},
      global: () => MathJax,
      finish: async () => {
        const sheet = MathJax.chtmlStylesheet();
        if (!sheet.isConnected) mw.document.head.appendChild(sheet);
      },
      document: mw.document,
    },
  });
  const root = join(book, "main.tex");
  assert.equal(await render.preload(root), true);
  const views: EditorView[] = [];
  /**
   * A live LaTeX editor for `doc`, focused, the cursor at `anchor` (else the end); refs from
   * `labels` (label numbers alone, or whole refs), else the root's (build folder and bibliography);
   * `file` its \include name.
   */
  const mount = async (doc: string, labels?: ReadonlyMap<string, string> | LatexRefs, anchor = doc.length, file?: string) => {
    const fixed: LatexRefs | undefined =
      !labels || "names" in labels ? labels : { numbers: labels, labels: new Map(), cites: new Map(), names: DEFAULT_REF_NAMES, theorems: new Map(), checkpoints: new Map() };
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: { anchor },
        extensions: texEditorExtensions({
          text: doc,
          diagnostics: true,
          live: livePreview({
            language: latexLiveLanguage({
              refs: () => fixed || render.refsOf(root),
              file,
              image: (path) => render.imageOf(root, path),
              crop: (d, from, to, kind) => render.cropOf(root, join(book, "chapters/ch2.tex"), d, from, to, kind),
            }),
            renderer: render.rendererFor(root),
          }),
        }),
      }),
    });
    views.push(view);
    view.focus();
    await sleep(40); // CodeMirror reports focus asynchronously
    await rendered(view);
    return view;
  };
  const done = () => {
    for (const v of views) v.destroy();
    render.dispose();
    rmSync(dir, { recursive: true, force: true });
  };
  return { render, root, book, outDir, mount, done, pdfPages };
}

/** Every render the view asked for has landed (a batch over its budget goes on in the next frames). */
const rendered = (view: EditorView) => waitFor(() => renderStats(view).pending === 0);

/** Widgets in place of source (not previews below revealed blocks). */
const inline = (view: EditorView) => [...view.contentDOM.querySelectorAll("span.lsp-lp-render")];
const blocks = (view: EditorView) => [...view.contentDOM.querySelectorAll("div.lsp-lp-render.is-block:not(.is-below)")];
const below = (view: EditorView) => view.contentDOM.querySelector("div.lsp-lp-render.is-below");
/** What the editor shows, top to bottom: each line's text ("[w]" for a widget) and "[below]" previews. */
const lines = (view: EditorView) =>
  [...view.contentDOM.children].map((el) => {
    if (el.classList.contains("is-below")) return "[below]";
    if (!el.classList.contains("cm-line")) return el.classList.contains("lsp-lp-render") ? "[w]" : `<${el.className}>`;
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll(".lsp-lp-render").forEach((w) => w.replaceWith("[w]"));
    return copy.textContent ?? "";
  });
const errors = (view: EditorView) => [...view.contentDOM.querySelectorAll(".lsp-lp-error")].map((e) => e.textContent);

const DOC = [
  "Inline $a^2$ and \\(\\E{X}\\) here.", // 1: #1
  "\\[", // 2-4: #2, a block
  "  \\norm{x}",
  "\\] % a comment after it",
  "text \\[ y_1 \\] more", // 5: #2 in running text
  "$$", // 6-8: #2, a block
  "  \\KL{P}{Q}",
  "$$",
  "\\begin{align}", // 9-12: #3 with labels
  "  a &= b \\label{eq:one} \\\\",
  "  c &= d \\label{eq:two}",
  "\\end{align}",
  "\\begin{align*}", // 13-15: #3 starred, no number
  "  e &= f \\label{eq:one}",
  "\\end{align*}",
  "\\begin{equation*}", // 16-18: #4 tikz-cd
  "  \\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}",
  "\\end{equation*}",
  "$\\undefinedmacro$ fails", // 19: #4 inline
  "$z$", // 20: inline math alone on its line
  "% $c$ in a comment, \\[ d \\]", // 21
  "\\verb|$v$| is verbatim", // 22
  "",
].join("\n");
const LABELS = new Map([
  ["eq:one", "1.1"],
  ["eq:two", "1.2"],
]);

test("T-L5 #1-#4: inline, block and display widgets, numbers from the labels, failures keep their source", async () => {
  const p = await project();
  try {
    const view = await p.mount(DOC, LABELS);
    assert.deepEqual(
      inline(view).map((w) => [w.className, chars(w)]),
      [
        ["lsp-lp-render lsp-lp-math", "𝑎2"],
        ["lsp-lp-render lsp-lp-math", "𝔼[𝑋]"],
        ["lsp-lp-render lsp-lp-math is-display", "𝑦1"],
        ["lsp-lp-render lsp-lp-math", "𝑧"],
      ],
      "#1 and a display formula in running text (the project's \\E)",
    );
    const b = blocks(view);
    assert.equal(b.length, 4, "\\[..\\], $$..$$, align, align*");
    assert.ok(b.every((w) => w.querySelector("mjx-container[display=true]")));
    assert.match(chars(b[0]), /‖𝑥‖/, "\\norm from macros.tex");
    assert.equal(chars(b[2]), "𝑎=𝑏𝑐=𝑑(1.1)(1.2)", "\\label -> \\tag{n} per row (MathJax draws the numbers in a column)");
    assert.equal(chars(b[3]), "𝑒=𝑓", "starred: no number");
    assert.deepEqual(
      lines(view),
      [
        "Inline [w] and [w] here.",
        "[w]", // the block replaces its lines (and the comment after it)
        "text [w] more",
        "[w]",
        "[w]",
        "[w]",
        "\\begin{equation*}",
        "  \\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}",
        "\\end{equation*}",
        "$\\undefinedmacro$ fails",
        "[w]",
        "% $c$ in a comment, \\[ d \\]",
        "\\verb|$v$| is verbatim",
        "",
      ],
    );
    assert.deepEqual(errors(view), [
      "\\begin{equation*}",
      "  \\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}",
      "\\end{equation*}",
      "$\\undefinedmacro$",
    ], "#4: MathJax's failures keep their source with the error underline");
  } finally {
    p.done();
  }
});

test("T-L5 reveal: an inline formula touched (inclusively), a block's lines with its rendering below", async () => {
  const p = await project();
  try {
    const view = await p.mount("a $x$ b\n\\begin{align}\n  u &= v \\label{eq:one}\n\\end{align}\nend", LABELS);
    const at = (pos: number) => view.dispatch({ selection: EditorSelection.cursor(pos) });
    assert.deepEqual([inline(view).length, blocks(view).length], [1, 1]);
    at(5);
    assert.equal(lines(view)[0], "a $x$ b", "the cursor right after $x$");
    at(6);
    assert.equal(lines(view)[0], "a [w] b");
    at(view.state.doc.line(3).from + 4);
    assert.deepEqual(lines(view).slice(1, 5), ["\\begin{align}", "  u &= v \\label{eq:one}", "\\end{align}", "[below]"]);
    assert.match(chars(below(view)!), /𝑢=𝑣\(1\.1\)/, "the rendering below the source keeps the number");
    view.contentDOM.blur();
    await waitFor(() => !view.hasFocus && below(view) === null);
    assert.deepEqual([inline(view).length, blocks(view).length, below(view)], [1, 1, null], "blurred: all rendered");
  } finally {
    p.done();
  }
});

test("T-L5 the preamble is never decorated; a compile error keeps its formula's source", async () => {
  const p = await project();
  try {
    const doc = "\\documentclass{article}\n\\newcommand{\\x}{$y$}\n\\begin{document}\n$a$ and $b$\n\\[ c \\]\n\\end{document}\n";
    const view = await p.mount(doc, LABELS);
    assert.deepEqual(lines(view).slice(0, 5), ["\\documentclass{article}", "\\newcommand{\\x}{$y$}", "\\begin{document}", "[w] and [w]", "[w]"]);
    showTexDiagnostics(view, [{ severity: "error", file: null, line: 5, message: "Missing $ inserted." }]);
    assert.equal(lines(view)[4], "\\[ c \\]", "an error diagnostic on its line: source with the lint underline");
    showTexDiagnostics(view, []);
    assert.equal(lines(view)[4], "[w]");
  } finally {
    p.done();
  }
});

test("T-L5 numbers follow the build folder: a renumbering compile re-renders only the formulas it changed", async () => {
  const p = await project();
  try {
    const aux = join(p.outDir, "chapters", "ch1.aux");
    const write = (n: number) =>
      writeFileSync(aux, `\\newlabel{eq:one}{{1.${n}}{1}{}{equation.1.${n}}{}}\n\\newlabel{eq:two}{{2.1}{1}{}{equation.2.1}{}}\n`);
    write(1);
    p.render.compiled(p.root); // a compile before the view opened: read at first use anyway
    const doc = "\\begin{equation}\n  x \\label{eq:one}\n\\end{equation}\n\\begin{equation}\n  y \\label{eq:two}\n\\end{equation}\n$w$ \\eqref{eq:one}\n";
    const view = await p.mount(doc);
    assert.deepEqual(blocks(view).map(chars), ["𝑥(1.1)", "𝑦(2.1)"]);
    const renders = renderStats(view).renders;
    write(7);
    p.render.compiled(p.root);
    // The label read (a timeout), then the views rebuild on the next frame.
    await waitFor(() => chars(blocks(view)[0] ?? view.contentDOM) === "𝑥(1.7)");
    assert.deepEqual(blocks(view).map(chars), ["𝑥(1.7)", "𝑦(2.1)"]);
    assert.equal(renderStats(view).renders, renders + 1, "only the renumbered equation");
    p.render.compiled(p.root);
    await sleep(40);
    assert.equal(renderStats(view).renders, renders + 1, "same numbers: nothing");
  } finally {
    p.done();
  }
});

test("T-L5 a changed definition (a new instance, a new epoch) re-renders the widgets with it", async () => {
  const p = await project();
  try {
    const view = await p.mount("$\\Lip$ and $\\N$\n");
    assert.deepEqual(inline(view).map(chars), ["𝐿", "ℕ0"], "ch2's \\Lip, main.tex's \\renewcommand{\\N}");
    const ch2 = join(p.book, "chapters", "ch2.tex");
    writeFileSync(ch2, readFileSync(ch2, "utf8").replace("\\newcommand{\\Lip}{L}", "\\newcommand{\\Lip}{K}"));
    p.render.fileModified(ch2);
    await sleep(250);
    assert.deepEqual(inline(view).map(chars), ["𝐿", "ℕ0"], "the 300 ms debounce");
    await waitFor(() => inline(view).map(chars).join() === "𝐾,ℕ0");
  } finally {
    p.done();
  }
});

test("T-L5 keys stay keyArbiter's: ArrowDown and ArrowUp enter a LaTeX block, which reveals", async () => {
  const p = await project();
  try {
    // (jsdom's vertical motion jumps to the document's end or start; enterBlocks brings it back.)
    const view = await p.mount("top\n\\[\n  x\n\\]\nend", LABELS, 0);
    assert.equal(blocks(view).length, 1);
    assert.deepEqual(press(view, "ArrowDown"), { handled: true, propagated: true });
    assert.equal(view.state.doc.lineAt(view.state.selection.main.head).number, 2);
    assert.equal(blocks(view).length, 0, "revealed");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    assert.equal(blocks(view).length, 1);
    press(view, "ArrowUp");
    assert.equal(view.state.selection.main.head, view.state.doc.line(4).to);
    assert.equal(blocks(view).length, 0);
  } finally {
    p.done();
  }
});

// ---- T-L8: text constructs (#5-#11) ------------------------------------------------------

/**
 * Each line as shown: render widgets as "[w]" ("[img]" for images, "below" for the rendering
 * under a revealed block), chips, list markers, theorem heads and proof marks as "[text]",
 * hidden markup gone; a collapsed line (a block replace without a widget) as "(collapsed)";
 * the lines in a theorem box prefixed with "│ " (per box).
 */
const shown = (view: EditorView) => rows(view.contentDOM, "");
function rows(parent: Element, prefix: string): string[] {
  const out: string[] = [];
  for (const el of parent.children) {
    if (el.classList.contains("lsp-lp-box")) {
      out.push(...rows(el, `${prefix}│ `));
      continue;
    }
    if (!el.classList.contains("cm-line")) {
      const cls = el.classList;
      out.push(prefix + (cls.contains("lsp-lp-render") ? `[${cls.contains("lsp-lp-image") ? "img" : "w"}${cls.contains("is-below") ? " below" : ""}]` : "(collapsed)"));
      continue;
    }
    out.push(prefix + lineText(el));
  }
  return out;
}
/** A line's text with its widgets as in `shown` (a theorem head's chip is a widget: not editable, unlike its title in place). */
function lineText(node: Node): string {
  if (!(node instanceof Element)) return node.textContent ?? "";
  if (node.classList.contains("lsp-lp-render")) return "[w]";
  const widget = (node as HTMLElement).contentEditable === "false";
  if (node.matches(".lsp-lp-chip, .lsp-lp-bullet, .lsp-lp-qed") || (widget && node.classList.contains("lsp-lp-box-title"))) return `[${node.textContent}]`;
  return [...node.childNodes].map(lineText).join("");
}
/** The chips (refs, cites, labels) with their classes' state. */
const chips = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll(".lsp-lp-chip")].map((c) => (c.classList.contains("is-missing") ? `!${c.textContent}` : c.textContent));
const cursorAt = (view: EditorView, pos: number) => view.dispatch({ selection: EditorSelection.cursor(pos) });

const TEXT = [
  "\\chapter{概率与期望}\\label{chap:prob}", // 1: #5 and #11
  "\\section*{A \\emph{short} title}", // 2
  "Text with \\textbf{bold}, \\emph{emph}, \\underline{u}, \\texttt{tt} and \\textsc{sc}.", // 3: #6
  "\\begin{enumerate}[(a)]", // 4: #8
  "  \\item first", // 5: #7
  "  \\item second",
  "  \\begin{itemize}",
  "    \\item nested $x$",
  "  \\end{itemize}",
  "\\end{enumerate}", // 10
  "\\begin{description}",
  "  \\item[Markov] bound",
  "\\end{description}",
  "\\begin{center}",
  "centered", // 15
  "\\end{center}",
  "end",
].join("\n");

test("T-L8 #5-#8: headings, text styles, list markers and collapsed list lines", async () => {
  const p = await project();
  try {
    const view = await p.mount(TEXT, LABELS);
    assert.deepEqual(shown(view), [
      "概率与期望[chap:prob]",
      "A short title",
      "Text with bold, emph, u, tt and sc.",
      "(collapsed)",
      "  [(a)] first",
      "  [(b)] second",
      "(collapsed)",
      "    [•] nested [w]",
      "(collapsed)",
      "(collapsed)",
      "(collapsed)",
      "  [Markov] bound",
      "(collapsed)",
      "(collapsed)",
      "centered",
      "(collapsed)",
      "end",
    ]);
    const heading = (level: number) => [...view.contentDOM.querySelectorAll(`.cm-line.lsp-lp-h${level}`)].map((l) => l.textContent);
    assert.deepEqual([heading(1), heading(2)], [["概率与期望chap:prob"], ["A short title"]], "heading line classes");
    assert.deepEqual(
      ["strong", "em", "u", "tt", "sc"].map((s) => [...view.contentDOM.querySelectorAll(`.lsp-lp-${s}`)].map((e) => e.textContent).join()),
      ["bold", "short,emph", "u", "tt", "sc"],
    );
    assert.ok(view.contentDOM.querySelector(".lsp-lp-bullet.is-term")?.textContent === "Markov", "a description's term");
  } finally {
    p.done();
  }
});

test("T-L8 reveal: a heading at its command or closing brace, a style anywhere in it, an item only at its token, a list line on its line", async () => {
  const p = await project();
  try {
    const view = await p.mount(TEXT, LABELS);
    const doc = view.state.doc;
    const at = (n: number, text: string, offset = 0) => doc.line(n).from + doc.line(n).text.indexOf(text) + offset;
    cursorAt(view, at(1, "率"));
    assert.equal(shown(view)[0], "概率与期望[chap:prob]", "inside the title: the markup stays hidden");
    assert.ok(view.contentDOM.querySelector(".lsp-lp-h1"), "the heading's line class stays");
    cursorAt(view, at(1, "概"));
    assert.equal(shown(view)[0], "\\chapter{概率与期望}[chap:prob]", "touching `\\chapter{`");
    cursorAt(view, at(1, "}", 1));
    assert.equal(shown(view)[0], "\\chapter{概率与期望}\\label{chap:prob}", "touching the `}` (and the label right after it)");
    cursorAt(view, at(3, "old"));
    assert.equal(shown(view)[2], "Text with \\textbf{bold}, emph, u, tt and sc.");
    assert.equal(view.contentDOM.querySelector(".lsp-lp-strong")?.textContent, "bold", "the mark stays while revealed");
    cursorAt(view, at(5, "first", 2));
    assert.equal(shown(view)[4], "  [(a)] first", "typing after the marker keeps it");
    cursorAt(view, at(5, "\\item", 5));
    assert.equal(shown(view)[4], "  \\item first", "right after `\\item`");
    cursorAt(view, at(4, "(a)"));
    assert.deepEqual(shown(view).slice(3, 5), ["\\begin{enumerate}[(a)]", "  [(a)] first"]);
    view.contentDOM.blur();
    await waitFor(() => !view.hasFocus && shown(view)[3] === "(collapsed)");
    assert.equal(shown(view)[0], "概率与期望[chap:prob]", "blurred: all rendered");
  } finally {
    p.done();
  }
});

test("T-L8 #7: an \\item label with math stays in place, its formula rendered and a term's text bold; its brackets reveal", async () => {
  const p = await project();
  try {
    const doc = [
      "\\begin{description}",
      "  \\item[$\\sigma$-代数] 集族",
      "  \\item[Markov] bound",
      "\\end{description}",
      "\\begin{itemize} \\item[$\\alpha$] alpha \\item[--] dash \\end{itemize}",
      "end",
    ].join("\n");
    const view = await p.mount(doc, LABELS);
    assert.deepEqual(shown(view), ["(collapsed)", "  [w]-代数 集族", "  [Markov] bound", "(collapsed)", "\\begin{itemize} [w] alpha [–] dash \\end{itemize}", "end"]);
    assert.equal(chars(inline(view)[0]), "𝜎", "MathJax's italic sigma");
    assert.deepEqual([...view.contentDOM.querySelectorAll(".lsp-lp-strong")].map((e) => e.textContent?.replace(/\s+/g, "")), ["-代数"], "the term's text is bold");
    const at = (text: string) => doc.indexOf(text);
    cursorAt(view, at("代数"));
    assert.equal(shown(view)[1], "  [w]-代数 集族", "typing in the label keeps the item rendered");
    cursorAt(view, at("\\item[$\\sigma"));
    assert.equal(shown(view)[1], "  \\item[[w]-代数] 集族", "touching `\\item[`");
    cursorAt(view, at("] 集族") + 1);
    assert.equal(shown(view)[1], "  \\item[[w]-代数] 集族", "touching `]`");
  } finally {
    p.done();
  }
});

test("T-L8 #9-#11: chips from the build folder's labels and the bibliography, as the PDF prints them (English names under elegantbook lang=cn too)", async () => {
  const p = await project();
  try {
    cpSync(resolve("tests/fixtures/aux/book"), p.outDir, { recursive: true });
    const doc = [
      "见 \\ref{eq:var-def}、\\eqref{eq:var-short}、\\autoref{thm:total-exp}、\\cref{eq:total-exp}、\\Cref{chap:prob}、",
      "\\cref{fig:grid,tab:decomp}、\\cref{eq:var-def,eq:trace}、\\pageref{pro:psd}、\\nameref{chap:linalg}、\\ref{nope}。",
      "\\cite[第 2 章]{zhang2020notes} \\cite{li2019lln,zhang2020notes} \\parencite[see][p.~3]{li2019lln} \\cite{missing}",
      "\\label{sec:here} $\\label{eq:in-math} y$",
    ].join("\n");
    const view = await p.mount(doc, undefined, 0);
    assert.deepEqual(chips(view), [
      "1.2",
      "(1.3)",
      "1.1", // hyperref has no name for elegantbook's tcolorbox theorems
      "eq. (1.1)", // cleveref's defaults (the book does not load it: the anchor's counter)
      "Chapter 1",
      "fig. 2.1 and table 2.1",
      "eqs. (1.2) and (2.1)",
      "2",
      "线性代数",
      "!??",
      "[张三、李四 2020, 第 2 章]",
      "[Li et al. 2019; 张三、李四 2020]",
      "[see Li et al. 2019, p. 3]",
      "![missing]",
      "sec:here",
    ]);
    const chip = (text: string) => [...view.contentDOM.querySelectorAll<HTMLElement>(".lsp-lp-chip")].find((c) => c.textContent === text)!;
    assert.ok(chip("1.2").classList.contains("is-ref") && chip("sec:here").classList.contains("is-label"));
    assert.equal(chip("1.2").title, "\\ref{eq:var-def}", "a ref chip's tooltip is its source");
    assert.equal(chip("[Li et al. 2019; 张三、李四 2020]").title, "li2019lln: Li et al. 2019. A Toy Proof of the Strong Law of Large Numbers\nzhang2020notes: 张三、李四 2020. 概率论讲义（示例版）");
    assert.equal(chip("![missing]".slice(1)).title, "missing: not in the bibliography");
    const end = doc.indexOf("}", doc.indexOf("\\ref{eq:var-def}")) + 1;
    cursorAt(view, end);
    assert.ok(shown(view)[0].startsWith("见 \\ref{eq:var-def}、[(1.3)]、"), "the chip the cursor touches shows its source");
  } finally {
    p.done();
  }
});

test("T-L8 reference names: hyperref's by the anchor, cleveref's by the .aux type with the project's options", async () => {
  const p = await project();
  try {
    const labels = readAuxLabels(resolve("tests/fixtures/aux/article"));
    const doc =
      "\\autoref{eq:bv-expand} \\cref{eq:wstar} \\Cref{def:linear} \\cref{fig:curve} \\autoref{app:derivations} " +
      "\\cref{lem:plain} \\ref{it:tight} \\autoref{fn:toy} \\cref{sec:intro,app:derivations} \\eqref{eq:wstar} \\autoref{nope}\n" +
      "$\\text{by \\Cref{def:linear}}$\n";
    const view = await p.mount(doc, { numbers: new Map(), labels, cites: new Map(), names: DEFAULT_REF_NAMES, theorems: new Map(), checkpoints: new Map() });
    assert.equal(chars(inline(view)[0]).replace(/\u00a0/g, " "), "by Theorem 2.1", "a reference inside a formula reads as its chip");
    assert.deepEqual(chips(view), [
      "Equation 2a",
      "eq. (⋆)",
      "Theorem 2.1",
      "fig. 1",
      "Appendix A",
      "lemma 3.2",
      "i",
      "footnote 1",
      "section 1 and appendix A",
      "(⋆)",
      "!??",
    ]);
    // \usepackage[capitalise,noabbrev]{cleveref} and a redefined \sectionautorefname.
    const names = refNames(["\\usepackage[capitalise,noabbrev]{cleveref}\n\\renewcommand{\\sectionautorefname}{Section}"]);
    const named = await p.mount(doc.replace("\\autoref{fn:toy}", "\\autoref{sec:intro}"), { numbers: new Map(), labels, cites: new Map(), names, theorems: new Map(), checkpoints: new Map() });
    assert.deepEqual(chips(named).slice(0, 9), [
      "Equation 2a",
      "Equation (⋆)",
      "Theorem 2.1",
      "Figure 1",
      "Appendix A",
      "Lemma 3.2",
      "i",
      "Section 1",
      "Section 1 and Appendix A",
    ]);
  } finally {
    p.done();
  }
});

test("T-L8 chips follow the refs: a compile result, a saved .bib and a view opening rebuild the live views", async () => {
  const p = await project();
  try {
    const view = await p.mount("\\ref{eq:var-def} \\cite{li2019lln}\n");
    assert.deepEqual(chips(view), ["!??", "[Li et al. 2019]"], "nothing compiled yet");
    cpSync(resolve("tests/fixtures/aux/book"), p.outDir, { recursive: true });
    p.render.compiled(p.root);
    await waitFor(() => chips(view)[0] === "1.2");

    const bib = join(p.book, "refs.bib");
    writeFileSync(bib, readFileSync(bib, "utf8").replace("Li, Wei and Doe, Jane and Roe, Richard", "Zhou, Kai"));
    p.render.fileModified(bib);
    await sleep(200);
    assert.equal(chips(view)[1], "[Li et al. 2019]", "a saved .bib is re-read after 300 ms");
    await waitFor(() => chips(view)[1] === "[Zhou 2019]");

    const ch1 = join(p.outDir, "chapters", "ch1.aux");
    writeFileSync(ch1, readFileSync(ch1, "utf8").replace("{{1.2}{1}", "{{1.9}{1}"));
    p.render.opened(p.root); // a compile that ran elsewhere
    await waitFor(() => chips(view)[0] === "1.9");
  } finally {
    p.done();
  }
});

test("T-L8 an error diagnostic on a line keeps its text constructs source", async () => {
  const p = await project();
  try {
    const view = await p.mount("\\begin{itemize}\n  \\item \\textbf{a} \\ref{x}\n\\end{itemize}\nend", LABELS);
    assert.deepEqual(shown(view), ["(collapsed)", "  [•] a [??]", "(collapsed)", "end"]);
    showTexDiagnostics(view, [{ severity: "error", file: null, line: 2, message: "Undefined control sequence." }]);
    assert.deepEqual(shown(view), ["(collapsed)", "  \\item \\textbf{a} \\ref{x}", "(collapsed)", "end"]);
    showTexDiagnostics(view, []);
    assert.equal(shown(view)[1], "  [•] a [??]");
  } finally {
    p.done();
  }
});

test("T-L8 keys stay keyArbiter's: arrows reveal collapsed lines one at a time; Enter continues a list", async () => {
  const p = await project();
  try {
    // (jsdom's vertical motion jumps to the document's end; enterBlocks stops it on the next hidden line.)
    const view = await p.mount("top\n\\begin{center}\n\\end{center}\nend", LABELS, 0);
    assert.deepEqual(shown(view), ["top", "(collapsed)", "(collapsed)", "end"]);
    press(view, "ArrowDown");
    assert.equal(view.state.doc.lineAt(view.state.selection.main.head).number, 2);
    assert.deepEqual(shown(view), ["top", "\\begin{center}", "(collapsed)", "end"]);
    press(view, "ArrowDown");
    assert.equal(view.state.doc.lineAt(view.state.selection.main.head).number, 3);
    assert.deepEqual(shown(view), ["top", "(collapsed)", "\\end{center}", "end"]);

    const list = await p.mount("\\begin{enumerate}\n  \\item first\n\\end{enumerate}\n", LABELS, "\\begin{enumerate}\n  \\item first".length);
    assert.equal(press(list, "Enter").handled, true);
    assert.equal(list.state.doc.toString(), "\\begin{enumerate}\n  \\item first\n  \\item \n\\end{enumerate}\n", "latexEnter's continueItem");
    assert.deepEqual(shown(list), ["(collapsed)", "  [1.] first", "  [2.] ", "(collapsed)", ""], "the new item's marker at once");
    list.dispatch({ changes: { from: list.state.selection.main.head, insert: "x" }, selection: { anchor: list.state.selection.main.head + 1 } });
    assert.equal(shown(list)[2], "  [2.] x");
  } finally {
    p.done();
  }
});

// ---- T-L9: theorem boxes (#12), figure and table lines (#8), images (#13) ---------------------

/** The theorem boxes: class, colour and the first line's text. */
const boxes = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll<HTMLElement>(".lsp-lp-box")].map((b) => [b.className, b.style.getPropertyValue("--lp-box-color").trim()]);

const BOOK_BOXES = [
  "\\begin{definition}{概率空间 Probability space}{prob-space}", // 1
  "  三元组 $(\\Omega, \\mathcal{F}, \\Prob)$。",
  "\\end{definition}",
  "\\begin{theorem}{全期望公式 Law of total expectation}{total-exp}", // 4
  "  若 $\\E{\\abs{X}} < \\infty$，则",
  "  \\begin{equation}\\label{eq:total-exp}",
  "    \\E{X} = \\E{\\E{X \\mid Y}}.",
  "  \\end{equation}",
  "\\end{theorem}",
  "\\begin{proof}", // 10
  "  由定义~\\ref{def:prob-space}。",
  "\\end{proof}",
  "\\begin{proposition}{半正定 $A \\succeq 0$}{psd} % a title with math", // 13
  "  x",
  "\\end{proposition}",
  "\\begin{example}[抛硬币 Coin tossing]", // 16
  "  $p$",
  "\\end{example}",
  "\\begin{lemma*}[无编号]",
  "\\end{lemma*}",
  "\\begin{theorem}", // 21: no label, no number
  "\\end{theorem}",
  "\\begin{unknown}", // not theorem-like
  "\\end{unknown}",
  "end",
].join("\n");

test("T-L9 #12: elegantbook's boxes with their heads as the PDF prints them, numbers from the .aux, the scheme's colours", async () => {
  const p = await project();
  try {
    cpSync(resolve("tests/fixtures/aux/book"), p.outDir, { recursive: true });
    const view = await p.mount(BOOK_BOXES, undefined, BOOK_BOXES.length);
    assert.deepEqual(shown(view), [
      "│ [定义 1.1 (概率空间 Probability space)]",
      "│   三元组 [w]。",
      "│ (collapsed)",
      "│ [定理 1.1 (全期望公式 Law of total expectation)]",
      "│   若 [w]，则",
      "│ [w]",
      "│ (collapsed)",
      "│ [证明]",
      "│   由定义~[1.1]。",
      "│ (collapsed)",
      "│ [命题 2.1 (]半正定 [w][)]", // the title stays in place, its formula rendered
      "│   x",
      "│ (collapsed)",
      "│ [例题 抛硬币 Coin tossing]", // elegantbook's example: its counter has no label here
      "│   [w]",
      "│ (collapsed)",
      "│ [引理 (无编号)]",
      "│ (collapsed)",
      "│ [定理]",
      "│ (collapsed)",
      "\\begin{unknown}",
      "\\end{unknown}",
      "end",
    ]);
    // The fixture book sets no colour: elegantbook's default scheme is blue (main 0,166,82, second 255,134,24, third 0,174,247).
    assert.deepEqual(boxes(view), [
      ["lsp-lp-box is-main", "rgb(0, 166, 82)"],
      ["lsp-lp-box is-second", "rgb(255, 134, 24)"],
      ["lsp-lp-box is-second", "rgb(255, 134, 24)"],
      ["lsp-lp-box is-third", "rgb(0, 174, 247)"],
      ["lsp-lp-box is-main", "rgb(0, 166, 82)"],
      ["lsp-lp-box is-second", "rgb(255, 134, 24)"],
      ["lsp-lp-box is-second", "rgb(255, 134, 24)"],
    ]);
    const title = view.contentDOM.querySelectorAll(".lsp-lp-box")[3].querySelector(".cm-line")!;
    assert.deepEqual(
      [...title.querySelectorAll<HTMLElement>(".lsp-lp-box-title")].map((e) => [e.contentEditable === "false", e.textContent]),
      [[true, "命题 2.1 ("], [false, "半正定 "], [true, ")"]],
      "the title (up to its formula's widget) between the head's chips, marked like them",
    );
    assert.equal(chars(inline(view).find((w) => title.contains(w))!), "𝐴⪰0");
  } finally {
    p.done();
  }
});

test("T-L9 reveal: the \\begin and \\end lines each on their own; editing the body keeps the box; ArrowDown enters the collapsed \\end line", async () => {
  const p = await project();
  try {
    cpSync(resolve("tests/fixtures/aux/book"), p.outDir, { recursive: true });
    const doc = ["top", "\\begin{theorem}{全期望公式}{total-exp}", "  body $x$", "  more", "\\end{theorem}", "end"].join("\n");
    const view = await p.mount(doc, undefined, 0);
    const line = (n: number) => view.state.doc.line(n);
    assert.deepEqual(shown(view), ["top", "│ [定理 1.1 (全期望公式)]", "│   body [w]", "│   more", "│ (collapsed)", "end"]);
    cursorAt(view, line(2).from + 3);
    assert.deepEqual(shown(view), ["top", "│ \\begin{theorem}{全期望公式}{total-exp}", "│   body [w]", "│   more", "│ (collapsed)", "end"], "the \\begin line only");
    cursorAt(view, line(5).to);
    assert.deepEqual(shown(view), ["top", "│ [定理 1.1 (全期望公式)]", "│   body [w]", "│   more", "│ \\end{theorem}", "end"], "the \\end line only");
    cursorAt(view, line(4).to);
    view.dispatch({ changes: { from: line(4).to, insert: " and $y$" }, selection: { anchor: line(4).to + 8 }, userEvent: "input.type" });
    await rendered(view);
    assert.deepEqual(shown(view), ["top", "│ [定理 1.1 (全期望公式)]", "│   body [w]", "│   more and $y$", "│ (collapsed)", "end"], "typing in the body: the box stays");
    view.dispatch({ changes: { from: line(4).to, insert: "\n" }, selection: { anchor: line(4).to + 1 }, userEvent: "input.type" });
    assert.equal(boxes(view).length, 1, "a new line in the body");
    assert.equal(view.contentDOM.querySelector(".lsp-lp-box")!.querySelectorAll(".cm-line").length, 4);

    // keyArbiter hands the arrows to CodeMirror; enterBlocks stops them on the collapsed \end line.
    // (jsdom's vertical motion jumps to the document's end or start: B6 walks every line in Chrome.)
    const at = () => view.state.doc.lineAt(view.state.selection.main.head).number;
    cursorAt(view, line(5).from);
    press(view, "ArrowDown");
    assert.equal(at(), 6);
    assert.equal(shown(view)[5], "│ \\end{theorem}");
    press(view, "ArrowDown");
    assert.deepEqual([at(), shown(view)[5]], [7, "│ (collapsed)"]);
  } finally {
    p.done();
  }
});

test("T-L9 a move inside a long box re-decorates only the constructs on its lines; one onto its \\begin line, the box", async () => {
  const p = await project();
  cpSync(resolve("tests/fixtures/aux/book"), p.outDir, { recursive: true });
  // 190 body lines (an environment spans at most 200), two formulas each.
  const body = Array.from({ length: 190 }, (_, i) => `  line ${i} with $x_{${i}}$ and $y_{${i}}$.`);
  const doc = ["top", "\\begin{theorem}{全期望公式}{total-exp}", ...body, "\\end{theorem}", "\\begin{quote}", ...body, "\\end{quote}", "end"].join("\n");
  const language = latexLiveLanguage({ refs: () => p.render.refsOf(p.root) });
  const decorated: string[] = [];
  const decorate = language.decorate.bind(language);
  language.decorate = (c, ctx) => {
    decorated.push(c.kind === "env" ? c.env : `${c.kind}@${ctx.state.doc.lineAt(c.from).number}`);
    decorate(c, ctx);
  };
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: texEditorExtensions({ text: doc, diagnostics: true, live: livePreview({ language, renderer: p.render.rendererFor(p.root) }) }),
    }),
  });
  try {
    view.focus();
    await sleep(40);
    await rendered(view);
    const at = (n: number) => view.state.doc.line(n).from + 3;
    const moved = (n: number) => {
      decorated.length = 0;
      cursorAt(view, at(n));
      return [...decorated];
    };
    moved(100);
    assert.deepEqual(moved(101), ["math@100", "math@100", "math@101", "math@101"], "the theorem's body: only the formulas on the two lines");
    moved(300);
    assert.deepEqual(moved(301), ["math@300", "math@300", "math@301", "math@301"], "a quote's body too");
    assert.ok(moved(2).includes("theorem"), "onto the \\begin line: the box re-decorates");
    assert.equal(shown(view)[1], "│ \\begin{theorem}{全期望公式}{total-exp}");
    moved(50);
    assert.equal(shown(view)[1], "│ [定理 1.1 (全期望公式)]", "and back into the body: its head again");
  } finally {
    view.destroy();
    p.done();
  }
});

test("T-L9 amsthm: \\newtheorem heads with their period, a \\label numbers them, proofs end in □, boxes nest; an error keeps a line source", async () => {
  const p = await project();
  try {
    const sources = ["\\documentclass{article}\n\\usepackage{amsthm}\n\\newtheorem{thm}{Theorem}[section]\n\\newtheorem{lem}[thm]{Lemma}\n\\newtheorem*{rem}{Remark}"];
    const labels = new Map([
      ["thm:cs", { number: "2.1", page: "3", title: "Cauchy", anchor: "thm.2.1", kind: "thm", order: null }],
      ["lem:aux", { number: "2.2", page: "3", title: "", anchor: "thm.2.2", kind: "thm", order: null }],
    ]);
    const refs: LatexRefs = { numbers: new Map(), labels, cites: new Map(), names: refNames(sources), theorems: theoremMap(sources), checkpoints: new Map() };
    const doc = [
      "\\begin{thm}[Cauchy--Schwarz]\\label{thm:cs}", // 1
      "  $\\abs{x \\cdot y} \\le \\norm{x}\\norm{y}$",
      "  \\begin{proof}[Proof of \\cref{thm:cs}]", // 3: a title with a reference
      "    \\begin{lem}",
      "    \\label{lem:aux}", // 5: the label first on the next line
      "    \\end{lem}",
      "    Trivial.",
      "  \\end{proof}",
      "\\end{thm}",
      "\\begin{rem}",
      "\\end{rem}",
      "\\begin{proof}",
      "\\end{proof}",
      "end",
    ].join("\n");
    const view = await p.mount(doc, refs);
    assert.deepEqual(shown(view), [
      "│ [Theorem 2.1 (Cauchy–Schwarz).]",
      "│   [w]",
      "│ │   Proof of [theorem 2.1][.]", // the indentation stays
      "│ │ │     [Lemma 2.2.]",
      "│ │ │     [lem:aux]",
      "│ │ │ (collapsed)",
      "│ │     Trivial.",
      "│ │ [□]",
      "│ (collapsed)",
      "│ [Remark.]",
      "│ (collapsed)",
      "│ [Proof.]",
      "│ [□]",
      "end",
    ]);
    assert.ok(view.contentDOM.querySelectorAll(".cm-line.ll-qed-line").length === 2, "the proof's mark sits at the right");
    assert.deepEqual(boxes(view).map(([cls, color]) => cls + color), Array(5).fill("lsp-lp-box"), "no scheme: the accent colour");
    showTexDiagnostics(view, [{ severity: "error", file: null, line: 1, message: "Undefined control sequence." }]);
    assert.equal(shown(view)[0], "│ \\begin{thm}[Cauchy--Schwarz]\\label{thm:cs}", "an error on the \\begin line: its source");
    assert.equal(boxes(view).length, 5, "the box stays");
  } finally {
    p.done();
  }
});

/**
 * Excerpts of the .aux XeLaTeX wrote for \include'd chapters of a synthetic elegantbook book (lang=cn,
 * chinese: the toc says 第四章, the anchor chapter.4; the first appendix's chapter counter is 1).
 */
const CH4_AUX = [
  "\\relax ",
  "\\@writefile{toc}{\\contentsline {chapter}{\\numberline {第四章}边界情形}{8}{chapter.4}\\protected@file@percent }",
  "\\newlabel{chap:edge}{{4}{8}{边界情形}{chapter.4}{}}",
  "\\newlabel{thm:t-label}{{4.3}{8}{边界情形}{tcb@cnt@theorem.4.3}{}}",
  "\\newlabel{thm:next-line}{{4.4}{8}{边界情形}{tcb@cnt@theorem.4.4}{}}",
  "\\newlabel{exam:lbl}{{4.2}{8}{边界情形}{exam.4.2}{}}",
  "\\@setckpt{chapters/ch4}{",
  "\\setcounter{page}{10}",
  "\\setcounter{chapter}{4}",
  "\\setcounter{tcb@cnt@theorem}{4}",
  "\\setcounter{tcb@cnt@definition}{0}",
  "\\setcounter{exam}{2}",
  "\\setcounter{exer}{0}",
  "\\setcounter{prob}{1}",
  "}",
].join("\n");
const APPENDIX_AUX = [
  "\\relax ",
  "\\@writefile{toc}{\\contentsline {chapter}{\\numberline {A}记号表}{10}{appendix.A}\\protected@file@percent }",
  "\\@setckpt{chapters/appendix}{",
  "\\setcounter{chapter}{1}",
  "\\setcounter{tcb@cnt@theorem}{1}",
  "\\setcounter{exam}{1}",
  "}",
].join("\n");
const CH4 = [
  "\\chapter{边界情形}\\label{chap:edge}", // 1
  "\\begin{theorem}{无标签定理}{}",
  "\\end{theorem}",
  "\\begin{theorem}[可选标题]", // 4
  "\\end{theorem}",
  "\\begin{theorem}{标题后标签}\\label{thm:t-label}", // 6
  "\\end{theorem}",
  "\\begin{theorem}[下一行标签]", // 8
  "  \\label{thm:next-line}",
  "\\end{theorem}",
  "\\begin{theorem*}{无编号定理}", // 11
  "\\end{theorem*}",
  "\\begin{example}", // 13
  "\\end{example}",
  "\\begin{example}[带标签]\\label{exam:lbl}", // 15
  "\\end{example}",
  "\\begin{problem}[一个问题]", // 17
  "\\end{problem}",
].join("\n");
/** The theorem heads, top to bottom. */
const heads = (view: EditorView) => shown(view).filter((l) => l.startsWith("│ [")).map((l) => l.slice(2));

test("T-L9 boxes without a label: numbered by their place when the \\include'd file's .aux checkpoint confirms the count", async () => {
  const p = await project();
  try {
    writeFileSync(join(p.outDir, "chapters", "ch4.aux"), CH4_AUX);
    writeFileSync(join(p.outDir, "chapters", "appendix.aux"), APPENDIX_AUX);
    // As the PDF prints them (pdf.js's text of the compiled book).
    const printed = ["[定理 4.1 (无标签定理)]", "[定理 4.2 (可选标题)]", "[定理 4.3 (标题后标签)]", "[定理 4.4 (下一行标签)]", "[定理 (无编号定理)]", "[例题 4.1]", "[例题 4.2 带标签]", "[问题 4.1 一个问题]"];
    assert.deepEqual(heads(await p.mount(CH4, undefined, 0, "chapters/ch4")), printed);
    const unknown = ["[定理 (无标签定理)]", "[定理 (可选标题)]", "[定理 4.3 (标题后标签)]", "[定理 4.4 (下一行标签)]", "[定理 (无编号定理)]", "[例题]", "[例题 4.2 带标签]", "[问题 一个问题]"];
    assert.deepEqual(heads(await p.mount(CH4, undefined, 0)), unknown, "an \\input'd file (no include name): labels only");
    assert.deepEqual(heads(await p.mount(CH4, undefined, 0, "chapters/ch5")), unknown, "a file the last compile did not include");

    // One more theorem than the checkpoint counted (typed since): the theorems wait for a compile, the examples do not.
    const added = CH4.replace("\\begin{theorem*}", "\\begin{theorem}{新定理}{}\n\\end{theorem}\n\\begin{theorem*}");
    assert.deepEqual(heads(await p.mount(added, undefined, 0, "chapters/ch4")), [
      ...unknown.slice(0, 4),
      "[定理 (新定理)]",
      "[定理 (无编号定理)]",
      ...printed.slice(5),
    ]);
    // A labelled box whose .aux number is not its place (moved first): its counter numbers nothing counted.
    const moved = CH4.replace("\\begin{theorem}{标题后标签}\\label{thm:t-label}\n\\end{theorem}\n", "").replace(
      "\\begin{theorem}{无标签定理}",
      "\\begin{theorem}{标题后标签}\\label{thm:t-label}\n\\end{theorem}\n\\begin{theorem}{无标签定理}",
    );
    assert.deepEqual(heads(await p.mount(moved, undefined, 0, "chapters/ch4")).slice(0, 3), ["[定理 4.3 (标题后标签)]", "[定理 (无标签定理)]", "[定理 (可选标题)]"]);
    // A box before the \\chapter heading (it counts on the chapter before), or two chapters in the file.
    const early = "x\n\\begin{problem}\n\\end{problem}\n" + CH4.replace("\\begin{problem}[一个问题]\n\\end{problem}", "");
    assert.deepEqual(heads(await p.mount(early, undefined, 0, "chapters/ch4"))[0], "[问题]");
    assert.deepEqual(heads(await p.mount(`${CH4}\n\\chapter{第二章}`, undefined, 0, "chapters/ch4"))[0], "[定理 (无标签定理)]");

    // The first appendix: its chapter counter is 1, the heads print A.
    const appendix = "\\chapter{记号表}\n\\begin{theorem}{附录定理}{}\n\\end{theorem}\n\\begin{example}\n\\end{example}";
    assert.deepEqual(heads(await p.mount(appendix, undefined, 0, "chapters/appendix")), ["[定理 A.1 (附录定理)]", "[例题 A.1]"]);
  } finally {
    p.done();
  }
});

test("T-L9 arguments a box does not take stay in place as text (elegantbook's proof and remark take none)", async () => {
  const p = await project();
  try {
    const sources = ["\\documentclass{article}\n\\usepackage{amsthm}\n\\newtheorem{thm}{Theorem}"];
    const amsthm: LatexRefs = { numbers: new Map(), labels: new Map(), cites: new Map(), names: refNames(sources), theorems: theoremMap(sources), checkpoints: new Map() };
    const doc = [
      "\\begin{proof}[另一种证明]", // 1
      "  可选参数。",
      "\\end{proof}",
      "\\begin{remark}[重要 $x$] % a note", // 4: the argument's formula renders
      "\\end{remark}",
      "\\begin{example}[抛硬币]{extra}", // 6: example takes [title] only
      "\\end{example}",
      "\\begin{theorem}{全期望公式}{total-exp}[x]", // 8: tcolorbox's g o t\\label g
      "\\end{theorem}",
      "end",
    ].join("\n");
    const view = await p.mount(doc);
    assert.deepEqual(shown(view).filter((l) => l !== "│ (collapsed)"), [
      "│ [证明][另一种证明]",
      "│   可选参数。",
      "│ [注][重要 [w]]",
      "│ [例题 抛硬币]{extra}",
      "│ [定理 (全期望公式)][x]",
      "end",
    ]);
    const thm = await p.mount("\\begin{thm}{extra}\n\\end{thm}\nend", amsthm);
    assert.equal(shown(thm)[0], "│ [Theorem.]{extra}", "amsthm's [title] only");
  } finally {
    p.done();
  }
});

test("T-L9 #8 and #13: figure and table lines collapse; \\includegraphics shows the image, a PDF's first page, or keeps its source", async () => {
  const p = await project();
  try {
    writeFileSync(join(p.book, "figures", "plot.pdf"), "%PDF-1.4 synthetic\n");
    mkdirSync(join(p.book, "img"));
    writeFileSync(join(p.book, "img", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    // A dot in a name without an extension: graphicx appends its extensions (pdfLaTeX reads loss_lr0.01.png).
    writeFileSync(join(p.book, "figures", "loss_lr0.01.png"), readFileSync(join(p.book, "figures", "grid.png")));
    const doc = [
      "\\begin{figure}[htbp]", // 1
      "  \\centering",
      "  \\includegraphics[width=0.3\\linewidth]{figures/grid.png}",
      "  \\caption{合成图片}\\label{fig:grid}",
      "\\end{figure}",
      "\\includegraphics{figures/plot}", // 6: graphicx's extensions (pdf first)
      "\\includegraphics{logo.svg}", // 7: not in \\graphicspath (main.tex has none)
      "\\includegraphics{figures/grid.eps}",
      "\\begin{table}", // 9
      "\\end{table}",
      "\\includegraphics[width=2cm]{figures/loss_lr0.01}", // 11
      "\\includegraphics{\\figdir/plot}", // 12: TeX expands the macro; the plugin cannot tell
      "\\includegraphics{example-image-a}", // 13: TeX may find a bare name in its tree (mwe)
      "end",
    ].join("\n");
    const view = await p.mount(doc, LABELS, doc.length);
    assert.deepEqual(shown(view), [
      "(collapsed)",
      "  \\centering",
      "[img]",
      "  \\caption{合成图片}[fig:grid]",
      "(collapsed)",
      "[img]",
      "\\includegraphics{logo.svg}",
      "\\includegraphics{figures/grid.eps}",
      "(collapsed)",
      "(collapsed)",
      "[img]",
      "\\includegraphics{\\figdir/plot}",
      "\\includegraphics{example-image-a}",
      "end",
    ]);
    const imgs = [...view.contentDOM.querySelectorAll<HTMLImageElement>(".lsp-lp-image img")];
    assert.deepEqual(
      imgs.map((i) => [i.getAttribute("src"), i.getAttribute("width")]),
      [
        [`app://local${join(p.book, "figures", "grid.png")}`, null],
        ["data:image/png;base64,page1-320", "120"],
        [`app://local${join(p.book, "figures", "loss_lr0.01.png")}`, null],
      ],
      "the host's resource URL; the PDF's first page at most 320 px high",
    );
    assert.deepEqual(p.pdfPages, [join(p.book, "figures", "plot.pdf")]);
    assert.deepEqual(
      [...view.contentDOM.querySelectorAll<HTMLElement>(".lsp-lp-error")].map((e) => [e.textContent, e.title]),
      [["\\includegraphics{figures/grid.eps}", "Image not found: figures/grid.eps"]],
      "a path not found is marked; a bare name (logo.svg too) or a macro in the path is not",
    );
    // Revealed: the source, the image below it.
    cursorAt(view, view.state.doc.line(3).from + 4);
    assert.deepEqual(shown(view).slice(2, 4), ["  \\includegraphics[width=0.3\\linewidth]{figures/grid.png}", "[img below]"]);
    cursorAt(view, view.state.doc.line(1).to);
    assert.equal(shown(view)[0], "\\begin{figure}[htbp]");

    // A \graphicspath and a file created later: the image appears (filesChanged).
    const main = join(p.book, "main.tex");
    writeFileSync(main, readFileSync(main, "utf8").replace("\\usepackage{mathtools}", "\\usepackage{mathtools}\n\\graphicspath{{img/}}"));
    p.render.fileModified(main);
    await waitFor(() => shown(view)[6] === "[img]");
    writeFileSync(join(p.book, "figures", "grid.eps"), "%!PS");
    p.render.filesChanged();
    await waitFor(() => view.contentDOM.querySelector<HTMLElement>(".lsp-lp-error")?.title === "Live preview does not show .eps images: figures/grid.eps");
    assert.equal(view.contentDOM.querySelectorAll(".lsp-lp-error").length, 1);
    // A saved image renders anew (its mtime is in the request).
    const before = renderStats(view).renders;
    const png = join(p.book, "figures", "grid.png");
    writeFileSync(png, readFileSync(png));
    const t = new Date(Date.now() + 5000);
    utimesSync(png, t, t);
    p.render.fileModified(png);
    await waitFor(() => renderStats(view).renders === before + 1);

    // A definitions change is a new epoch: no image renders again (image requests are epoch-free).
    const renderer = p.render.rendererFor(p.root);
    const [epoch, renders, pages] = [renderer.epoch, renderStats(view).renders, p.pdfPages.length];
    const macros = join(p.book, "macros.tex");
    writeFileSync(macros, readFileSync(macros, "utf8") + "\\newcommand{\\foo}{x}\n");
    p.render.fileModified(macros);
    await waitFor(() => renderer.epoch !== epoch);
    await sleep(50);
    await rendered(view);
    assert.deepEqual([renderStats(view).renders, p.pdfPages.length], [renders, pages]);
    assert.equal(view.contentDOM.querySelectorAll(".lsp-lp-image img").length, 4, "the images stay");
  } finally {
    p.done();
  }
});

/**
 * A stand-in for blockCrop's CropService: the blocks whose text is in `compiled` crop (as
 * `${seq}|${kind}|${first line}` cards), the rest changed; `previous` as the service gives it;
 * renders take `delay` ms and fail for blocks whose first line is in `failing`.
 */
function fakeCrops() {
  const f = {
    seq: 1,
    compiled: null as string | null,
    failing: new Set<string>(),
    delay: 5,
    /** Request source -> its block's text; block text -> the source that drew it last. */
    blocks: new Map<string, string>(),
    drawn: new Map<string, string>(),
  };
  const crops: TexCrops = {
    locate(_root, _file, text, _line, kind) {
      if (f.compiled === null || !f.compiled.includes(text)) return { note: NOTE_CHANGED };
      const src = `${f.seq}|${kind}|${text.split("\n")[0].trim()}`;
      f.blocks.set(src, text);
      const was = f.drawn.get(text);
      return { src, previous: was && was !== src ? was : null };
    },
    async render(_root, src) {
      await sleep(f.delay);
      if ([...f.failing].some((t) => src.endsWith(t))) return { ok: false, message: "no records", quiet: true };
      f.drawn.set(f.blocks.get(src)!, src);
      const card = document.createElement("div");
      card.className = "lsp-lp-paper ll-crop";
      card.textContent = `crop ${src}`;
      return { ok: true, node: card };
    },
    hover: async () => ({ note: NOTE_CHANGED }),
  };
  return Object.assign(f, { crops });
}

/** The crop cards the view shows in place of blocks. */
const cropCards = (view: EditorView) => blocks(view).filter((w) => w.classList.contains("lsp-lp-crop")).map((w) => w.textContent);

const CROP_DOC = [
  "\\begin{tikzpicture}[scale=2]", // 1-3: #14
  "  \\draw (0,0) -- (1,1);",
  "\\end{tikzpicture}",
  "\\begin{equation*}", // 4-8: #4, MathJax rejects tikz-cd
  "  \\begin{tikzcd}",
  "    A \\arrow[r] & B",
  "  \\end{tikzcd}",
  "\\end{equation*}",
  "\\begin{table}[htbp]", // 9-14: #14 in a float
  "  \\begin{tabular}{ll}",
  "    a & $x^2$ \\\\",
  "  \\end{tabular}",
  "  \\caption{T}",
  "\\end{table}",
  "$\\undefinedmacro$ inline", // 15: #4 inline, never a crop
  "\\begin{theorem}{Title}{t}", // 16-20: inside elegantbook's tcolorbox, never a crop
  "  \\begin{tikzpicture}",
  "    \\draw (0,0) circle (1);",
  "  \\end{tikzpicture}",
  "\\end{theorem}",
  "end",
].join("\n");

test("P5 #4 and #14: PDF crops for TikZ pictures, tables and rejected block formulas; source when changed", async () => {
  const f = fakeCrops();
  f.compiled = CROP_DOC;
  const p = await project(f.crops);
  try {
    const view = await p.mount(CROP_DOC, undefined, CROP_DOC.length);
    await waitFor(() => cropCards(view).length === 3);
    assert.deepEqual(cropCards(view), [
      "crop 1|picture|\\begin{tikzpicture}[scale=2]",
      "crop 1|math|\\begin{equation*}",
      "crop 1|picture|\\begin{tabular}{ll}",
    ]);
    assert.deepEqual(
      lines(view),
      ["[w]", "[w]", "<>", "[w]", "  \\caption{T}", "<>", "$\\undefinedmacro$ inline", "<lsp-lp-box is-second>", "end"],
      "the float's \\begin and \\end lines collapse around the crop, its caption stays",
    );
    assert.match(view.contentDOM.querySelector(".lsp-lp-box")!.textContent!, /\\begin\{tikzpicture\}/, "inside elegantbook's tcolorbox: source");
    assert.deepEqual(errors(view), ["$\\undefinedmacro$"], "inline math never crops");

    // Revealed: the source, no preview below (the crop would be stale).
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from + 3) });
    assert.deepEqual(lines(view).slice(0, 3), ["\\begin{tikzpicture}[scale=2]", "  \\draw (0,0) -- (1,1);", "\\end{tikzpicture}"]);
    assert.equal(below(view), null);
    // Changed since the compile: source after the cursor leaves.
    view.dispatch({ changes: { from: view.state.doc.line(2).to - 1, insert: " -- (2,0)" } });
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    await rendered(view);
    assert.equal(lines(view)[0], "\\begin{tikzpicture}[scale=2]");
    assert.equal(cropCards(view).length, 2);
    // A rejected formula without a crop is MathJax's error again.
    view.dispatch({ changes: { from: view.state.doc.line(6).from + 4, insert: "C " } });
    await rendered(view);
    assert.ok(errors(view).includes("\\begin{equation*}"));
  } finally {
    p.done();
  }
});

test("P5 a new compile's crop replaces the last one when it lands; a crop that fails leaves the source", async () => {
  const f = fakeCrops();
  f.compiled = CROP_DOC;
  const p = await project(f.crops);
  try {
    const view = await p.mount(CROP_DOC, undefined, CROP_DOC.length);
    await waitFor(() => cropCards(view).length === 3);
    // A new result: every block's request changes; the old crops stay until the new ones land.
    f.seq = 2;
    f.delay = 60;
    p.render.cropsChanged(p.root);
    await sleep(30);
    assert.deepEqual(cropCards(view).map((c) => c!.slice(0, 7)), ["crop 1|", "crop 1|", "crop 1|"], "the last crops meanwhile");
    await waitFor(() => cropCards(view).every((c) => c!.startsWith("crop 2|")), 3000);
    assert.equal(cropCards(view).length, 3);

    // A crop that cannot render (no SyncTeX records): #14 keeps its source, #4 MathJax's error.
    f.seq = 3;
    f.delay = 5;
    f.failing = new Set(["\\begin{tabular}{ll}", "\\begin{equation*}"]);
    p.render.cropsChanged(p.root);
    await waitFor(() => cropCards(view).length === 1 && cropCards(view)[0]!.startsWith("crop 3|"), 3000);
    assert.ok(lines(view).includes("  \\begin{tabular}{ll}"));
    assert.ok(errors(view).includes("\\begin{equation*}"));
  } finally {
    p.done();
  }
});
