# Demo source provenance

The local mathematics demonstration uses [Onion20040508/notes](https://github.com/Onion20040508/notes) at commit [`248dc5590feeb41b52e2ef0977f9947d00712baf`](https://github.com/Onion20040508/notes/tree/248dc5590feeb41b52e2ef0977f9947d00712baf). The user explicitly stated that the author is a friend and gave permission to use the material in these local product demonstration recordings. This records that session authorization; it does not infer a general redistribution license from a public repository. No material has been published or uploaded.

The source checkout is read-only in `node_modules/.cache/product-demo/source-notes/`. It has no `AGENTS.md`, `CLAUDE.md`, or explicit `LICENSE`/`COPYING` file in the inspected commit. Its `Home.md` documents an Obsidian note organization; its `preamble.sty` documents macro compatibility. Those files were read as source information, and no source automation scripts or repository configuration were executed or installed.

The original TeX source is [Math/Single Variable Analysis/tex/math451_notes.tex](https://github.com/Onion20040508/notes/blob/248dc5590feeb41b52e2ef0977f9947d00712baf/Math/Single%20Variable%20Analysis/tex/math451_notes.tex). It uses the standard `report` class with custom Axler-style `tcolorbox` environments, TikZ and pgfplots. It is **not** originally an elegantbook project. The original header identifies University of Michigan, instructor Lizhen Ji, Fall 2025, and K. Ross's *Elementary Analysis* textbook; that attribution is preserved in the unmodified source copy.

Only provenance is checked into this plugin repository. The checkout, note excerpts, TeX project, build files and recordings remain under ignored `node_modules/.cache/product-demo/`.

## Local project and changes

The prepared project is `node_modules/.cache/product-demo/vault/math-notes/main.tex`, with chapter files below `chapters/` and a machine-readable `SOURCE.json` recording exact original line ranges and excerpt hashes. An unmodified copy of the full original source is `_source/original-math451.tex`.

The presentation adaptations are explicit and reversible:

- Use a presenter-authored elegantbook wrapper, Chinese navigation headings, `fontset=fandol`, and the `xelatex` magic comment. The source's English mathematical exposition and arguments remain the note author's material.
- Extract complete proof-bearing portions of §9 (limit arithmetic), §10 (monotone/Cauchy sequences), and §11 (subsequences) into four chapter files.
- Rename the source's `defbox`, `thmbox`, `lembox`, `propbox`, `corbox`, `exbox`, `rembox`, and `notebox` environments to the corresponding elegantbook environments.
- Add explicit demo labels. Replace the original product-proof mention `(Theorem 9.1)` with `Theorem~\ref{thm:bounded}`, and the divergence-proof phrase `by the theorem` with `by Theorem~\ref{thm:subsequence}`. These labels and links are demo adaptations, not claims that the author's original monolithic document already had this source graph.
- Place the unchanged monotone-convergence explanatory remark after its proof, so the theorem/proof association is structurally unambiguous in the demonstration copy.
- Replace the two excerpted amsthm-specific `\qedhere` calls with `\quad\square` inside the existing display formulas for elegantbook's proof environment.
- Keep the original monotone-convergence TikZ/pgfplots plot data and explanatory text; change its `center`/`figcap` wrapper to a standard `figure`/`caption` and add `fig:monotone`.
- Add a source bibliography and a separate, empty presenter-authored `05-writing-workbench.tex`. Writing acceleration exercises happen there; they are not represented as original note content.

## Recommended recording scenes

| Scene | File | Material and feature |
|---|---|---|
| Reading and mode switch | `chapters/01-limits.tex` | Convergent sequences are bounded: readable theorem, proof, inline and display mathematics. |
| Cross-file theorem graph | `chapters/02-arithmetic.tex` | Product proof's `\ref{thm:bounded}` targets the preceding chapter; expand its statement/proof and jump to source. |
| Complex mathematics | `chapters/02-arithmetic.tex` | Product and quotient estimates with nested fractions, limits, epsilon bounds and long expressions. |
| TikZ and PDF synchronization | `chapters/03-cauchy.tex` | Author's monotone-convergence plot, figure caption, theorem and proof. |
| Reference navigation | `chapters/04-subsequences.tex` | Subsequence theorem and divergence corollary with an explicit proof reference. |
| Writing acceleration | `chapters/05-writing-workbench.tex` | Controlled empty writing area for completion, snippets, indentation, YOLO suggestions and accepted/rejected edits. |
| Export and attribution | `main.tex` | Bibliography, source credit, cross-file project root and HTML/PDF export. |
| Original-template comparison | `_source/original-math451.tex` | Unmodified report source and its real compiled PDF, preserving the author's original presentation. |

Compilation receipts and the local source-graph verification are saved under `node_modules/.cache/product-demo/source-build/`. They distinguish successful builds and diagnostic warnings from source adaptations; recording evidence must still come from actual application interactions.

## Verified local artifacts

The adapted elegantbook project compiled through the plugin's real `Compiler`/latexmk on MacTeX with XeLaTeX and Fandol: **11 PDF pages, zero diagnostics** in the final source-preparation build. All five chapter paths resolve to `math-notes/main.tex`. The current source index contains 15 nodes, two literal proof-reference edges, and no unresolved diagnostics. The added edges are product proof → bounded-sequence theorem and divergence-corollary proof → subsequence theorem; both are presenter-added structural references to existing mathematical dependencies in the excerpted arguments.

`vault/html/analysis-notes.html` was produced through the current production NodeHost/exporter with real TeX probe and dvisvgm fragment stages. The local export report records 341,456 bytes, 185 math renderings, one TikZ SVG fragment, one figure caption, two source references, and two bibliography items, with no export warnings. The measured Node preparation/emit run was 2,294 ms using an already fresh verified build (build 9 ms, plan 191 ms, probe 1,855 ms, fragments 223 ms, emit 13 ms). This is a process measurement, not a browser rendering or recording timing claim. The HTML embeds its math/fragment fonts and uses no external image/font resource dependencies; its source-credit hyperlinks remain normal external hyperlinks.

For a short native-template comparison, `vault/native-report-excerpt/main.tex` retains the original `report` preamble, original custom box definitions, and unchanged source body ranges 1544–1671 and 1894–1949. The presenter adds only an excerpt chapter heading and an initial section counter of eight; no labels, references, environment renaming, proof reordering, or formula edits occur in that native-style excerpt. Its real pdfLaTeX build produced **six PDF pages, zero diagnostics**, measured at 2,709 ms during source preparation. The full, unmodified 170-page report also compiled without errors, with existing hyperref/bookmark/tcolorbox layout warnings; it need not be recorded in full.

Machine-readable receipts are `source-build/demo-verification.json`, `source-build/html-export-report.json`, `source-build/native-report-excerpt-result.json`, and `source-build/original-result.json`. These artifacts do not replace the actual application footage required for the demonstration.

## Recording-copy additions on 2026-10-01

The Desktop recording copy additionally includes presenter-authored `reading-guide.tex`, included in the source appendix, with navigation references to `thm:products` and `cor:divergence`. It makes the existing explicit proof-reference neighborhoods accessible without asserting that the author added these navigation links. The separate writing workbench receives presenter-authored fraction/align, diagnostic and code-listing examples during recording. None of these changes alter the read-only original checkout.

The recording copy is retained under the local `LaTeX-Live-Demo-2026-09-30` artifact folder; that date identifies the task's start. Actual video timestamps and receipts use their real capture times on 2026-10-01.
