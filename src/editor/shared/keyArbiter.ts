// Shared with obsidian-latex-live / obsidian-tinymist: keep byte-identical (canonical copy: obsidian-tinymist/src/editor/shared).
//
// One owner for Tab / Shift-Tab / Enter / Escape / ArrowUp / ArrowDown in our
// CodeMirror editors. Mount it FIRST in the extension array: it is Prec.highest,
// and among Prec.highest keymaps the one registered first wins. autocompletion()'s
// keymap (Prec.highest) and the snippet keymap (Prec.highest, appended through
// StateEffect.appendConfig on the first snippet) therefore run after it. Nothing else
// should bind these keys; what the arbiter declines falls through to the view keymap
// (insertNewlineAndIndent, indentWithTab or a replacement, cursor motion).
//
// Precedence, modelled on VS Code
// (suggest widget > inline suggestion > snippet tab stop > indent):
//   Tab       popup accept > AI ghost accept > next snippet field > Tab-ahead > view keymap
//             (Tab-ahead: completions are still loading, so the Tab waits for them. In a
//             snippet field it goes first while the popup for the word being typed is on
//             screen (an incomplete list keeps it there, disabled, while it re-queries on
//             every key) or the word is one that always asks (`completesWord`: `\alp|`).
//             When nothing comes back the Tab moves to the next field, or runs
//             `tabFallback`. A field's Tab also moves on when the list only holds the word
//             as typed, at the deadline, or when a character is typed before the list
//             arrives; that character then goes into the next field.)
//   Shift-Tab AI ghost dismiss (consumes) > previous snippet field > view keymap
//   Enter     popup accept (only if it changes text, and not from an untouched list that a
//             trigger character opened: `.` `#` `(` `\ref{` + Enter is a newline until
//             something is typed or the selection moved) > language hooks > view keymap
//   Escape    close popup + dismiss ghost > dismiss ghost > clear snippet > swallow
//   Arrows    move popup selection > cycle AI candidates (>= 2) > cursor motion
// Enter never accepts AI text; Backspace is never intercepted.
import {
  acceptCompletion,
  clearSnippet,
  closeCompletion,
  completionStatus,
  currentCompletions,
  hasNextSnippetField,
  hasPrevSnippetField,
  moveCompletionSelection,
  nextSnippetField,
  prevSnippetField,
  selectedCompletion,
  selectedCompletionIndex,
} from "@codemirror/autocomplete";
import {
  EditorState,
  Extension,
  Prec,
  Text,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";
import { Command, EditorView, ViewPlugin, ViewUpdate, keymap } from "@codemirror/view";
import { lspQueryEmpty } from "./lspCompletion";

/** What an inline (ghost-text) suggestion provider exposes to the arbiter. */
export type InlineStatus = "none" | "pending" | "visible";
export interface InlineSuggestions {
  /** "visible": ghost text is on screen at the cursor; "pending": request in flight. */
  status(view: EditorView): InlineStatus;
  accept(view: EditorView): boolean;
  dismiss(view: EditorView): void;
  /** Switch candidates; false when fewer than two candidates have text. */
  cycle(view: EditorView, dir: 1 | -1): boolean;
}

export interface KeyArbiterOptions {
  /** Ghost-text provider (the YOLO bridge's `inline`); read on every key press. */
  inline?: () => InlineSuggestions | null;
  /**
   * Language Enter hooks, run in order after the popup check; the first that returns
   * true wins (LaTeX environment close, list continuation).
   */
  enter?: Command | readonly Command[];
  /** Enter accepts a completion only when accepting changes the text (VS Code "smart"). */
  smartEnter?: boolean;
  /** Swallow an Escape nothing else wants, so Escape-then-Tab cannot leave the editor. */
  swallowEscape?: boolean;
  /** Tab typed while completions are still loading waits this long for them (0 = off). */
  tabAheadMs?: number;
  /**
   * Runs when a Tab-ahead outside a snippet field ends because completion came back with
   * nothing that matches (CodeMirror reports completions as loading for its typing delay
   * after every typed character, even when the source then declines), so a fast Tab does
   * what a slow one does. Pass a Tab that never shifts the line from mid-word (editorKit's
   * `indentOrInsertTab`); without it that Tab is dropped.
   */
  tabFallback?: Command;
  /**
   * Whether the word before the cursor always asks for completion (LaTeX: a command name,
   * `\alp|`). Inside a snippet field a Tab typed there while its list is still loading
   * waits for it, even before the popup has been on screen; otherwise such a Tab moves to
   * the next field at once.
   */
  completesWord?: (state: EditorState) => boolean;
}

const REQUIRED: Record<string, unknown> = {
  acceptCompletion, clearSnippet, closeCompletion, completionStatus, currentCompletions,
  hasNextSnippetField, hasPrevSnippetField, moveCompletionSelection, nextSnippetField,
  prevSnippetField, selectedCompletion, selectedCompletionIndex,
};

/** The completion popup is open, enabled and has a selection (accepting may still wait out interactionDelay). */
export const popupUsable = (s: EditorState): boolean => selectedCompletionIndex(s) !== null;
/** The completion popup is on screen (possibly disabled while re-querying). */
export const popupVisible = (s: EditorState): boolean => currentCompletions(s).length > 0;
const snippetActive = (s: EditorState) => hasNextSnippetField(s) || hasPrevSnippetField(s);

/**
 * Whether accepting the selected completion would change the document. The accept is
 * dry-run against a view stand-in that only has `state` and `dispatch`, so `apply`
 * functions should only read `view.state` and call `view.dispatch` synchronously
 * (anything else they do also happens during the dry run). One that needs more of the
 * view, or throws, counts as a change.
 */
export function acceptWouldChange(state: EditorState): boolean {
  if (!selectedCompletion(state)) return false;
  let cur = state;
  const probe = {
    get state() {
      return cur;
    },
    dispatch(...specs: (Transaction | TransactionSpec)[]) {
      const tr = specs.length === 1 && specs[0] instanceof Transaction
        ? specs[0]
        : cur.update(...(specs as TransactionSpec[]));
      cur = tr.state;
    },
  } as unknown as EditorView;
  try {
    if (!acceptCompletion(probe)) return true;
  } catch {
    return true;
  }
  return !cur.doc.eq(state.doc);
}

interface TabAhead {
  doc: Text;
  head: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Tabs pressed while waiting. An accept takes them all; with nothing to accept each runs. */
  count: number;
  /** Pressed in a snippet field: whatever ends the wait without an accept moves on. */
  field: boolean;
}

export function keyArbiter(opts: KeyArbiterOptions = {}): Extension {
  const missing = Object.keys(REQUIRED).filter((k) => typeof REQUIRED[k] !== "function");
  if (missing.length) {
    console.error("[keyArbiter] @codemirror/autocomplete lacks", missing.join(", "), "- using CodeMirror defaults");
    return [];
  }
  const smartEnter = opts.smartEnter ?? true;
  const swallowEscape = opts.swallowEscape ?? true;
  const tabAheadMs = opts.tabAheadMs ?? 400;
  const enterHooks: readonly Command[] = typeof opts.enter === "function" ? [opts.enter] : opts.enter ?? [];

  const inline = (): InlineSuggestions | null => {
    try {
      return opts.inline?.() ?? null;
    } catch {
      return null;
    }
  };
  const inlineStatus = (view: EditorView): InlineStatus => {
    try {
      return inline()?.status(view) ?? "none";
    } catch {
      return "none";
    }
  };

  // ---- Tab-ahead: Tab pressed in the ~200 ms before a popup is usable -------------
  // (activateOnTypingDelay 100 ms + source latency + interactionDelay 75 ms). Without
  // this, Tab right after `\sec` indents the whole line.
  const pendingTab = new WeakMap<EditorView, TabAhead>();
  // Views whose popup has been on screen since completion was last idle (it stays on
  // screen, disabled, while an incomplete list re-queries after each key).
  const popupShown = new WeakSet<EditorView>();
  // Views whose popup selection the arrows moved since the last edit.
  const navigated = new WeakSet<EditorView>();
  const dropTab = (view: EditorView) => {
    const t = pendingTab.get(view);
    if (t?.timer) clearTimeout(t.timer);
    pendingTab.delete(view);
  };
  // Do what each waiting Tab does without a popup.
  const moveOn = (view: EditorView, t: TabAhead) => {
    dropTab(view);
    for (let i = 0; i < t.count; i++) {
      if (hasNextSnippetField(view.state)) nextSnippetField(view);
      else opts.tabFallback?.(view);
    }
  };
  const pumpTab = (view: EditorView) => {
    const t = pendingTab.get(view);
    if (!t) return;
    const s = view.state;
    const sel = s.selection.main;
    // Typed on or moved: the Tab is stale, drop it.
    if (s.doc !== t.doc || !sel.empty || sel.head !== t.head) return dropTab(view);
    // Still loading at the deadline: drop it, or leave the field.
    if (Date.now() > t.deadline) return t.field ? moveOn(view, t) : dropTab(view);
    if (popupUsable(s)) {
      // In a field, a list whose entry is the word as typed (`\alpha|`) lets the Tab move on.
      if (t.field && !acceptWouldChange(s)) return moveOn(view, t);
      if (acceptCompletion(view)) return dropTab(view);
    } else if (completionStatus(s) === null || (completionStatus(s) === "active" && !popupVisible(s))) {
      return moveOn(view, t); // nothing came back, or nothing that matches
    }
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => pumpTab(view), 15); // still loading or inside interactionDelay
  };
  const startTab = (view: EditorView, field: boolean) => {
    const { doc } = view.state;
    const head = view.state.selection.main.head;
    const prev = pendingTab.get(view);
    const count = prev && prev.doc === doc && prev.head === head ? prev.count + 1 : 1;
    dropTab(view);
    pendingTab.set(view, { doc, head, deadline: Date.now() + tabAheadMs, timer: null, count, field });
    pumpTab(view);
  };
  // A character typed while a field's Tab waits: the Tab moves on first and the character
  // goes into the next field, as if the Tab had not waited (`\alpha` Tab `2`).
  const typedAhead = (view: EditorView, from: number, to: number, text: string): boolean => {
    const t = pendingTab.get(view);
    const sel = view.state.selection.main;
    if (!t?.field || view.compositionStarted || view.state.doc !== t.doc || from !== to || sel.head !== from) return false;
    moveOn(view, t);
    const at = view.state.selection.main;
    const insert = () => view.state.update(view.state.replaceSelection(text), { userEvent: "input.type", scrollIntoView: true });
    for (const handler of view.state.facet(EditorView.inputHandler)) {
      if (handler !== typedAhead && handler(view, at.from, at.to, text, insert)) return true;
    }
    view.dispatch(insert());
    return true;
  };

  const onTab: Command = (view) => {
    const s = view.state;
    if (popupUsable(s) && acceptCompletion(view)) return true; // T1
    if (inlineStatus(view) === "visible" && inline()!.accept(view)) return true; // T2
    const field = hasNextSnippetField(s);
    const sel = s.selection.main;
    const before = s.sliceDoc(s.doc.lineAt(sel.head).from, sel.head);
    if (
      tabAheadMs > 0 && completionStatus(s) !== null && sel.empty &&
      // In a snippet field only while the popup for the word being typed is on screen, or
      // for a word that always asks.
      (field
        ? /[\p{L}\p{N}_]$/u.test(before) && (popupShown.has(view) || !!opts.completesWord?.(s))
        : /\S$/.test(before))
    ) {
      startTab(view, field); // T4
      return true;
    }
    if (field) return nextSnippetField(view); // T3
    return false; // T5: the view keymap's Tab (indentWithTab)
  };

  const onShiftTab: Command = (view) => {
    dropTab(view);
    const st = inlineStatus(view);
    if (st === "visible") {
      inline()!.dismiss(view);
      return true;
    }
    if (st === "pending") inline()!.dismiss(view); // invisible: cancel, do not consume
    if (hasPrevSnippetField(view.state)) return prevSnippetField(view);
    return false; // indentLess
  };

  const onEnter: Command = (view) => {
    const s = view.state;
    if (popupUsable(s)) {
      // A list a trigger character opened, untouched: nothing typed, selection not moved.
      const unasked = lspQueryEmpty(s) && selectedCompletionIndex(s) === 0 && !navigated.has(view);
      if (!smartEnter || (!unasked && acceptWouldChange(s))) {
        if (acceptCompletion(view)) return true; // false inside interactionDelay: newline
      } else {
        closeCompletion(view); // exact match or unasked list: Enter means newline
      }
    }
    for (const hook of enterHooks) if (hook(view)) return true;
    return false; // insertNewlineAndIndent
  };

  const onEscape: Command = (view) => {
    dropTab(view); // before closeCompletion, which would read as "nothing came back"
    let handled = false;
    if (completionStatus(view.state) !== null) handled = closeCompletion(view) || handled;
    if (inlineStatus(view) !== "none") {
      inline()!.dismiss(view);
      handled = true;
    }
    if (!handled && snippetActive(view.state)) handled = clearSnippet(view);
    return handled;
  };

  const onArrow = (dir: 1 | -1): Command => (view) => {
    if (popupVisible(view.state) && moveCompletionSelection(dir > 0)(view)) {
      navigated.add(view);
      return true;
    }
    if (inlineStatus(view) === "visible" && inline()!.cycle(view, dir)) return true;
    return false;
  };

  return [
    Prec.highest(
      keymap.of([
        { key: "Tab", run: onTab, shift: onShiftTab },
        { key: "Enter", run: onEnter },
        // stopPropagation: an Escape we consume must not reach YOLO's document-level
        // Escape listener (cancelAllAiTasks -> agentService.abortAll()).
        { key: "Escape", run: onEscape, stopPropagation: true },
        { key: "ArrowDown", run: onArrow(1) },
        { key: "ArrowUp", run: onArrow(-1) },
      ]),
    ),
    Prec.highest(EditorView.inputHandler.of(typedAhead)),
    // An Escape no keymap handled: swallow it (no tab-focus mode) but let it propagate,
    // so YOLO's global "Escape cancels AI tasks" keeps working as in Markdown notes.
    Prec.lowest(
      EditorView.domEventHandlers({
        keydown: (e) =>
          swallowEscape && e.key === "Escape" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey,
      }),
    ),
    ViewPlugin.define((view) => ({
      update: (u: ViewUpdate) => {
        if (completionStatus(u.state) === null) popupShown.delete(view);
        else if (popupVisible(u.state)) popupShown.add(view);
        if (u.docChanged || completionStatus(u.state) === null) navigated.delete(view);
        if (pendingTab.has(view) && u.transactions.length) queueMicrotask(() => pumpTab(view));
      },
      destroy: () => {
        dropTab(view);
        popupShown.delete(view);
        navigated.delete(view);
      },
    })),
  ];
}
