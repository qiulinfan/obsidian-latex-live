// TeX fragments (design 3.3, S5): dvisvgm's pages of the probe pass as inline SVG (fragments.ts).
// Static pages (tests/fixtures/export-static/fragments: the probe pass over fragments/main.tex on
// pdfLaTeX and XeLaTeX, dvisvgm 3.6) for the post-processing: the marker's id and baseline, sizes in
// em, the per-fragment prefixes (two pages each embedding their own `cmmi10`), black as
// currentColor, the dark theme's colours, sanitizing; the emitter's fallback to source; and, with
// TeX (skipped without it), the whole export on both engines against the probe's box sizes.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { exportHtml } from "../src/export/exporter";
import { pageFragment, prepareFragment, sanitizeSvg } from "../src/export/fragments";
import { readProbeLog } from "../src/export/probeLog";
import { texTool } from "../src/tex/binaries";
import { emitDoc, nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

const STATIC = join("tests", "fixtures", "export-static", "fragments");
const page = (engine: string, n: number) => readFileSync(join(STATIC, engine, `f${n}.svg`), "utf8");
/** TeX points per big point. */
const PT_PER_BP = 72.27 / 72;

/** A prepared fragment's size and depth in TeX points (the document's font `fontPt`). */
function measure(html: string, fontPt: number): { width: number; height: number; depth: number | null } {
  const em = (name: string) => Number(new RegExp(`\\b${name}="(-?[\\d.]+)em"`).exec(html)?.[1]);
  const lowered = /vertical-align:(-?[\d.]+)em/.exec(html);
  return { width: em("width") * fontPt, height: em("height") * fontPt, depth: lowered ? -Number(lowered[1]) * fontPt : null };
}

after(removeExportTemps);

test("a page names its fragment; the baseline from the marker: pdfLaTeX (y=0) and XeLaTeX (y=-64.03) alike", () => {
  // The probe's boxes for these fragments (llxfrag records): ht, dp, wd in TeX points.
  const boxes = [
    { n: 1, id: 0, ht: 7.5, dp: 2.5 },
    { n: 2, id: 1, ht: 5.803, dp: 1.493 },
  ];
  for (const engine of ["pdflatex", "xelatex"]) {
    for (const b of boxes) {
      const svg = page(engine, b.n);
      assert.equal(pageFragment(svg), b.id, `${engine} f${b.n}`);
      const html = prepareFragment(svg, b.id, 10)!;
      assert.ok(html.startsWith('<svg class="llx-frag" viewBox="'), html.slice(0, 80));
      const m = measure(html, 10);
      // The ink box: its depth below the baseline is TeX's \dp (within rounding and ink).
      assert.ok(Math.abs(m.depth! - b.dp) < 0.02, `${engine} f${b.n}: depth ${m.depth} vs ${b.dp}`);
      assert.ok(Math.abs(m.height - m.depth! - b.ht) < 0.1, `${engine} f${b.n}: height ${m.height - m.depth!} vs ${b.ht}`);
      // The viewBox is dvisvgm's (an ink box), the size its width in bp as em of 10 pt.
      const box = /viewBox="([^"]*)"/.exec(html)![1].split(" ").map(Number);
      assert.ok(Math.abs(m.width - box[2] * PT_PER_BP) < 0.01);
      assert.doesNotMatch(html, /llx-ref|data-y|<\?xml|<!--|CDATA/);
    }
  }
  // XeLaTeX's origin is elsewhere (dvisvgm keeps the DVI's 1in offsets), so the marker is needed.
  assert.match(page("xelatex", 1), /data-y='-64\.028007'/);
  assert.match(page("pdflatex", 1), /data-y='0'/);
  // Only pages the probe marked are fragments.
  assert.equal(pageFragment("<svg viewBox='0 0 1 1'><g id='page9'/></svg>"), null);
  assert.equal(prepareFragment("<svg><g/></svg>", 0, 10), null, "no viewBox");
});

