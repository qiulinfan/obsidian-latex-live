// Fidelity of the HTML export against real TeX builds (design 7, assertions 1 to 6; S2 to S6
// acceptance), on fresh $TMPDIR copies of the synthetic fixtures and generated documents
// (amsmath's numbering; floats, images, tables and fragments). Skipped without TeX; the
// comparisons with the PDF's text need Ghostscript (`gs -sDEVICE=txtwrite`) and are skipped
// without it.
//   1. every number the page shows for a label is the .aux's (texText of its number field);
//   2. the numbers the emitter took for equations, boxes, captions and footnotes are the probe's
//      steps of those counters, in order (shown, or taken back as TeX did: own \tag, subequations);
//   3. the class's names (定义, 定理, 命题, 图, 表, 目录, 参考文献; Definition, Lemma, Remark) are the
//      probe's and the contents' (and, for ASCII, the PDF's text);
//   4. the page's colour variables are the probe's values (elegantbook's blue scheme), their dark
//      variants readable (>= 4.5:1);
//   5. every reference's text is latexRefs' refText on the build's .aux, and its link resolves;
//   6. citation labels are the probe's biblatex numbers (natbib's `\bibcite`s), the bibliography
//      lists the .bbl's entries.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { refNames, refText, type LatexRefs } from "../src/editor/latexRefs";
import { exportHtml } from "../src/export/exporter";
import type { PdfImages } from "../src/export/images";
import { planExport, type ExportPlan } from "../src/export/plan";
import { readProbeLog, type ProbeLog } from "../src/export/probeLog";
import type { ExportReport } from "../src/export/report";
import { walkTex, argText, type TexNode } from "../src/export/texTree";
import { readAuxLabels } from "../src/tex/aux";
import { texTool } from "../src/tex/binaries";
import { projectDefinitions } from "../src/tex/macros";
import { stripComments } from "../src/tex/project";
import { texText } from "../src/tex/texText";
import { ELEGANT_SCHEMES, theoremMap } from "../src/tex/theorems";
import { contrast } from "../src/export/profiles";
import { fixtureCopy, nodeExportHost, removeExportTemps, testPng, texBin, type NodeExportHost } from "./support/exportHost";

const skip = !texBin ? "no TeX installation found" : !existsSync(texTool(texBin, "xelatex")) ? "no XeLaTeX" : false;
const gs = spawnSync("gs", ["--version"]).status === 0 ? "gs" : null;

interface Exported {
  root: string;
  host: NodeExportHost;
  plan: ExportPlan;
  log: ProbeLog;
  refs: LatexRefs;
  html: string;
  report: ExportReport;
}

const temps: string[] = [];
after(() => {
  removeExportTemps();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A stand-in for Obsidian's pdf.js: each page a 2x1 PNG, A5 in size. */
const pdfStandIn: PdfImages = async (_abs, want) => want(1).map((page) => ({ page, png: testPng(2, 1), width: 419.5, height: 595.3 }));

/** Export `root` (a full build first); the plan, the probe's log and the build's references with it. */
async function exported(root: string): Promise<Exported> {
  const host = nodeExportHost(root);
  host.pdfImages = pdfStandIn;
  const { html, report } = await exportHtml(root, host, () => undefined, new AbortController().signal);
  const defs = projectDefinitions(root);
  const sources = defs.files.map((f) => stripComments(readFileSync(f, "utf8")));
  const theorems = theoremMap(sources);
  const plan = planExport(root, { defs, theorems });
  const log = readProbeLog(readFileSync(join(host.workDir, "main.llx"), "utf8"));
  const refs: LatexRefs = { labels: readAuxLabels(host.buildDir), numbers: new Map(), cites: new Map(), names: refNames(sources, theorems), theorems, checkpoints: new Map() };
  return { root, host, plan, log, refs, html, report };
}

const fixtures = new Map<string, Promise<Exported>>();
const fixture = (name: string) => {
  let p = fixtures.get(name);
  if (!p) fixtures.set(name, (p = exported(fixtureCopy(name).root)));
  return p;
};

/** The page without its stylesheet. */
const body = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "");

/** HTML text as a reader sees it (tags gone, entities decoded). */
const text = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\u00a0/g, " ");
/** Without white space (Ghostscript's text drops or adds spaces between glyphs). */
const squeeze = (s: string) => s.replace(/[\s ]+/g, "");

