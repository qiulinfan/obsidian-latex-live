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
//   Shift-Tab AI ghost dismiss (consumes) > previous snippet field > view keymap
//   Enter     popup accept (only if it changes text) > language hooks > view keymap
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

interface TabAhead { doc: Text; head: number; deadline: number; timer: ReturnType<typeof setTimeout> | null }

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
  const dropTab = (view: EditorView) => {
    const t = pendingTab.get(view);
    if (t?.timer) clearTimeout(t.timer);
    pendingTab.delete(view);
  };
  const pumpTab = (view: EditorView) => {
    const t = pendingTab.get(view);
    if (!t) return;
    const s = view.state;
    const sel = s.selection.main;
    if (Date.now() > t.deadline || s.doc !== t.doc || !sel.empty || sel.head !== t.head) return dropTab(view);
    if (popupUsable(s)) {
      if (acceptCompletion(view)) return dropTab(view);
    } else if (completionStatus(s) === null) {
      return dropTab(view); // nothing came back: the Tab was a no-op
    }
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => pumpTab(view), 15); // still loading or inside interactionDelay
  };
  const startTab = (view: EditorView) => {
    dropTab(view);
    pendingTab.set(view, {
      doc: view.state.doc,
      head: view.state.selection.main.head,
      deadline: Date.now() + tabAheadMs,
      timer: null,
    });
    pumpTab(view);
  };

  const onTab: Command = (view) => {
    const s = view.state;
    if (popupUsable(s) && acceptCompletion(view)) return true; // T1
    if (inlineStatus(view) === "visible" && inline()!.accept(view)) return true; // T2
    if (hasNextSnippetField(s)) return nextSnippetField(view); // T3
    const sel = s.selection.main;
    if (
      tabAheadMs > 0 && completionStatus(s) !== null && sel.empty &&
      /\S$/.test(s.sliceDoc(s.doc.lineAt(sel.head).from, sel.head))
    ) {
      startTab(view); // T4
      return true;
    }
    return false; // T5: the view keymap's Tab (indentWithTab)
  };

  const onShiftTab: Command = (view) => {
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
    if (popupUsable(view.state)) {
      if (!smartEnter || acceptWouldChange(view.state)) {
        if (acceptCompletion(view)) return true; // false inside interactionDelay: newline
      } else {
        closeCompletion(view); // exact match: Enter means newline
      }
    }
    for (const hook of enterHooks) if (hook(view)) return true;
    return false; // insertNewlineAndIndent
  };

  const onEscape: Command = (view) => {
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
    if (popupVisible(view.state) && moveCompletionSelection(dir > 0)(view)) return true;
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
        if (pendingTab.has(view) && u.transactions.length) queueMicrotask(() => pumpTab(view));
      },
      destroy: () => dropTab(view),
    })),
  ];
}