test("ids, classes and font families get the fragment's prefix: two cmmi10 subsets stay apart", () => {
  const [a, b] = [page("pdflatex", 1), page("pdflatex", 4)];
  const font = (svg: string) => /font-family:cmmi10;src:url\(([^)]*)\)/.exec(svg)![1];
  assert.notEqual(font(a), font(b), "each page embeds its own subset of cmmi10");
  const [pa, pb] = [prepareFragment(a, 0, 10)!, prepareFragment(b, 3, 10)!];
  assert.match(pa, /font-family:llx0-cmmi10;src:url\(data:/);
  assert.match(pb, /font-family:llx3-cmmi10;src:url\(data:/);
  for (const [html, prefix] of [[pa, "llx0-"], [pb, "llx3-"]] as const) {
    assert.doesNotMatch(html, /font-family:(?!llx\d+-)/, "every family prefixed");
    assert.match(html, new RegExp(`id='${prefix}page\\d'`));
    // Every class the markup uses is the page's own, and its stylesheet defines it.
    const classes = [...html.matchAll(/class='([^']*)'/g)].map((m) => m[1]);
    assert.ok(classes.length > 0);
    for (const c of classes) {
      assert.ok(c.startsWith(prefix), c);
      assert.ok(html.includes(`text.${c} {`), `text.${c} is styled`);
    }
  }
});

test("black is currentColor (glyphs and pgf's own fill), colours stay; the dark theme lightens the dark ones", () => {
  const glyphs = prepareFragment(page("pdflatex", 1), 0, 10)!;
  assert.match(glyphs, /<tspan fill='currentColor'>/);
  const arrow = prepareFragment(page("pdflatex", 3), 2, 10)!;
  assert.match(page("pdflatex", 3), /<g fill='#000' stroke='#000'>/, "pgf writes black itself");
  assert.match(arrow, /<g fill='currentColor' stroke='currentColor'>/);
  assert.doesNotMatch(arrow, /#000/);
  const red = prepareFragment(page("pdflatex", 2), 1, 10)!;
  assert.match(red, /stroke='#f00'/);
  assert.doesNotMatch(red, /prefers-color-scheme/, "red is legible on the dark page (contrast over 3:1)");
  // blue!70!black is not: a dark-theme rule mixes it with white.
  const blue = prepareFragment(`<svg viewBox='0 0 10 10'><g id='page1'><g class='llx-ref' data-id='5'/><path d='M0 0L1 1' stroke='#0000b3'/><text fill='#0000b3'>x</text></g></svg>`, 5, 10)!;
  assert.match(blue, /@media \(prefers-color-scheme: dark\) \{ svg\.llx-frag \[stroke="#0000b3"\] \{ stroke: color-mix\(in oklab, #0000b3 45%, white\); \} svg\.llx-frag \[fill="#0000b3"\]/);
  assert.doesNotMatch(blue, /vertical-align/, "a block (no baseline) is not lowered");
});

test("Kangxi radicals dvisvgm names glyphs by are the ideographs in the text; full-width punctuation stays", () => {
  const svg = `<svg viewBox='0 0 10 10'><g id='page1'><g class='llx-ref' data-id='2'/><text class='f0' x='1' y='2'><tspan fill='currentColor'>\u2fae空，标记</tspan></text></g></svg>`;
  const html = prepareFragment(svg, 2, 10)!;
  assert.match(html, /<tspan fill='currentColor'>非空，标记<\/tspan>/);
  assert.doesNotMatch(html, /\u2fae/);
});

test("a picture's image (pdfLaTeX: a file name from the project) is embedded; without a file it is left out", () => {
  const svg = `<svg viewBox='0 0 10 10'><g id='page1'><g class='llx-ref' data-id='4'/><image height='10' width='20' xlink:href='figs/dot.png'/></g></svg>`;
  const asked: string[] = [];
  const html = prepareFragment(svg, 4, 10, (file) => (asked.push(file), "data:image/png;base64,AAAA"))!;
  assert.deepEqual(asked, ["figs/dot.png"]);
  assert.match(html, /<image height='10' width='20' xlink:href='data:image\/png;base64,AAAA'\/>/);
  assert.match(prepareFragment(svg, 4, 10, () => null)!, /<image height='10' width='20'\/>/);
});

test("sanitizing: scripts, event handlers, script URLs, foreign content and outside references go", () => {
  const evil = [
    "<g id='page1'><g class='llx-ref' data-id='0' data-y='0'/>",
    "<script>alert(1)</script><script type='text/javascript'/>",
    "<g onload='alert(2)' ONCLICK=\"x()\" fill='red'><path d='M0 0' onmouseover=alert(3) /></g>",
    "<a xlink:href='javascript:alert(4)'><text x='1' y='2'>link</text></a>",
    "<a href='https://example.org/'><text>out</text></a>",
    "<image xlink:href='file:///etc/passwd' width='1' height='1'/><image xlink:href='data:image/png;base64,AAAA' width='1' height='1'/>",
    "<image href='&#106;avascript:alert(5)'/>",
    "<foreignObject><div xmlns='http://www.w3.org/1999/xhtml'>html</div></foreignObject>",
    "<style>@import url(https://example.org/x.css); text.f0 {fill:url(https://example.org/p)} .g {fill:url(#grad)}</style>",
    "<iframe src='https://example.org/'></iframe><set attributeName='href' to='javascript:alert(6)'/>",
    "<animate attributeName='onload' to='alert(7)'/>",
    "<g title='a>b' onclick='alert(8)'><text>a &lt; b</text></g>",
    "<text>x <scr<script>ipt>alert(9)</script></text>",
    "<g style='fill:url(https://example.org/q)' class='f0'/>",
    "</g>",
  ].join("");
  const html = prepareFragment(`<svg viewBox='0 0 10 10'>${evil}</svg>`, 7, 10)!;
  for (const bad of [/<script/i, /\son\w+\s*=/i, /javascript/i, /foreignObject/i, /<div/, /<iframe/, /<set\b/, /<animate/, /@import/, /https?:/, /file:/, /xlink:href='(?!data:|#)/]) {
    assert.doesNotMatch(html, bad, String(bad));
  }
  assert.match(html, /<image xlink:href='data:image\/png;base64,AAAA'/, "an embedded image stays");
  assert.match(html, /<g><text x='1' y='2'>link<\/text><\/g>/, "a link becomes a group");
  assert.match(html, /url\(#llx7-grad\)/, "a reference inside the page stays, prefixed");
  assert.match(html, /<text>a &lt; b<\/text>/);
  // A `<` that starts no tag the filter read is escaped: the HTML parser sees no tag there.
  assert.equal(sanitizeSvg("<g><scr<b>ipt></g>"), "<g>&lt;script></g>");
});

test("a fragment TeX drew no page of shows its source, with a report item; the steps inside are still taken", async () => {
  const body = String.raw`Before \eqref{e:a}.
\begin{equation}\label{e:a} \pair{x}[y] \end{equation}
\begin{figure}\centering\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}\caption{P}\label{f:p}\end{figure}
\begin{equation}\label{e:b} b \end{equation}`;
  const llx = [
    "llxinfo{fontsize}{10}",
    "llxopen{0}",
    "llxblock{0}",
    "llxstep{equation}{1}{}{main.tex}{5}",
    "llxclose{0}",
    "llxopen{1}",
    "llxclose{1}",
    "llxfrag{1}{20pt}{0pt}{30pt}",
    // The caption's step on the picture's line is outside the picture.
    "llxstep{figure}{1}{}{main.tex}{6}",
    "llxstep{equation}{2}{}{main.tex}{7}",
  ].join("\n");
  const aux = String.raw`\newlabel{e:a}{{1}{1}}\newlabel{f:p}{{1}{1}}\newlabel{e:b}{{2}{1}}`;
  const preamble = String.raw`\usepackage{amsmath,tikz}\NewDocumentCommand{\pair}{m o}{\langle #1 \IfValueT{#2}{\mid #2}\rangle}`;
  // Fragment 1 (the picture) was drawn, fragment 0 (the formula) was not.
  const drawn = new Map([[1, `<svg class="llx-frag" viewBox="0 0 30 20" width="3em" height="2em" style="vertical-align:0em"></svg>`]]);
  const out = await emitDoc({ preamble, body, llx, aux, fragments: drawn });
  assert.match(out.body, /<a id="e:a"><\/a><pre class="llx-source">\\begin\{equation\}\\label\{e:a\} \\pair\{x\}\[y\] \\end\{equation\}<\/pre>/);
  assert.match(out.body, /<figure class="llx-float llx-figure"><p><svg class="llx-frag"[^>]*><\/svg><\/p><figcaption><span class="llx-caption-label">Figure 1<\/span>P<\/figcaption>/);
  assert.deepEqual(
    out.report.items.filter((i) => i.kind === "fragment").map((i) => [i.severity, i.message, i.line]),
    [["warning", "display math MathJax rejects: TeX drew no picture of it (see the probe's errors), shown as source", 5]],
  );
  // The missing formula's step is consumed without claiming its number was drawn; later
  // numbers remain TeX's, and the source fallback still keeps the labelled anchor.
  assert.deepEqual(out.numbers, [
    { counter: "equation", value: "1", shown: false, label: "e:a" },
    { counter: "figure", value: "1", shown: true, label: "f:p" },
    { counter: "equation", value: "2", shown: true, label: "e:b" },
  ]);
  assert.equal(out.counts.fragments, 2);
});

const skip = !texBin ? "no TeX installation found" : !existsSync(texTool(texBin, "dvisvgm")) ? "no dvisvgm" : false;
const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

test("export on pdfLaTeX and XeLaTeX: every planned fragment is an SVG, on the baseline TeX measured", { skip, timeout: 240_000 }, async () => {
  for (const engine of ["pdflatex", "xelatex"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "latex-live-export-frag-"));
    temps.push(dir);
    const src = readFileSync(join(STATIC, "main.tex"), "utf8");
    writeFileSync(join(dir, "main.tex"), src);
    const root = join(dir, "main.tex");
    const host = nodeExportHost(root, { engine });
    const { html, report } = await exportHtml(root, host, () => undefined, new AbortController().signal);
    const log = readProbeLog(readFileSync(join(host.workDir, "main.llx"), "utf8"));
    const svgs = [...html.matchAll(/<svg class="llx-frag"[^>]*>/g)].map((m) => m[0]);
    assert.equal(report.counts.planned, 4, engine);
    assert.equal(svgs.length, 4, engine);
    assert.equal(report.counts.fragments, 4);
    assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/, ""), /class="llx-source/);
    assert.deepEqual(report.items.filter((i) => i.severity !== "info"), [], engine);
    // Each inline fragment's depth below the baseline is the box depth TeX logged (ink within 0.1 pt).
    const fontPt = Number(log.info.get("fontsize"));
    svgs.forEach((svg, i) => {
      const box = log.fragments[i].box!;
      const m = measure(svg, fontPt);
      assert.ok(Math.abs(m.depth! - box.dp) < 0.1, `${engine} fragment ${i}: depth ${m.depth} vs \\dp ${box.dp}`);
    });
    // The fonts are the page's own: the four fragments define disjoint families.
    const families = [...html.matchAll(/@font-face\{font-family:([\w-]+);/g)].map((m) => m[1]);
    assert.equal(new Set(families).size, families.length);
    assert.ok(families.every((f) => /^llx\d+-/.test(f)));
  }
});
