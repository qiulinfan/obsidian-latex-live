// T-L3: the math scanner (design 4.3) on the synthetic elegantbook fixture and on half-typed input.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Text } from "@codemirror/state";
import { LatexMath, mathAt, scanLatex } from "../src/editor/latexScan";

const BOOK = resolve("tests/fixtures/elegantbook");
const doc = (s: string) => Text.of(s.split("\n"));
const read = (file: string) => doc(readFileSync(resolve(BOOK, file), "utf8"));
/** A construct as [source text, display, env]. */
const show = (d: Text, m: LatexMath) => [d.sliceString(m.from, m.to), m.display, m.env] as const;

test("scanLatex: every formula of ch1, and nothing escaped, verbatim or commented", () => {
  const d = read("chapters/ch1.tex");
  const all = scanLatex(d);
  const text = all.map((m) => d.sliceString(m.from, m.to));
  assert.equal(all.length, 18);
  assert.ok(text.includes("$(\\Omega, \\mathcal{F}, \\Prob)$"), "inside a definition box");
  assert.ok(text.includes("\\(\\bar X_n = \\frac{1}{n}\\sum_{i=1}^n X_i\\)"));
  assert.ok(text.includes("$\\KL{P}{P} = 0$"), "inside a footnote");
  assert.ok(text.includes("$\\Prob(\\abs{X - \\E{X}} \\ge \\eps) \\le \\Var(X) / \\eps^2$"), "in a nested list");
  assert.ok(!text.some((t) => t.includes("5") && t.includes("$x$")), "\\$5 and \\verb|$x$|");
  assert.ok(!text.some((t) => t.includes("\\alpha") || t.includes("\\beta")), "math in a comment");

  const display = all.filter((m) => m.display).map((m) => show(d, m));
  assert.deepEqual(
    display.map(([, , env]) => env),
    ["equation", "align", null, null, "align*"],
  );
  const eq = all.find((m) => m.env === "equation")!;
  assert.equal(eq.src, d.sliceString(eq.from, eq.to), "MathJax reads the environment whole");
  assert.deepEqual(eq.labels, ["eq:total-exp"]);
  assert.deepEqual(all.find((m) => m.env === "align")!.labels, ["eq:var-def", "eq:var-short"]);
  const bracket = all.find((m) => m.display && m.env === null && d.sliceString(m.from, m.from + 2) === "\\[")!;
  assert.equal(bracket.src.trim(), "\\norm{x}^2 = \\inner{x}{x}, \\qquad x \\in \\R^n.", "delimiters are not MathJax input");
  assert.equal(bracket.block, true);
  const dollars = all.find((m) => d.sliceString(m.from, m.from + 2) === "$$")!;
  assert.equal(dollars.block, true);
  assert.equal(all.find((m) => !m.display)!.block, false);
  assert.equal(scanLatex(d), all, "memoized per document");
});

test("scanLatex: ch2's environments, a tikz-cd diagram and a table; verbatim skipped", () => {
  const d = read("chapters/ch2.tex");
  const all = scanLatex(d);
  assert.deepEqual(
    all.filter((m) => m.env).map((m) => m.env),
    ["gather", "equation*"],
  );
  assert.ok(all.find((m) => m.env === "equation*")!.src.includes("\\begin{tikzcd}"));
  assert.ok(all.some((m) => m.src === "A = Q \\Lambda Q^\\top"), "inline math in a tabular");
  assert.ok(!all.some((m) => m.src.includes("not math") || m.src.includes("neither")), "verbatim");
  assert.equal(all.length, 12);
});

test("scanLatex: the preamble and anything after \\end{document} are not scanned", () => {
  assert.deepEqual(scanLatex(read("main.tex")), []);
  const d = doc(
    "\\documentclass{article}\n\\newcommand{\\x}{$a$}\n% \\begin{document} in a comment\n\\begin{document}\n$b$\n\\end{document}\n$c$",
  );
  assert.deepEqual(scanLatex(d).map((m) => m.src), ["b"]);
  assert.deepEqual(scanLatex(doc("no document environment: $x$")).map((m) => m.src), ["x"], "a chapter file");
});