/** The text of a PDF (Ghostscript's txtwrite; the Fandol glyphs come out as other characters, ASCII is kept). */
const pdfText = (pdf: string) => execFileSync(gs!, ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=txtwrite", "-sOutputFile=-", pdf], { encoding: "utf8", maxBuffer: 64 << 20 });

/** The equation tags a PDF prints: a parenthesized number last on its line (a box's frame glyph may follow). */
const pdfTags = (pdf: string) =>
  pdfText(pdf)
    .split(/\r?\n/)
    .flatMap((line) => /\s\(([0-9A-Za-z.]+)\)(?:\s+\S)?\s*$/.exec(line)?.[1] ?? []);

/** The tags the page shows: equation numbers and own \tags, in order. */
const shownTags = (r: ExportReport) => r.numbers.filter((n) => (n.counter === "equation" || n.counter === "tag") && n.shown).map((n) => n.value);

/** Assertion 1: every labelled number shown is the .aux's. */
function assertLabels(e: Exported): number {
  const labelled = e.report.numbers.filter((n) => n.label && n.shown);
  for (const n of labelled) {
    const aux = e.refs.labels.get(n.label!);
    assert.ok(aux, `${n.label} in the .aux`);
    assert.equal(n.value, texText(aux.number), `${n.counter} ${n.label}`);
  }
  return labelled.length;
}

/** Assertion 2: per counter, the numbers taken are the probe's steps (merged as StepQueue merges them). */
function assertSteps(e: Exported): void {
  const counters = new Set(["equation", "figure", "table", "footnote", ...e.report.numbers.map((n) => n.counter)]);
  counters.delete("tag");
  for (const c of counters) {
    const steps: string[] = [];
    let last: ProbeLog["steps"][number] | undefined;
    for (const s of e.log.steps) {
      if (s.counter !== c) continue;
      if (!(last && last.value === s.value && last.visit === s.visit && last.line === s.line)) steps.push(texText(s.value));
      last = s;
    }
    assert.deepEqual(e.report.numbers.filter((n) => n.counter === c).map((n) => n.value), steps, c);
  }
  assert.deepEqual(e.report.items.filter((i) => i.kind === "numbering"), []);
}

const REFS: Record<string, string> = { ref: "ref", eqref: "eqref", pageref: "pageref", autoref: "autoref", Autoref: "autoref", cref: "cref", Cref: "Cref", nameref: "nameref" };

/** Assertion 5: the references' texts are refText's on the .aux (outside math and fragments), and every link resolves. */
function assertRefs(e: Exported): number {
  const expected: string[] = [];
  for (const v of e.plan.visits) {
    const file = e.plan.files.get(v.key)!;
    const doc = v.key === e.plan.rootKey ? file.nodes.find((n) => n.t === "env" && n.name === "document") : null;
    const nodes: readonly TexNode[] = v.key === e.plan.rootKey ? (doc?.t === "env" ? doc.body : []) : file.nodes;
    walkTex(nodes, (n) => {
      if (e.plan.fragments.some((f) => f.key === v.key && f.from === n.from)) return false;
      if (n.t !== "macro" || !(n.name in REFS)) return;
      const keys = argText(file.src, n.args[n.args.length - 1]).split(",").map((k) => k.trim()).filter(Boolean);
      expected.push(refText(REFS[n.name], keys, e.refs).text);
    });
  }
  const shown = [...e.html.matchAll(/<(?:a|span) class="llx-ref[^"]*"[^>]*>([^<]*)<\/(?:a|span)>/g)].map((m) => text(m[1]));
  assert.deepEqual([...shown].sort(), [...expected].sort());
  const ids = new Set([...e.html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]));
  for (const m of e.html.matchAll(/href="#([^"]*)"/g)) assert.ok(ids.has(decodeURIComponent(m[1])), `link to #${m[1]}`);
  return shown.length;
}

test("book (XeLaTeX, elegantbook): equation tags as the PDF prints them, labels, steps", { skip, timeout: 240_000 }, async (t) => {
  if (!gs) t.diagnostic("no Ghostscript: the comparisons with the PDFs' text are skipped");
  const e = await fixture("export-book");
  assert.deepEqual(shownTags(e.report), ["1.1", "1.2", "1.3", "1.4", "2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "3.1", "3.2", "3.3", "3.4", "3.5"]);
  if (gs) assert.deepEqual(pdfTags(join(e.host.buildDir, "main.pdf")), shownTags(e.report));
  assert.equal(assertLabels(e), 28);
  assertSteps(e);
  // The boxes, captions and the footnote as the PDF numbers them.
  const of = (c: string) => e.report.numbers.filter((n) => n.counter === c).map((n) => n.value);
  assert.deepEqual(of("tcb@cnt@theorem"), ["1.1", "2.1", "3.1"]);
  assert.deepEqual([...of("figure"), ...of("table")], ["2.1", "2.2", "2.1", "A.1"]);
  assert.deepEqual(of("footnote"), ["1"]);
  // \intertext is a paragraph between the two parts of its alignment; math renders, no source left.
  assert.match(e.html, /<\/mjx-container><\/div><p class="llx-cont llx-intertext">再由凸性 <mjx-container/);
  assert.equal(e.report.counts.math, 130);
  assert.doesNotMatch(e.html.replace(/<style>[\s\S]*?<\/style>/, ""), /class="llx-math|llx-math-error|<mjx-merror|data-mjx-error/);
  assert.ok(e.report.counts.mathFontBytes > 100_000 && e.report.counts.mathFontBytes < 400_000, `${e.report.counts.mathFontBytes}`);
});

test("book: references, citations [5, 第 2 章] and [2, 3], the bibliography", { skip, timeout: 240_000 }, async () => {
  const e = await fixture("export-book");
  assert.ok(assertRefs(e) >= 40);
  const page = text(e.html);
  for (const s of ["[5, 第 2 章]", "[2, 3]", "[1, 5]", "[6]", "[4]", "定理 1.1", "(1.1)、(1.2)、(2.3)、(3.2)、(3.5)", "图 2.1、图 2.2、表 2.1"]) assert.ok(page.includes(s), s);
  if (gs) {
    const pdf = squeeze(pdfText(join(e.host.buildDir, "main.pdf")));
    for (const s of ["[2,3]", "[1,5]", "[6]", "[4]", "[1]LinChen,EllenExample,andPaulPlaceholder."]) assert.ok(pdf.includes(s), `PDF: ${s}`);
  }
  // Assertion 6: labels are the probe's numbers; the bibliography is the .bbl's data list.
  for (const m of e.html.matchAll(/<a class="llx-cite-link" href="#llx-bib-([^"]*)">([^<]*)<\/a>/g)) {
    const c = e.log.cites.get(m[1]);
    assert.equal(m[2], `${c?.prefix}${c?.number}`, m[1]);
  }
  const bbl = readFileSync(join(e.host.buildDir, "main.bbl"), "utf8");
  const entries = [...bbl.slice(0, bbl.indexOf("\\enddatalist")).matchAll(/\\entry\{([^{}]*)\}/g)].map((m) => m[1]);
  const items = [...e.html.matchAll(/<li id="llx-bib-([^"]*)"><span class="llx-label">\[([^\]]*)\]<\/span>/g)];
  assert.deepEqual(items.map((m) => m[1]).sort(), [...entries].sort());
  for (const m of items) assert.equal(m[2], e.log.cites.get(m[1])?.number);
  assert.match(page, /\[5\]张三 and 李四\. 概率论讲义（示例版）\. chinese\. 北京: 示例出版社, 2020\./);
  assert.deepEqual(e.report.items.filter((i) => i.severity !== "info"), []);
});

test("article (pdfLaTeX, natbib, cleveref): (2a)(2b) and (⋆); references and citations as the PDF prints them", { skip, timeout: 240_000 }, async () => {
  const e = await fixture("export-article");
  assert.deepEqual(shownTags(e.report), ["1", "2a", "2b", "⋆", "3", "4", "5"]);
  // The PDF's ASCII tags (⋆ is no ASCII); the picture's label `bound (2b)` ends a line of its text too.
  if (gs) assert.deepEqual(pdfTags(join(e.host.buildDir, "main.pdf")), ["1", "2a", "2b", "2b", "3", "4", "5"]);
  assert.equal(assertLabels(e), 13);
  assertSteps(e);
  assert.ok(assertRefs(e) >= 15);
  // The \thanks footnote's mark is TeX's (\@fnsymbol).
  assert.deepEqual(e.report.numbers.filter((n) => n.counter === "footnote").map((n) => n.value), ["∗"]);
  const page = squeeze(text(e.html));
  const expected = [
    "recoverthem[1].",
    "numerically.RoeandPlaceholder",
    "[3]givearelatedmulti-viewargument",
    "seealso[1,Sec.3].",
    "Section2derivesabound",
    "andSection3checks",
    "Table1comparesthebound(2b)",
    "Figures1and2showthetrend",
    "(Equation(⋆))",
    "ProofofTheorem2.2.",
    "UnderTheorem2.2,",
    "attentionmodels;see[2,3].",
    "ComparewithTheorem3.1andSection1.",
  ];
  for (const s of expected) assert.ok(page.includes(s), s);
  if (gs) {
    const pdf = squeeze(pdfText(join(e.host.buildDir, "main.pdf")));
    for (const s of expected) assert.ok(pdf.includes(s), `PDF: ${s}`);
  }
  // natbib's labels are the .aux's \bibcite numbers; the bibliography lists the .bbl's items.
  for (const m of e.html.matchAll(/<a class="llx-cite-link" href="#llx-bib-([^"]*)">([^<]*)<\/a>/g)) {
    assert.equal(m[2], { doe2023masked: "1", lee2024note: "2", roe2022views: "3" }[m[1]], m[1]);
  }
  const bbl = readFileSync(join(e.host.buildDir, "main.bbl"), "utf8");
  const items = [...e.html.matchAll(/<li id="llx-bib-([^"]*)"><span class="llx-label">\[(\d+)\]<\/span>/g)].map((m) => `${m[2]} ${m[1]}`);
  assert.equal(items.length, (bbl.match(/\\bibitem/g) ?? []).length);
  assert.deepEqual(items, ["1 doe2023masked", "2 lee2024note", "3 roe2022views"]);
  // The two MathJax-rejected set formulas and the plot are SVG; keypoint expands into HTML.
  assert.equal(e.report.counts.planned, 3);
  assert.equal((e.html.match(/<svg class="llx-frag"/g) ?? []).length, 3);
  assert.match(body(e.html), /<b>Notation\.<\/b>/, "a custom text environment keeps its native head");
  assert.match(e.html, /<\/mjx-container> with <svg class="llx-frag"[^>]*style="vertical-align:-0\.25\d*em">/);
  assert.doesNotMatch(body(e.html), /class="llx-source/);
  assert.deepEqual(e.report.items.filter((i) => i.severity !== "info"), []);
});

test("homework (listings, algorithm): captions and labels as TeX numbers them", { skip, timeout: 240_000 }, async () => {
  const e = await fixture("export-homework");
  assertLabels(e);
  assertSteps(e);
  assertRefs(e);
  assert.deepEqual(e.report.numbers.map((n) => `${n.counter} ${n.value}`), ["lstlisting 1.1", "algorithm 1"]);
});

test("book: the class's names and colours as TeX prints them (assertions 3, 4)", { skip, timeout: 240_000 }, async () => {
  const e = await fixture("export-book");
  const names = e.log.names;
  // 3. Box heads, caption labels, the contents' title and heads of the class's environments are the probe's names.
  const heads = new Set([...e.html.matchAll(/<div class="llx-box-title">(\S+) /g)].map((m) => m[1]));
  assert.deepEqual([...heads].sort(), ["definition", "theorem", "proposition", "lemma", "corollary"].map((k) => names.get(k)).sort());
  assert.deepEqual(["definition", "theorem", "proposition", "figure", "table", "contents", "proof"].map((k) => names.get(k)), ["定义", "定理", "命题", "图", "表", "目录", "证明"]);
  const captions = [...e.html.matchAll(/<span class="llx-caption-label">(\S+) [^<]*<\/span>/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(captions)], [names.get("figure"), names.get("table")]);
  assert.match(e.html, new RegExp(`<nav class="llx-toc"><h2>${names.get("contents")}</h2>`));
  const runIn = [...e.html.matchAll(/<span class="llx-thm-head">([^< ]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(runIn)].sort(), ["note", "proof", "example", "remark", "exercise", "solution"].map((k) => names.get(k)).sort());
  // The bibliography's heading is its contents entry (elegantbook's bibintoc: 参考文献).
  const toc = readFileSync(join(e.host.buildDir, "main.toc"), "utf8");
  assert.match(toc, /\\contentsline \{chapter\}\{参考文献\}/);
  assert.match(e.html, /<h2 class="llx-chapter" id="[^"]*">参考文献<\/h2>/);
  // 4. The colour variables: the probe's values, elegantbook's blue scheme, winered links; readable in dark mode.
  const [light, dark] = e.html.split("@media (prefers-color-scheme: dark) { :root { --llx-c-");
  const vars = (css: string) => Object.fromEntries([...css.matchAll(/--llx-c-([\w-]+): (rgb\([^)]*\))/g)].map((m) => [m[1], m[2]]));
  const lightVars = vars(/:root \{ (--llx-c-[^}]*)\}/.exec(light)![1]);
  for (const k of ["structurecolor", "main", "second", "third", "winered", "coverlinecolor"]) assert.equal(lightVars[k], e.log.colors.get(k), k);
  const rgb = (c: readonly number[]) => `rgb(${c.join(", ")})`;
  assert.deepEqual([lightVars.main, lightVars.second, lightVars.third], ELEGANT_SCHEMES.blue.map(rgb));
  assert.equal(lightVars.winered, "rgb(128, 0, 0)");
  const darkVars = vars(`--llx-c-${dark.slice(0, dark.indexOf("}"))}`);
  assert.deepEqual(Object.keys(darkVars).sort(), Object.keys(lightVars).sort());
  for (const [k, v] of Object.entries(darkVars)) assert.ok(contrast(v.match(/\d+/g)!.map(Number) as unknown as [number, number, number], [48, 48, 52]) >= 4.5, `${k} ${v}`);
  // The boxes take their role's variables: definition main, theorem second, proposition third.
  assert.match(e.html, /<div class="llx-box llx-thm llx-definition is-main" id="def:prob-space">/);
  assert.match(e.html, /<div class="llx-box llx-thm llx-proposition is-third"/);
});

test("article: amsthm's names and heads as the PDF prints them (assertion 3)", { skip, timeout: 240_000 }, async () => {
  const e = await fixture("export-article");
  const page = squeeze(text(e.html));
  const heads = ["Definition2.1(Linearreconstructor).", "Lemma2.2.", "Theorem3.1.", "Remark.", "ProofofTheorem2.2.", "Abstract", "References", "Table1", "Figure1", "Figure2"];
  for (const s of heads) assert.ok(page.includes(s), s);
  if (gs) {
    const pdf = squeeze(pdfText(join(e.host.buildDir, "main.pdf")));
    for (const s of heads) assert.ok(pdf.includes(s), `PDF: ${s}`);
  }
  // amsthm's styles from the census: the definition upright, the lemma italic, the remark's head italic.
  assert.match(e.html, /<div class="llx-thm llx-definition" id="def:linear"><p class="llx-cont"><span class="llx-thm-head">Definition 2\.1 <span class="llx-thm-note">\(Linear reconstructor\)<\/span>\.<\/span>/);
  assert.match(e.html, /<div class="llx-thm llx-lemma llx-it"/);
  assert.match(e.html, /<div class="llx-thm llx-remark is-head-it">/);
  assert.equal(e.report.profile, "standard");
});

test("book: the projection and tikz-cd as vector SVG, the heatmap embedded, table 2.1 with booktabs rules (S5, S6)", { skip, timeout: 240_000 }, async () => {
  const e = await fixture("export-book");
  // Every planned fragment is an SVG (none as source), its fonts its own.
  assert.equal(e.report.counts.planned, 2);
  assert.equal((e.html.match(/<svg class="llx-frag"/g) ?? []).length, 2);
  assert.doesNotMatch(body(e.html), /class="llx-source/);
  const [projection, cd] = [...e.html.matchAll(/<svg class="llx-frag"[\s\S]*?<\/svg>/g)].map((m) => m[0]);
  assert.match(projection, /<text[^>]*><tspan fill='currentColor'>span<\/tspan>/, "the picture's labels are text");
  assert.match(e.html, /<figure class="llx-float llx-figure"><p><svg class="llx-frag"[\s\S]*?<\/svg><\/p><figcaption><span class="llx-caption-label">图 2\.1<\/span>向量 /);
  assert.match(e.html, /<div class="llx-frag-block is-display"><svg class="llx-frag"/);
  assert.ok(cd.includes("currentColor"));
  // The heatmap: the file's bytes as a data URI, at 0.55\linewidth.
  const heatmap = readFileSync(join(process.cwd(), "tests", "fixtures", "export-book", "figures", "heatmap.png")).toString("base64");
  assert.ok(e.html.includes(`<img class="llx-img" src="data:image/png;base64,${heatmap}" alt="heatmap" style="width:55%">`));
  // Table 2.1: \toprule over the head, \midrule under it, \bottomrule under the last row.
  const table = /<span class="llx-caption-label">表 2\.1<\/span>矩阵分解一览<\/figcaption><a id="tab:decomp"><\/a>(<table class="llx-tabular">[\s\S]*?<\/table>)/.exec(e.html)![1];
  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<td class="([^"]*)">/g)].map((c) => c[1]));
  assert.deepEqual(rows, [
    ["llx-l llx-rt-heavy", "llx-l llx-rt-heavy", "llx-l llx-rt-heavy"],
    ["llx-l llx-rt-light", "llx-l llx-rt-light", "llx-l llx-rt-light"],
    ["llx-l", "llx-l", "llx-l"],
    ["llx-l llx-rb-heavy", "llx-l llx-rb-heavy", "llx-l llx-rb-heavy"],
  ]);
  // Figure and table numbers are the .aux's, after the TikZ figure too.
  const labelled = Object.fromEntries(e.report.numbers.filter((n) => n.label).map((n) => [n.label!, n.value]));
  for (const k of ["fig:projection", "fig:heatmap", "tab:decomp", "tab:notation"]) assert.equal(labelled[k], texText(e.refs.labels.get(k)!.number), k);
  assert.equal(e.report.counts.images, 1);
});

test("homework: \\includepdf's page as an image (through the host's pdf.js), the algorithmic as an SVG with its Chinese", { skip, timeout: 240_000 }, async () => {
  const e = await fixture("export-homework");
  assert.match(e.html, new RegExp(`<div class="llx-pdfpages"><img class="llx-img" src="data:image/png;base64,${testPng(2, 1).toString("base64")}" alt="scan" style="width:38\\.4\\d*em"></div>`));
  const algorithm = /<figure class="llx-float llx-algorithm">([\s\S]*?)<\/figure>/.exec(e.html)![1];
  assert.match(algorithm, /^<figcaption><span class="llx-caption-label">Algorithm 1<\/span>广度优先搜索 BFS<\/figcaption><a id="alg:bfs"><\/a><div class="llx-frag-block"><svg class="llx-frag"/);
  const words = [...algorithm.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]).join("");
  for (const w of ["标记", "非空", "未标记"]) assert.ok(words.includes(w), w);
  assert.deepEqual(e.report.items.filter((i) => i.severity !== "info"), []);
});

