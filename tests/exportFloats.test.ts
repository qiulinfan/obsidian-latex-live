// Floats, images and tables of the HTML export (S6): tables.ts (column specs, rows, booktabs and
// \hline rules, \cline/\cmidrule, \multicolumn), images.ts (lengths, pdfpages' page lists, bitmap
// sizes, the images a plan names), and the emitter on synthetic documents with handwritten probe
// logs: captions with the probe's names and numbers (`\caption*`, subcaption's `(a)`,
// `\captionof`), images as data URIs at graphicx's sizes, PDF pages through a stand-in for
// Obsidian's pdf.js, `\includepdf`, `\lstinputlisting`, the algorithm float around its TeX
// fragment, and the tables the plan leaves to TeX. No TeX here (exportFidelity.test.ts compares a
// real build).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { bitmapSize, cssLength, keyValues, pdfPageList, type PdfImages } from "../src/export/images";
import { planExport } from "../src/export/plan";
import { tableColumns } from "../src/export/tables";
import { projectDefinitions } from "../src/tex/macros";
import { theoremMap } from "../src/tex/theorems";
import { emitDoc, removeExportTemps, testPng as png } from "./support/exportHost";

after(removeExportTemps);

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

test("column specs: alignments, paragraph widths, rules, @{}, *{n}{..}, >{..}, S and X", () => {
  const cols = tableColumns(String.raw`@{}l|c|p{3cm}*{2}{r}@{}`);
  assert.deepEqual(
    cols.map((c) => [c.align, c.width, c.ruleLeft, c.ruleRight, c.noPadLeft, c.noPadRight]),
    [
      ["l", null, 0, 1, true, false],
      ["c", null, 0, 1, false, false],
      ["p", "3cm", 0, 0, false, false],
      ["r", null, 0, 0, false, false],
      ["r", null, 0, 0, false, true],
    ],
  );
  assert.deepEqual(tableColumns("|l||c|").map((c) => [c.ruleLeft, c.ruleRight]), [[1, 2], [0, 1]]);
  assert.deepEqual(tableColumns(String.raw`S[table-format=2.1] >{\bfseries}l<{x} !{\vrule} m{2em} b{1in} X`).map((c) => c.align), ["c", "l", "m", "b", "p"]);
  assert.deepEqual(tableColumns(""), []);
});

test("lengths, key=value options and pdfpages' page lists", () => {
  assert.equal(cssLength(String.raw`0.55\linewidth`, 10.95), "55%");
  assert.equal(cssLength(String.raw`\textwidth`, 10), "100%");
  assert.equal(cssLength(String.raw` .3 \columnwidth `, 10), "30%");
  assert.equal(cssLength("5cm", 10), "14.226em");
  assert.equal(cssLength("12pt", 12), "1em");
  assert.equal(cssLength("72bp", 10), "7.227em");
  assert.equal(cssLength("2em", 10), "2em");
  assert.equal(cssLength(String.raw`\dimexpr 1pt\relax`, 10), null);
  assert.deepEqual([...keyValues(String.raw`width=0.5\linewidth, pages={1,3-4}, keepaspectratio ,trim=1 2 3 4`)], [
    ["width", String.raw`0.5\linewidth`],
    ["pages", "1,3-4"],
    ["keepaspectratio", ""],
    ["trim", "1 2 3 4"],
  ]);
  const cases: [string | null, number, number[]][] = [
    [null, 5, [1]],
    ["1", 5, [1]],
    ["{1,3-4}", 5, [1, 3, 4]],
    ["-", 3, [1, 2, 3]],
    ["3-", 5, [3, 4, 5]],
    ["-2", 5, [1, 2]],
    ["last", 5, [5]],
    ["last-1", 5, [4]],
    ["2-last", 4, [2, 3, 4]],
    ["5-3", 5, [5, 4, 3]],
    ["{},2", 3, [2]],
    ["9", 3, []],
  ];
  for (const [spec, count, pages] of cases) assert.deepEqual(pdfPageList(spec, count), pages, `${spec} of ${count}`);
});

