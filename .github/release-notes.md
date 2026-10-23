LaTeX Live 0.2.0 makes the live editor read your project: its own environments and layout commands, beamer decks and tables, with references that jump to their labels and TikZ crops placed from where TeX actually put each picture.

- **Live editor rules.** Formula aliases (an environment rendered as `equation`), wrapper environments whose `\begin`/`\end` lines fold, and hidden layout commands (`\centering`, `\vspace{…}`, a deck's own layout macros). Rules come from your settings, then from the project's `\newcommand`/`\newenvironment` definitions, then from built-in defaults; edit them under **Settings → LaTeX Live → Live editor rules**. `\caption` shows as "Figure n: …" with the number from the `.aux`. The PDF and exports are unchanged.
- **References jump.** A `\ref`/`\eqref`/`\cref` chip goes to its `\label` on click, in the same file or another, including tabs Obsidian restored in the background, and flashes the formula it lands on.
- **Beamer decks.** Frames show as cards with their title and their PDF page (click to turn the preview); overlays, `columns` and font-size commands are hidden; section banners, image and layout macros are detected from their definitions; TikZ pictures and the title page fold to one line. Inverse search inside a frame lands on the clicked word instead of `\end{frame}`.
- **Tables are drawn.** `tabular`, `tabular*`, `tabularx` and `longtable` render as tables, with column specs, rules (`\hline`, booktabs, `\cline`), `\multicolumn`, `\multirow` and formulas, references and styles in cells. A click shows the source.
- **Accurate TikZ crops.** Fast compiles record where each TikZ picture lands in the PDF and crop from that box, falling back to SyncTeX. The recorder changes no page of the output, leaves a project's `latexmkrc` to full builds and takes a write stream only when one is free.
- **LaTeX Suite snippets** expand in the LaTeX editor.
- **SyncTeX.** Forward search is corrected by the cursor line's words in the PDF; inverse search places the cursor on the double-clicked word and flashes the target.
- **Custom templates.** Configurable template visualization profiles, inherited theorem rendering and ElegantBook proof and example heads.
- **Exports and integrations.** HTML exports stage local classes and packages; the kgdistiller export anchors `\kn[NAME]{TEXT}` knowledge markers; other plugins can add CodeMirror extensions to the TeX editor (`registerTexEditorExtension`).
- **Appearance and platforms.** LaTeX source uses the theme's code size and the preview sits on the note background; Windows TeX paths are fixed.

Typing stays within a frame on long documents: tables, formula cells and rule detection are cached, and a browser check types in a 6,000-line chapter with 66 tables (keystroke p95 under 16 ms). Validated with 957 passing tests against a real TeX distribution and 52 editor browser checks.

Requires desktop Obsidian 1.13.7 or later and a separately installed TeX distribution.

The project's own code is MIT. Bundled DOMPurify uses its Apache-2.0 license option; upstream software and referenced materials retain their own licenses. See THIRD_PARTY_NOTICES.md for details.
