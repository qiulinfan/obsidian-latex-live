LaTeX Live 0.1.7 fixes blurred PDF previews after moving between displays with different pixel densities and removes the runtime stylesheet fallback rejected in the 0.1.6 community review.

- Display-density changes redraw PDF backing pixels even when the preview pane's width is unchanged. Zoom, scroll position and text selection are retained, without recompiling or reopening the document.
- Preview styling uses the standard styles.css release asset. If the stylesheet was not downloaded or loaded, a delayed notice explains how to update and restart Obsidian, or reinstall after backing up settings. Normal and startup-delayed loading produce no warning; closed previews cancel the check and popouts inspect their own window.
- Runtime style-element creation and bundled CSS text are removed. CI and releases now enforce every error-level rule in the official Obsidian recommended configuration, including forbidden elements, plus the SDL unsafe-HTML rule.
- The community review fixes from the successfully reviewed 0.1.5 release remain included.

Validated with 855 passing tests, 18 real pdf.js reading/layout browser checks and 31 editor browser checks. Coverage includes missing/delayed stylesheet loading, light/dark themes, 375/800px panes, Retina density changes, a 65-page bilingual PDF and native English/Chinese copying. Production build and the expanded blocking community-review lint gate pass.

Requires desktop Obsidian 1.13.7 or later and a separately installed TeX distribution.

The project's own code is MIT. Bundled DOMPurify uses its Apache-2.0 license option; upstream software and referenced materials retain their own licenses. See THIRD_PARTY_NOTICES.md for details.
