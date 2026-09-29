// T-L5 and T-L8: LaTeX's live preview (latexLive.ts, design 4.4 #1-#4 and #5-#11) on the real
// editor stack (texEditorExtensions, keyArbiter first) with TexRender's live renderer over
// Obsidian's MathJax (tests/support/mathjax.ts), on a temporary copy of the synthetic
// elegantbook fixture; chips read static .aux excerpts (tests/fixtures/aux) and its refs.bib.
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EditorSelection, EditorState, SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLiveLanguage } from "../src/editor/latexLive";
import { DEFAULT_REF_NAMES, LatexRefs, refNames } from "../src/editor/latexRefs";
import { livePreview, renderStats } from "../src/editor/shared/livePreview";
import { showTexDiagnostics, texEditorExtensions } from "../src/editor/texExtensions";
import { TexRender } from "../src/editor/texRender";
import { readAuxLabels } from "../src/tex/aux";
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

/** A copy of the fixture book with TexRender over Obsidian's MathJax, preloaded. */
async function project() {
  const { window: mw, MathJax } = await obsidianMathJax();
  const dir = mkdtempSync(join(tmpdir(), "ll-live-"));
  const book = join(dir, "book");
  cpSync(resolve("tests/fixtures/elegantbook"), book, { recursive: true });
  const outDir = join(dir, "out");
  mkdirSync(join(outDir, "chapters"), { recursive: true });
  const render = new TexRender({
    outDirFor: () => outDir,
    buffers: () => new Map(),
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
   * `labels` (label numbers alone, or whole refs), else the root's (build folder and bibliography).
   */
  const mount = async (doc: string, labels?: ReadonlyMap<string, string> | LatexRefs, anchor = doc.length) => {
    const fixed: LatexRefs | undefined =
      !labels || "names" in labels ? labels : { numbers: labels, labels: new Map(), cites: new Map(), names: DEFAULT_REF_NAMES };
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: { anchor },
        extensions: texEditorExtensions({
          text: doc,
          diagnostics: true,
          live: livePreview({
            language: latexLiveLanguage({ refs: () => fixed || render.refsOf(root) }),
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
  return { render, root, book, outDir, mount, done };
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
 * Each line as shown: render widgets as "[w]", chips and list markers as "[text]", hidden
 * markup gone; a collapsed line (a block replace without a widget) as "(collapsed)".
 */
const shown = (view: EditorView) =>
  [...view.contentDOM.children].map((el) => {
    if (!el.classList.contains("cm-line")) return el.classList.contains("lsp-lp-render") ? "[w]" : "(collapsed)";
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll(".lsp-lp-render").forEach((w) => w.replaceWith("[w]"));
    copy.querySelectorAll(".lsp-lp-chip, .lsp-lp-bullet").forEach((w) => w.replaceWith(`[${w.textContent}]`));
    return copy.textContent ?? "";
  });
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
    const view = await p.mount(doc, { numbers: new Map(), labels, cites: new Map(), names: DEFAULT_REF_NAMES });
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
    const named = await p.mount(doc.replace("\\autoref{fn:toy}", "\\autoref{sec:intro}"), { numbers: new Map(), labels, cites: new Map(), names });
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
