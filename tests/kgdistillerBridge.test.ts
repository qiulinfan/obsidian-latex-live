import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { kgdistillerHtml } from "../src/export/kgdistillerBridge";
import { resolveTexBinDir } from "../src/tex/binaries";

const schema = "latex-live-html-request-v1";
const tex = resolveTexBinDir(process.env.TEXBIN ?? "");

test("headless labels retain mixed math, project macros, Chinese and formatting as portable MathML", async () => {
  const folder = await mkdtemp(join(tmpdir(), "latex-live 中文 labels test-"));
  try {
    const source = join(folder, "main.tex");
    await writeFile(source, "\\documentclass{article}\n\\input{defs}\n\\begin{document}Test.\\end{document}\n");
    await writeFile(join(folder, "defs.tex"), "\\newcommand{\\Rn}{\\mathbb{R}^{n}}\n");
    const result = await kgdistillerHtml({ schema, operation: "labels", source, labels: [
      { id: "sigma", latex: "$\\sigma$-algebra" },
      { id: "sigma-alt", latex: "\\(\\sigma\\)-代数" },
      { id: "lp", latex: "$L^p$ \\textbf{space}" },
      { id: "rn", latex: "spaces over $\\Rn$" },
      { id: "ensure", latex: "\\ensuremath{x^2} 中文" },
    ] });
    assert.equal(result.operation, "labels");
    if (result.operation !== "labels") throw new Error("Expected labels");
    for (const label of result.labels) {
      assert.match(label.html, /^<math xmlns=/);
      assert.doesNotMatch(label.html, /mjx-|style=|<style|<script|href=|@font/);
    }
    assert.match(result.labels[0].html, /<mi>σ<\/mi>/);
    assert.match(result.labels[1].html, /代数/);
    assert.match(result.labels[2].html, /mathvariant="bold"/);
    assert.match(result.labels[3].html, /<msup>/);
    assert.match(result.labels[3].html, /mathvariant="double-struck">R/);
    assert.match(result.labels[4].html, /中文/);
    const childResult = await kgdistillerHtml({ schema, operation: "labels", source: join(folder, "defs.tex"), labels: [{ id: "child", latex: "$\\Rn$" }] });
    assert.equal(childResult.operation, "labels");
    if (childResult.operation !== "labels") throw new Error("Expected child labels");
    assert.match(childResult.labels[0].html, /mathvariant="double-struck">R/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("bridge protocol works from an unrelated cwd with exactly one stdout JSON value", () => {
  const result = spawnSync(process.execPath, [resolve("scripts/kgdistiller-export.mjs")], {
    cwd: tmpdir(), encoding: "utf8",
    input: JSON.stringify({ schema, operation: "labels", labels: [{ id: "sig", latex: "$\\sigma$-algebra" }] }) + "\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const json = JSON.parse(result.stdout);
  assert.equal(json.schema, "latex-live-html-result-v1");
  assert.match(json.labels[0].html, /σ/);
});

test("unknown explicit document marker rejects before compilation and leaves original files intact", async () => {
  const folder = await mkdtemp(join(tmpdir(), "latex-live-bridge-unknown-test-"));
  try {
    const source = join(folder, "main.tex");
    const text = "\\documentclass{article}\n\\begin{document}\n\\kn{Unknown}\n\\end{document}\n";
    await writeFile(source, text);
    await assert.rejects(kgdistillerHtml({ schema, operation: "document", source, markers: [] }), /Unmapped explicit knowledge marker: Unknown/);
    assert.equal(await readFile(source, "utf8"), text);
    assert.deepEqual(await readdir(folder), ["main.tex"]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("document bridge adds exact semantic anchors and repeated refs without touching source", { skip: !tex, timeout: 90_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "latex-live-bridge-doc-test-"));
  try {
    const source = join(folder, "main.tex");
    const child = join(folder, "chapter.tex");
    const main = "\\documentclass{article}\n\\usepackage{amsmath}\n\\providecommand{\\kn}[1]{\\textbf{#1}}\n\\providecommand{\\knref}[1]{#1}\n\\begin{document}\n\\input{chapter}\n\\end{document}\n";
    const body = "% \\kn{Ignored}\n\\section{A topic}\n\\kn{$\\sigma$-algebra}: a collection. See \\knref{$\\sigma$-algebra} twice: \\knref{$\\sigma$-algebra}.\n\\verb|\\kn{Literal}|\n";
    await writeFile(source, main);
    await writeFile(child, body);
    const result = await kgdistillerHtml({ schema, operation: "document", source, markers: [{ name: "$\\sigma$-algebra", id: "sigma-algebra", url: "#kn-sigma-algebra" }] });
    assert.equal(result.operation, "document");
    if (result.operation !== "document") throw new Error("Expected document");
    const dom = new JSDOM(result.html);
    assert.equal(dom.window.document.querySelectorAll('[id="kn-sigma-algebra"][data-ql-kn="sigma-algebra"]').length, 1);
    assert.equal(dom.window.document.querySelectorAll('a[data-ql-ref="sigma-algebra"][href="#kn-sigma-algebra"]').length, 2);
    assert.match(result.html, /<mjx-container/);
    assert.doesNotMatch(result.html, /kgdistiller\.invalid|kgd-kn-/);
    assert.equal(await readFile(source, "utf8"), main);
    assert.equal(await readFile(child, "utf8"), body);
    assert.deepEqual((await readdir(folder)).sort(), ["chapter.tex", "main.tex"]);
    dom.window.close();
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("notes wrapper can read absolute repository inputs within project_root", { skip: !tex, timeout: 90_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "latex-live-bridge-wrapper-test-"));
  try {
    const build = join(folder, "knowledge", "build");
    const notes = join(folder, "notes", "math");
    await mkdir(build, { recursive: true });
    await mkdir(notes, { recursive: true });
    const source = join(build, "wrapper.tex");
    const fragment = join(notes, "notes.tex");
    const text = "\\kn{Nested}: text and \\knref{Nested}.\n";
    await writeFile(fragment, text);
    await writeFile(source, `\\documentclass{article}\n\\begin{document}\n\\input{${fragment}}\n\\end{document}\n`);
    await writeFile(join(folder, "unrelated-secret.env"), "not a dependency");
    const result = await kgdistillerHtml({ schema, operation: "document", source, project_root: folder, markers: [{ name: "Nested", id: "nested", url: "#kn-nested" }] });
    assert.equal(result.operation, "document");
    if (result.operation !== "document") throw new Error("Expected document");
    assert.match(result.html, /data-ql-kn="nested"/);
    assert.match(result.html, /data-ql-ref="nested"/);
    assert.equal(await readFile(fragment, "utf8"), text);
    await assert.rejects(kgdistillerHtml({ schema, operation: "document", source, markers: [] }), /outside project_root/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("nested import and subimport preserve their resolved directory context", { skip: !tex, timeout: 90_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "latex-live-bridge-import-test-"));
  try {
    await mkdir(join(folder, "chapters", "sub"), { recursive: true });
    const source = join(folder, "main.tex");
    await writeFile(source, "\\documentclass{article}\n\\usepackage{import}\n\\begin{document}\n\\import{chapters/}{one.tex}\n\\end{document}\n");
    await writeFile(join(folder, "chapters", "one.tex"), "\\subimport{sub/}{two.tex}\n");
    const deep = join(folder, "chapters", "sub", "two.tex");
    const text = "\\kn{Deep}: nested content. See \\knref{Deep}.\n";
    await writeFile(deep, text);
    const result = await kgdistillerHtml({ schema, operation: "document", source, markers: [{ name: "Deep", id: "deep", url: "#kn-deep" }] });
    assert.equal(result.operation, "document");
    if (result.operation !== "document") throw new Error("Expected document");
    assert.match(result.html, /data-ql-kn="deep"/);
    assert.match(result.html, /data-ql-ref="deep"/);
    assert.match(result.html, /nested content/);
    assert.deepEqual(result.report.items, []);
    assert.equal(await readFile(deep, "utf8"), text);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("preamble initialization uses the active document environment after comments and macro literals", { skip: !tex, timeout: 90_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "latex-live-bridge-preamble-test-"));
  try {
    const source = join(folder, "main.tex");
    const text = "% example: \\begin{document}\n\\documentclass{article}\n\\newcommand{\\ExampleDocumentStart}{\\begin{document}}\n\\begin  {document}\n\\kn{A}: content. See \\knref{A}.\n\\verb|\\begin{document}|\n\\end{document}\n";
    await writeFile(source, text);
    const result = await kgdistillerHtml({ schema, operation: "document", source, markers: [{ name: "A", id: "a", url: "#kn-a" }] });
    assert.equal(result.operation, "document");
    if (result.operation !== "document") throw new Error("Expected document");
    assert.match(result.html, /data-ql-kn="a"/);
    assert.match(result.html, /data-ql-ref="a"/);
    assert.deepEqual(result.report.items.filter((item) => ["build", "probe"].includes(item.kind)), []);
    assert.equal(await readFile(source, "utf8"), text);
    assert.deepEqual(await readdir(folder), ["main.tex"]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("includeonly expects markers only from visited source bodies", { skip: !tex, timeout: 90_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "latex-live-bridge-include-test-"));
  try {
    const book = join(folder, "book");
    await mkdir(book);
    const source = join(book, "main.tex");
    await writeFile(source, "\\documentclass{article}\n\\includeonly{a}\n\\begin{document}\n\\include{a}\n\\include{b}\n\\end{document}\n");
    await writeFile(join(book, "a.tex"), "\\kn{A}: selected content. See \\knref{A}.\n");
    const excluded = "\\kn{B}: excluded content. See \\knref{A}.\n";
    await writeFile(join(book, "b.tex"), excluded);
    const result = await kgdistillerHtml({ schema, operation: "document", source, project_root: folder, markers: [
      { name: "A", id: "a", url: "#kn-a" }, { name: "B", id: "b", url: "#kn-b" },
    ] });
    assert.equal(result.operation, "document");
    if (result.operation !== "document") throw new Error("Expected document");
    assert.match(result.html, /data-ql-kn="a"/);
    assert.match(result.html, /data-ql-ref="a"/);
    assert.match(result.html, /selected content/);
    assert.doesNotMatch(result.html, /data-ql-kn="b"|excluded content/);
    assert.equal(await readFile(join(book, "b.tex"), "utf8"), excluded);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("XeLaTeX wrapper preserves Chinese spaced paths and distinct raw names sharing one id", { skip: !tex, timeout: 90_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "latex live 中文 wrapper-"));
  try {
    const build = join(folder, "knowledge", "build");
    const notes = join(folder, "数学 资料");
    await mkdir(build, { recursive: true });
    await mkdir(notes, { recursive: true });
    const source = join(build, "wrapper.tex");
    const fragment = join(notes, "片段 notes.tex");
    const text = "\\kn{$\\sigma$-代数}：集合族。见 \\knref{\\(\\sigma\\)-代数}。\n";
    await writeFile(fragment, text);
    await writeFile(source, `\\documentclass[UTF8,fontset=fandol]{ctexart}\n\\begin{document}\n\\input{"${fragment}"}\n\\end{document}\n`);
    const result = await kgdistillerHtml({ schema, operation: "document", source, project_root: folder, markers: [
      { name: "$\\sigma$-代数", id: "sigma", url: "../../knowledge/graph/#kn-sigma" },
      { name: "\\(\\sigma\\)-代数", id: "sigma", url: "../../knowledge/graph/#kn-sigma" },
    ] });
    assert.equal(result.operation, "document");
    if (result.operation !== "document") throw new Error("Expected document");
    assert.equal(result.report.engine, "xelatex");
    assert.match(result.html, /<html lang="zh-CN"/);
    assert.match(result.html, /data-ql-kn="sigma"/);
    assert.match(result.html, /data-ql-ref="sigma"/);
    assert.match(result.html, /集合族/);
    assert.equal(await readFile(fragment, "utf8"), text);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("LuaLaTeX document bridge retains native drawings and exact markers without touching source", { skip: !tex, timeout: 90_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "latex-live-bridge-lua-test-"));
  try {
    const source = join(folder, "main.tex");
    const text = String.raw`\documentclass{article}
\usepackage{luamplib,tikz}
\providecommand{\kn}[1]{\textbf{#1}}\providecommand{\knref}[1]{#1}
\begin{document}
\kn{Lua}: native drawings. See \knref{Lua}.
\begin{mplibcode}
beginfig(0); fill (0,0)--(13,0)--(3,7)--cycle withcolor (1,0,0); endfig;
\end{mplibcode}
\tikz\draw (0,0) circle (0.8ex);
\end{document}`;
    await writeFile(source, text);
    const result = await kgdistillerHtml({ schema, operation: "document", source, engine: "lualatex", markers: [{ name: "Lua", id: "lua", url: "#kn-lua" }] });
    assert.equal(result.operation, "document");
    if (result.operation !== "document") throw new Error("Expected document");
    assert.equal(result.report.engine, "lualatex");
    const dom = new JSDOM(result.html);
    assert.equal(dom.window.document.querySelectorAll('[id="kn-lua"][data-ql-kn="lua"]').length, 1);
    assert.equal(dom.window.document.querySelectorAll('a[data-ql-ref="lua"][href="#kn-lua"]').length, 1);
    assert.equal(dom.window.document.querySelectorAll("svg.llx-frag").length, 2);
    assert.deepEqual(result.report.items.filter((item) => item.severity !== "info"), []);
    assert.equal(await readFile(source, "utf8"), text);
    assert.deepEqual(await readdir(folder), ["main.tex"]);
    dom.window.close();
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("unsafe mappings and cancelled Lua document exports fail explicitly", async () => {
  const folder = await mkdtemp(join(tmpdir(), "latex-live-bridge-engine-test-"));
  try {
    const source = join(folder, "main.tex");
    await writeFile(source, "\\documentclass{article}\n\\begin{document}Test.\\end{document}\n");
    await assert.rejects(kgdistillerHtml({ schema, operation: "document", source, markers: [{ name: "A", id: "a", url: "javascript:alert(1)" }] }), /safe http/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(kgdistillerHtml({ schema, operation: "labels", labels: [] }, controller.signal), /cancelled/);
    await assert.rejects(kgdistillerHtml({ schema, operation: "document", source, engine: "lualatex", markers: [] }, controller.signal), /cancelled/);
    assert.deepEqual(await readdir(folder), ["main.tex"]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
