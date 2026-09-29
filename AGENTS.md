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
  the decoration tokenizer in `src/editor/latexHighlight.ts`. The dev pins of
  `@codemirror/*` (`overrides` and devDependencies) are the versions the
  `minAppVersion` Obsidian ships (1.13.7: view 6.43.8, state 6.7.0), so tests run
  on the runtime's CodeMirror; raise them only together with `minAppVersion`.
- The PDF preview uses Obsidian's bundled pdf.js (`loadPdfJs`, 5.x in
  Obsidian 1.13). pdf.js takes ownership of the data buffer: always pass a
  copy (`slice()`). Every `getDocument` passes `PDFJS_ASSETS` (the cMap,
  standard font, wasm and ICC folders Obsidian's own viewer uses, under
  `/lib/pdfjs/`); without the CMaps the Chinese glyphs of XeLaTeX PDFs vanish.
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
  - Every TeX run goes through `Compiler.exec` (a new kind of spawn uses
    `watchStall` from `src/tex/watchdog.ts` the same way): no log or output
    growth and under 2 % CPU of the process group for 30 s kills the group and
    adds `stallMessage` as an error. XeLaTeX on macOS blocks forever in a
    CoreText font download (ctex's default fontset) otherwise.
  - latexmk takes biber from PATH, bin dir first; full builds pass
    `-e $biber=...` when that biber does not run (`workingBiber`; MacTeX
    2026's universal biber only prints lipo's usage on this Mac).
  - Recompile dependencies are the `.fls` inputs plus what it never lists: the
    files only the preamble format read and the `.bib` files (`.bcf`, `.aux`).
    A changed `.bib` requests a full build.
  - `detectEngine` picks XeLaTeX for classes that load ctex themselves (the
    ctex classes, elegantbook/elegantnote/elegantpaper in Chinese: `lang=cn` or
    `cn`, elegantnote's default); pdfLaTeX fails on them without a PDF.
    elegantbook's `chinese` is only a heading scheme and loads no ctex.
  - `findRoot`: the magic comment, the file's own `\documentclass`, else a
    `\documentclass` file in its folder or an ancestor that inputs it, directly
    first, then through other inputs (main -> appendix -> notation). Preview,
    SyncTeX, texlab's build folder, completion and the render hover all use it.
- Spawned TeX processes run in their own process group and must be killed on
  session dispose (preview closed or switched, plugin unload). No orphans.
- Editor keys: `keyArbiter` (from `src/editor/shared/`) is mounted FIRST in
  `texEditorExtensions` and owns Tab, Shift-Tab, Enter, Escape, ArrowUp and
  ArrowDown (completion popup > YOLO ghost text > snippet field > indent; Enter
  accepts only when that changes the text, never from a list a trigger character
  opened before anything was typed or the selection moved (`\ref{` + Enter is a
  newline, and so is `\re` + Tab + Enter: accepting `\ref` reopens the argument's list
  through autocompletion's `activateOnCompletion`, as if `{` was typed, never with the
  explicit `startCompletion`; texlab's preselected name after `\end{` still counts), and
  never accepts AI text). Never bind
  these keys anywhere else; LaTeX Enter behaviour goes into the arbiter's `enter`
  hooks (`src/editor/latexEnter.ts`, which also holds `latexIndent`, the
  indentService for new lines). In a snippet field a Tab typed while completions load
  waits only under a popup already shown or after a command name (the arbiter's
  `completesWord` is `typingCommand`: `\frac{\alp|}{}` + a fast Tab completes). A
  hook that must wait for the completion popup (`\begin{ali|}` + a fast Enter)
  swallows the key and pumps like Tab-ahead instead of binding anything. The arbiter
  never intercepts Backspace; the view keymap binds editorKit's `deleteMathPair`
  (empty `\(|\)` / `\[|\]`) just before `closeBracketsKeymap`. Obsidian
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
- Render hover (`renderHover`, `src/editor/shared/renderHover.ts`; its test
  `tests/renderHover.test.ts` is identical in both repositories) is `Prec.high`, so
  its section stays above texlab's and lint's wherever the view mounts it. An async
  `render` gets a spinner 400 ms after the pointer rests; CodeMirror restarts a pending
  hover on every view update, and those restarts reuse the pending render. A settled
  render is never reused by a later hover: caches (MathJax nodes, crops, fragment PDFs)
  belong to the renderer and key on its epoch. Failures render as `hoverError`;
  positions a live widget renders are skipped through `replacedAt`. The section anchors
  at the start of the pointer's line within the target (`end` is the target's end), never
  at the target's start: CodeMirror hides a tooltip whose anchor is scrolled out and places
  the merged hover at its lowest section anchor, so a long `align` scrolled past its first
  line would show nothing (`tests/renderHover.test.ts` checks the anchor). A render still
  pending when the pointer leaves the editor shows nothing.
- Formulas render through `ProjectMath` (`src/editor/mathjaxProject.ts`): a private MathJax
  TeX input and document built from Obsidian's own bundle (`MathJax._`), with Obsidian's
  `MathJax.config.options` and its CHTML output; `noerrors`/`noundefined` stay off, so
  failures throw `MathError`. Never feed definitions to the global MathJax (`tex2chtml`:
  they stay defined in every Markdown note; the fallback refuses a formula that defines
  something) and never call `MathJax.texReset()` on Obsidian's instance; without `MathJax._`
  the public `tex2chtml` renders without project macros. Definitions reach it only as
  `Definitions.statements` (`definitionStatements`: normalized, in document order across
  `\input` files, local packages and unsaved buffers, definer aliases such as `\nc` followed
  into the files read later), one statement per convert, and as `Definitions.unsupported`
  (macros whose last definition MathJax cannot read: xparse specs beyond one `o`/`O{}` and
  `m`s, bodies with `@` internals), which fail with a message instead of drawing MathJax's
  own macro of that name (braket's `\set`). Memory rules, measured on MathJax 3.2.2:
  - every `new TeX(...)` would be kept forever by the global `TagsFactory` (tagformat and
    mathtools register a per-input tags class closing over it); `buildTex` re-points those
    names at the no-tags class after construction. Still build an instance only when the
    definitions change: labels are a render argument (`render(src, display, labels)`), and a
    compile re-reads only them (`TexRender.compiled`);
  - textmacros keeps every text-mode parse (`\text`, `\mbox`, a `\tag`'s number) in parse
    options of its own that MathJax never clears; `render` clears them after each convert
    (else about 17 KB of MathML per render);
  - a render leaves no definition behind (`\def\x{..}` inside a formula): the definition
    tables are restored after each convert.
  `prepareMath`: `\label` -> `\tag{n}` only in unstarred numbered environments, one per
  outer row at the row's end (never inside `split`/`aligned`/`gathered`, which reject
  `\tag`); other labels are dropped; `\ref`/`\eqref` -> `\textup{..}` (`\text` fails inside
  text-mode arguments). `texRender.ts` keeps one instance per root with its labels and a
  render cache (clones; dropped when the instance or the labels change), and gets
  `loadMathJax`/`finishRenderMath` from `main.ts` (no runtime `obsidian` import, so tests run
  it). After a new render it calls `chtmlStylesheet()` at once (only that call adds new glyph
  rules; Obsidian's `finishRenderMath` waits 100 ms) and puts the sheet into the main head if
  Obsidian has not; popout windows get a copy from its `cssRules` (MathJax adds glyph rules
  with `insertRule`, which a cloned element misses).
- `texHover` (the `hover` option of `texEditorExtensions`) mounts the render hover and
  texlab's hover together: texlab's returns nothing inside a formula while `hoverRender`
  is on. Formulas come from `latexScan.ts` (memoized per `Text`, body only, bounded by
  paragraphs; inline math steps over text arguments: `$f = \text{当 $x$ 时} 1$` is one formula).
- Tests load Obsidian's MathJax with `tests/support/mathjax.ts`: the devDependency
  `mathjax@3.2.2` (`es5/tex-chtml-full.js` + `es5/ui/safe.js` is byte for byte Obsidian's
  `lib/mathjax/tex-chtml-full.js`) with the config from app.js. It is never bundled.
  `tests/fixtures/elegantbook/` is a small synthetic elegantbook project (XeLaTeX with
  fandol, `\input`, `\include`, a local package, biblatex); keep it synthetic and compiling.
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
  - Compile diagnostics reach the editor only through `showTexDiagnostics`
    (`texExtensions.ts`, the full set every time; `diagnostics: true` mounts the lint
    gutter with editorKit's `typingDiagnostics`): a new error on the line being typed
    waits for a 1.5 s pause or for the cursor to leave the line. Never dispatch
    `setDiagnostics` on the editor. The preview's status and problem list are unaffected.
  - texlab has no argument snippets, no `\end` insertion, no math awareness and a
    50-item cap; `src/editor/latexCompletion.ts` adds those on top. Snippets from
    that layer are applied with CodeMirror's `snippet()` directly from their
    `#1 ... #0` templates (the shared `lspSnippetToCm` now escapes only `{` after
    `#`/`$`/`\` and `}` after `\`, but @codemirror/autocomplete 6.20.3 still
    misplaces a field after three or more escapes right before it).
  - texlab 5.26 sends files and folders as kind 1 (never 17): file-argument rules
    key on the argument context (a file has its extension, except after `\include`,
    where `TexView.isFolder` asks the file system from the root document's folder).
    At `\frac{\|}{}` it reads the control symbol `\}`
    and its range covers the `}` (`$\|$`: `\$` and the closing `$`); built-ins never
    take a texlab range that reaches past the word, after a bare `\` in front of a `}`
    or of a `$` closing math every item's range stops at the cursor (a `$` opening math
    keeps texlab's range), and a bare-`\` list counts as incomplete (the next letter
    asks again).
  - Accepting a single value (`\ref`-family labels, `\begin`/`\end` names, files of
    `\input`/`\include`/`\subfile`/`\includegraphics`/`\addbibresource`, `\documentclass`,
    `\bibliographystyle`, colors) leaves the braces (`SINGLE_VALUE`, `leaveArgument`): a
    second transaction after the accept steps over the `}`, adds one when nothing closes the
    group on the line, or moves to a snippet field right there (`\ref{#1}#0`,
    `\textcolor{#1}{#2}`). Lists (`\cite`, `\usepackage`, `\bibliography`) and folders keep
    the cursor inside.
  - A complete list is reused only while the query extends the one it was asked for
    (shared `lspCompletion`); backspacing into it asks texlab again, explicit lists too.
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
  `\begin{ali` Enter, `\ref{`), a hover on a formula that uses a project macro (rendered)
  and a hover on a `\ref` (texlab). Obsidian ignores background clicks from
  computer-use tools; UI checks need full-screen control.
- Design notes, measurements, and the roadmap are in
  [docs/design.md](docs/design.md); update its checkboxes when an item lands.