test("bitmap sizes: PNG with and without its resolution, JPEG's JFIF density and frame, GIF", () => {
  assert.deepEqual(bitmapSize(png(40, 20), "png"), { width: 40, height: 20, dpi: null });
  const dpi = bitmapSize(png(40, 20, 144), "png")!.dpi!;
  assert.ok(Math.abs(dpi - 144) < 0.01, `${dpi}`);
  // A JPEG's headers: SOI, APP0 JFIF at 300 dpi, a DQT, SOF0 of 64x32.
  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x01, 0x2c, 0x01, 0x2c, 0x00, 0x00,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  assert.deepEqual(bitmapSize(jpeg, "jpg"), { width: 64, height: 32, dpi: 300 });
  assert.deepEqual(bitmapSize(Buffer.from("GIF89a\x07\x00\x05\x00", "latin1"), "gif"), { width: 7, height: 5, dpi: null });
  assert.equal(bitmapSize(Buffer.from("not an image"), "png"), null);
});

test("tables: booktabs rules, \\hline (twice: double), \\cline and \\cmidrule ranges, \\multicolumn, vertical rules, p columns", async () => {
  const body = String.raw`\begin{tabular}{@{}lcr@{}}
  \toprule
  A & \multicolumn{2}{c}{B and C} \\ \cmidrule(lr){2-3}
  a & $x$ & 1 \\
  \midrule
  b & y & 2 \\[2pt]
  \bottomrule
\end{tabular}

\begin{tabular}{|l|p{3cm}|}
  \hline\hline
  x & long text \\ \cline{2-2}
  \multicolumn{1}{|r|}{z} & w \\
  \hline
\end{tabular}`;
  const out = await emitDoc({ preamble: String.raw`\usepackage{booktabs}`, body, llx: "llxinfo{fontsize}{10}" });
  const [booktabs, ruled] = [...out.body.matchAll(/<table class="llx-tabular">[\s\S]*?<\/table>/g)].map((m) => m[0]);
  const rows = (table: string) => [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((c) => `${c[1].trim()} ${c[2].replace(/<mjx-container[\s\S]*<\/mjx-container>/, "M")}`));
  assert.deepEqual(rows(booktabs), [
    // A \multicolumn's own spec replaces the columns' (and their @{}): its padding is back.
    ['class="llx-l llx-npl llx-rt-heavy" A', 'colspan="2" class="llx-c llx-rt-heavy" B and C'],
    ['class="llx-l llx-npl" a', 'class="llx-c llx-rt-light" M', 'class="llx-r llx-npr llx-rt-light" 1'],
    ['class="llx-l llx-npl llx-rt-light llx-rb-heavy" b', 'class="llx-c llx-rt-light llx-rb-heavy" y', 'class="llx-r llx-npr llx-rt-light llx-rb-heavy" 2'],
  ]);
  assert.match(ruled, /^<table class="llx-tabular"><colgroup><col><col style="width:8\.536em"><\/colgroup>/);
  assert.deepEqual(rows(ruled), [
    ['class="llx-l llx-vl llx-vr llx-rt-double" x', 'class="llx-p llx-vp llx-vr llx-rt-double" long text'],
    ['class="llx-r llx-vl llx-vr llx-rb-thin" z', 'class="llx-p llx-vp llx-vr llx-rt-thin llx-rb-thin" w'],
  ]);
  assert.deepEqual(out.report.items, []);
  assert.equal(out.counts.tables, 2);
});

