import {
  CompletionSource,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { Diagnostic, lintGutter } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { ChangeSet, EditorState, Extension, Text } from "@codemirror/state";
import {
  EditorView,
  HoverTooltipSource,
  KeyBinding,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  hoverTooltip,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import type { TexDiagnostic } from "../tex/logParser";
import { opensArgumentList, typingCommand } from "./latexCompletion";
import { latexEnterHooks, latexIndent } from "./latexEnter";
import { latexHighlightPlugin } from "./latexHighlight";
import { LatexBlock, LatexMath, mathAt } from "./latexScan";
import {
  CLOSE_BEFORE,
  darkThemeExtension,
  deleteMathPair,
  editNotifier,
  indentOrInsertTab,
  indentTabBinding,
  indentUnitFor,
  languageData,
  mathInput,
  setTypingDiagnostics,
  typingDiagnostics,
} from "./shared/editorKit";
import { InlineSuggestions, keyArbiter } from "./shared/keyArbiter";
import { liveActive, liveInput, livePreviewCompartment, replacedAt } from "./shared/livePreview";
import { lspGlyphColumn } from "./shared/lspCompletion";
import { cursorPreview, renderHover } from "./shared/renderHover";

export interface TexEditorOptions {
  /** The file's text, to detect its indent unit. */
  text: string;
  /** Ghost-text provider for keyArbiter (the YOLO bridge's `inline`). */
  inline?: () => InlineSuggestions | null;
  /** The YOLO bridge's per-state extension. */
  yolo?: Extension;
  completion?: CompletionSource | null;
  /** Committed edits only (never inside an IME composition): save, compile, texlab sync. */
  onEdit?: (view: EditorView, changes: ChangeSet, startDoc: Text) => void;
  /** The cursor moved without an edit (outside a composition). */
  onCursor?: (view: EditorView) => void;
  /**
   * The lint layer for compile diagnostics (gutter and underlines), set with
   * showTexDiagnostics only: a new problem on the line being typed waits for a pause.
   */
  diagnostics?: boolean;
  /** The render hover and texlab's hover (texHover). */
  hover?: TexHoverOptions;
  /**
   * Live preview, `livePreview(...)` (latexLive), or nothing for source mode: the content of
   * `livePreviewCompartment`, which is always mounted right after the highlighter (with
   * `liveInput()` next to it), so the mode toggle is one reconfiguration.
   */
  live?: Extension;
  /** More extensions and key bindings (F12), before the default keymap. */
  extensions?: Extension[];
  keys?: KeyBinding[];
}

/**
 * The LaTeX editor's extension list. keyArbiter comes FIRST: it owns Tab, Enter, Escape
 * and the arrows (popup > AI ghost > snippet field > indent); nothing else binds them.
 * Kept free of the obsidian module so tests build the same stack.
 */
export function texEditorExtensions(o: TexEditorOptions): Extension[] {
  return [
    keyArbiter({ inline: o.inline, enter: latexEnterHooks, tabFallback: indentOrInsertTab, completesWord: typingCommand }),
    o.yolo ?? [],
    EditorState.allowMultipleSelections.of(true),
    darkThemeExtension(),
    languageData({ brackets: ["(", "[", "{", "$"], before: CLOSE_BEFORE, lineComment: "%" }),
    indentUnitFor(o.text, "    "),
    latexIndent,
    mathInput({ latexDelimiters: true }),
    lineNumbers(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    closeBrackets(),
    EditorView.lineWrapping,
    latexHighlightPlugin,
    liveInput(),
    livePreviewCompartment.of(o.live ?? []),
    o.completion
      ? autocompletion({ override: [o.completion], addToOptions: [lspGlyphColumn], activateOnCompletion: opensArgumentList })
      : [],
    o.diagnostics ? [lintGutter(), typingDiagnostics()] : [],
    o.hover ? texHover(o.hover) : [],
    o.extensions ?? [],
    o.onEdit ? editNotifier(o.onEdit) : [],
    o.onCursor
      ? EditorView.updateListener.of((u) => {
          if (u.selectionSet && !u.docChanged && !u.view.compositionStarted) o.onCursor!(u.view);
        })
      : [],
    keymap.of([
      { key: "Backspace", run: deleteMathPair }, // `\(|\)` as a pair; closeBrackets only knows `(|)`
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...(o.keys ?? []),
      indentTabBinding,
    ]),
  ];
}

export interface TexHoverOptions {
  /** The `hoverRender` setting, read on every hover. */
  enabled(): boolean;
  /**
   * What renders at `pos`: a formula, or a block cropped from the PDF (TexRender's
   * `hoverTarget`). Default: the formula there.
   */
  target?(state: EditorState, pos: number): LatexMath | LatexBlock | null;
  /** The rendering (MathJax, a PDF crop), a failure (`hoverError`) or a note, or null. */
  render(target: LatexMath | LatexBlock, view: EditorView): HTMLElement | null | Promise<HTMLElement | null>;
  /** texlab's hover. */
  lsp?: HoverTooltipSource;
  /** The cursor preview (texCursorPreview). */
  cursor?: TexCursorOptions;
}

export interface TexCursorOptions {
  /** The `cursorPreview` setting, read at every change. */
  enabled(): boolean;
  /** The formula's rendering (TexRender's `preview`: MathJax), or a failure (`hoverError`). */
  render(math: LatexMath, view: EditorView): HTMLElement | null | Promise<HTMLElement | null>;
}

/**
 * The hover sources: the render hover (Prec.high, so its section sits above texlab's) for the
 * formula or block under the pointer, and texlab's hover, which returns nothing inside a
 * formula while rendering is on (it would only repeat a glyph). Neither shows over a live
 * preview widget (renderHover skips them itself). With `cursor`, the cursor preview too.
 */
export function texHover(o: TexHoverOptions): Extension[] {
  const lsp = o.lsp;
  return [
    renderHover<LatexMath | LatexBlock>({
      enabled: o.enabled,
      target: (state, pos) => (o.target ? o.target(state, pos) : mathAt(state.doc, pos)),
      render: (t, view) => o.render(t, view),
    }),
    lsp
      ? hoverTooltip(
          (view, pos, side) =>
            replacedAt(view.state, pos) || (o.enabled() && insideMath(view.state, pos, side)) ? null : lsp(view, pos, side),
          { hoverTime: 300 },
        )
      : [],
    o.cursor ? texCursorPreview(o.cursor) : [],
  ];
}

/**
 * The cursor preview for LaTeX math (shared `cursorPreview`, design 3.1): the formula around the
 * main cursor rendered below it while it is typed. Inline math in both modes, display math in
 * source mode; in live preview a formula owning its lines is a block, which keeps its own
 * rendering below its revealed source (also under an error diagnostic), unless live preview does
 * not decorate (a document grown past its maxLines).
 */
export function texCursorPreview(o: TexCursorOptions): Extension {
  return cursorPreview<LatexMath>({
    enabled: o.enabled,
    target: (state) => {
      const m = mathAt(state.doc, state.selection.main.head);
      return m && !(m.block && liveActive(state)) ? m : null;
    },
    render: (m, view) => o.render(m, view),
  });
}

/** The pointer (at `pos`, on the character before it when side < 0) is on a formula. */
function insideMath(state: EditorState, pos: number, side: -1 | 1): boolean {
  const m = mathAt(state.doc, pos);
  return !!m && !(side < 0 && pos <= m.from) && !(side > 0 && pos >= m.to);
}

/**
 * Compile diagnostics into the editor's lint layer, each from the first non-blank character
 * to the end of its reported line (TeX reports lines only). The only way diagnostics reach
 * the editor: through typingDiagnostics, an error on the line being typed (a half-typed `\fr`
 * compiled after the save debounce) waits until typing there pauses or the cursor leaves the
 * line, while errors elsewhere show and fixed ones go at once. The preview's status and
 * problem list are not affected.
 */
export function showTexDiagnostics(view: EditorView, diags: readonly TexDiagnostic[]): void {
  setTypingDiagnostics(view, texDiagnosticsToCm(view.state, diags));
}

function texDiagnosticsToCm(state: EditorState, diags: readonly TexDiagnostic[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of diags) {
    if (d.line === null || d.line < 1 || d.line > state.doc.lines) continue;
    const line = state.doc.line(d.line);
    const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
    const from = line.from + Math.min(indent, line.length);
    out.push({
      from,
      to: Math.max(from, line.to),
      severity: d.severity,
      message: d.message,
      source: "LaTeX",
    });
  }
  return out;
}
