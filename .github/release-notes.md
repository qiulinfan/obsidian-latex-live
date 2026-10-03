LaTeX Live 0.1.6 addresses vertically stacked PDF controls when the plugin stylesheet is missing, and blurred previews after moving between displays with different pixel densities.

- If Obsidian did not download or load styles.css, opening a preview restores the same authored stylesheet bundled in main.js. Controls, page dimensions and selectable text recover together. Normal stylesheet loading adds nothing; theme/snippet overrides and unload cleanup are preserved. No network request or appearance reset is required.
- Changes between Retina and other displays redraw PDF backing pixels even when the preview pane's width is unchanged. Zoom, scroll position and text selection are retained, without recompiling or reopening the document.
- The community review fixes shipped in 0.1.5 remain included. That version completed its official review successfully.

Validated with 855 passing tests, 17 real pdf.js reading/layout browser checks and 31 editor browser checks, including missing-stylesheet recovery, light/dark themes, 375/800px panes, Retina density changes, a 65-page bilingual PDF and native English/Chinese copying. Production build and the blocking community-review lint gate pass.

Requires desktop Obsidian 1.13.7 or later and a separately installed TeX distribution.

The project's own code is MIT. Bundled DOMPurify uses its Apache-2.0 license option; upstream software and referenced materials retain their own licenses. See THIRD_PARTY_NOTICES.md for details.
