# Project writing and PDF reading tools

The project tools work on the current root and its literal inputs, using committed open
buffers before disk. They never scan the entire vault or invoke TeX on a keystroke.
Custom macros are not executed. Unreadable, dynamic or cyclic input traversal is reported.

## Commands and controls

- **Open project outline** opens a side pane. Standard part/chapter/section headings form
  a project hierarchy in actual input order, including repeated visits, import/subfiles and
  inputs in parent folders. Click a heading to open its source. The pane follows the active
  project and refreshes 800 ms after committed edits; closing it cancels its work.
- The fold gutter and standard CodeMirror fold shortcuts fold sections, proofs and matched
  environments. Edits map cached ranges; structural parsing runs after 400 ms of inactivity
  or an explicit fold action. Composition postpones indexing. Bibliography/package files do
  not mount the semantic fold index. Sources over 1,000,000 characters also skip indexing,
  matching the syntax highlighter's budget and avoiding an idle-time pause.
- **Search and replace in current LaTeX project** groups literal matches by file, with match
  case and whole word options. Results navigate to exact source positions. **Preview
  replacement** lists each change before **Apply changes** can write it.
- **Find all label references in current project**, **Rename label across current project**
  and **Rename paired begin/end environment** use source ranges, including math references,
  cleveref lists/ranges and ElegantBook's native theorem labels. Ordinary references treat
  commas as part of one key; cleveref lists alone split them. Safe label rename rejects
  duplicate definitions, repeated defining files, collisions and dynamic reference-generating
  macros. Changes never silently widen to another root.
- Project edits check both disk and every open pane before writing, use `Vault.process`
  compare-and-swap, reject IME and conflicting buffers, preserve CRLF, and keep a recovery
  JSON file at the path displayed in the preview. They conditionally roll back on failure.
  **Undo this operation** and **Undo last project replacement or rename** check for later
  edits before restoring; they never overwrite newer text.
- **Search project bibliography** searches every declared local `.bib` by citation key,
  full author/editor names, title and year. Results are paged, not truncated. Selecting an
  entry shows all resolved fields and its original BibTeX entry, with insertion/source
  actions. Citation completion uses the same complete libraries without texlab's 50-item
  limit. Closed/inactive code declarations are ignored; multiline path edits invalidate
  the cache. No bibliography parsing runs on ordinary text edits.
- **Count prose words in project** counts source prose for the actual document visits and
  reports words and Chinese characters separately. Math, commands, reference identifiers,
  code and definitions are excluded; repeated inputs count per visit. This is a source
  count, not a count after expanding custom macros.
- **Check prose spelling in current file** uses the project's argument signatures and
  Obsidian/Electron's system dictionary. It skips math, commands, references, definitions
  and code, checks in yielded batches, and offers location/suggestion buttons. Edits clear
  stale underlines. A disabled or unloaded dictionary is reported; no dictionary is bundled
  or downloaded.
- **Paste clipboard as LaTeX table** converts rectangular HTML/TSV/CSV clipboard data to
  a preview of `tabular` or `booktabs`, then inserts it as one undoable operation. One-row
  and one-column tables work. TeX special characters are escaped; merged cells and large
  tables are reported. `booktabs` requires the package in the document's preamble.
- The PDF dock provides previous/next page, page-number entry, zoom status and **Save the
  last successful build as PDF**. Trackpad ctrl-wheel pinch keeps the pointer's PDF
  position, coalesces frames and delays expensive redraws. Native pdf.js text is selectable
  and copyable; PDF links navigate to destinations or safe external URLs. Double-click on
  text or the page still performs inverse SyncTeX. Saving snapshots the last successful
  bytes before opening the native dialog and writes atomically.

## Performance and validation

The outline and bibliography are lazy project tools; search, replacement, references,
word count, spelling and table conversion are explicit operations. Fold ranges are mapped
inside edit transactions rather than reparsed. PDF rendering is independent of editor
updates, with two concurrent renders and ten cached canvas/text/link pages; active text
selection can protect its two endpoint pages.

Regression tests cover snapshots/imports/parent paths, stale previews, disk/pane races,
IME, CRLF, recovery/Undo, project signatures, all-entry bibliographies, PDF loading races
and bounded layers. The browser scripts exercise native pointer/clipboard input:

- `node scripts/outline-folding-smoke.mjs`
- `node scripts/project-operations-smoke.mjs`
- `node scripts/bibliography-prose-smoke.mjs`
- `node scripts/pdf-reading-smoke.mjs`

Reference research: Overleaf's [file outline](https://docs.overleaf.com/navigating-in-the-editor/selecting-and-managing-files),
[project search](https://docs.overleaf.com/navigating-in-the-editor/searching-within-a-project),
[bibliography search](https://docs.overleaf.com/citing-and-references/adding-citations-and-references/searching-for-references),
[word count](https://docs.overleaf.com/writing-and-editing/using-word-count),
[table tools](https://docs.overleaf.com/writing-and-editing/generating-and-inserting-tables),
and Electron's [system spelling API](https://www.electronjs.org/docs/latest/api/web-frame#webframeiswordmisspelledword).