/** A document with floats, images, tables and fragments (pdfLaTeX): numbers after fragments stay TeX's. */
const FLOATS_DOC = String.raw`\documentclass{article}
\usepackage{amsmath,graphicx,booktabs,multirow,tikz,subcaption,listings,capt-of}
\usepackage{hyperref}
\NewDocumentCommand{\pair}{m o}{\langle #1 \IfValueT{#2}{\mid #2}\rangle}
\begin{document}
\section{Floats}
\begin{equation}\label{e:one} a = b \end{equation}
A numbered formula MathJax rejects, drawn by TeX:
\begin{equation}\label{e:frag} \pair{x}[y] = 1 \end{equation}
then \eqref{e:frag} and an inline one, $\pair{z}$\footnote{A note after the fragment.}.
\begin{equation}\label{e:three} c = d \end{equation}
\begin{figure}[h]
  \centering
  \begin{tikzpicture}\draw (0,0) -- (1,1) node[right] {$x^2$};\end{tikzpicture}
  \caption{A picture.}\label{f:pic}
\end{figure}
\begin{figure}[h]
  \centering
  \begin{subfigure}[b]{0.45\textwidth}\centering
    \includegraphics[width=\linewidth]{dot.png}
    \caption{Left.}\label{f:left}
  \end{subfigure}\hfill
  \begin{subfigure}[b]{0.45\textwidth}\centering
    \includegraphics[scale=2]{dot}
    \caption{Right.}\label{f:right}
  \end{subfigure}
  \caption{Two pictures.}\label{f:two}
\end{figure}
\begin{table}[h]
  \centering
  \caption{Rules.}\label{t:rules}
  \begin{tabular}{|l|c|r|}
    \hline\hline
    a & b & c \\ \hline
    \multicolumn{2}{|c|}{wide} & d \\ \cline{2-3}
    e & f & g \\
    \hline
  \end{tabular}
\end{table}
\begin{table}[h]
  \centering
  \begin{tabular}{ll}
    \multirow{2}{*}{span} & x \\ & y \\
  \end{tabular}
  \caption{Spanning rows.}\label{t:multi}
\end{table}
\begin{center}
  \includegraphics[height=1cm]{dot.png}
  \captionof{figure}{Outside a float.}\label{f:captionof}
\end{center}
\begin{lstlisting}[caption={Inline listing},label=l:one]
x = 1
\end{lstlisting}
\lstinputlisting[caption={From a file},label=l:two,firstline=2,lastline=3]{code.py}
\begin{equation}\label{e:last} e = f \end{equation}
Figures \ref{f:pic}, \ref{f:two}, \ref{f:left}, \ref{f:captionof}; tables \ref{t:rules}, \ref{t:multi};
listings \ref{l:one}, \ref{l:two}; equations \eqref{e:one}, \eqref{e:three}, \eqref{e:last}.
\end{document}
`;

