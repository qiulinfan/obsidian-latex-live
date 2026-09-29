import {
  CompletionSource,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { ChangeSet, EditorState, Extension, Prec, Text } from "@codemirror/state";
import {
  EditorView,
  KeyBinding,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { argumentRetrigger } from "./latexCompletion";
import { latexEnterHooks, latexIndent } from "./latexEnter";
import { latexHighlightPlugin } from "./latexHighlight";
import {
  darkThemeExtension,
  deleteMathPair,
  editNotifier,
  indentOrInsertTab,
  indentTabBinding,
  indentUnitFor,
  languageData,
  mathInput,
} from "./shared/editorKit";
import { InlineSuggestions, keyArbiter } from "./shared/keyArbiter";
import { lspGlyphColumn } from "./shared/lspCompletion";

/**
 * closeBrackets pairs `(`, `[`, `{` before these (and whitespace or the line end):
 * CodeMirror's default plus Chinese closing punctuation. cjkDollar uses the same set.
 */
const CLOSE_BEFORE = ")]}:;>，。：；）、！？」』";
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * `$` right after a CJK character opens math as a pair (`设|，则` -> `设$|$，则`):
 * closeBrackets never pairs `$` after a word character, where it usually closes math, and
 * CJK characters are word characters. It only steps over closers it inserted itself, so
 * `$` typed in front of the closer of such a pair (`设$x|$`) steps over it here.
 * Stopgap: remove it once the shared mathInput handles `$` after CJK text (requested for
 * the canonical editorKit in obsidian-tinymist).
 */
const cjkDollar = Prec.high(
  EditorView.inputHandler.of((view, from, to, text) => {
    const { state } = view;
    if (text !== "$" || view.compositionStarted || from !== to || state.readOnly) return false;
    const sel = state.selection;
    if (sel.ranges.length > 1 || !sel.main.empty) return false;
    const line = state.doc.lineAt(from);
    const before = line.text.slice(0, from - line.from);
    const after = line.text.slice(from - line.from);
    const next = after.slice(0, 1);
    let spec;
    if (CJK.test(before.slice(-1)) && (next === "" || /\s/.test(next) || CLOSE_BEFORE.includes(next))) {
      spec = { changes: { from, insert: "$$" }, selection: { anchor: from + 1 } };
    } else {
      const open = /\$[^$]+$/.exec(before);
      if (!open || !CJK.test(before.charAt(open.index - 1)) || next !== "$" || after[1] === "$") return false;
      spec = { selection: { anchor: from + 1 } };
    }
    view.dispatch({ ...spec, userEvent: "input.type", scrollIntoView: true });
    return true;
  }),
);

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
  /** More extensions (lint gutter, hover) and key bindings (F12), before the default keymap. */
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
    keyArbiter({ inline: o.inline, enter: latexEnterHooks, tabFallback: indentOrInsertTab }),
    o.yolo ?? [],
    EditorState.allowMultipleSelections.of(true),
    darkThemeExtension(),
    languageData({ brackets: ["(", "[", "{", "$"], before: CLOSE_BEFORE, lineComment: "%" }),
    indentUnitFor(o.text, "    "),
    latexIndent,
    mathInput({ latexDelimiters: true }),
    cjkDollar,
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
    o.completion
      ? [autocompletion({ override: [o.completion], addToOptions: [lspGlyphColumn] }), argumentRetrigger]
      : [],
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
