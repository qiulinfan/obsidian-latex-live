# obsidian-latex-live agent guidance

- This plugin is a thin Obsidian frontend over the TeX distribution already
  installed on the machine (pdfLaTeX, XeLaTeX, LuaLaTeX, latexmk, SyncTeX).
  It owns the editor view, the compile queue, log parsing, the PDF preview,
  and Obsidian integration. Never bundle or reimplement a TeX engine.
- `src/tex/` must stay free of the `obsidian` module so it runs under Node
  tests against real TeX. Obsidian glue lives in `src/main.ts`,
  `src/session.ts`, `src/editor/`, and `src/preview/`.
- CodeMirror 6 and Lezer come from Obsidian at runtime and stay in the
  esbuild `external` list. Obsidian inlines its own CM6 language plumbing, so
  `syntaxHighlighting` never decorates custom views; highlighting goes through
  the decoration tokenizer in `src/editor/latexHighlight.ts`.
- The PDF preview uses Obsidian's bundled pdf.js (`loadPdfJs`, 5.x in
  Obsidian 1.13). pdf.js takes ownership of the data buffer: always pass a
  copy (`slice()`).
- TeX tool conventions that bugs have already come from:
  - Pass the preamble format by name (`-fmt=<job>-preamble`) with
    `TEXFORMATS=<outDir>:`; an absolute `-fmt` path breaks the `-recorder`
    temp file name and pdfTeX exits before writing a log.
  - Delete the job log before each run so a run that dies early never
    reports the previous log as success.
  - TeX reports physical paths (`/private/var/...` on macOS); map them back
    with `logicalMapper` before comparing with vault paths.
  - Spawn TeX with `max_print_line=10000` and `-file-line-error`; the log
    parser depends on both.
- Spawned TeX processes run in their own process group and must be killed on
  session dispose (preview closed or switched, plugin unload). No orphans.
- Editor keys: `keyArbiter` (from `src/editor/shared/`) is mounted FIRST in
  `texEditorExtensions` and owns Tab, Shift-Tab, Enter, Escape, ArrowUp and
  ArrowDown (completion popup > YOLO ghost text > snippet field > indent; Enter
  accepts only when that changes the text and never accepts AI text). Never bind
  these keys anywhere else; LaTeX Enter behaviour goes into the arbiter's `enter`
  hooks (`src/editor/latexEnter.ts`, which also holds `latexIndent`, the
  indentService for new lines). A hook that must wait for the completion popup
  (`\begin{ali|}` + a fast Enter) swallows the key and pumps like Tab-ahead instead
  of binding anything. The arbiter never intercepts Backspace; the view keymap binds
  editorKit's `deleteMathPair` (empty `\(|\)` / `\[|\]`) just before
  `closeBracketsKeymap`. Obsidian
  hotkeys that would swallow editor keys (Mod-/, Mod-D, Mod-G, Mod-B, Mod-I,
  Mod-E, ...) are routed through the view's `Scope` (`registerEditorScope`);
  Mod-S and Mod-F keep their Obsidian meaning (`showSearch` handles Mod-F).
- Edits reach saving, compiling and texlab only through `editNotifier` (committed
  text, never mid-IME-composition), and `TexView.save` defers every save (including
  Obsidian's own debounced one) while a composition is open, so uncommitted Pinyin is
  never written or compiled. `TexView` keeps a CRLF file CRLF (CodeMirror holds LF;
  `getViewData` converts back), so opening a file and switching away never rewrites it.
- `src/editor/shared/` is shared with obsidian-tinymist and must stay
  byte-identical; the canonical copy lives in
  `obsidian-tinymist/src/editor/shared`. Never edit the copies here: change the
  canonical files and copy them over (`cmp` both trees). Shared modules may only
  `import type` from `obsidian`. `styles.css` embeds `editor.css` verbatim between
  `/* shared:editor.css begin */` and `/* shared:editor.css end */`, and the
  editor container carries the neutral class `lsp-cm-view` next to
  `ll-editor-content`.
- texlab (`src/lsp/`, free of the `obsidian` module) provides completion and
  hover. Conventions that measurements established:
  - One server per vault, started lazily by the first LaTeX view, with the vault
    root as workspace (a chapter folder as workspace loses the other chapters).
    It is killed on plugin unload and exits by itself when Obsidian dies.
  - Every document goes out with a trailing `\n` when it lacks one: texlab 5.26
    returns no command completions when the command touches the very end of the
    document (many real files end without one). Edits are
    sent incrementally while that state is unchanged, else as full text.
  - Settings are answered from `workspace/configuration` (`texlabSettings`);
    `didChangeConfiguration {settings: null}` makes texlab pull them again, e.g.
    when the active document's build folder (`build.auxDirectory`, label numbers)
    changes.
  - texlab's diagnostics are ignored: compile diagnostics from the log stay
    authoritative. Its PATH starts with the resolved TeX bin directory, so
    texlab and the compiler see the same distribution.
  - texlab has no argument snippets, no `\end` insertion, no math awareness and a
    50-item cap; `src/editor/latexCompletion.ts` adds those on top. Snippets from
    that layer are applied with CodeMirror's `snippet()` directly from their
    `#1 ... #0` templates (the shared `lspSnippetToCm` now escapes only `{` after
    `#`/`$`/`\` and `}` after `\`, but @codemirror/autocomplete 6.20.3 still
    misplaces a field after three or more escapes right before it).
  - texlab 5.26 sends files and folders as kind 1 (never 17): file-argument rules
    key on the argument context. At `\frac{\|}{}` it reads the control symbol `\}`
    and its range covers the `}`; built-ins never take a texlab range that reaches
    past the word.
- Build output goes to `$TMPDIR/obsidian-latex-live/<hash of root>/`, never
  into the vault.
- Desktop only (`isDesktopOnly: true`).
- Never commit build artifacts (`main.js`, sourcemaps) or `node_modules`.
- Verify with `npm run build`, `npm test` (integration tests need a TeX
  installation; `TEXBIN=/path/to/bin` overrides detection; the live texlab tests
  run when texlab is found, `TEXLAB_BIN` overrides), after a YOLO update
  `YOLO_MAIN=<vault>/.obsidian/plugins/yolo/main.js npm run test:yolo` (reads
  only main.js, never data.json), and a smoke test
  in a real vault via `scripts/install-dev.sh <vault> [more vaults]`: open a `.tex` file,
  open the preview, edit, introduce an error, double-click the PDF, run
  "Show cursor position in preview", and try completion (`\fr` Tab,
  `\begin{ali` Enter, `\ref{`) and a hover on `\alpha`. Obsidian ignores background clicks from
  computer-use tools; UI checks need full-screen control.
- Design notes, measurements, and the roadmap are in
  [docs/design.md](docs/design.md); update its checkboxes when an item lands.
