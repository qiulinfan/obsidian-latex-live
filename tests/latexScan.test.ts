// T-L3: the scanner (design 4.3) on the synthetic elegantbook fixture and on half-typed input:
// formulas (`formulas`), and the text constructs of design 4.4 #5-#11 (`scanLatex`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Text } from "@codemirror/state";
import { LatexConstruct, LatexEnv, LatexMath, blockAt, blocks, blocksAround, formulas, mathAt, scanLatex } from "../src/editor/latexScan";

const BOOK = resolve("tests/fixtures/elegantbook");
const doc = (s: string) => Text.of(s.split("\n"));
const read = (file: string) => doc(readFileSync(resolve(BOOK, file), "utf8"));
/** A construct as [source text, display, env]. */
const show = (d: Text, m: LatexMath) => [d.sliceString(m.from, m.to), m.display, m.env] as const;

test("formulas: every formula of ch1, and nothing escaped, verbatim or commented", () => {
  const d = read("chapters/ch1.tex");
  const all = formulas(d);
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
  assert.equal(formulas(d), all, "memoized per document");
  assert.equal(scanLatex(d), scanLatex(d));
});

test("formulas: ch2's environments, a tikz-cd diagram and a table; verbatim skipped", () => {
  const d = read("chapters/ch2.tex");
  const all = formulas(d);
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
  assert.deepEqual(formulas(d).map((m) => m.src), ["b"]);
  assert.deepEqual(formulas(doc("no document environment: $x$")).map((m) => m.src), ["x"], "a chapter file");
});