test("the tables HTML cannot draw are TeX fragments; a box around a table is a block", async () => {
  const body = String.raw`\begin{tabular}{ll} \multirow{2}{*}{a} & b \\ & c \end{tabular}
\begin{tabular}{l} \rowcolor{gray} x \end{tabular}
\begin{tabular}{l} plain \end{tabular}
\resizebox{0.5\linewidth}{!}{\begin{tabular}{cc} p & q \\ \end{tabular}}`;
  const out = await emitDoc({ preamble: String.raw`\usepackage{multirow,colortbl,graphicx}`, body, llx: "llxinfo{fontsize}{10}" });
  const root = join(out.dir, "main.tex");
  const defs = projectDefinitions(root);
  const plan = planExport(root, { defs, theorems: theoremMap([]) });
  assert.deepEqual(plan.fragments.map((f) => [f.kind, f.what]), [
    ["inline", "tabular with spanning rows or colours"],
    ["inline", "tabular with spanning rows or colours"],
  ]);
  assert.equal((out.body.match(/<table class="llx-tabular">/g) ?? []).length, 2, "the plain table and the one in the box");
  assert.match(out.body, /<\/table><table class="llx-tabular"><tbody><tr><td class="llx-c">p<\/td><td class="llx-c">q<\/td><\/tr><\/tbody><\/table>$/);
});

