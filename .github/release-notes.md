LaTeX Live 0.1.3 adds project writing tools, PDF reading controls, customizable editor typography and LuaLaTeX HTML export. It also fixes inverse SyncTeX navigation when the filesystem's Unicode path spelling differs from Obsidian's normalized file index.

- Customize source font size, line height and font family, plus formula preview size.
- Use a project outline and fold sections, proofs and environments.
- Search across the current root and its input files. Preview cross-file replacements and label renames, or rename a paired begin/end environment, with stale-file checks, recovery backups and Undo.
- Search complete local bibliography libraries by author, title, year or citation key, inspect all fields and insert citations without texlab's 50-result limit.
- Count source prose, check spelling with Obsidian's system dictionary, and preview clipboard tables as tabular/booktabs before inserting them.
- Read PDFs with trackpad zoom, selectable/copyable text, clickable links, page navigation and Save as PDF. Double-click inverse SyncTeX remains available.
- Export HTML with pdfLaTeX, XeLaTeX or LuaLaTeX. LuaLaTeX preserves native PDF drawing. Native graphic fragments require separately installed dvisvgm and a working PDF backend, such as mutool from MuPDF on PATH. Missing tools are reported and the affected source is retained; the plugin does not install them.

Project tools run on demand or after an idle delay. Typing does not scan a whole project, and PDF layers are rendered lazily with a bounded cache. Source word counts do not expand custom macros; spelling requires an enabled host dictionary. Semantic fold indexing skips documents over 1,000,000 characters. Cross-file edits never write outside the vault; dynamic or incomplete input traversal prevents global label rename. booktabs tables require the document to load booktabs, and merged clipboard cells are not supported.

Requires desktop Obsidian 1.13.7 or later and a separately installed TeX distribution. texlab and YOLO remain optional, separately installed integrations. The plugin does not bundle a TeX engine.

Validated with 836 passing tests, real pdfLaTeX/XeLaTeX/LuaLaTeX Unicode-path navigation regressions, and browser checks for editing, project tools and a 65-page bilingual PDF.

The project's own code is MIT. Bundled DOMPurify uses its Apache-2.0 license option, with the full license included in the bundle. Upstream software and referenced materials retain their own licenses. See THIRD_PARTY_NOTICES.md for details.
