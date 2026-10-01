# obsidian-latex-live agent guidance

- Editor and gutter surfaces are transparent so vault/theme background-image snippets can
  paint behind them; keep text, selection, tooltip and control opacity independent. Background
  artwork and personal appearance settings belong to the vault's configuration, not this plugin.
  The preview's build controls and diagnostics live in `.ll-preview-dock`, in normal layout
  flow above the independently scrolling PDF viewport. Diagnostics start collapsed, never
  auto-open on errors, retain an explicit choice across builds, and reset on root changes or
  cleared diagnostics. Long lists scroll within the dock without covering the PDF.

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
    temp file name and pdfTeX exits before writing a log. A ready format has a
    stamp `<job>-preamble.json` (its key and the project files its preamble read,
    with mtimes), deleted before a rebuild and when the format proves broken;
    other runs (fragment compiles) take a format only through `readyPreambleFormat`.
  - Delete the job log before each run so a run that dies early never
    reports the previous log as success.
    A full latexmk no-op may reuse the existing PDF only when this invocation exits 0,
    has no new log, is neither stalled nor timed out, and explicitly confirms both this
    root's "Nothing to do" and its complete up-to-date PDF target list (XeLaTeX may also
    list XDV). Match logical/physical or root-relative paths exactly, including spaces;
    neither recent PDF mtime nor an old log proves success. The PDF must be readable.
    `pdfReused` distinguishes this result from a new compile; preview says "Up to date".
    Keep the real and fake regressions in `tests/fullBuildNoop.test.ts`.
  - TeX reports physical paths (`/private/var/...` on macOS); map them back
    with `logicalMapper` before comparing with vault paths.
  - Spawn TeX with `max_print_line=10000` and `-file-line-error`; the log
    parser depends on both.
  - Every TeX run goes through `runTex` (`src/tex/run.ts`: its own process
    group, the stall watchdog, a timeout, an `AbortSignal` that kills the group;
    `Compiler.exec`, the export's probe and its dvisvgm run use it, `fragment.ts` still spawns with
    the same rules): no log or output growth and under 2 % CPU of the process
    group for 30 s kills the group and adds `stallMessage` as an error. XeLaTeX
    on macOS blocks forever in a CoreText font download (ctex's default fontset)
    otherwise.
  - latexmk takes biber from PATH, bin dir first; full builds pass
    `-e $biber=...` when that biber does not run (`workingBiber`; MacTeX
    2026's universal biber only prints lipo's usage on this Mac).
    The public `after_xlatex_analysis` hook removes only the exact physical
    build-dir/job `.run.xml` dependency confirmed as a recorder OUTPUT, with
    logreq's header and exclusively biblatex request owners. Preserve existing
    hooks and every other XML input/package; return 0 on success. Real TeX
    regressions cover XML and bibliography edits and foreign logreq owners.
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
- The shared live input plugin reconciles actual DOM focus in a coalesced microtask
  after updates, applying every `EditorView.focusChangeEffect` hook together.
  CodeMirror can drop its queued focus transaction after another update; repairing
  only the live field leaves cursor preview unfocused. Defer reconciliation during
  IME composition. Keep the focus/blur race regressions in both repositories.
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
  pending when the pointer leaves the editor shows nothing. `cursorPreview` (same module, T-S13 in
  the same test; setting-gated) is a `showTooltip` field: while the focused editor's main cursor
  is in a target, its rendering floats below the target's last row (the tooltip view's `getCoords`:
  a rect from the top of the target's first row to the bottom of its last, its left edge at the
  anchor, so a formula that soft-wraps never covers the row being typed, and a preview CodeMirror
  flips above for want of room below clears the whole target; smoke B8). It renders again after every
  edit in the same tooltip view (kept while the target's start maps onto itself), so typing never
  rebuilds or blanks it: a pending render keeps the last one, an older render never lands over a
  newer one, and a `hoverError` after a rendering keeps that rendering marked `is-error`. It hides
  while the completion list is open (`is-covered`; both sit below the line), takes no clicks
  (`pointer-events: none`) and binds no keys; it goes when the cursor leaves the target or the
  editor blurs (a state set on a focused editor picks the focus up in a microtask).
- Live preview (`src/editor/shared/livePreview.ts`; its test `tests/livePreview.test.ts`
  is identical in both repositories): one StateField holds every decoration (block widgets
  and replaced line breaks throw from a ViewPlugin). `liveInput()` is mounted always and
  OUTSIDE `livePreviewCompartment` (a field added by a reconfiguration never sees that
  transaction's effects); `livePreview({ language, renderer })` goes inside it, so a mode
  toggle is one reconfigure, and `HistoryCache.restore` gets the compartment content for
  the view's mode. It binds no keys: keyArbiter stays first and the only owner of Tab,
  Shift-Tab, Enter, Escape and the arrows; vertical motion into block widgets goes only
  through the `enterBlocks` transaction filter, and the golden key matrix passes unchanged
  with live preview on. The filter corrects only line moves: userEvent exactly "select", a
  goal column on the range (cursorLineUp/Down, their Shift forms, PageUp/Down) and as many
  ranges as before, so Select All, Mod-Home/End, Cmd-ArrowUp/Down, snippet fields and
  Escape's simplifySelection are never redirected; a line move into a block at the
  document's end or start stops on its first or last line. A line move that lands one line past
  the line after a block stops on the block too when that line is outside the viewport the view
  last drew (CodeMirror places undrawn lines by their characters: a short or blank line there gets
  almost no height); transaction filters see no view, so `drawnViewport` records each view's
  viewport by its state (T-S7, smoke B7). jsdom's vertical motion returns
  no goal column: tests that press arrows into blocks patch
  `EditorView.prototype.moveVertically` to add one (`tests/livePreview.test.ts`,
  `tests/latexLive.test.ts`). A construct shows its source while the editor has focus, or
  its search panel is open (findNext and replace keep the focus in the panel; the current
  match must show), and a selection touches it (inclusively), so completion popups,
  snippet fields and YOLO ghost text always sit in visible source. A language's `decorate`
  keeps a construct's decorations within its own lines (a selection move re-decorates only
  the constructs on the lines it left or entered; the test compares that with a full
  build). A construct that tests the selection on fewer lines says so with the optional
  `reveals` (theorem boxes: their `\begin` and `\end` lines), so a move inside a long one
  re-decorates only the constructs on the lines moved over, not the box and its whole body
  (T-S5). `decorate` draws rendered constructs through `renderConstruct`. A construct with an
  error diagnostic in it (overlapping it, or empty and inside or at its edge; one that
  only ends where it starts does not count) stays source; a revealed block keeps its rendering
  below it (the last one, `is-error` when the new source fails, no dotted mark: the lint
  underline shows). Diagnostics still reach the editor only through `showTexDiagnostics`, the
  field rebuilds on lint's `setDiagnosticsEffect`, and the live layer never dispatches
  `setDiagnostics`. While the
  mouse is down and during `input.type.compose` the decorations are only mapped
  (`compositionend` refreshes); renders that land are shown through `refreshLive` carrying
  their keys, which re-decorates only the constructs waiting for them
  (`refreshLive.of(null)` rebuilds everything), never mid-composition, and the scheduler
  never waits on visible renders that are cached but held by the mouse or a composition
  (it would spin through microtasks and starve the mouseup). The view draws the
  replacements within one line only near the viewport (4,000 characters on each side, and
  the main selection's lines), through a function in `EditorView.decorations`: CodeMirror
  compares every replaced range of a set on each update. Block replacements and
  replacements over line breaks stay in the field's static sets; atomic ranges,
  `replacedAt` and `enterBlocks` read the whole sets, and tests comparing decorations
  include the function's output. A scanner that throws leaves that text as source (logged
  once). A `FragmentRenderer` keys its results on its `epoch` and calls `subscribe`'s
  listener when that changes; a construct still rendering stays source (no placeholders). A new
  epoch empties the cache but keeps its successful renders by request identity (the key without
  its `${epoch}|` prefix, so only keys built with `ctx.request`): while a construct's render for
  the new epoch is pending, `ctx.result` answers with the earlier rendering (display-only: the
  render stays queued, it is never a hit, `ctx.peek` never returns it), so a definitions change
  never flashes the document back to source; the new result replaces it, a failure shows the
  source and its error mark, and a construct whose own text changed has no earlier rendering.
  Those renderings count against the cache bound and are evicted first when no build shows them
  (`renderStats().cached`). An epoch-free request (`ctx.request(.., epochFree)`: what the epoch
  cannot change, images and crops) has `*` in place of the epoch and stays cached across epochs.
  Asynchronous renders run one at a time per renderer, by kind: while one is in flight, requests
  of a kind that has answered with a promise wait, other kinds (and kinds not seen yet) keep
  rendering, so a formula never waits for a PDF page or crop being drawn. `isLive` says the
  compartment holds live preview, `liveActive` that it decorates (the document is within maxLines).
  A pending or failed `RenderWidget` keeps what its element shows only when that was its
  own construct's (the same request, or the preview below the block being edited):
  CodeMirror hands any dropped widget's DOM to `updateDOM`, with the old widget. Block
  widgets, the preview below a revealed block and BlockWrapper boxes get no vertical
  margins (CodeMirror's height map and vertical motion miss them); their late size changes
  are remeasured through a line attribute. The render hover never shows over a live widget
  (`renderHover` checks `replacedAt` itself). SyncTeX, cursor-follow and "Show cursor
  position in preview" work on source positions and are unchanged. Search: other matches
  inside rendered widgets stay hidden (accepted). External changes (`setDocText`) are
  ordinary edits that rebuild the field; each pane has its own mode. After changing
  `livePreview.ts` or its styles, also run `node scripts/browser-smoke.mjs` (headless
  Chrome, skipped without it: B1 arrows through blocks, including blocks at the document's
  edges, and the jumps that must not be redirected; B2 IME; B3 drag; B4 gutter drift; B5
  performance on `scripts/gen-perf-fixture.mjs`'s 5,700-line chapter, typing in a revealed
  block until its preview re-rendered, cursor moves inside a 190-line theorem box, and the page
  staying responsive with the mouse held during the prefetch; B6 arrows through theorem boxes one
  line at a time, gutter aligned; B7 ArrowDown at the pane's bottom edge, the drawn viewport
  ending at a block; B8 the cursor preview below a soft-wrapped formula, and above a display near
  the window's bottom). Both scripts are identical in the two repositories.
- LaTeX's live preview (`src/editor/latexLive.ts`, pure; `tests/latexLive.test.ts` runs it on
  the real stack with Obsidian's MathJax): formulas (`$..$`, `\(..\)`, `\[..\]`, `$$..$$`, the math
  environments), since P3 the text constructs of design 4.4 #5-#11, since P4 theorem boxes (#12),
  figure/table lines (#8) and images (#13), since P5 PDF crops (#14: TikZ pictures and tables; #4:
  a block formula MathJax rejects); unknown environments stay source. A display
  formula owning its lines (latexScan's `block`; inline math never is one) becomes a block
  widget, one in running text an inline display widget; a formula MathJax rejects shows its crop
  when it owns its lines and has one, else keeps its source with the `lsp-lp-error` underline.
  Requests carry the formula already prepared (`prepareMath` with the root's refs: `\label` ->
  `\tag{n}`, references -> the chips' text), so the renderer's epoch is the definitions' hash
  alone and a renumbering compile re-renders only the formulas whose text changed; `TexRender`
  calls its renderer's subscribers on a new instance and on new refs. Text constructs:
  - a heading (`\part`..`\subparagraph`, at the start of its line, the title closed there) keeps
    its line class `lsp-lp-h1`..`h6`; its command, `[short]` and closing brace are hidden until the
    cursor touches either end. `\textbf`/`\textit`/`\emph`/`\underline`/`\texttt`/`\textsc` with a
    one-line argument: a mark on the content, the markup hidden until the construct is touched.
  - `\item` shows the marker LaTeX typesets (latexScan computes it: bullets by itemize depth,
    numbers by enumerate depth (elegantbook's `problemset` is an enumerate: its `[title]` is no
    list option, and `resume` after it starts over, its enumerate having ended in its group), the
    enumerate package's short form, enumitem `label=`/`start=`,
    `resume`/`resume*`/`series=`/`resume=` (enumitem's rules: `resume` sees the last list of that
    environment ended in the same list or around it, a `resume*` list saves the counter only) and
    `\setcounter`/`\addtocounter`/`\stepcounter{enumi..iv}` inside the list, `\item[x]` without a
    counter step, description terms bold; checked against pdfLaTeX); only touching the token
    reveals it, so typing after it keeps the marker. An `\item[..]` label with math or a
    reference (`\item[$\sigma$-algebra]`) is no widget: `\item[` and `]` hide, the label stays in
    place (bold for a term) and its constructs render; touching `\item[` or `]` reveals both. The
    `\begin`/`\end` lines of lists, `center`, `figure(*)` and `table(*)` alone on their lines
    collapse (a block replace without a widget) until the cursor is on the line; arrows reach them
    through `enterBlocks` like any block.
  - theorem boxes: latexScan emits every other environment whose `\begin` (with the arguments and
    a `\label` on its line) and `\end` are alone on their lines, within 200 lines, as an `env`
    construct (held at its `\begin` so constructs stay in document order; nested ones pair by
    name); latexLive draws those in the project's theorem map (`src/tex/theorems.ts`, pure, checked
    against the installed elegantbook.cls by `tests/theorems.test.ts`: amsthm's proof,
    `\newtheorem`/`\newtheorem*`, elegantbook's boxes and heads by `lang`/`mode`/`color`,
    `\elegantnewtheorem`) as a BlockWrapper (`lsp-lp-box is-<role>`, elegantbook's scheme colour
    inline as `--lp-box-color`; never a vertical margin or padding; in a dark theme the head's text
    is that colour lightened to oklch L >= 0.72, so `color=black` stays readable, while the border and
    background keep it). The `\begin` line shows the
    head the PDF prints (`定理 1.1 (title)`, `Theorem 2 (title).`, `例题 1.1 title`, `Proof.`), its
    number from the .aux label of the box (elegantbook's `{title}{label}` is `prefix:label`, else a
    `\label` after the arguments or first on the next line); a title with math or a reference stays
    in place between the head's chips; arguments the environment does not take stay as text
    (`\begin{proof}[x]` under elegantbook, whose proof takes none: the PDF prints `证明 [x]`). A box
    without a label is numbered by counting (`boxNumber`, also the hover fragment's `\the<counter>`)
    only in an `\include`d file (`LatexLiveEnv.file`, project's `includeName`) whose .aux checkpoint
    (`readAuxCheckpoints`: `\@setckpt` counters, the chapter from its hyperref anchor, `A` in an
    appendix) confirms it: one `\chapter`, the boxes on the def's `counter` (theorems.ts: a
    chapter-reset counter printing `\thechapter.\arabic`) all after it, as many as the checkpoint
    counted, the labelled ones at their .aux numbers; otherwise no number (`\input`, single files,
    thmcnt=section, unsaved extra boxes). The `\end` line collapses (amsthm's proof: `□` at the right,
    `ll-qed-line` in styles.css outside the shared block). Each of the two lines reveals on its own;
    the body is plain text, so typing keeps the box. Every `env` but a crop declares the live core's
    `reveals` (its `\begin` and `\end` lines: the memoized scan cannot see which ones the theorem map
    boxes), so a cursor move inside a long environment re-decorates only the constructs on the lines
    moved over (on a 3,192-line chapter with a 190-line box, 0.3-0.4 ms and 6 decorate calls instead
    of a full rebuild).
  - images: `\includegraphics` alone on its line is an `image` construct; `LatexLiveEnv.image`
    (TexRender's `imageOf`) resolves it (`src/tex/graphics.ts`: root folder, the last
    `\graphicspath`, graphicx's extensions) to an epoch-free request `mtime|path` (a definitions
    change never draws it again) the renderer draws as an
    `<img>` of Obsidian's resource URL, or of a PDF's first page (`pdfPageImage`, pdf.js with
    `PDFJS_ASSETS`, async); not found, eps or a bitmap outside the vault keep the source with a
    titled `lsp-lp-error` mark, but a path with a macro or a bare name found nowhere in the project
    (TeX may find it in its tree: mwe's `example-image-a`) keeps it unmarked (`image` returns null).
    A name whose extension is none of graphicx's (`loss_lr0.01`) gets the extensions appended.
  - crops (P5): latexScan reports a TikZ picture (tikzpicture, tikzcd, pgfpicture, circuitikz; its
    inside still skipped) whose `\begin` and `\end` are alone on their lines as an `env`, like tables;
    `CROP_ENVS` and a block formula whose MathJax render failed get `LatexLiveEnv.crop` (TexRender's
    `cropOf`: the crop service's `locate`) and render (epoch-free requests) as a `crop` block
    widget through `renderConstruct(.., { below: false })`: its source while the cursor is on its
    lines, no preview below. While a new result's crop is pending, the block shows the crop its
    `previous` request drew (the key changes with every result, so the core's stale-while-revalidate
    cannot match it); changed, without a preview or failing (quietly) it is source (#4: MathJax's
    error).
    `cropKindOf` decides how a block crops and refuses anything inside a tcolorbox (elegantbook's
    fancy theorems): pgf moves a box's content, and SyncTeX places it ~20 pt off.
  - `\ref`-family, `\cite`-family (`CITE_COMMANDS` in latexHighlight: natbib's and biblatex's,
    capitalized ones too) and `\label` (outside math) are `TextWidget` chips; their texts come
    from `src/editor/latexRefs.ts` (pure; also prepareMath's `refs`, so a `\cref` inside a formula
    and in the hover reads like its chip) and are what the PDF prints (`tests/latexRefs.test.ts`
    compares them with pdfLaTeX's output): numbers (texText of the .aux field: elegantbook's
    `{\color {structurecolor}1.}` is `1.`), pages and titles; `\autoref` names the hyperref
    anchor's type with hyperref's English `\<type>autorefname` (the number alone for a type without
    one, such as elegantbook's `tcb@cnt@theorem`); `\cref`/`\Cref` group, sort, range and name by
    the cleveref type of the .aux twin (`refNames`: cleveref's defaults with its `capitalise` and
    `noabbrev` options, \newtheorem titles, `\crefname`/`\Crefname`). Chinese documents get these
    English names too (ctex and elegantbook define none; a project's own `\<type>autorefname` or
    `\crefname` wins). `??`/unknown keys and a type cleveref cannot name (`??1`) get `is-missing`;
    cite labels `[pre Li et al. 2019, post]` from `src/tex/bib.ts`.
  - Definitions (`\newcommand`, `\def`, `\newenvironment`, ...) are code: the scanner skips them to
    their first line break outside braces, so macro files (no `\begin{document}`) get nothing.
    The scanner also skips verbatim-like environments (`VERBATIM_ENVS`, shared with the
    highlighter: tcblisting, fancyvrb's, filecontents), TikZ pictures (to their `\end`; a
    half-typed one hides nothing), and the text an `\iffalse` first on its line skips (to its
    `\fi` or `\else`, nested conditionals counted, `\if..{` macros and `\iff` not; the
    highlighter shows it as a comment). Files the root reads before `\begin{document}`
    (`preambleFiles`: its preamble's `\input` chains) get no constructs, like package, class and
    .bib files; a chapter with no root is still scanned whole.
  - A construct with an error diagnostic on it stays source.
  Refs (`TexRender.refsOf(root)`, no MathJax needed; `theorems` is the theorem map of the same
  sources, and refNames' autoref names fall back to its `\<env>name`s as hyperref does): `readAuxLabels` over the build folder's
  `**/*.aux` (a number field loses only its outer braces; the kind is the `k@cref` twin's type,
  with its sort key, else the anchor's counter: `tcb@cnt@` stripped, `AMS` equation, `Item`
  enumi), the entries of the .bib files the project's sources name (`bibFiles`: `\addbibresource`,
  `\bibliography`; `readBib` caches by mtime, unsaved buffers win) and the reference names
  (`refNames` of the comment-free sources, kept while equal). The labels are re-read after every
  session result (`compiled`); everything when a view opens a document of the root (`opened`: a
  compile run elsewhere), when a project or .bib file is saved (300 ms), and when an edit changes
  a .bib buffer or a bibliography, `\documentclass`, `\usepackage`, cleveref, `\crefname`,
  `\(elegant)newtheorem`, `\graphicspath` or `autorefname` line (500 ms). Image resolutions are cached
  per root: a saved image drops its entry, a vault create/delete/rename (`filesChanged`, registered
  after the layout is ready) drops them all; the views rebuild through the renderer's subscribers. A refs object changes only when something in it did (`numbers`
  keeps its identity while the numbers stay); a change drops the hover's render cache and notifies
  the renderer's subscribers. `TexRender.rendererFor(root)` is one object per root (views of a
  project share renders); its `flush` installs MathJax's stylesheet at once and copies it into
  every window with a LaTeX editor (host `documents`). `TexRender.preload(root)` (MathJax, one
  warm-up render, finishRenderMath, fonts) runs before the first live mount: until
  `texRender.ready`, a live view shows source. `TexView` keeps its mode in the view state
  (`getState`/`setState`, applied before the file loads); a new view starts in the `editingMode`
  setting (default source) and a file opened in the view keeps the view's mode. The mode switches
  through the header action (`book-open` / `code`, right of the preview's eye) and the command
  "Toggle live preview" (no default hotkey; Mod-E stays the preview pane's), then
  `requestSaveLayout`; the container gets `is-live-preview`. Documents over `LIVE_MAX_LINES` stay
  in source (the toggle refuses with a Notice); package, class and .bib files and the root's
  preamble inputs get no constructs (decided when the view mounts live). `texEditorExtensions`'
  `live` option is the compartment's content (mounted right after the highlighter, `liveInput()`
  next to it), and `TexView.stateFor` passes it for the mode, so `HistoryCache.restore` restores
  live views live. "Show render statistics" (`renderStats`) is offered only in a live editor.
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
  text-mode arguments), and with `refs` (latexRefs' `formulaRefs`) every reference command ->
  its chip's text, TeX specials escaped for MathJax's text mode (which has no text command for
  `\`, `^`, `~`: look-alikes). `texRender.ts` keeps one instance per root with a render cache
  (clones; dropped when the instance or the root's refs change), and gets
  `loadMathJax`/`finishRenderMath` from `main.ts` (no runtime `obsidian` import, so tests run
  it). After a new render it calls `chtmlStylesheet()` at once (only that call adds new glyph
  rules; Obsidian's `finishRenderMath` waits 100 ms) and puts the sheet into the main head if
  Obsidian has not; popout windows get a copy from its `cssRules` (MathJax adds glyph rules
  with `insertRule`, which a cloned element misses).
- `texHover` (the `hover` option of `texEditorExtensions`) mounts the render hover and
  texlab's hover together: texlab's returns nothing inside a formula while `hoverRender`
  is on, and nothing over a live widget. Its `cursor` option mounts `texCursorPreview` (setting
  `cursorPreview`, default off): inline math in both modes, display math in source mode (a live
  block has its own rendering below it, also under an error diagnostic; a live view that does not
  decorate, past maxLines, gets the preview: `liveActive`), rendered by `TexRender.preview`
  (MathJax alone: it runs at every keystroke, never crops or fragment compiles). Formulas come
  from `latexScan.ts` (`formulas`/`mathAt`; memoized per `Text`, body only, bounded by paragraphs;
  inline math steps over text arguments: `$f = \text{当 $x$ 时} 1$` is one formula; definitions
  are skipped).
- Tests load Obsidian's MathJax with `tests/support/mathjax.ts`: the devDependency
  `mathjax@3.2.2` (`es5/tex-chtml-full.js` + `es5/ui/safe.js` is byte for byte Obsidian's
  `lib/mathjax/tex-chtml-full.js`) with the config from app.js. It is never bundled.
  `tests/fixtures/elegantbook/` is a small synthetic elegantbook project (XeLaTeX with
  fandol, `\input`, `\include`, a local package, biblatex); keep it synthetic and compiling.
  `tests/fixtures/aux/` holds static .aux excerpts of it and of a synthetic cleveref article
  (T-L6), and `cleveref/` the .aux of its synthetic `probe.tex` (the texts
  `tests/latexRefs.test.ts` expects are what pdfLaTeX printed for it); regenerate them from a
  compile of synthetic sources only.
  Views mount in tests on `tests/support/obsidian.ts` (`tests/texView.test.ts`), the
  stand-in `scripts/run-tests.mjs` aliases `obsidian` to; extend it with the documented
  behaviour a test needs, never with Obsidian's own code.
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
- PDF crops (`src/preview/blockCrop.ts`, `CropService`, one per plugin; free of the obsidian
  module, main.ts passes `openPdf` and `sessionFor`; `tests/crop.test.ts` runs its SyncTeX part on
  a real XeLaTeX compile, T-L10..T-L12). A session reads the open editors' project files from disk
  at each compile start and hangs them on the result that writes a PDF (`session.compiled`, `seq`
  unique across sessions): a block crops only while its text is in that snapshot, the occurrence
  nearest to its current line giving the compiled lines (a text search: line numbers after an
  insertion point at the neighbouring block). `forwardSearchAll` returns every record of a line;
  `queryLines`/`cropRegion` hold the geometry measured on the synthetic books (docs/design.md, P5):
  never the `\begin` line as the block's own (a formula's opening line is asked as a line before:
  a paragraph's last line is tagged with the line that ended the paragraph); records borrowed from
  the neighbouring lines dropped; a tcolorbox is its `\end` line's record; a picture or table takes
  the enclosing box its `\end` line reports, never a paragraph line; running text and tcolorboxes
  drop what lies above the line before them (a page shipped out while the block was read tags its
  boxes with the block's lines; a box broken over pages reports that page whole); formulas span the
  text width; every block stops at the lines around it; the drawing is trimmed to its ink. Rules:
  at most 4 `synctex view` at once, 2 s each, killed on dispose; a query that times out, is killed
  or cannot start fails its region (never taken for "no records"; `synctex view` exits 0 then), and
  the next render asks again; the last result's queries also run while the next compile runs
  (TeX writes `<job>.synctex(busy)` and replaces the `.synctex.gz` when a pass ends; the hover waits
  only before a session's first result), and a `.synctex.gz` whose mtime is not the one taken when
  the result landed (`CompiledPdf.synctex`) fails the query quietly; `compiledLines` is memoized per
  file, current line and text (duplicate blocks each get their own occurrence); regions and
  drawings cached per result, drawn crops render synchronously; one pdf.js
  document per result (a copy of the bytes, `PDFJS_ASSETS`: without the cMaps the Chinese glyphs
  vanish), destroyed with the next result or the session; drawings are PNG blob URLs revoked one
  result later (never data URLs: live preview keeps up to 2000 renders). Cards are
  `lsp-lp-paper ll-crop`, `is-inverted` when "Invert preview colors" applies (part of the request;
  `refreshPreviews` rebuilds). main.ts tells TexRender (`cropsChanged`) when a compile ends, a
  preview closes (`crops.release`) or the theme changes. The render hover (TexRender's
  `hoverTarget`/`hover`): a formula, else the innermost block that crops; a block formula shows its
  fresh crop, else MathJax (a first compile running is not waited for); a block its fresh crop
  (waiting for the session's first compile) or the note "Changed since the last compile."; no
  preview: no section. P6 puts a fragment compile between them (next bullet).
- Fragment compiles (design 4.7; `src/tex/fragment.ts`, pure, T-L13/T-L14 in `tests/fragment.test.ts`
  against real TeX; `src/preview/fragments.ts`'s `FragmentService` draws them with pdf.js): the
  render hover's last resort, only when MathJax failed (not on an unbalanced brace, which TeX
  rejects too) and no fresh crop exists, setting `texFragmentFallback` (default on); when TeX fails
  too, a formula shows MathJax's message and a block TeX's. Never for live preview or the cursor
  preview. A job is one `.tex` in `<build folder>/snippets` run from the root's folder: pdfLaTeX from
  the ready preamble format (a placeholder `\documentclass` line, `\endofdump`, the root's lines after
  its own `\endofdump`), else the root's whole preamble; then `preview` (`active,tightpage,auctex`,
  which also sets `\nofiles`), the `.aux` labels the fragments name as `\global\@namedef{r@k}` (raw
  values, `readAuxDefinitions`), and after `\begin{document}` the body's definitions
  (`fragmentContext`, allowed to redefine) and one preview environment per fragment; a fragment that is
  not inline ends with `\par\hbox{}` (preview's box after a display loses the last line's depth).
  Boxes come from `Preview: Snippet n ended.(h+dxw)`; errors in a fragment's lines are its own. Runs
  have their own process group, killed on abort, on the 10 s (pdfLaTeX) / 20 s timeout, by the 8 s
  stall watchdog, when the root's session is released and on unload; `FragmentQueue` (one per root)
  runs one and keeps the newest waiting; `FragmentService.render` takes the root's queue before its
  first await (a release or unload meanwhile disposes it, and a disposed queue starts no TeX) and
  starts nothing after `dispose`. Results are cached by content hash (the source, a stamp of the files
  the preamble reads, and `bodyStamp`: the files the fragment itself `\input`s and its images) as
  `frag-<hash>.pdf`/`.json`; every other file of a run goes, also when it is aborted or TeX cannot
  start, and `readAuxLabels` never reads a `frag-<hash>.aux`. `fragmentBody` (texRender) writes a
  target as the PDF numbers it: numbered displays starred with `\tag{n}` from the .aux, a theorem box's
  `\the<counter>` from its head's number (`boxNumber`), a float's from its label's .aux entry, a float
  as a minipage with `\@captype`.
  Cards are `lsp-lp-paper ll-fragment` (`is-inverted` as crops), drawn as PNG data URLs.
- HTML export (`src/export/`, docs/design.md "HTML 导出"): every module is free of the
  `obsidian` module except `command.ts` (the command and the .tex files' context menu entry, the
  save dialog through Electron's `remote` and Open/Reveal through its `shell`, both behind the
  `ExportIo` wrapper tests replace, the progress and completion Notices, `ExportReportModal`, the
  `exportFolder` setting and the root's last target in the session, the build through the root's
  session), so the whole pipeline runs under Node tests against real TeX
  (`tests/support/exportHost.ts`); `tests/exportCommand.test.ts` runs the command on the Obsidian
  stand-in. Conventions measurements established:
  - Paper template coverage and receipts live in `docs/template-compatibility.md`
    and `tests/fixtures/paper-templates/`. Test semantic content independently
    of warning counts: titles, every author/affiliation, abstracts and keywords
    can be silently lost. Publisher classes remain unchanged test dependencies.
    `scripts/fetch-paper-templates.mjs` verifies the external Springer files in
    ignored cache; never vendor its restricted standalone class. A generated
    current ACM class must retain its original dtx/ins source.
  - `frontmatter.ts` collects source declarations and real author relationships,
    including body declarations and AASTeX701's first-section title trigger.
    Preserve source file/visit provenance, star/short-name/ORCID meanings and
    native anonymous flags. PLOS's handwritten header stays ordinary content.
    Consume only represented title/author/abstract TOC roles through the title's
    read-ahead point; ordinary numbered sections remain untouched.
  - The parser uses `Definitions.declarations` for complete effective public
    interfaces, including readers inside atletter scopes. Its provide/order
    semantics match source execution; MathJax still receives only its original
    filtered statement stream and bounded unsupported-definition messages.
  - Citation defaults and punctuation come from TeX: natbib cite aliases, active
    cite-package delimiters/dashes/options, and the native equation-label side.
    Bibliography wrapper vocabulary is scoped to bibliography content; ACM's
    explicit article-title override wins. Native PDF comparisons cover these
    publisher behaviors, not only values inferred from earlier HTML output.
  - Code listings use the host's public `loadPrism()` tokenizer, never a bundled
    lexer or Prism HTML hooks. TeX's listings `Init` hook records the effective
    language/dialect and unexpanded keyword/comment/string styles after options
    apply. `StepQueue.takeListing` consumes per probe visit, in source order,
    excluding fragment records. Inline/block/external code share the pure
    `listings.ts` renderer; it checks the token stream preserves every character,
    escapes its own HTML, and reports unavailable grammars/unsupported styles.
    The host is optional for Node consumers; without it the existing plain-code
    output remains. `PRISM_JS` lets export-smoke use the exact host script.
  - Flush the current project input graph from editor buffers, bibliographies,
    recorded dependencies and same-root views, including files outside the root
    folder. A requested build must see a subsequent full `start` before accepting
    its result: an already running full build can have read older sources.
    External outputs write to a unique adjacent temporary file and rename only
    after the write succeeds and cancellation is checked. Vault outputs retain
    the adapter's writer. PDF hosts receive the export signal; loading/rendering
    cancels without waiting for a pending page or encoding promise.
  - Native `\newenvironment` expansions preserve original-site provenance; constructs
    requiring TeX remain fragments. File visits carry import directories and subfile
    body boundaries. Assets and listings resolve by visit site and load before emit.
    Absolute in-project inputs are shadowed through exact kernel input aliases, not
    basename substitutions; instrumented source bytes outside inserts stay unchanged.
  - Each fragment drawing is identified by both static id and probe visit (`data-id`,
    `data-visit`). Fonts, CSS and DOM ids are unique per drawing. `StepQueue.drop` is
    limited to that fragment's owning visit, including its nested input steps. Never
    select a repeated drawing by page order or reuse its first occurrence.
  - Probe `today` and `title-date` values come from TeX before `maketitle` clears its
    fields. LuaLaTeX HTML export is explicitly outside the first-release scope;
    its DVI probe can return success while losing luamplib drawings. Reject it early.
  - `node scripts/regen-export-fixtures.mjs` regenerates the synthetic `.llx` and SVG
    evidence after probe/plan changes. `scripts/prepare-editor-fixture.mjs` prepares
    the GUI source fixture and its generated image assets in a fresh scratch folder.
    `scripts/gen-export-large-fixture.mjs` makes the 65-page performance project;
    export-smoke accepts its absolute folder. Keep PDFs and screenshots outside Git.
  - The work folder is `exportDirFor(outDirFor(root))` = `<build folder>-export`, a sibling of
    the build folder, never inside it (`readAuxLabels` scans the build folder three levels
    deep); labels and page numbers are always read from the build folder itself.
  - The probe pass compiles the plan's instrumented copies (`<work>/src/<key>`) with
    `\RequirePackage{llxprobe}\input{<root file>}`, cwd the work folder and
    `TEXINPUTS=.:<work>/src:<root folder>:` (+ the user's), in DVI mode. Inserts never add a line
    break (`\begin{llxfrag}{7}` right before a construct, `\end{llxfrag}` right after): a copy
    has the original's lines and its bytes outside the inserts (`tests/exportPlan.test.ts`).
    `llxprobe.sty` is a string in `probe.ts`, written on every export.
  - `.llx` records are positioned by visit (`llxin`/`llxout` from the `file/before`/`file/after`
    hooks), never by their file fields: right after a visit ends TeX still names the child file
    with the parent's line. Plan visits map to the probe's by file key and occurrence; files are
    keyed by their path from the root's folder with forward slashes and extension.
  - The parser (`texTree.ts`) follows latexHighlight's lexical rules (MATH_ENVS,
    VERBATIM_ENVS, `\iffalse`) and the signature table (`signatures.ts`); unified-latex is a
    devDependency used only by the differential test in `tests/exportTree.test.ts`, which also
    checks that `main.js` never bundles it.
  - Math goes through `ExportMath` (`math.ts`): a `ProjectMath` with a CHTML output jax of its own
    (`ProjectMath.create`'s optional `{ output, tagSide }`), never Obsidian's shared one, so the
    page's stylesheet holds only its own glyphs; `stylesheet(html)` keeps the glyph rules of the
    page's `mjx-c` class combinations, the family classes it uses and their `@font-face` rules with
    the woff files as data URIs (host `math().font`: Obsidian fetches MathJax's `fontURL`, tests read
    `node_modules/mathjax`). Parse MathJax's CSS string-aware (the `{` glyph is `content: "{"`).
    The plan's `mathOk` is answered from ExportMath's render cache, filled before planning with the
    UI yielding; the plan never renders synchronously. Display numbering follows amsmath as the
    probe measured it (math.ts's file comment: equation steps and restores for its own `\tag`,
    eqnarray's undone last step, a trailing `\\` numbers an empty row); every number the emitter
    takes goes into `report.numbers`, which `tests/exportFidelity.test.ts` compares with the probe,
    the .aux and the PDF's text (`gs -sDEVICE=txtwrite`, skipped without gs).
  - Citations: biblatex's numbers are the probe's `llxcite` records and a bibliography lists the
    entries its `llx@bib` steps name (`\AtEveryBibitem`, registered in `begindocument/before`);
    natbib's and LaTeX's labels are the .aux's `\bibcite` (natbib counts with `\advance`, never
    `\stepcounter`), natbib's mode and punctuation the probe's `enddocument` records. `joinCjk`
    never joins across a formula (MathJax markup has no text) and drops spaces next to full-width
    punctuation, as xeCJK does.
  - TeX fragments (`fragments.ts`): every probe page goes through `runDvisvgm` (`dvisvgm --page=1-
    --exact-bbox --currentcolor --font-format=woff2`, through `runTex`) and is matched to its fragment
    by the marker the probe writes on it (`<g class="llx-ref" data-id data-y>`), never by page order;
    `data-y` is the baseline (pdfLaTeX y=0, XeLaTeX -64.03 for the same box). `llxopen`/`llxclose`
    bracket each fragment in the `.llx`, and the emitter drops a fragment's steps by its id
    (`StepQueue.drop(id)`), never by lines (a caption on an inline picture's line keeps its step),
    recording those of the counters the page shows as drawn in `report.numbers`. `prepareFragment` prefixes ids,
    classes and font families per fragment (each page embeds its own font subsets and an inline
    SVG's `<style>` is global), sanitizes (an SVG element allowlist; `on*`, `javascript:` and outside
    references go; a `<` that starts no tag it read is escaped), turns black into `currentColor`,
    lightens colours under 3:1 on the dark background in a dark theme, maps Kangxi radicals in text to
    the ideographs (dvisvgm names a Fandol glyph `⾮` for `非`), and sizes in em of
    `llxinfo{fontsize}`. A fragment's sibling nodes up to its end (`\tikz`'s path) are skipped.
  - Images (`images.ts`) are read before the emit and embedded as data URIs; PDF pages come from the
    host's `pdfImages` (Obsidian: `pdfPagePngs` in `pdfRenderer.ts`, pdf.js at 2x, one document per
    file), and a host without it gets a report item, never a failed export. Tables are `tables.ts`
    (column specs, rows, booktabs/`\hline`/`\cline` rules); the plan makes tabulars with multirow or
    colortbl commands fragments.
  - The look is `profiles.ts` (elegantbook and standard profiles, from what the installed classes
    print); the emitter writes structure and classes, never literal colours or fonts. A colour is a
    page variable (`var(--llx-c-<colorId>)`: TeX's value in light mode, `darkText`/`darkFill`
    computed in TS for dark mode, >= 4.5 against the lightest dark surface `#303034`), xcolor
    expressions mixed from the probe's colours; a name without the probe comes from `fallbackName`.
    An environment the plan made a fragment whose census meaning is `\@thm` (a class's
    \newtheorem) is emitted as a theorem (not when it holds a picture); amsthm's style comes from the
    census too.
  - `exportHtml` is `prepareExport` (files and processes) then `emitExport` (the DOM only:
    `ExportImages` resolves its files in `load`, the emit touches no file system).
    `scripts/export-smoke.mjs` prepares the three fixtures in Node and emits them in headless Chrome
    with MathJax 3.2.2 as Obsidian loads it, then checks fonts, glyph widths, box frames, overflow
    against the device width, inline fragment baselines, dark contrast >= 4.5 and console errors at
    1000 px and 375 px, light and dark (skipped without Chrome or TeX; screenshots and pages in
    `$TMPDIR/latex-live-export-smoke/`). Run it after changing `profiles.ts`, `html.ts` or the
    emitter's markup. The command's math host takes MathJax's own startup document
    (`MathJax.startup.document.document`): its HTML handler accepts no other window's.
  - `tests/fixtures/export-book`, `export-article` and `export-homework` are synthetic and small
    (images under 20 KB, the one-page PDF under 30 KB); `export-static/*.llx` are probe outputs
    of the first two, planned with MathJax's checks as the exporter plans (regenerate them from an
    export of fresh copies, `<work>/main.llx`, when the probe or the plan changes);
    `export-static/fragments/` holds dvisvgm's pages of `fragments/main.tex` on both engines
    (regenerate from `<work>/frag/` when the probe's markers change). `emitDoc` in
    `tests/support/exportHost.ts` runs the emitter on a synthetic document with a handwritten `.llx`.
- Proof-reference popups stay local to the current LaTeX project. `src/tex/theoremGraph.ts`
  indexes original AST nodes and exact input visits from the source plan, including committed
  unsaved buffers. Only literal `\ref` calls in associated proof bodies create edges; native
  proof-title references select an owner, and duplicate source labels remain ambiguous.
  `src/editor/theoremGraphs.ts` owns bounded project snapshots and lazy source cards; its
  bibliography and aux data belong to that same committed snapshot. `emitSourceSlice` validates
  original node identity, visit and size before any image IO, follows original input targets,
  and excludes contained proofs from statement content. Card HTML enters the editor only
  through `safeHtmlFragment` (DOMPurify per actual window): preserve generated MathJax CHTML
  layout attributes, but never executable HTML, event handlers or external SVG glyph reuse.
  Keep its upstream Apache-2.0 license in the source and production bundle. The Node bridge
  parses generated MathML as XML, then applies its strict MathML allowlist.
  Cards reuse the project's private
  MathJax and never run a build, probe or fragment compile. Unavailable drawings stay source.
  `theoremGraphHover` is LaTeX-specific: plain source refs, math refs and live chip metadata share
  the same literal key. Normal chip clicks and drag selection remain CodeMirror's. Mouse holds,
  IME, edits, selection changes, project invalidation and destruction abort pending popups/cards;
  window release/cancel/blur listeners follow the view's actual ownerDocument after popout
  adoption and are removed on dispose. Keep every style scoped to
  `.ll-theorem-graph`; shared modules and keys are unchanged. After UI changes run
  `node scripts/theorem-graph-smoke.mjs` (real Chrome; fails if unavailable), plus the theorem
  index/content/service/UI tests. This script also verifies source/live themes, node expansion,
  source links, cycles, narrow windows and dragging over a live reference while held.
  `latexTooltipPortal` mounts CM's official `tooltips({ parent })` outside Obsidian's clipped,
  transformed panes, in the view's actual `ownerDocument.body`. Keep the scoped editor CSS
  and CM theme classes, rebind the parent after popout adoption/history restoration, and
  remove the per-view container on destroy. The browser regression uses a narrow clipped
  pane beside a PDF placeholder: `elementFromPoint` must hit the second-column node before
  actual pointer press/release expands it. DOM existence or a synthetic `.click()` is insufficient.
- The independent kgdistiller CLI bridge follows
  [docs/kgdistiller-export.md](docs/kgdistiller-export.md). Keep graph identity
  decisions in kgdistiller and reuse the existing renderer; bridge tests and
  the full suite share one bundle cache and must run sequentially.
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
  `\begin{ali` Enter, `\ref{`), a hover on a formula that uses a project macro (rendered),
  a hover on a `\ref` (texlab) and one on an `\intertext` align with the preview closed (a
  fragment compile, spinner first); then switch to live preview (header icon), check the
  equation numbers and the `\ref`/`\cite` chips after a compile, walk the arrows through a
  display block and a list, press Enter after an `\item`, and repeat the completion keys next to
  a rendered formula. Obsidian ignores background clicks from
  computer-use tools; UI checks need full-screen control.
- Design notes, measurements, and the roadmap are in
  [docs/design.md](docs/design.md); update its checkboxes when an item lands.
- Native demo recording uses `scripts/demo-capture.swift` (ScreenCaptureKit selected window,
  no microphone/audio), `scripts/demo-drive.mjs` (isolated demo vault), and the source-backed
  comparison deck via `scripts/record-comparison.mjs --prepare-only` / explicit `--record`.
  The comparison recorder owns a fresh Chrome app/profile; its receipt is marked
  `documented_comparison_deck`, separately from native product interaction. Scene times
  come from the capture's `startedAtUnixMs`; don't invent verified events or speed comparisons.
  Avoid concurrent TeX/test/build/browser work while capturing. Package supplied recordings
  with `scripts/package-demo-videos.mjs --input <receipt>` for zh/en caption rails, preserving
  native timings and raw video. Storyboard and caption libraries live in [docs/demo](docs/demo/).
  Keep raw videos, screenshots, compiled recorders, profiles and credentials outside Git.

- Public source and authored documentation use MIT. Upstream libraries, external programs,
  fonts and referenced/demo materials retain their original terms; do not relabel those.
  README.md and README_zh-CN.md are user-facing release documentation.
- `node scripts/check-release.mjs` verifies the public identity, exact x.y.z tag, package and
  versions metadata; `--assets` verifies the production three-file release and no sourcemap.
  GitHub release assets are built from the pushed tag. Never overwrite published tags or
  release assets to correct a mistake; increment the patch version and publish a fresh release.