test("images: data URIs at graphicx's sizes, natural sizes at their resolution, EPS and missing files reported", async () => {
  const dot = png(40, 20, 144);
  const body = String.raw`\includegraphics[width=0.5\linewidth]{dot}
\includegraphics{dot.png}
\includegraphics[scale=2]{dot}
\includegraphics[height=2cm,angle=90]{dot}
\includegraphics[width=3cm,height=1cm,keepaspectratio]{dot}
\includegraphics{fig.eps}
\includegraphics{nothere}`;
  const out = await emitDoc({
    preamble: String.raw`\usepackage{graphicx}\graphicspath{{img/}}`,
    body,
    llx: "llxinfo{fontsize}{10}",
    files: { "img/dot.png": dot, "img/fig.eps": "%!PS-Adobe-3.0 EPSF-3.0\n" },
  });
  const imgs = [...out.body.matchAll(/<img class="llx-img" src="([^"]*)" alt="([^"]*)"(?: style="([^"]*)")?>/g)];
  assert.ok(imgs.every((m) => m[1] === `data:image/png;base64,${b64(dot)}`));
  // 40 px at 144 dpi is 20 bp: 2.0075 em of 10 pt; scale 2 doubles it.
  assert.deepEqual(imgs.map((m) => [m[2], m[3]]), [
    ["dot", "width:50%"],
    ["dot", "width:2.008em"],
    ["dot", "width:4.015em"],
    ["dot", "height:5.691em;transform:rotate(-90deg)"],
    ["dot", "width:8.536em"],
  ]);
  assert.match(out.body, /<span class="llx-missing">\[fig\.eps\]<\/span>/);
  assert.match(out.body, /<span class="llx-missing">\[nothere\]<\/span>/);
  assert.deepEqual(
    out.report.items.map((i) => [i.severity, i.kind, i.message, i.line]),
    [
      ["warning", "image", "fig.eps: EPS images are not exported (include a PDF or PNG version)", 9],
      ["warning", "image", "nothere: file not found", 10],
    ],
  );
  assert.equal(out.counts.images, 5);
});

test("PDF images and \\includepdf pages through the host's renderer: one call per file, the pages the document names", async () => {
  const calls: { file: string; pages: number[] }[] = [];
  const pdfImages: PdfImages = async (abs, want) => {
    const pages = want(3);
    calls.push({ file: abs.split("/").pop()!, pages });
    return pages.map((page) => ({ page, png: png(page, 1), width: 100 * page, height: 200 }));
  };
  const body = String.raw`\includegraphics[page=2,width=3cm]{doc.pdf}
\includepdf[pages={1,3}]{doc}
\includepdf{doc}
\includepdf[pages=-]{other.pdf}`;
  const files = { "doc.pdf": "%PDF-1.5 stand-in\n", "other.pdf": "%PDF-1.5 stand-in\n" };
  const out = await emitDoc({ preamble: String.raw`\usepackage{graphicx,pdfpages}`, body, llx: "llxinfo{fontsize}{10}", files, pdfImages });
  assert.deepEqual(calls, [
    { file: "doc.pdf", pages: [1, 2, 3] },
    { file: "other.pdf", pages: [1, 2, 3] },
  ]);
  const page = (n: number) => `data:image/png;base64,${b64(png(n, 1))}`;
  assert.match(out.body, new RegExp(`<img class="llx-img" src="${page(2)}" alt="doc" style="width:8\\.536em">`));
  const blocks = [...out.body.matchAll(/<div class="llx-pdfpages">([\s\S]*?)<\/div>/g)].map((m) => [...m[1].matchAll(/src="([^"]*)"[^>]*style="([^"]*)"/g)].map((i) => [i[1] === page(1) ? 1 : i[1] === page(2) ? 2 : i[1] === page(3) ? 3 : 0, i[2]]));
  // Each page at its natural size (100 bp per page number here), never wider than the text.
  assert.deepEqual(blocks, [
    [[1, "width:10.037em"], [3, "width:30.113em"]],
    [[1, "width:10.037em"]],
    [[1, "width:10.037em"], [2, "width:20.075em"], [3, "width:30.113em"]],
  ]);
  assert.deepEqual(out.report.items, []);
  assert.equal(out.counts.pdfpages, 6);
  // Without the renderer: the page says which file is missing, and the report why.
  const without = await emitDoc({ preamble: String.raw`\usepackage{pdfpages}`, body: String.raw`\includepdf{doc}`, llx: "llxinfo{fontsize}{10}", files });
  assert.match(without.body, /<p class="llx-cont llx-missing">\[doc\]<\/p>/);
  assert.deepEqual(without.report.items.map((i) => [i.severity, i.kind, i.message]), [["warning", "image", "PDF pages need Obsidian's pdf.js, which this export has not"]]);
});

test("captions: the probe's names and numbers, \\caption*, subcaption's (a), \\captionof, wrapfigure, minipages", async () => {
  const body = [
    String.raw`\begin{figure}\centering x\caption{One.}\label{f:one}\end{figure}`,
    String.raw`\begin{figure}`,
    String.raw`\begin{subfigure}[b]{0.45\textwidth}\centering l\caption{Left.}\label{f:l}\end{subfigure}\hfill`,
    String.raw`\begin{subfigure}[t]{.5\linewidth} r\caption{Right.}\end{subfigure}`,
    String.raw`\caption{Two.}\label{f:two}`,
    String.raw`\end{figure}`,
    String.raw`\begin{table}\caption*{Unnumbered.}\end{table}`,
    String.raw`\begin{center}\captionof{table}{Outside.}\label{t:out}\end{center}`,
    String.raw`\begin{wrapfigure}{r}{0.4\textwidth}\caption{Wrapped.}\end{wrapfigure}`,
    String.raw`\begin{minipage}[t]{3cm} m \end{minipage}`,
  ].join("\n");
  // Lines 4.. of main.tex; subcaption steps the figure at the first subfigure, before its caption.
  const llx = [
    "llxinfo{fontsize}{10}",
    "llxname{figure}{Fig.}",
    "llxstep{figure}{1}{}{main.tex}{4}",
    "llxstep{figure}{2}{}{main.tex}{6}",
    "llxstep{subfigure}{a}{}{main.tex}{6}",
    "llxstep{subfigure}{b}{}{main.tex}{7}",
    "llxstep{table}{1}{}{main.tex}{11}",
    "llxstep{figure}{3}{}{main.tex}{12}",
  ].join("\n");
  const out = await emitDoc({ preamble: String.raw`\usepackage{subcaption,capt-of,wrapfig}`, body, llx });
  const captions = [...out.body.matchAll(/<(figcaption|p class="llx-cont llx-caption")>(?:<span class="llx-caption-label(?: is-sub)?">([^<]*)<\/span>)?([^<]*)<\/(?:figcaption|p)>/g)].map((m) => `${m[2] ?? "-"}|${m[3]}`);
  assert.deepEqual(captions, ["Fig. 1|One.", "(a)|Left.", "(b)|Right.", "Fig. 2|Two.", "-|Unnumbered.", "Table 1|Outside.", "Fig. 3|Wrapped."]);
  assert.match(out.body, /<p class="llx-cont llx-caption"><span class="llx-caption-label">Table 1<\/span>Outside\.<\/p>/, "a \\captionof outside a float is no figcaption");
  assert.match(out.body, /<figure class="llx-subfloat" style="width:45%;vertical-align:bottom">/);
  assert.match(out.body, /<figure class="llx-subfloat" style="width:50%;vertical-align:top">/);
  assert.match(out.body, /<div class="llx-minipage" style="width:8\.536em;vertical-align:top">/);
  assert.deepEqual(out.numbers.map((n) => `${n.counter} ${n.value}${n.label ? ` ${n.label}` : ""}`), [
    "figure 1 f:one",
    "subfigure a",
    "subfigure b",
    "figure 2 f:two",
    "table 1 t:out",
    "figure 3",
  ]);
  assert.deepEqual(out.report.items.filter((i) => i.kind === "numbering"), []);
});

test("listings from files and algorithm floats: captions and numbers from the probe, algorithmic as a TeX fragment", async () => {
  const body = [
    String.raw`\lstinputlisting[caption={From a file},label=l:file,firstline=2,lastline=3]{src/code.py}`,
    String.raw`\lstinputlisting{src/code.py}`,
    String.raw`\begin{algorithm}`,
    String.raw`\caption{Search}\label{alg:s}`,
    String.raw`\begin{algorithmic}[1]`,
    String.raw`\State $x \gets 1$`,
    String.raw`\end{algorithmic}`,
    String.raw`\end{algorithm}`,
    String.raw`\lstinputlisting{missing.py}`,
  ].join("\n");
  const llx = [
    "llxinfo{fontsize}{10}",
    "llxname{lstlisting}{代码}",
    "llxstep{lstlisting}{1}{}{main.tex}{4}",
    "llxstep{algorithm}{1}{}{main.tex}{7}",
    "llxopen{0}",
    "llxblock{0}",
    "llxstep{ALG@line}{1}{}{main.tex}{9}",
    "llxclose{0}",
  ].join("\n");
  const fragments = new Map([[0, `<svg class="llx-frag" viewBox="0 0 10 10" width="1em" height="1em"></svg>`]]);
  const files = { "src/code.py": "first\nsecond\nthird <&>\nfourth\n" };
  const out = await emitDoc({ preamble: String.raw`\usepackage{listings,algorithm,algpseudocode}`, body, llx, files, fragments });
  assert.match(out.body, /^<a id="l:file"><\/a><figure class="llx-listing"><figcaption><span class="llx-caption-label">代码 1<\/span>From a file<\/figcaption><pre class="llx-lst"><code>second\nthird &lt;&amp;&gt;<\/code><\/pre><\/figure><pre class="llx-lst"><code>first\nsecond\nthird &lt;&amp;&gt;\nfourth<\/code><\/pre>/);
  assert.match(out.body, /<figure class="llx-float llx-algorithm"><figcaption><span class="llx-caption-label">Algorithm 1<\/span>Search<\/figcaption><a id="alg:s"><\/a><div class="llx-frag-block"><svg class="llx-frag"[^>]*><\/svg><\/div><\/figure>/);
  assert.match(out.body, /<p class="llx-cont llx-missing">\[missing\.py\]<\/p>/);
  // The algorithmic's own line numbers are in its drawing, not on the page's counters.
  assert.deepEqual(out.numbers.map((n) => `${n.counter} ${n.value}${n.label ? ` ${n.label}` : ""}`), ["lstlisting 1 l:file", "algorithm 1 alg:s"]);
  assert.deepEqual(out.report.items.map((i) => [i.kind, i.message, i.line]), [["build", "missing.py: file not found", 12]]);
  assert.equal(readFileSync(join(out.dir, "src", "code.py"), "utf8").split("\n").length, 5);
});
