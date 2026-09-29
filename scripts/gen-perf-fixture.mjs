// Synthetic long chapters for the live-preview performance checks (browser-smoke B5 and manual
// runs), never committed. Every section has its own formulas (numbered by the section), so
// renders are not cache hits of each other; `first` numbers the first section (chapters that
// share no formula). Identical in obsidian-latex-live and obsidian-tinymist.
//   latexChapter(lines, first)  a LaTeX chapter: sections of inline math (`$..$`, `\(..\)`), an
//                               equation with a label, an \eqref, an align*, prose
//   typstChapter(lines, first)  the Typst equivalent: headings, inline math, a display formula
//                               with a label, a reference, a two-row display, prose
// Usage: node scripts/gen-perf-fixture.mjs [outDir]   writes ch2-3000 and ch2-5700 of both
// (default outDir: $TMPDIR/live-perf-fixture) and prints the folder.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `lines` lines of a LaTeX chapter (standard commands only: it renders without a preamble). */
export function latexChapter(lines, first = 1) {
  const out = [String.raw`\chapter{Long chapter}`];
  for (let i = first; out.length < lines; i++) {
    out.push(
      String.raw`\section{Part ${i}}`,
      String.raw`Let $x_{${i}} \in \mathbb{R}^{n}$ with $\lVert x_{${i}} \rVert \le ${i}$ and $\mathbb{E}[X_{${i}}] = \mu_{${i}}$.`,
      String.raw`\begin{equation}\label{eq:long-${i}}`,
      String.raw`  S_{${i}} = \sum_{k=1}^{${i}} \frac{1}{k^2} + \int_0^{1} t^{${i}}\,dt`,
      String.raw`\end{equation}`,
      String.raw`By~\eqref{eq:long-${i}} we get $\operatorname{Var}(S_{${i}}) \ge 0$, where \(\varepsilon = 2^{-${i}}\).`,
      String.raw`\begin{align*}`,
      String.raw`  a_{${i}} &= b_{${i}} + c_{${i}} \\`,
      String.raw`  &\le \langle a, b \rangle + \frac{\alpha}{2}`,
      String.raw`\end{align*}`,
      "This paragraph is plain prose without any formula at all.",
      "",
    );
  }
  return out.slice(0, lines).join("\n") + "\n";
}

/** `lines` lines of a Typst chapter (no imports: it compiles on its own). */
export function typstChapter(lines, first = 1) {
  const out = ['#set math.equation(numbering: "(1)")', "= Long chapter"];
  for (let i = first; out.length < lines; i++) {
    out.push(
      `== Part ${i}`,
      `Let $x_${i} in RR^n$ with $norm(x_${i}) <= ${i}$ and $EE[X_${i}] = mu_${i}$.`,
      `$ S_${i} = sum_(k=1)^${i} 1/k^2 + integral_0^1 t^${i} dif t $ <eq:long-${i}>`,
      `By @eq:long-${i} we get $"Var"(S_${i}) >= 0$, where $epsilon = 2^(-${i})$.`,
      `$ a_${i} &= b_${i} + c_${i} \\`,
      "  &<= chevron.l a, b chevron.r + alpha/2 $",
      "This paragraph is plain prose without any formula at all.",
      "",
    );
  }
  return out.slice(0, lines).join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ?? join(tmpdir(), "live-perf-fixture");
  mkdirSync(dir, { recursive: true });
  for (const lines of [3000, 5700]) {
    writeFileSync(join(dir, `ch2-${lines}.tex`), latexChapter(lines));
    writeFileSync(join(dir, `ch2-${lines}.typ`), typstChapter(lines));
  }
  console.log(dir);
}
