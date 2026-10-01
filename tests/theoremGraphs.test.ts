import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TheoremGraphs } from "../src/editor/theoremGraphs";

const source = String.raw`\documentclass{article}
\usepackage{amsthm}
\newtheorem{theorem}{Theorem}
\begin{document}
\begin{theorem}\label{base}The base is $x=1$.\end{theorem}
\begin{theorem}\label{result}The result is \textbf{useful}.\end{theorem}
\begin{proof}By \ref{base}, $x+1=2$.\end{proof}
\end{document}`;

function fixture(math?: (src: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), "ll-graph-service-"));
  const root = join(dir, "main.tex");
  const out = join(dir, "out");
  mkdirSync(out);
  writeFileSync(root, source);
  writeFileSync(join(out, "main.aux"), String.raw`\newlabel{base}{{1}{1}{}{theorem.1}{}}`);
  const buffers = new Map<string, string>();
  let loads = 0;
  let maths = 0;
  const service = new TheoremGraphs({
    buffers: () => buffers,
    outDirFor: () => out,
    prepareMath: async () => { loads++; },
    math: (_root, src) => { maths++; if (math) return math(src); const el = document.createElement("code"); el.textContent = src; return el.outerHTML; },
  });
  return { root, out, buffers, service, loads: () => loads, maths: () => maths, close: () => { service.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test("theorem graph service: hover reads sources only; a selected card lazily renders and caches its statement and proof", async () => {
  const f = fixture();
  try {
    const signal = new AbortController().signal;
    const loaded = await f.service.load(f.root, "result", signal);
    assert.ok(loaded?.selectedId);
    assert.equal(f.loads(), 0);
    assert.equal(f.maths(), 0);
    assert.equal(loaded.graph.edges.length, 1);
    const node = loaded.graph.nodes.get(loaded.selectedId)!;
    const content = await f.service.content(node, document, signal);
    assert.match(content.textContent ?? "", /陈述.*The result is useful.*证明.*By 1/s);
    assert.ok(content.querySelector("a[data-ll-theorem-key='base']"));
    assert.equal(f.loads(), 1);
    assert.equal(f.maths(), 1);
    const clone = await f.service.content(node, document, signal);
    assert.notEqual(content, clone);
    assert.equal(clone.outerHTML, content.outerHTML);
    assert.equal(f.maths(), 1, "opening a cached node doesn't render again");
    assert.equal(clone.querySelectorAll("[id]").length, 0);
  } finally { f.close(); }
});

test("theorem graph service: committed unsaved edits and fresh aux numbers invalidate older cards", async () => {
  const f = fixture();
  try {
    const signal = new AbortController().signal;
    const old = await f.service.load(f.root, "result", signal);
    const oldNode = old!.graph.nodes.get(old!.selectedId!)!;
    let changes = 0;
    const unsubscribe = f.service.subscribe(() => changes++);
    f.buffers.set(f.root, source.replace("useful", "edited").replace("x+1=2", "x+2=3"));
    writeFileSync(join(f.out, "main.aux"), String.raw`\newlabel{base}{{7}{1}{}{theorem.7}{}}`);
    f.service.invalidate();
    assert.equal(changes, 1);
    await assert.rejects(f.service.content(oldNode, document, signal), /source changed/);
    const current = await f.service.load(f.root, "result", signal);
    const content = await f.service.content(current!.graph.nodes.get(current!.selectedId!)!, document, signal);
    assert.match(content.textContent ?? "", /edited.*By 7.*x\+2=3/s);
    unsubscribe();
  } finally { f.close(); }
});

test("theorem graph service: duplicate labels return explicit ambiguity and cancellation prevents source work", async () => {
  const f = fixture();
  try {
    f.buffers.set(f.root, source.replace("\\label{result}", "\\label{base}"));
    const loaded = await f.service.load(f.root, "base", new AbortController().signal);
    assert.equal(loaded?.selectedId, null);
    assert.equal(loaded?.graph.byLabel.get("base")?.length, 2);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(f.service.load(f.root, "base", aborted.signal), /closed/);
    assert.equal(f.loads(), 0);
  } finally { f.close(); }
});

test("theorem graph service: cached card clones preserve independent drawing IDs and internal references", async () => {
  const f = fixture(() => '<svg><defs><path id="glyph" d="M0 0L1 1"/></defs><use href="#glyph"/></svg>');
  try {
    const signal = new AbortController().signal;
    const loaded = await f.service.load(f.root, "result", signal);
    const node = loaded!.graph.nodes.get(loaded!.selectedId!)!;
    const first = await f.service.content(node, document, signal);
    const second = await f.service.content(node, document, signal);
    const id = first.querySelector("path")!.id;
    assert.ok(id);
    assert.notEqual(second.querySelector("path")!.id, id);
    assert.equal(first.querySelector("use")!.getAttribute("href"), `#${id}`);
    assert.equal(second.querySelector("use")!.getAttribute("href"), `#${second.querySelector("path")!.id}`);
    assert.equal(f.maths(), 1);
  } finally { f.close(); }
});

test("theorem graph service: bibliography text comes from the same committed unsaved snapshot", async () => {
  const f = fixture();
  try {
    const bib = join(f.root, "..", "refs.bib");
    writeFileSync(bib, '@article{smith, author={Saved, Alice}, year={2026}, title={A result}}');
    f.buffers.set(bib, '@article{smith, author={Committed, Alice}, year={2026}, title={A result}}');
    f.buffers.set(f.root, source.replace("\\begin{document}", "\\addbibresource{refs.bib}\n\\begin{document}").replace("By \\ref{base}", "By \\cite{smith} and \\ref{base}"));
    const signal = new AbortController().signal;
    const loaded = await f.service.load(f.root, "result", signal);
    const content = await f.service.content(loaded!.graph.nodes.get(loaded!.selectedId!)!, document, signal);
    assert.match(content.textContent ?? "", /Committed.*2026/);
    assert.doesNotMatch(content.textContent ?? "", /Saved/);
  } finally { f.close(); }
});
