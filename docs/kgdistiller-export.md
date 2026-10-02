# Headless kgdistiller HTML bridge

The independent entry is `scripts/kgdistiller-export.mjs`. It uses the existing
project macro handling, isolated MathJax and native document exporter, without
Obsidian UI or a LaTeX-to-Typst conversion. Install this checkout's npm
dependencies first, then invoke `node scripts/kgdistiller-export.mjs`, or link
the executable as `latex-live-export` on PATH. kgdistiller can select another
location through `KGDISTILLER_LATEX_HTML_COMMAND`, a JSON argv array; no shell
evaluates it.

## Request and response

Read one UTF-8 JSON object from stdin and write one JSON object to stdout.
The request schema is `latex-live-html-request-v1`; the response schema is
`latex-live-html-result-v1`, with the same `operation`. Errors go to stderr and
exit nonzero. The two operations are:

- `labels`: optional absolute `.tex` `source`, and `labels: [{id, latex}]`.
  Returns `labels: [{id, html}]` containing safe self-contained MathML. Project
  macros come from the source's root. This mode needs Node/MathJax but no TeX
  build, CHTML stylesheet, or font files in the consumer.
- `document`: absolute complete-root `.tex` `source`, optional absolute
  `project_root`, `markers: [{name, id, url}]`, optional `engine`.
  Returns complete self-contained `html` and the existing export `report`.
  Whole-document export needs a TeX installation (`TEXBIN` can select its bin
  directory), and supports pdfLaTeX, XeLaTeX and LuaLaTeX. LuaLaTeX drawing
  fragments use native PDF and require a supported dvisvgm PDF backend, such as
  mutool (MuPDF tools).

kgdistiller owns identity decisions. Each marker mapping preserves an exact raw
TeX name and supplies its established stable ID and URL. Several raw names may
share one ID only with the same URL. Displayed text never determines identity.
Unknown markers and duplicate active definitions fail. Definitions emit
`id="kn-ID" data-ql-kn="ID"`; references emit `data-ql-ref="ID"` with the supplied
URL. Math belongs in the marker argument, such as `\kn{$\sigma$-algebra}`;
markers inside a math formula cannot establish HTML anchors.

## Source and process boundaries

The bridge copies the static dependency closure into a disposable project and
uses the exporter's actual visits for marker coverage, including `includeonly`,
imports and subfiles. `project_root` bounds original inputs and resources;
needed images, local styles, bibliography and listings are copied on demand.
Do not copy an entire vault, edit original sources, infer IDs from rendered
HTML, or add a second renderer. Runtime outputs and compiler work are temporary.
SIGINT/SIGTERM abort the export and dispose its compiler process groups.

The bridge lives in `src/export/kgdistillerBridge.ts`; the Node DOM/compiler
host lives in `src/export/nodeHost.ts`. Keep both free of Obsidian imports.
MathML labels reuse `ProjectMath` and MathJax's serialized-MML visitor, retaining
project macro isolation and restoration after each formula. Documents retain
the original CHTML export's embedded styles and fonts.

## Verification

Run `node scripts/run-tests.mjs kgdistillerBridge.test.ts`, `npm test` and
`npm run build`. The test runner rebuilds the shared
`node_modules/.cache/test-build`; run subset and full-suite commands sequentially.
Real regressions cover mathematical/CJK names, macros, raw-name aliases,
source-byte preservation, nested imports, `includeonly`, initialization around
comments or macro definitions, standalone assets, and cancellation. Changes
to the underlying visual exporter still follow the repository's existing
export-smoke and rendered-layout checks.