test("formulas: half-typed delimiters end at the paragraph", () => {
  const srcs = (s: string) => formulas(doc(s)).map((m) => m.src.trim());
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

test("formulas: a `$` or `\\(` in a text argument of inline math starts a nested formula", () => {
  const whole = (s: string) => formulas(doc(s)).map((m) => s.slice(m.from, m.to));
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

test("formulas: a block is a display formula owning its lines (a comment may follow); inline math never is", () => {
  const blocks = (s: string) => formulas(doc(s)).map((m) => [s.slice(m.from, m.to), m.block]);
  assert.deepEqual(blocks("$x$\n\\(y\\)"), [["$x$", false], ["\\(y\\)", false]], "alone on its line, still inline");
  assert.deepEqual(blocks("  \\[ a \\] % note\ntext \\[ b \\] text"), [["\\[ a \\]", true], ["\\[ b \\]", false]]);
  assert.deepEqual(blocks("\\begin{math} c \\end{math}\n  \\begin{equation}\n d\n  \\end{equation}"), [
    ["\\begin{math} c \\end{math}", false],
    ["\\begin{equation}\n d\n  \\end{equation}", true],
  ]);
});

/** A construct as short text: its kind and what it carries. */
function describe(s: string, c: LatexConstruct): string {
  switch (c.kind) {
    case "math":
      return `math ${c.src.trim()}`;
    case "heading":
      return `h${c.level} ${s.slice(c.titleFrom, c.titleTo)}`;
    case "style":
      return `${c.style} ${s.slice(c.contentFrom, c.contentTo)}`;
    case "item":
      return `item ${c.labelFrom !== undefined ? `[${s.slice(c.labelFrom, c.labelTo)}]` : c.marker}${c.term ? " (term)" : ""}`;
    case "envline":
      return `${c.begin ? "begin" : "end"} ${s.slice(c.from, c.to)}`;
    case "ref":
      return `${c.command} ${c.keys.join(",")}`;
    case "cite":
      return `${c.command} ${c.prenote ?? "-"}|${c.postnote ?? "-"}|${c.keys.join(",")}`;
    case "label":
      return `label ${c.key}`;
    case "env": {
      const args = c.args.map((a) => (a.optional ? `[${s.slice(a.from, a.to)}]` : `{${s.slice(a.from, a.to)}}`)).join("");
      return `env ${c.env}${args}${c.label === null ? "" : ` #${c.label}`}`;
    }
    case "image":
      return `image ${c.path}`;
  }
}
const constructs = (s: string) => scanLatex(doc(s)).map((c) => describe(s, c));

test("scanLatex: ch1's text constructs in document order, around its formulas", () => {
  const text = readFileSync(resolve(BOOK, "chapters/ch1.tex"), "utf8");
  const all = scanLatex(doc(text));
  assert.ok(all.every((c, i) => i === 0 || all[i - 1].from <= c.from), "document order");
  const shown = all.filter((c) => c.kind !== "math").map((c) => describe(text, c));
  assert.deepEqual(shown, [
    "h1 概率与期望",
    "label chap:prob",
    "env definition{概率空间 Probability space}{prob-space}",
    "env theorem{全期望公式}{total-exp}",
    "eqref eq:var-short",
    "ref thm:total-exp",
    "cite -|第 2 章|zhang2020notes",
    "begin \\begin{enumerate}",
    "item 1.",
    "item 2.",
    "begin \\begin{itemize}",
    "item •",
    "end \\end{itemize}",
    "end \\end{enumerate}",
    "cite -|-|li2019lln",
  ]);
});

test("scanLatex: headings start their line with the title closed there; styles have one-line arguments and nest", () => {
  assert.deepEqual(constructs("\\section{Intro $x$ \\emph{a}}\\label{sec:i}"), ["h2 Intro $x$ \\emph{a}", "math x", "em a", "label sec:i"]);
  assert.deepEqual(constructs("  \\subsection*[short]{Long}\n\\part{P}\n\\subparagraph{S}"), ["h3 Long", "h1 P", "h6 S"]);
  assert.deepEqual(constructs("text \\section{not at the start}"), []);
  assert.deepEqual(constructs("\\section{half\ntyped}\n\\chapter{open"), []);
  assert.deepEqual(constructs("\\textbf{} \\emph{a\nb} \\textit{c % d}"), [], "empty, across lines, a comment inside");
  assert.deepEqual(constructs("\\textbf {spaced} \\emph{x \\textbf{y}} \\underline{u}\\texttt{t}\\textsc{s}\\textit{i}"), [
    "strong spaced",
    "em x \\textbf{y}",
    "strong y",
    "u u",
    "tt t",
    "sc s",
    "em i",
  ]);
  assert.deepEqual(constructs("\\textbf{a {b} \\} c}"), ["strong a {b} \\} c"], "braces balance, escapes skip");
});

test("scanLatex: items carry the marker LaTeX typesets, by depth, short form, enumitem label and start", () => {
  const nested = [
    "\\begin{itemize}",
    "  \\item a",
    "  \\begin{itemize}",
    "    \\item b",
    "    \\begin{enumerate}",
    "      \\item c",
    "      \\begin{enumerate} \\item d",
    "        \\item e \\begin{enumerate}\\item f\\end{enumerate}",
    "      \\end{enumerate}",
    "    \\end{enumerate}",
    "    \\begin{itemize}\\item g \\begin{itemize}\\item h\\end{itemize}\\end{itemize}",
    "  \\end{itemize}",
    "  \\item[--] i \\item j",
    "\\end{itemize}",
  ].join("\n");
  assert.deepEqual(constructs(nested).filter((c) => c.startsWith("item")), [
    "item •",
    "item ◦",
    "item 1.",
    "item (a)",
    "item (b)",
    "item i.",
    "item ▪",
    "item •",
    "item –",
    "item •",
  ]);
  const items = (option: string) =>
    constructs(`\\begin{enumerate}${option}\n\\item a \\item[x] b \\item c\n\\end{enumerate}`).filter((c) => c.startsWith("item"));
  assert.deepEqual(items("[(a)]"), ["item (a)", "item x", "item (b)"], "\\item[x] leaves the counter alone");
  assert.deepEqual(items("[label=(\\roman*), start=3]"), ["item (iii)", "item x", "item (iv)"]);
  assert.deepEqual(items("[label={\\Alph*.}]"), ["item A.", "item x", "item B."]);
  assert.deepEqual(items("[label=\\arabic*), nosep]"), ["item 1)", "item x", "item 2)"]);
  assert.deepEqual(items("[noitemsep]"), ["item 1.", "item x", "item 2."], "keys only: the default label");
  assert.deepEqual(items("[i)]"), ["item i)", "item x", "item ii)"]);
  assert.deepEqual(items("[\\bfseries Step 1:]"), ["item Step 1:", "item x", "item Step 2:"]);
  assert.deepEqual(items("[{Case} A]"), ["item Case A", "item x", "item Case B"], "braces keep letters literal");
  assert.deepEqual(constructs("\\begin{itemize}[label=$\\star$] \\item a \\end{itemize}"), ["item ⋆"]);
  assert.deepEqual(
    constructs("\\begin{description}\n  \\item[Markov] a\n  \\item b\n\\end{description}"),
    ["begin \\begin{description}", "item Markov (term)", "item  (term)", "end \\end{description}"],
  );
  assert.deepEqual(constructs("\\item outside a list"), []);
});

test("scanLatex: \\begin/\\end lines of lists, center, figure and table alone on their lines (options included)", () => {
  assert.deepEqual(
    constructs("\\begin{enumerate}[label=(\\alph*)] % note\n\\item a\n  \\end{enumerate}\n\\begin{center}\nc\n\\end{center}"),
    ["begin \\begin{enumerate}[label=(\\alph*)]", "item (a)", "end \\end{enumerate}", "begin \\begin{center}", "end \\end{center}"],
  );
  assert.deepEqual(constructs("text \\begin{itemize} \\item a\n\\end{itemize} text"), ["item •"], "not alone: the list still counts");
  assert.deepEqual(
    constructs("\\begin{figure}[htbp]\n\\begin{theorem}\n\\end{theorem}\n\\end{figure}\n\\begin{table*}[t] \\centering\n\\end{table*}"),
    ["begin \\begin{figure}[htbp]", "env theorem", "end \\end{figure}", "end \\end{table*}"],
    "figure and table (P4); a \\begin line with more on it stays",
  );
});

test("scanLatex: environments alone on their lines are `env` constructs with their arguments and label (T-L9)", () => {
  const text = [
    "\\begin{theorem}{全期望公式 $\\E$}{total-exp} % elegantbook",
    "  body $x$",
    "\\end{theorem}",
    "\\begin{lemma}[下降引理]\\label{lem:descent}",
    "\\end{lemma}",
    "\\begin{thm}[Cauchy]",
    "  \\label{thm:cauchy}",
    "  \\begin{proof}",
    "    \\begin{remark}",
    "    \\end{remark}",
    "  \\end{proof}",
    "\\end{thm}",
    "\\begin{note} text on its line",
    "\\end{note}",
    "\\begin{custom}{性质}",
    "\\end{custom} after",
    "\\begin{proof}",
    "\\begin{remark}",
    "\\end{proof}",
  ].join("\n");
  const all = scanLatex(doc(text));
  assert.ok(all.every((c, i) => i === 0 || all[i - 1].from <= c.from), "document order: an env before what is in it");
  assert.deepEqual(all.map((c) => describe(text, c)), [
    "env theorem{全期望公式 $\\E$}{total-exp}",
    "math \\E",
    "math x",
    "env lemma[下降引理] #lem:descent",
    "label lem:descent",
    "env thm[Cauchy] #thm:cauchy",
    "label thm:cauchy",
    "env proof",
    "env remark",
    "env proof",
  ], "a \\begin or \\end with text beside it, and an environment left open, are none");
  const thm = all[0] as LatexEnv;
  assert.deepEqual(
    [text.slice(thm.from, thm.beginTo), text.slice(thm.endFrom, thm.to)],
    ["\\begin{theorem}{全期望公式 $\\E$}{total-exp}", "\\end{theorem}"],
  );
  const lemma = all[3] as LatexEnv;
  assert.equal(text.slice(lemma.from, lemma.beginTo), "\\begin{lemma}[下降引理]\\label{lem:descent}", "the \\label belongs to the \\begin line");
  const long = `\\begin{proof}\n${"x\n".repeat(250)}\\end{proof}\n\\begin{proof}\n${"x\n".repeat(150)}\\end{proof}`;
  assert.deepEqual(constructs(long), ["env proof"], "within 200 lines");
});

test("scanLatex: \\includegraphics alone on its line is an image (#13)", () => {
  assert.deepEqual(
    constructs(
      [
        "  \\includegraphics[width=0.3\\linewidth]{figures/grid.png} % a figure",
        "\\includegraphics*[0,0][10,10]{ grid }",
        "\\centerline{\\includegraphics{a.png}}",
        "text \\includegraphics{b.png}",
        "\\includegraphics{}",
      ].join("\n"),
    ),
    ["image figures/grid.png", "image grid"],
  );
});

test("scanLatex: formulas nested in text arguments any number of levels deep never overflow the stack (R6)", () => {
  const deep = "$" + "a \\text{b $".repeat(20000) + "c" + "$ d} e".repeat(20000) + "$ and $f$";
  const found = formulas(doc(deep));
  assert.ok(found.length >= 1);
  assert.equal(found[found.length - 1].src, "f", "the formula after it is found");
  const nested = "$x = \\text{if $y = \\text{when $z$}$}$";
  assert.deepEqual(formulas(doc(nested)).map((m) => m.src), ["x = \\text{if $y = \\text{when $z$}$}"], "a few levels: one formula");
});

test("scanLatex: text arguments that never close cost a few passes over their paragraph, not exponentially many (R4)", () => {
  for (const n of [40, 160]) {
    const t0 = performance.now();
    const found = formulas(doc("\\text{$".repeat(n) + "\n\nafter $f$"));
    const ms = performance.now() - t0;
    assert.equal(found[found.length - 1].src, "f");
    assert.ok(ms < 500, `${n} unclosed levels: ${ms.toFixed(1)} ms`);
  }
  // The same inside a formula that closes: a formula still pairs as before.
  assert.deepEqual(formulas(doc("$a \\text{b $c$ d} e$ and $\\text{x $")).map((m) => m.src), ["a \\text{b $c$ d} e", "\\text{x "]);
});

test("scanLatex: references, citations with notes, and labels outside math", () => {
  assert.deepEqual(
    constructs(
      "\\ref{a} \\eqref{ b } \\cref{a,b} \\Cref*{c} \\autoref{d} \\pageref{e} \\nameref{f} \\ref{} \\ref{g\n}\n" +
        "\\cite{k1, k2} \\cite[p.~3]{k} \\parencite[see][p.~3]{k} \\citep[][p.~5]{k} \\citet*{k} \\textcite{k} \\autocite{k} \\cite[x]{}\n" +
        "\\label{x} $a \\label{m} \\ref{n}$ \\begin{equation}\\label{eq}\\end{equation}",
    ),
    [
      "ref a",
      "eqref b",
      "cref a,b",
      "Cref c",
      "autoref d",
      "pageref e",
      "nameref f",
      "cite -|-|k1,k2",
      "cite -|p.~3|k",
      "parencite see|p.~3|k",
      "citep -|p.~5|k",
      "citet -|-|k",
      "textcite -|-|k",
      "autocite -|-|k",
      "label x",
      "math a \\label{m} \\ref{n}",
      "math \\begin{equation}\\label{eq}\\end{equation}",
    ],
  );
  assert.deepEqual(
    constructs("% \\ref{a}\n\\verb|\\ref{b}| \\begin{verbatim}\n\\textbf{c} \\label{d}\n\\end{verbatim}\n\\footnote{\\cite{e}}"),
    ["cite -|-|e"],
    "comments and verbatim are skipped; a footnote's content is scanned",
  );
});

test("scanLatex: definitions are code, in macro files and in chapters: nothing in them is a construct", () => {
  const macros = readFileSync(resolve(BOOK, "macros.tex"), "utf8");
  assert.deepEqual(constructs(macros), [], "the fixture's macros.tex (every definition kind)");
  assert.deepEqual(
    constructs(
      [
        "\\newcommand{\\term}[1]{\\textbf{\\emph{#1}}} after",
        "\\newcommand*{\\x}{%",
        "  $y$ \\ref{a}",
        "}",
        "\\renewenvironment{proof}{\\textit{Proof.}}{\\qed}",
        "\\def\\pair#1,#2.{(#1;#2)} \\let\\a\\b",
        "\\textbf{text} again \\newcommand{\\half}{\\textbf{",
        "",
        "$z$ after a half-typed definition's paragraph",
      ].join("\n"),
    ),
    ["strong text", "math z"],
  );
});

test("scanLatex: list markers without the colours and spaces a label typesets nothing of (T-L1)", () => {
  const items = (begin: string, body = "\\item a \\item b") =>
    constructs(`${begin}\n${body}\n\\end{${/\{(\w+)\}/.exec(begin)![1]}}`).filter((c) => c.startsWith("item"));
  assert.deepEqual(items("\\begin{enumerate}[label=\\textcolor{blue}{\\arabic*}.]"), ["item 1.", "item 2."]);
  assert.deepEqual(items("\\begin{enumerate}[label=\\color{structurecolor}\\arabic*.]"), ["item 1.", "item 2."], "elegantbook's own label");
  assert.deepEqual(items("\\begin{itemize}[label=\\textcolor{red}{$\\star$}]"), ["item ⋆", "item ⋆"]);
  assert.deepEqual(items("\\begin{itemize}", "\\item[\\color{red}X] a \\item[\\hspace*{1em}Y] b \\item[\\fcolorbox{a}{b}{Z}] c"), ["item X", "item Y", "item Z"]);
});

test("scanLatex: an \\item label with math or a reference stays in place, its constructs scanned (T-L2)", () => {
  assert.deepEqual(
    constructs(
      [
        "\\begin{description}",
        "  \\item[$\\sigma$-代数] 集族",
        "  \\item[$L^2$ 空间] 平方可积 \\item[\\(\\mathbb{R}^n\\)] 空间",
        "  \\item[Markov] bound \\item[see \\ref{a}] b",
        "\\end{description}",
        "\\begin{itemize} \\item[$\\alpha$] alpha \\item[--] dash \\end{itemize}",
      ].join("\n"),
    ),
    [
      "begin \\begin{description}",
      "item [$\\sigma$-代数] (term)",
      "math \\sigma",
      "item [$L^2$ 空间] (term)",
      "math L^2",
      "item [\\(\\mathbb{R}^n\\)] (term)",
      "math \\mathbb{R}^n",
      "item Markov (term)",
      "item [see \\ref{a}] (term)",
      "ref a",
      "end \\end{description}",
      "item [$\\alpha$]",
      "math \\alpha",
      "item –",
    ],
  );
});

test("scanLatex: TikZ pictures are code: nothing in them is a construct (T-L3)", () => {
  assert.deepEqual(
    constructs(
      [
        "$a$ \\begin{tikzpicture}",
        "  \\coordinate (H) at ($(O)!(Y)!(X)$);",
        "  \\node[label={\\textbf{A}}] at (0,0) {$x$ \\ref{r}};",
        "  \\foreach \\t in {0,1} \\draw (\\t,0) node {\\small $\\t$};",
        "\\end{tikzpicture} $b$",
        "\\begin{tikzcd} A \\arrow[r, \"$f$\"] & B \\end{tikzcd}",
        "\\[ \\begin{tikzcd} C \\end{tikzcd} \\]",
        "\\begin{tikzpicture} half-typed: $c$",
      ].join("\n"),
    ),
    ["math a", "math b", "math \\begin{tikzcd} C \\end{tikzcd}", "math c"],
  );
});

test("scanLatex: elegantbook's problemset is an enumerate: numbered items, its [title] no list option, its lines collapse", () => {
  assert.deepEqual(
    constructs(
      [
        "\\begin{problemset}[本章练习]",
        "  \\item 证明 $x$。",
        "  \\item 计算：",
        "    \\begin{enumerate}",
        "      \\item a",
        "    \\end{enumerate}",
        "\\end{problemset}",
        "\\begin{enumerate}[resume]",
        "  \\item its enumerate ended inside problemset's group: resume starts over (XeLaTeX prints 1.)",
        "\\end{enumerate}",
      ].join("\n"),
    ).filter((c) => !c.startsWith("math")),
    [
      "begin \\begin{problemset}[本章练习]",
      "item 1.",
      "item 2.",
      "begin \\begin{enumerate}",
      "item (a)",
      "end \\end{enumerate}",
      "end \\end{problemset}",
      "begin \\begin{enumerate}[resume]",
      "item 1.",
      "end \\end{enumerate}",
    ],
  );
});

test("scanLatex: enumitem's resume, resume*, series and \\setcounter continue the numbers (T-L7)", () => {
  const items = (s: string) => constructs(s).filter((c) => c.startsWith("item"));
  assert.deepEqual(
    items("\\begin{enumerate}\\item a \\item b\\end{enumerate} text \\begin{enumerate}[resume]\\item c\\end{enumerate} \\begin{enumerate}\\item d\\end{enumerate}"),
    ["item 1.", "item 2.", "item 3.", "item 1."],
  );
  assert.deepEqual(
    items(
      "\\begin{enumerate}[label=(\\roman*)]\\item a\\end{enumerate}\n" +
        "\\begin{enumerate}[resume*]\\item b\\end{enumerate}\n" +
        "\\begin{enumerate}[resume*, start=7]\\item c\\end{enumerate}\n" +
        "\\begin{enumerate}[resume]\\item d\\end{enumerate}",
    ),
    ["item (i)", "item (ii)", "item (vii)", "item 8."],
    "resume* keeps the counter and the label, resume the counter; start= wins",
  );
  assert.deepEqual(
    items(
      "\\begin{enumerate}[series=steps, label=S\\arabic*]\\item a\\item b\\end{enumerate}\n" +
        "\\begin{enumerate}\\item x\\end{enumerate}\n" +
        "\\begin{enumerate}[resume=steps]\\item c\\end{enumerate}\n" +
        "\\begin{enumerate}[steps]\\item d\\end{enumerate}\n" +
        "\\begin{enumerate}[resume*=steps]\\item e\\end{enumerate}",
    ),
    ["item S1", "item S2", "item 1.", "item 3.", "item S4", "item S5"],
    "a series: resume=s the counter, s and resume*=s the label too",
  );
  assert.deepEqual(
    items(
      "\\begin{enumerate}\\item A \\begin{enumerate}\\item a\\end{enumerate}\n" +
        "\\item B \\begin{enumerate}[resume]\\item b\\end{enumerate}\\end{enumerate}\n" +
        "\\begin{enumerate}[resume]\\item C\\end{enumerate}",
    ),
    ["item 1.", "item (a)", "item 2.", "item (b)", "item 3."],
    "nested: resume sees the lists ended in the same list, and the outer list's end outside it",
  );
  assert.deepEqual(
    items("\\begin{enumerate}\\setcounter{enumi}{4}\\item e \\begin{enumerate}\\addtocounter{enumii}{2}\\item c\\end{enumerate}\\stepcounter{enumi}\\item g\\end{enumerate}"),
    ["item 5.", "item (c)", "item 7."],
  );
});

test("scanLatex: listings, fancyvrb's and tcolorbox's verbatim, filecontents and \\iffalse blocks are skipped (T-L8)", () => {
  assert.deepEqual(
    constructs(
      [
        "\\begin{tcblisting}{listing only} $t$ \\textbf{tcb} \\cite{k} \\end{tcblisting}",
        "\\begin{BVerbatim} $bv$ \\end{BVerbatim} \\begin{filecontents*}{x.tex} $f$ \\end{filecontents*}",
        "\\iffalse $hidden$ \\ifx\\a\\b $nested$ \\fi \\ifdef{\\x}{$y$}{} $still$ \\fi $after$",
        "\\iffalse",
        "  $A \\iff B$ % \\fi in a comment",
        "\\else $shown$ \\fi",
        "text \\iffalse $mid$ \\fi $z$ % not first on its line: TeX code, never skipped",
        "\\global\\let\\ifdraft\\iffalse",
        "$w$",
        "\\iffalse $to the end",
      ].join("\n"),
    ),
    ["math after", "math shown", "math mid", "math z", "math w"],
  );
});

test("scanLatex: natbib's and biblatex's capitalized and alternative citation commands are chips (T-L9)", () => {
  assert.deepEqual(
    constructs("\\Citet{a} \\Citep[p.~2]{b} \\citealt{c} \\citealp{d} \\Parencite{e} \\Textcite{f} \\Autocite{g} \\footcite{h} \\Cite{i}"),
    ["Citet -|-|a", "Citep -|p.~2|b", "citealt -|-|c", "citealp -|-|d", "Parencite -|-|e", "Textcite -|-|f", "Autocite -|-|g", "footcite -|-|h", "Cite -|-|i"],
  );
});

test("scanLatex: a TikZ picture alone on its lines is an env (a PDF crop, #14), still with nothing inside", () => {
  const text = [
    "\\begin{tikzpicture}[scale=1.4, >={Stealth[length=2mm]}]",
    "  \\node at (0,0) {$x$};",
    "\\end{tikzpicture}",
    "  \\begin{tikzcd}",
    "    A \\arrow[r, \"$f$\"] & B",
    "  \\end{tikzcd}",
    "\\begin{tikzpicture} \\draw (0,0); \\end{tikzpicture}",
    "\\begin{tabular}{ll}",
    "  $a$ & b \\\\",
    "\\end{tabular}",
  ].join("\n");
  assert.deepEqual(constructs(text), ["env tikzpicture[scale=1.4, >={Stealth[length=2mm]}]", "env tikzcd", "env tabular{ll}", "math a"]);
});

test("blocks and blockAt: environments and floats around a position, the innermost first", () => {
  const text = [
    "\\begin{figure}[htbp]", // 1
    "  \\centering",
    "  \\begin{tikzpicture}", // 3
    "    \\draw (0,0);",
    "  \\end{tikzpicture}", // 5
    "  \\caption{A $y$}",
    "\\end{figure}", // 7
    "\\begin{theorem}{T}{t}", // 8
    "  body $z$",
    "\\end{theorem}", // 10
    "\\begin{figure}", // 11: never closed
  ].join("\n");
  const d = doc(text);
  assert.deepEqual(
    blocks(d).map((b) => `${b.env} ${d.lineAt(b.from).number}-${d.lineAt(b.to).number}`),
    ["tikzpicture 3-5", "figure 1-7", "theorem 8-10"],
  );
  const all = () => true;
  const pos = (line: number, col: number) => d.line(line).from + col;
  assert.equal(blockAt(d, pos(4, 4), all)?.env, "tikzpicture");
  assert.equal(blockAt(d, pos(4, 4), (b) => b.env !== "tikzpicture")?.env, "figure", "the next one out when refused");
  assert.equal(blockAt(d, pos(6, 12), all)?.env, "figure", "the caption");
  assert.equal(blockAt(d, pos(9, 3), all)?.env, "theorem");
  assert.equal(blockAt(d, pos(11, 3), all), null);
  const picture = blocks(d)[0];
  assert.deepEqual(blocksAround(d, picture.from, picture.to).map((b) => b.env), ["figure"]);
  assert.equal(blocks(d), blocks(d), "memoized per document");
});