test("floats, images, tables and fragments (pdfLaTeX): every number TeX's, after the fragments too", { skip, timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-export-floats-"));
  temps.push(dir);
  writeFileSync(join(dir, "main.tex"), FLOATS_DOC);
  writeFileSync(join(dir, "dot.png"), testPng(20, 10));
  writeFileSync(join(dir, "code.py"), "line one\nline two\nline three\nline four\n");
  const e = await exported(join(dir, "main.tex"));
  // The numbered formula and the inline one are TeX's drawings; so are the picture and the table with \multirow.
  assert.equal(e.report.counts.planned, 4);
  assert.equal((e.html.match(/<svg class="llx-frag"/g) ?? []).length, 4);
  assert.deepEqual(shownTags(e.report), ["1", "2", "3", "4"]);
  if (gs) assert.deepEqual(pdfTags(join(e.host.buildDir, "main.pdf")), ["1", "2", "3", "4"]);
  // Equations 1-4 (2 drawn by TeX), figures 1-3, tables 1-2, listings 1-2 (sub-captions show (a), not 2a).
  assert.equal(assertLabels(e), 11);
  assertSteps(e);
  assertRefs(e);
  const of = (c: string) => e.report.numbers.filter((n) => n.counter === c).map((n) => n.value);
  assert.deepEqual([of("figure"), of("subfigure"), of("table"), of("lstlisting"), of("footnote")], [["1", "2", "3"], ["a", "b"], ["1", "2"], ["1", "2"], ["1"]]);
  const page = squeeze(text(e.html));
  for (const s of ["Figure1Apicture.", "(a)Left.", "(b)Right.", "Figure2Twopictures.", "Table1Rules.", "Table2Spanningrows.", "Figure3Outsideafloat.", "Listing1Inlinelisting", "Listing2Fromafile", "then(2)andaninlineone,", "Figures1,2,2a,3;tables1,2;listings1,2;equations(1),(3),(4)."]) {
    assert.ok(page.includes(s), s);
  }
  assert.match(e.html, /<code>line two\nline three<\/code>/);
  assert.equal((e.html.match(/<img class="llx-img" src="data:image\/png;base64,/g) ?? []).length, 3);
  assert.deepEqual(e.report.items.filter((i) => i.severity !== "info"), []);
});

/** A document with every amsmath numbering case (the export's rows against TeX's). */
const MATH_DOC = String.raw`\documentclass{article}
\usepackage{amsmath}
\usepackage{hyperref}
\begin{document}
\section{Numbers}
\begin{equation}\label{e:one} a = b \end{equation}
\begin{equation} c = d \tag{A}\label{e:a} \end{equation}
\begin{equation} c = d \notag \end{equation}
\begin{align}
  x &= 1 \label{e:x} \\
  y &= 2 \tag{B}\label{e:b} \\
  z &= 3 \notag \\
  w &= 4 \nonumber \\
  v &= 5 \label{e:v}
\end{align}
\begin{gather} p = q \\ r = s \notag \end{gather}
\begin{multline} m + n \\ = o \tag{C}\label{e:c} \end{multline}
\begin{multline} m + n \\ = o \label{e:m} \end{multline}
\begin{subequations}\label{e:sub}
\begin{align}
  f &= g \label{e:suba} \\
  h &= i
\end{align}
\end{subequations}
\begin{equation}\label{e:split}
  \begin{split} s &= t \\ &= u \end{split}
\end{equation}
\begin{align}
  k &= l \label{e:k} \\
  \intertext{and so}
  k' &= l' \label{e:inter}
\end{align}
\begin{flalign} aa &= bb & cc &= dd \end{flalign}
\begin{alignat}{2} aa &= bb &\quad cc &= dd \label{e:alat} \end{alignat}
\begin{eqnarray}
  a & = & b \nonumber \\
  c & = & d \label{e:eqna}
\end{eqnarray}
\begin{eqnarray*} a & = & b \end{eqnarray*}
\begin{align}
  t &= 1 \\
  t &= 2 \\
\end{align}
\[ q = r \]
\begin{equation*} q = r \tag{D} \end{equation*}
\begin{equation} z = y \label{e:last} \end{equation}
See \eqref{e:one}, \eqref{e:a}, \eqref{e:x}, \eqref{e:b}, \eqref{e:v}, \eqref{e:c}, \eqref{e:m}, \eqref{e:sub},
\eqref{e:suba}, \eqref{e:split}, \eqref{e:inter}, \eqref{e:alat}, \eqref{e:eqna} and \eqref{e:last}.
\end{document}
`;

test("amsmath's numbering (pdfLaTeX): own tags, \\notag, subequations, split, \\intertext, eqnarray, a trailing \\\\", { skip, timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-export-math-"));
  temps.push(dir);
  writeFileSync(join(dir, "main.tex"), MATH_DOC);
  const e = await exported(join(dir, "main.tex"));
  const tags = ["1", "A", "2", "B", "3", "4", "C", "5", "6a", "6b", "7", "8", "9", "10", "11", "12", "13", "14", "15", "D", "16"];
  assert.deepEqual(shownTags(e.report), tags);
  if (gs) assert.deepEqual(pdfTags(join(e.host.buildDir, "main.pdf")), tags);
  assert.equal(assertLabels(e), 14);
  assertSteps(e);
  assertRefs(e);
  assert.match(e.html, /<p class="llx-cont llx-intertext">and so<\/p>/);
  assert.equal((e.html.match(/<mjx-mlabeledtr/g) ?? []).length, tags.length);
  assert.deepEqual(e.report.items.filter((i) => i.severity !== "info"), []);
});
