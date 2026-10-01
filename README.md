<h1 align="center">LaTeX Live</h1>
<p align="center">Read and write LaTeX projects in Obsidian, with live math, proof references and native PDF preview.</p>

<p align="center">
  <a href="https://github.com/qiulinfan/obsidian-latex-live/commits/main"><img src="https://img.shields.io/github/last-commit/qiulinfan/obsidian-latex-live/main?style=flat-square&color=6c5ce7" alt="Last commit"></a>
  <a href="https://github.com/qiulinfan/obsidian-latex-live/stargazers"><img src="https://img.shields.io/github/stars/qiulinfan/obsidian-latex-live?style=flat-square&color=6c5ce7" alt="GitHub stars"></a>
  <a href="https://github.com/qiulinfan/obsidian-latex-live/releases/latest"><img src="https://img.shields.io/github/v/release/qiulinfan/obsidian-latex-live?style=flat-square&color=00b894" alt="Latest release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT--0-636e72?style=flat-square" alt="MIT-0 license"></a>
  <img src="https://img.shields.io/badge/Obsidian-1.13.7%2B-7c3aed?style=flat-square" alt="Obsidian 1.13.7 or later">
</p>

<p align="center"><b>English</b> | <a href="./README_zh-CN.md">简体中文</a></p>

## Highlights

![Source editing and a locally compiled PDF](./docs/assets/writing-preview.png)

Work with the original `.tex` files. Read supported formulas and theorem blocks in place, reveal their source while editing, and check the result against a PDF produced by your installed TeX distribution.

Follow a theorem reference without leaving the paragraph: open a proof-reference graph, expand a node's statement and proof, then jump to its source. Share a self-contained HTML reading edition when a PDF is not the format your reader needs.

## Features

| Feature | What it does |
| --- | --- |
| Source and live editing | Render supported math, headings, lists, theorem blocks, images and reference chips; keep editable source available. |
| Native PDF preview | Compile with your installed pdfLaTeX, XeLaTeX or LuaLaTeX; use latexmk for bibliography and complete builds. |
| Bidirectional SyncTeX | Locate the cursor in the PDF and double-click the PDF to return to source, including multi-file projects. |
| Language assistance | Use a separately installed texlab for completion, snippets, diagnostics and hover information. |
| Formula previews | Render project macros on hover, with optional cursor previews and supported TeX/PDF fallbacks. |
| Proof-reference graph | Explore literal `\ref` calls in the current project's proofs; expand statements/proofs and open source locations. |
| HTML export | Export headings, math, theorem blocks, references, bibliography, embedded resources and supported graphics to a standalone reading page, with a report. |
| Optional YOLO completion | Use real ghost-text suggestions from a separately installed YOLO plugin. Tab accepts; Enter never accepts AI text. |

The proof graph describes explicit source references, not machine-verified logical dependencies. Unknown environments and unsupported macros retain their source or use a supported fallback.

## Quick start

1. Install **Obsidian 1.13.7 or later on desktop** and a local TeX distribution such as [TeX Live](https://www.tug.org/texlive/) or [MacTeX](https://www.tug.org/mactex/).
2. Install and enable LaTeX Live using the release instructions below.
3. Put a `.tex` project inside your vault and open it. Use the eye action in the editor header to open the PDF preview.
4. Edit and save. The default typing delay is 400 ms before saving and requesting a compile; it is not the time required to generate a PDF.
5. Switch the editor mode from its header or run **LaTeX Live: Toggle live preview**. Use **LaTeX Live: Full build with latexmk (BibTeX/Biber, all passes)** when a complete build is needed.

For enhanced editing, install [texlab](https://github.com/latex-lsp/texlab) separately. Configure **TeX binary directory** and **texlab binary** in plugin settings if automatic detection does not find them.

## Installation

### Community directory

Open the [LaTeX Live community listing](https://community.obsidian.md/plugins/latex-live), choose **Add to Obsidian**, then enable **LaTeX Live**.

### Manual installation

1. Download `main.js`, `manifest.json` and `styles.css` from the same [GitHub Release](https://github.com/qiulinfan/obsidian-latex-live/releases).
2. Put them in `<vault>/.obsidian/plugins/latex-live/`.
3. Reload Obsidian, then enable **LaTeX Live** under Settings → Community plugins.

The plugin does not download, install or update TeX, texlab, bibliography processors or other dependencies.

## Projects and templates

Keep the original project structure, including `\input`, `\include`, bibliography and local packages. A chapter can identify its main document with a magic comment:

```tex
% !TEX root = ../main.tex
```

An engine comment such as `% !TEX program = xelatex` takes precedence over the default engine setting. Automatic detection also reads the preamble and latexmk configuration.

PDF layout belongs to the original class and TeX toolchain. Tested examples include ElegantBook and PLOS, Springer Nature, REVTeX, AASTeX, AMS, LNCS, ACM and IEEE paper templates. This is a tested set, not a promise that every template or package has full live-editor/HTML semantics. See [template compatibility](./docs/template-compatibility.md).

## Export a reading edition

Run **LaTeX Live: Export to HTML**, choose a destination and inspect **Report** when export finishes. The page embeds its supported math fonts, images and SVG resources and requires no JavaScript for reading.

The current HTML exporter supports **pdfLaTeX and XeLaTeX**. LuaLaTeX remains available for PDF compilation, but HTML export is outside its current support scope. Complex constructs may be represented as SVG or source; the report makes those boundaries visible. A reading edition does not reproduce every journal's printed page layout.

## Local files, processes and network

- Compilation, PDF preview and language assistance use local processes. TeX, texlab, packages and fonts are separately installed software with their own behavior and licenses.
- The plugin reads project inputs and dependencies, finds configured/system binaries and writes build files under an operating-system temporary directory outside the vault. Packages, fonts, bibliography files and other TeX dependencies may also live outside the vault; these accesses support normal local compilation.
- Math and PDF rendering use Obsidian's bundled MathJax and pdf.js resources. The plugin has no built-in remote AI service or client telemetry.
- Optional YOLO completion is **off by default**. Enabling it uses the separate YOLO plugin, which can send writing context to its configured model provider. Review YOLO's configuration and the provider's policies before enabling it.
- Shell escape is **off by default**. Enabling it lets trusted TeX documents execute commands through the installed toolchain.

Desktop only; this release does not provide iPad editing. Source files remain ordinary LaTeX files that other editors and tools can use.

## Feedback and contributing

[Report a bug or suggest a feature](https://github.com/qiulinfan/obsidian-latex-live/issues). Include your Obsidian/plugin version, OS, TeX engine and a small reproducible project. Remove private notes, keys and unrelated files before attaching material.

Contributions are welcome. For large changes, open an issue first to discuss the use case and implementation. Development guidance is in [AGENTS.md](./AGENTS.md).

## Acknowledgments and license

Built around Obsidian, CodeMirror, texlab, MathJax, pdf.js and the TeX ecosystem. Optional AI completion is supplied by [YOLO](https://github.com/Lapis0x0/obsidian-yolo).

The project's own software and authored documentation use [MIT No Attribution (MIT-0)](./LICENSE): commercial use, modification and closed-source distribution are permitted without an attribution condition. Third-party software, fonts and referenced materials retain their original licenses; see [third-party notices](./THIRD_PARTY_NOTICES.md).
