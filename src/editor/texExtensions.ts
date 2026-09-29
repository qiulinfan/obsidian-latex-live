import {
  CompletionSource,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { ChangeSet, EditorState, Extension, Text } from "@codemirror/state";
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
import { latexEnterHooks } from "./latexEnter";
import { latexHighlightPlugin } from "./latexHighlight";
import {
  darkThemeExtension,
  editNotifier,
  indentTabBinding,
  indentUnitFor,
  languageData,
  mathInput,
} from "./shared/editorKit";
import { InlineSuggestions, keyArbiter } from "./shared/keyArbiter";
import { lspGlyphColumn } from "./shared/lspCompletion";

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
    keyArbiter({ inline: o.inline, enter: latexEnterHooks }),
    o.yolo ?? [],
    EditorState.allowMultipleSelections.of(true),
    darkThemeExtension(),
    languageData({ brackets: ["(", "[", "{", "$"], lineComment: "%" }),
    indentUnitFor(o.text, "    "),
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
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...(o.keys ?? []),
      indentTabBinding,
    ]),
  ];
}
