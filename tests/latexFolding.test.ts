import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldable, foldedRanges, unfoldAll } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parseTex } from "../src/export/texTree";
import { projectSignatures } from "../src/export/signatures";
import { emptyDefinitions } from "../src/tex/macros";
import { semanticFolds } from "../src/tex/outline";
import { LATEX_FOLD_MAX_CHARS, ensureLatexFoldIndex, foldAllLatex, foldLatexSection, latexFoldStats, latexFolding } from "../src/editor/latexFolding";
import { texEditorExtensions } from "../src/editor/texExtensions";
import { latexLiveLanguage } from "../src/editor/latexLive";
import { theoremMap } from "../src/tex/theorems";
import { livePreview, type FragmentRenderer } from "../src/editor/shared/livePreview";

const SIG = projectSignatures(emptyDefinitions(), [], new Map());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function folds(text: string) { return semanticFolds(text, parseTex(text, SIG)); }
function setup(text: string, live = false) {
  const parent = document.body.appendChild(document.createElement("div"));
  const renderer: FragmentRenderer = { epoch: 0, render: () => ({ ok: true, node: document.createElement("span") }), flush: () => {} };
  const language = latexLiveLanguage({ refs: () => ({ numbers: new Map(), labels: new Map(), cites: new Map(), names: { autoref: new Map(), cref: new Map(), Cref: new Map() }, checkpoints: new Map(), theorems: theoremMap([String.raw`\usepackage{amsthm}\newtheorem{theorem}{Theorem}`]) }) });
  const view = new EditorView({ parent, state: EditorState.create({ doc: text, extensions: texEditorExtensions({ text, live: live ? livePreview({ language, renderer }) : [], extensions: [latexFolding] }) }) });
  return { view, done: () => { view.destroy(); parent.remove(); } };
}

test("semantic sections fold to the next same/higher heading, respecting multiline titles and nesting", () => {
  const src = String.raw`\chapter{A}
chapter prose
\section[short]{Long
title}
section prose
\subsection{Nested}
nested prose
\section{B}
B prose
\chapter{C}
C prose`;
  const out = folds(src).filter((f) => f.kind === "section");
  assert.equal(out.length, 5);
  assert.equal(src.slice(out[0].to + 1).startsWith("\\chapter{C}"), true);
  assert.equal(src.slice(out[1].from).startsWith("\nsection prose"), true);
  assert.equal(src.slice(out[1].to + 1).startsWith("\\section{B}"), true);
  assert.equal(src.slice(out[2].to + 1).startsWith("\\section{B}"), true);
});

test("nested same-name proof/environments match their own end; incomplete and one-line boxes do not fold", () => {
  const src = String.raw`\begin{proof}
outer
\begin{proof}
inner
\end{proof}
outer end
\end{proof}
\begin{theorem}one-line\end{theorem}
\begin{half}
unfinished`;
  const out = folds(src);
  assert.deepEqual(out.map((f) => f.kind), ["proof", "proof"]);
  assert.equal(src.slice(out[0].to + 1).startsWith("\\end{proof}\n\\begin{theorem}"), true);
  assert.equal(src.slice(out[1].to + 1).startsWith("\\end{proof}\nouter end"), true);
});

test("math/verbatim environments fold but fake sections/definitions/comments/false branches do not", () => {
  const src = String.raw`\newcommand{\x}{\section{Fake}}
% \begin{proof}
\iffalse
\section{False}
\fi
\begin{align}
x &= y\\
\section{Math fake}
\end{align}
\begin{verbatim}
\section{Raw fake}
\end{verbatim}
\section{Real}
prose`;
  assert.deepEqual(folds(src).map((f) => f.name), ["align", "verbatim", "section"]);
});

test("fold commands are lazy and share standard CM fold state without editing text/history", () => {
  const src = "\\section{First}\nprose\n\\section{Second}\nmore";
  const { view, done } = setup(src);
  try {
    assert.equal(latexFoldStats(view.state).scans, 0);
    assert.equal(foldLatexSection(view), true);
    assert.equal(latexFoldStats(view.state).scans, 1);
    assert.equal(foldedRanges(view.state).size, 1);
    assert.equal(view.state.doc.toString(), src);
    const line = view.state.doc.line(3);
    assert.deepEqual(foldable(view.state, line.from, line.to), { from: line.to, to: src.length });
    unfoldAll(view);
    assert.equal(foldAllLatex(view), true);
    assert.equal(foldedRanges(view.state).size, 2);
    assert.equal(latexFoldStats(view.state).scans, 1);
  } finally { done(); }
});

test("typing maps the cached index without a synchronous scan, idle rebuild coalesces the burst", async () => {
  const { view, done } = setup("\\section{A}\nprose\n\\section{B}\nmore");
  try {
    ensureLatexFoldIndex(view);
    for (let i = 0; i < 80; i++) view.dispatch({ changes: { from: 17, insert: "x" }, userEvent: "input.type" });
    assert.equal(latexFoldStats(view.state).scans, 1);
    assert.equal(latexFoldStats(view.state).fresh, false);
    await sleep(470);
    assert.equal(latexFoldStats(view.state).scans, 2);
    assert.equal(latexFoldStats(view.state).fresh, true);
  } finally { done(); }
});

