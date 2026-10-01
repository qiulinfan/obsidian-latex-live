// The HTML export's math (src/export/math.ts, design 3.4, S2) on Obsidian's MathJax in jsdom:
// display layouts as amsmath numbers them, the tags the emitter writes, the export's own CHTML
// output (its stylesheet reduced to the page's glyphs and families, the woff files inline, byte for
// byte node_modules/mathjax's, which are Obsidian's), project macros, leqno.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { MathError } from "../src/editor/mathjaxProject";
import { displayLayout, displayTex, ExportMath, pageMathCss, tagSide, type DisplayRow } from "../src/export/math";
import { projectDefinitions } from "../src/tex/macros";
import { nodeMathEnv } from "./support/exportHost";
import { obsidianMathJax } from "./support/mathjax";
import { isAbortError } from "../src/tex/run";

const FONTS = resolve("node_modules/mathjax/es5/output/chtml/fonts/woff-v2");

async function bookMath(o: { tagSide?: "left" | "right" } = {}): Promise<ExportMath> {
  const defs = projectDefinitions(resolve("tests/fixtures/export-book/main.tex"));
  return ExportMath.create(await nodeMathEnv(), { statements: defs.statements, physics: false, unsupported: defs.unsupported }, {
    refs: (command, keys) => (command === "eqref" ? `(${keys.join(",")})` : keys.join(",")),
    ...o,
  });
}

/** The TeX of every math part of `src`, each row's tag from `tags` (by row order). */
function tagged(src: string, env: string | null, tags: (string | null)[]): string[] {
  const layout = displayLayout(src, env);
  const rows = layout.parts.flatMap((p) => (p.kind === "math" ? p.rows : []));
  const of = new Map<DisplayRow, string | null>(rows.map((r, i) => [r, tags[i] ?? null]));
  return layout.parts.flatMap((p) => (p.kind === "math" ? [displayTex(src, layout, p, (r) => of.get(r) ?? null)] : []));
}

test("layout: align rows, their own tags, \\notag and labels; split's rows stay inside", () => {
  const align = String.raw`\begin{align}
  x &= 1 \label{a} \\
  y &= 2 \tag{$\star$}\label{b} \\
  z &= \begin{cases} 1 \\ 2 \end{cases} \notag \\[2pt]
  w &= {a \\ b} \nonumber \\
\end{align}`;
  const l = displayLayout(align, "align");
  assert.equal(l.numbering, "rows");
  assert.deepEqual(l.labels, ["a", "b"]);
  const rows = l.parts.flatMap((p) => (p.kind === "math" ? p.rows : []));
  // A trailing \\ makes one more, empty row: TeX numbers it.
  assert.deepEqual(
    rows.map((r) => [r.own, r.tag, r.labels]),
    [[null, null, ["a"]], ["tag", "$\\star$", ["b"]], ["notag", null, []], ["notag", null, []], [null, null, []]],
  );
  assert.deepEqual(tagged(align, "align", ["1.1", null, null, null, "1.2"]), [
    String.raw`\begin{align}
  x &= 1 \label{a} \tag{1.1}\\
  y &= 2 \tag{$\star$}\label{b} \\
  z &= \begin{cases} 1 \\ 2 \end{cases} \notag \\[2pt]
  w &= {a \\ b} \nonumber \\
{}\tag{1.2}\end{align}`,
  ]);
  // equation and multline are one row, split's and multline's \\ no row ends.
  const eq = String.raw`\begin{equation}\label{s}\begin{split} a &= b \\ &= c \end{split}\end{equation}`;
  assert.deepEqual(displayLayout(eq, "equation").parts.flatMap((p) => (p.kind === "math" ? p.rows.map((r) => r.labels) : [])), [["s"]]);
  assert.deepEqual(tagged(eq, "equation", ["2.7"]), [String.raw`\begin{equation}\label{s}\begin{split} a &= b \\ &= c \end{split}\tag{2.7}\end{equation}`]);
  const multline = String.raw`\begin{multline} a \\ b \tag{C} \end{multline}`;
  const ml = displayLayout(multline, "multline");
  assert.equal(ml.numbering, "multline");
  assert.deepEqual(ml.parts.flatMap((p) => (p.kind === "math" ? p.rows.map((r) => r.own) : [])), ["tag"]);
  assert.equal(displayLayout(String.raw`\begin{gather} a \\ b \end{gather}`, "gather").numbering, "rows");
  assert.equal(displayLayout(String.raw`\begin{align*} a \end{align*}`, "align*").numbering, null);
  assert.equal(displayLayout(String.raw`\begin{eqnarray*} a \end{eqnarray*}`, "eqnarray*").numbering, "eqnarray*");
  // \[..\]: one part, nothing numbered, its own \tag left to MathJax.
  const bare = displayLayout(String.raw` x = 1 \tag{D} `, null);
  assert.deepEqual([bare.numbering, bare.open, bare.close, bare.parts.length], [null, "", "", 1]);
});