test("scanLatex: half-typed delimiters end at the paragraph", () => {
  const srcs = (s: string) => scanLatex(doc(s)).map((m) => m.src.trim());
  assert.deepEqual(srcs("a $x + y\n\nb $z$ c"), ["z"]);
  assert.deepEqual(srcs("a $x + y\nstill the paragraph $ z"), ["x + y\nstill the paragraph"]);
  assert.deepEqual(srcs("$$ x\n\n$$ y $$"), ["y"]);
  assert.deepEqual(srcs("\\[ x\n  \n\\[ y \\]"), ["y"]);
  assert.deepEqual(srcs("\\( x\n\nand \\(y\\)"), ["y"]);
  assert.deepEqual(srcs("\\begin{align} a\n\n\\begin{align} b \\end{align}"), ["\\begin{align} b \\end{align}"]);
  assert.deepEqual(srcs("\\begin{align} a % \\end{align}\n b \\end{align}"), ["\\begin{align} a % \\end{align}\n b \\end{align}"], "a commented end");
  assert.deepEqual(srcs("a % comment line\n$x$"), ["x"]);
  assert.deepEqual(srcs("\\begin{verbatim}\n$x$"), [], "an unclosed verbatim runs to the end");
  assert.deepEqual(srcs("\\verb|$| and $y$ and \\lstinline{$} $z$"), ["y", "z"]);
  assert.deepEqual(srcs("$ $ and $\\$$"), ["\\$"], "empty math is no construct");
});

test("mathAt: inclusive at both ends, null outside", () => {
  const d = doc("a $x$ b \\[y\\]");
  assert.equal(mathAt(d, 1), null);
  assert.equal(mathAt(d, 2)?.src, "x");
  assert.equal(mathAt(d, 5)?.src, "x");
  assert.equal(mathAt(d, 6), null);
  assert.equal(mathAt(d, 8)?.src, "y");
  assert.equal(mathAt(d, 13)?.src, "y");
  assert.equal(mathAt(doc(""), 0), null);
});

test("scanLatex: a `$` or `\\(` in a text argument of inline math starts a nested formula", () => {
  const whole = (s: string) => scanLatex(doc(s)).map((m) => s.slice(m.from, m.to));
  assert.deepEqual(whole("令 $f(x) = \\text{当 $x>0$ 时为 } 1$ 成立。"), ["$f(x) = \\text{当 $x>0$ 时为 } 1$"]);
  assert.deepEqual(whole("$a = \\begin{cases} 1 & \\text{if $x$ odd} \\\\ 0 \\end{cases}$"), [
    "$a = \\begin{cases} 1 & \\text{if $x$ odd} \\\\ 0 \\end{cases}$",
  ]);
  assert.deepEqual(whole("\\(\\text{当 \\(x\\) 时}\\)"), ["\\(\\text{当 \\(x\\) 时}\\)"]);
  assert.deepEqual(whole("$\\mbox{a $b \\text{c $d$} $ e}$ and $y$"), ["$\\mbox{a $b \\text{c $d$} $ e}$", "$y$"]);
  // Half-typed input still pairs (H4 shows MathJax's error); other commands are plain math.
  assert.deepEqual(whole("$\\frac{a}{$"), ["$\\frac{a}{$"]);
  assert.deepEqual(whole("$\\text{a $"), ["$\\text{a $"]);
  assert.deepEqual(whole("$\\textcolor{red}{z}$ $w$"), ["$\\textcolor{red}{z}$", "$w$"]);
  assert.deepEqual(whole("$$ \\text{if $x$} $$"), ["$$ \\text{if $x$} $$"], "`$$` never closed on one `$`");
});