test("IME composition postpones indexing and refuses explicit folds", async () => {
  const { view, done } = setup("\\section{A}\nprose");
  try {
    Object.defineProperty(view, "compositionStarted", { value: true, configurable: true });
    assert.equal(ensureLatexFoldIndex(view), false);
    assert.equal(foldLatexSection(view), false);
    await sleep(440);
    assert.equal(latexFoldStats(view.state).scans, 0);
    Object.defineProperty(view, "compositionStarted", { value: false, configurable: true });
    ensureLatexFoldIndex(view);
    assert.equal(latexFoldStats(view.state).scans, 1);
  } finally { done(); }
});

test("semantic folding coexists with real LaTeX live block widgets and nested theorem wrappers", async () => {
  const src = String.raw`\section{A}
\begin{theorem}
Statement $x$.
\begin{proof}
\[
x=y
\]
\end{proof}
\end{theorem}
\section{B}
More.`;
  const { view, done } = setup(src, true);
  try {
    await sleep(20);
    assert.equal(foldLatexSection(view), true);
    await sleep(20);
    assert.equal(foldedRanges(view.state).size, 1);
    assert.equal(view.dom.querySelectorAll(".cm-foldPlaceholder").length, 1);
    unfoldAll(view);
    view.dispatch({ selection: { anchor: src.indexOf("\\begin{proof}") } });
    assert.equal(foldLatexSection(view), true);
    await sleep(20);
    assert.equal(view.dom.querySelectorAll(".cm-foldPlaceholder").length, 1);
    assert.equal(view.state.doc.toString(), src);
  } finally { done(); }
});

test("oversize sources never stringify or parse during manual or idle folding", async () => {
  const src = "\\section{Large}\n" + "Prose line.\n".repeat(Math.ceil(LATEX_FOLD_MAX_CHARS / 12) + 1);
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ parent, state: EditorState.create({ doc: src, extensions: latexFolding }) });
  let stringifications = 0;
  const rejectStringifying = () => {
    stringifications++;
    throw new Error("Oversize folding must not stringify the source");
  };
  Object.defineProperty(view.state.doc, "toString", { configurable: true, value: rejectStringifying });
  try {
    assert.ok(view.state.doc.length > LATEX_FOLD_MAX_CHARS);
    assert.equal(ensureLatexFoldIndex(view), true);
    assert.equal(foldLatexSection(view), false);
    assert.equal(foldAllLatex(view), false);
    const line = view.state.doc.line(1);
    assert.equal(foldable(view.state, line.from, line.to), null);
    // Make the index stale again and let only the idle path refresh this new document.
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    Object.defineProperty(view.state.doc, "toString", { configurable: true, value: rejectStringifying });
    assert.equal(latexFoldStats(view.state).fresh, false);
    await sleep(440);
    assert.deepEqual(latexFoldStats(view.state), { scans: 0, ranges: 0, fresh: true });
    assert.equal(stringifications, 0);
  } finally { view.destroy(); parent.remove(); }
});

test("crossing the size limit clears cached markers and shrinking restores semantic folds", () => {
  const small = "\\section{Small}\nProse.\n\\section{Next}\nMore.";
  const { view, done } = setup(small);
  try {
    ensureLatexFoldIndex(view);
    assert.equal(latexFoldStats(view.state).scans, 1);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x".repeat(LATEX_FOLD_MAX_CHARS) } });
    assert.equal(latexFoldStats(view.state).ranges, 0);
    const largeDoc = view.state.doc;
    Object.defineProperty(largeDoc, "toString", { configurable: true, value: () => { throw new Error("Must reject before toString"); } });
    assert.equal(foldLatexSection(view), false);
    assert.equal(latexFoldStats(view.state).scans, 1);
    view.dispatch({ changes: { from: 0, to: largeDoc.length, insert: small } });
    assert.equal(foldLatexSection(view), true);
    assert.equal(latexFoldStats(view.state).scans, 2);
    assert.equal(foldedRanges(view.state).size, 1);
  } finally { done(); }
});

test("large-source edit burst adds no fold scans to the transaction hot path", () => {
  const chapter = Array.from({ length: 600 }, (_, i) => `\\section{Section ${i}}\n${"Sentence with $x$ and words.\n".repeat(8)}`).join("");
  // Pure CM transaction benchmark: avoid measuring jsdom's unrelated gutter layout cost.
  let state = EditorState.create({ doc: chapter, extensions: latexFolding });
  const started = performance.now();
  for (let i = 0; i < 500; i++) state = state.update({ changes: { from: 25, insert: "x" } }).state;
  const elapsed = performance.now() - started;
  assert.equal(latexFoldStats(state).scans, 0);
  assert.ok(elapsed < 1000, `${elapsed.toFixed(1)} ms for 500 source transactions`);
});