test("layout: \\intertext splits the alignment; alignat's column count opens every part", () => {
  const src = String.raw`\begin{alignat}{2}
  a &= b &\quad c &= d \label{x} \\
  \intertext{再由 $f$ 的凸性，配方得 \eqref{x}}
  e &= f \notag
\end{alignat}`;
  const l = displayLayout(src, "alignat");
  assert.deepEqual(l.parts.map((p) => p.kind), ["math", "text", "math"]);
  const text = l.parts[1];
  assert.equal(src.slice(text.from, text.to), String.raw`再由 $f$ 的凸性，配方得 \eqref{x}`);
  assert.deepEqual(tagged(src, "alignat", ["3.3", null]), [
    String.raw`\begin{alignat}{2}
  a &= b &\quad c &= d \label{x} \tag{3.3}\\
  \end{alignat}`,
    String.raw`\begin{alignat}{2}
  e &= f \notag
\end{alignat}`,
  ]);
  // \intertext first: no empty part before it.
  assert.deepEqual(displayLayout(String.raw`\begin{align}\intertext{t} a &= b\end{align}`, "align").parts.map((p) => p.kind), ["text", "math"]);
});

test("ExportMath: project macros, tags as TeX numbers them, leqno, failures", async () => {
  const math = await bookMath();
  for (const src of [String.raw`\E[Q]{X} + \E{X}`, String.raw`\KL[\text{fwd}]{P}{Q}`, String.raw`\loss = \loss[\theta]`, String.raw`x \iid P`]) {
    assert.match(math.render(src, false), /^<mjx-container class="MathJax" jax="CHTML">/, src);
  }
  // Rows with a tag get a labelled row; subequations' `2a`, an own `\tag{$\star$}`, \notag rows none.
  const align = String.raw`\begin{align} a &= b \label{p} \\ c &= d \notag \\ e &= f \tag{$\star$} \end{align}`;
  const [tex] = tagged(align, "align", ["2a", null, null]);
  const html = math.render(tex, true);
  assert.equal((html.match(/<mjx-mlabeledtr/g) ?? []).length, 2);
  assert.match(html, /<mjx-mtable[^>]* side="right"/);
  for (const [src, env] of [
    [String.raw`\begin{gather} a \\ b \end{gather}`, "gather"],
    [String.raw`\begin{multline} a \\ b \end{multline}`, "multline"],
  ] as const) {
    assert.match(math.render(tagged(src, env, ["4", "5"])[0], true), /<mjx-mlabeledtr/, env);
  }
  // A reference inside a formula is its text (latexRefs' formulaRefs); labels go.
  assert.doesNotThrow(() => math.render(String.raw`a \label{q} = b \text{ by \eqref{p}}`, false));
  // leqno: tags on the left.
  const left = await bookMath({ tagSide: "left" });
  assert.match(left.render(tex, true), /<mjx-mtable[^>]* side="left"/);
  assert.equal(tagSide([String.raw`\documentclass[11pt,leqno]{article}`]), "left");
  assert.equal(tagSide([String.raw`\usepackage[leqno,fleqn]{amsmath}`]), "left");
  assert.equal(tagSide([String.raw`\documentclass{article}\usepackage{amsmath}`]), "right");
  // Failures throw; the plan's check says no (every part of a display is checked).
  assert.throws(() => math.render(String.raw`\undefinedmacro`, false), MathError);
  assert.equal(math.ok(String.raw`\undefinedmacro x`, false), false);
  assert.equal(math.ok(String.raw`\begin{align} a &= b \\ \intertext{t} c &= \undefinedmacro \end{align}`, true), false);
  assert.equal(math.ok(String.raw`\begin{align} a &= b \\ \intertext{t} c &= d \end{align}`, true), true);
});

