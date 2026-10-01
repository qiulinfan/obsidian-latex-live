LaTeX Live 0.1.1 sanitizes theorem statement, proof and footnote cards before inserting them into the editor. The cards preserve MathJax formulas, local reference links and SVG glyphs while removing executable HTML and unsafe URLs. The kgdistiller CLI bridge now parses generated MathML as XML before applying its existing allowlist.

Requires desktop Obsidian 1.13.7 or later and a separately installed TeX distribution. texlab and YOLO are optional, separately installed integrations. HTML export currently supports pdfLaTeX and XeLaTeX; LuaLaTeX remains supported for PDF compilation.

The project's own code is MIT-0. Bundled DOMPurify uses its Apache-2.0 license option, with the full license included in the bundle. Upstream software and referenced materials retain their own licenses. See the README and THIRD_PARTY_NOTICES.md for installation, file access and optional-network disclosures.
