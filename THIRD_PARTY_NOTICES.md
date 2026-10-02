# Third-party notices

LaTeX Live's own software and authored documentation are MIT. Third-party code, libraries, fonts, applications and referenced materials retain their original terms.

The production Obsidian bundle uses this repository's source and does not bundle a TeX engine, texlab, MathJax, pdf.js, CodeMirror or Lezer. Obsidian supplies its runtime APIs, CodeMirror/Lezer, MathJax and pdf.js. The user's separately installed TeX distribution and texlab are separate programs.

- [DOMPurify](https://github.com/cure53/DOMPurify): Copyright Cure53 and other contributors. Bundled to sanitize theorem-card HTML, under its Apache-2.0 license option. The full license is in [licenses/DOMPurify-Apache-2.0.txt](licenses/DOMPurify-Apache-2.0.txt) and the production bundle.
- [CodeMirror and Lezer](https://codemirror.net/): MIT upstream libraries, supplied by Obsidian at runtime.
- [MathJax](https://github.com/mathjax/MathJax): Apache-2.0. The test dependency matches the runtime supplied by Obsidian. MathJax/font resources used in exported documents retain their upstream terms.
- [pdf.js](https://github.com/mozilla/pdf.js): Apache-2.0, supplied by Obsidian at runtime.
- [texlab](https://github.com/latex-lsp/texlab): GPL-3.0 upstream program; separately installed, never bundled by this plugin. Upstream-derived LSP response text in tests remains under its upstream terms.
- [YOLO](https://github.com/Lapis0x0/obsidian-yolo): a separately installed optional AI-completion provider, never bundled by this plugin.
- TeX engines, packages, bibliography processors and dvisvgm retain the licenses of the separately installed distribution. Synthetic fixtures use them for validation; installing this plugin does not install those dependencies.

`docs/demo/source-provenance.md` records attribution and demo authorization for third-party notes. This project's MIT license does not grant a general license to those notes.

The clear showcase recordings dated 2026-10-01 display user-supplied Miku wallpaper with permission. The artwork appears only within the application recordings; its original file is not distributed here. The artwork's rights remain separate from the project's MIT license. The short ElegantBook manuscripts and caption text are original demonstration material.

Development-only packages retain the license identifiers and notices shipped by their packages. No development dependency is relicensed by this repository's LICENSE file.