test("ExportMath's stylesheet: only the page's glyphs and families, the fonts inline, byte for byte", async () => {
  const math = await bookMath();
  const { MathJax } = await obsidianMathJax();
  // Obsidian's shared output draws other glyphs; the export's sheet never sees them.
  MathJax.tex2chtml(String.raw`\mathfrak{G} \oint \mathscr{Q}`, { display: true });
  MathJax.chtmlStylesheet();
  // A formula the export rendered but the page does not show adds nothing either.
  math.render(String.raw`\mathsf{S} + \mathtt{T}`, false);
  const page = [String.raw`x^2 + \left\{ \frac{a}{b} \right\}`, String.raw`\mathbb{R} \ni y`].map((s) => math.render(s, false)).join(" ");
  const { css, fontBytes, missing } = await math.stylesheet(page);
  assert.deepEqual(missing, []);
  // Glyph rules: exactly the class combinations of the page's mjx-c elements that draw from CSS.
  const combos = new Set([...page.matchAll(/<mjx-c class="([^"]*)"/g)].map((m) => m[1].split(" ").sort().join(" ")));
  const rules = [...css.matchAll(/(?:^|\n)mjx-c((?:\.[\w-]+)+)::before \{/g)].map((m) => m[1].slice(1).split(".").sort().join(" "));
  assert.ok(rules.length > 5);
  for (const r of rules) assert.ok(combos.has(r), `rule for ${r} not on the page`);
  assert.ok(!/TEX-FR|TEX-SS\b|TEX-T\b|MJXTEX-FR|MJXTEX-SS;|MJXTEX-T;/.test(css), "families of glyphs the page does not show");
  // The `{` glyph's rule (content "{") did not break the sheet: its @font-face rules follow it.
  assert.match(css, /content: "\{"/);
  const faces = [...css.matchAll(/@font-face[^{]*\{ font-family: ([\w-]+); src: url\("data:font\/woff;base64,([A-Za-z0-9+/=]+)"\)/g)];
  const used = faces.map((f) => f[1]).sort();
  assert.deepEqual(used, ["MJXTEX", "MJXTEX-A", "MJXTEX-I", "MJXTEX-S1", "MJXTEX-S2", "MJXTEX-S3", "MJXTEX-S4", "MJXZERO"].filter((f) => used.includes(f)));
  for (const f of ["MJXZERO", "MJXTEX", "MJXTEX-I", "MJXTEX-A"]) assert.ok(used.includes(f), f);
  const files: Record<string, string> = { MJXZERO: "MathJax_Zero.woff", MJXTEX: "MathJax_Main-Regular.woff", "MJXTEX-I": "MathJax_Math-Italic.woff", "MJXTEX-A": "MathJax_AMS-Regular.woff" };
  let bytes = 0;
  for (const [, family, data] of faces) {
    const decoded = Buffer.from(data, "base64");
    bytes += decoded.length;
    if (files[family]) assert.ok(decoded.equals(readFileSync(join(FONTS, files[family]))), `${family}: the npm woff`);
  }
  assert.equal(bytes, fontBytes);
  // Without math, no stylesheet.
  assert.deepEqual(await math.stylesheet("<p>text</p>"), { css: "", fontBytes: 0, missing: [] });
});

test("pageMathCss keeps MathJax's layout rules and drops unused families", () => {
  const css = `mjx-container[jax="CHTML"] {\n  line-height: 0;\n}\n\n.MJX-TEX {\n  font-family: MJXZERO, MJXTEX;\n}\n\n.TEX-B {\n  font-family: MJXZERO, MJXTEX-B;\n}\n\n@font-face /* 0 */ {\n  font-family: MJXZERO;\n  src: url("u/MathJax_Zero.woff") format("woff");\n}\n\n@font-face /* 1 */ {\n  font-family: MJXTEX;\n  src: url("u/MathJax_Main-Regular.woff") format("woff");\n}\n\n@font-face /* 2 */ {\n  font-family: MJXTEX-B;\n  src: url("u/MathJax_Main-Bold.woff") format("woff");\n}\n\nmjx-c.mjx-c7B::before {\n  padding: 0.75em 0.5em 0.25em 0;\n  content: "{";\n}\n\nmjx-c.mjx-c1D400.TEX-B::before {\n  content: "A";\n}`;
  const out = pageMathCss(css, '<mjx-container class="MathJax" jax="CHTML"><mjx-math class="MJX-TEX"><mjx-c class="mjx-c7B"></mjx-c></mjx-math></mjx-container>');
  assert.deepEqual([...out.fonts], [["MJXZERO", "MathJax_Zero.woff"], ["MJXTEX", "MathJax_Main-Regular.woff"]]);
  assert.match(out.css, /^mjx-container\[jax="CHTML"\] \{ line-height: 0; \}/);
  assert.match(out.css, /mjx-c\.mjx-c7B::before \{ padding: 0\.75em 0\.5em 0\.25em 0; content: "\{"; \}/);
  assert.ok(!out.css.includes("TEX-B"));
});

test("font embedding cancellation rejects before requesting another font", async () => {
  const abort = new AbortController();
  const env = await nodeMathEnv();
  const font = env.font;
  let requests = 0;
  env.font = async (file) => { requests++; const bytes = await font(file); abort.abort(); return bytes; };
  const math = ExportMath.create(env, { statements: [], physics: false, unsupported: new Map() });
  const html = math.render(String.raw`x + \mathbb{R}`, false);
  await assert.rejects(math.stylesheet(html, abort.signal), isAbortError);
  assert.equal(requests, 1);
});

test("unavailable math fonts are reported without leaving external URLs in the page", async () => {
  const env = await nodeMathEnv();
  env.font = async () => { throw new Error("font unavailable"); };
  const math = ExportMath.create(env, { statements: [], physics: false, unsupported: new Map() });
  const html = math.render("x+1", false);
  const style = await math.stylesheet(html);
  assert.ok(style.missing.includes("MathJax_Main-Regular.woff"));
  assert.equal(style.fontBytes, 0);
  assert.ok(!/url\(/.test(style.css), "the stylesheet cannot depend on a network or host font URL");
});

test("font embedding aborts while a host font request is still pending", async () => {
  const abort = new AbortController();
  const env = await nodeMathEnv();
  let pending: ((data: Uint8Array) => void) | undefined;
  let received: AbortSignal | undefined;
  env.font = (_, signal) => { received = signal; return new Promise((resolve) => { pending = resolve; }); };
  const math = ExportMath.create(env, { statements: [], physics: false, unsupported: new Map() });
  const html = math.render("x+1", false);
  const reading = math.stylesheet(html, abort.signal);
  assert.equal(received, abort.signal);
  assert.ok(pending);
  abort.abort();
  await assert.rejects(reading, isAbortError);
  pending!(new Uint8Array()); // A late answer cannot resume the aborted stylesheet.
});
