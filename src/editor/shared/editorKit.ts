// Shared with obsidian-latex-live / obsidian-tinymist: keep byte-identical (canonical copy: obsidian-tinymist/src/editor/shared).
//
// Editing helpers for the plugins' own CodeMirror views (the Typst and LaTeX file views
// get none of Obsidian's Markdown-editor behaviour):
//   setDocText            external file changes as a minimal diff (cursor, scroll, undo kept)
//   HistoryCache          per-file undo history across reopen (state.toJSON/fromJSON)
//   getEphemeralState / applyEphemeralState   cursor + scroll round trip, focus on activation
//   darkThemeExtension / syncDarkTheme        EditorView.darkTheme following Obsidian's theme
//   editNotifier          committed edits only: nothing while an IME composition is open
//   languageData / detectIndentUnit           closeBrackets, commentTokens, indent unit
//   mathInput / mathEnter / deleteMathPair    $, \( \[ and escapes, which closeBrackets cannot express
//   CLOSE_BEFORE          what brackets and math pair before, CJK closing punctuation included
//   wrapSelection, indentOrInsertTab, showSearch
//   registerEditorScope   Obsidian hotkeys that would otherwise swallow editor keys
// Only type imports from "obsidian" are allowed here: tests bundle this without Obsidian.
import {
  historyField,
  indentLess,
  indentMore,
  insertBlankLine,
  isolateHistory,
  toggleComment,
} from "@codemirror/commands";
import { getIndentUnit, indentUnit } from "@codemirror/language";
import { findNext, findPrevious, openSearchPanel, selectNextOccurrence } from "@codemirror/search";
import {
  ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  EditorStateConfig,
  Extension,
  Prec,
  StateEffect,
  Text,
  TransactionSpec,
} from "@codemirror/state";
import { Command, EditorView, KeyBinding } from "@codemirror/view";
import type { Modifier, Scope } from "obsidian";

// ---- External text ----------------------------------------------------------------

/**
 * The single change turning `cur` into `next` (common prefix and suffix kept), or null
 * when they are equal. Never splits a surrogate pair.
 */
export function minimalChange(
  cur: string,
  next: string,
): { from: number; to: number; insert: string } | null {
  if (cur === next) return null;
  const max = Math.min(cur.length, next.length);
  let start = 0;
  while (start < max && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  const same = (i: number) => cur.charCodeAt(cur.length - 1 - i) === next.charCodeAt(next.length - 1 - i);
  while (end < max - start && same(end)) end++;
  if (start > 0 && isHigh(cur.charCodeAt(start - 1))) start--;
  if (end > 0 && isLow(cur.charCodeAt(cur.length - end))) end--;
  return { from: start, to: cur.length - end, insert: next.slice(start, next.length - end) };
}
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

const deferredText = new WeakMap<EditorView, string>();

/**
 * Replace the document with `text` (a file change from outside the view) the way
 * Obsidian's Markdown editor does: one minimal change with userEvent "set" as its own undo
 * step, so the cursor, scroll position and decorations map instead of jumping to 0.
 * During an IME composition the update waits for compositionend (the last text wins).
 */
export function setDocText(view: EditorView, text: string): "applied" | "unchanged" | "deferred" {
  if (view.compositionStarted) {
    if (!deferredText.has(view)) {
      view.contentDOM.addEventListener(
        "compositionend",
        () =>
          setTimeout(() => {
            const pending = deferredText.get(view);
            deferredText.delete(view);
            if (pending !== undefined) setDocText(view, pending);
          }, 0),
        { once: true },
      );
    }
    deferredText.set(view, text);
    return "deferred";
  }
  deferredText.delete(view);
  const change = minimalChange(view.state.doc.toString(), view.state.toText(text).toString());
  if (!change) return "unchanged";
  view.dispatch({ changes: change, userEvent: "set", annotations: isolateHistory.of("full") });
  return "applied";
}

// ---- Undo history per file ----------------------------------------------------------

/**
 * Keeps the serialized state (doc, selection, undo history) of recently closed files so
 * reopening one restores its history, as Obsidian does for Markdown. A cached entry is
 * used only when the file text is unchanged.
 */
export class HistoryCache {
  private entries = new Map<string, { doc: string }>();

  constructor(private readonly max = 20) {}

  save(key: string, state: EditorState): void {
    this.entries.delete(key);
    this.entries.set(key, state.toJSON({ history: historyField }) as { doc: string });
    for (const old of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(old);
    }
  }

  /** A state for `text` with the cached history, or null (no entry or text changed). */
  restore(key: string, text: string, config: EditorStateConfig): EditorState | null {
    const json = this.entries.get(key);
    if (!json || json.doc !== text.replace(/\r\n?/g, "\n")) return null;
    try {
      return EditorState.fromJSON(json, config, { history: historyField });
    } catch {
      return null;
    }
  }

  rename(from: string, to: string): void {
    const json = this.entries.get(from);
    this.entries.delete(from);
    if (json) this.entries.set(to, json);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

// ---- Ephemeral state ------------------------------------------------------------------

/** Obsidian's MarkdownView ephemeral-state shape (0-based lines), plus `focus`/`line`. */
export interface EditorEphemeralState {
  cursor?: { from: { line: number; ch: number }; to: { line: number; ch: number } };
  /** First visible line. */
  scroll?: number;
  /** A line to reveal (link targets). */
  line?: number;
  focus?: boolean;
}

export function getEphemeralState(view: EditorView): EditorEphemeralState {
  const { doc, selection } = view.state;
  const at = (pos: number) => {
    const line = doc.lineAt(pos);
    return { line: line.number - 1, ch: pos - line.from };
  };
  const top = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top));
  return {
    cursor: { from: at(selection.main.anchor), to: at(selection.main.head) },
    scroll: doc.lineAt(top.from).number - 1,
  };
}

export function applyEphemeralState(view: EditorView, st: EditorEphemeralState | null | undefined): void {
  if (!st) return;
  const doc = view.state.doc;
  const lineAt = (n: number) => doc.line(Math.min(Math.max(Math.floor(n) + 1, 1), doc.lines));
  const offset = (p: { line: number; ch: number }) => {
    const line = lineAt(p.line);
    return Math.min(line.from + Math.max(0, p.ch), line.to);
  };
  let selection: { anchor: number; head: number } | undefined;
  if (st.cursor) {
    selection = { anchor: offset(st.cursor.from), head: offset(st.cursor.to) };
  } else if (typeof st.line === "number") {
    const from = lineAt(st.line).from;
    selection = { anchor: from, head: from };
  }
  const effects: StateEffect<unknown>[] = [];
  if (typeof st.scroll === "number") {
    effects.push(EditorView.scrollIntoView(lineAt(st.scroll).from, { y: "start" }));
  } else if (selection) {
    effects.push(EditorView.scrollIntoView(selection.head, { y: "center" }));
  }
  if (selection || effects.length) view.dispatch({ selection, effects });
  if (st.focus) view.focus();
}

// ---- Dark theme ---------------------------------------------------------------------

const darkMode = new Compartment();

/** Whether Obsidian currently shows its dark theme. */
export const isDarkUi = (): boolean => document.body.classList.contains("theme-dark");

/** Add to the view's extensions; call syncDarkTheme on the workspace "css-change" event. */
export function darkThemeExtension(dark: boolean = isDarkUi()): Extension {
  return darkMode.of(EditorView.darkTheme.of(dark));
}

export function syncDarkTheme(view: EditorView, dark: boolean = isDarkUi()): void {
  if (darkMode.get(view.state) === undefined || view.state.facet(EditorView.darkTheme) === dark) return;
  view.dispatch({ effects: darkMode.reconfigure(EditorView.darkTheme.of(dark)) });
}

// ---- Composition-aware edit notifications ---------------------------------------------

/**
 * Calls `onEdit` for committed document changes. Changes made while an IME composition is
 * open (uncommitted Pinyin) are collected and reported once, after compositionend.
 * `changes` spans everything since the last call and applies to `startDoc`.
 */
export function editNotifier(
  onEdit: (view: EditorView, changes: ChangeSet, startDoc: Text) => void,
): Extension {
  const pending = new WeakMap<EditorView, { changes: ChangeSet; startDoc: Text }>();
  const flush = (view: EditorView) => {
    const p = pending.get(view);
    if (!p) return;
    pending.delete(view);
    onEdit(view, p.changes, p.startDoc);
  };
  return [
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      const p = pending.get(u.view);
      pending.set(u.view, {
        changes: p ? p.changes.compose(u.changes) : u.changes,
        startDoc: p ? p.startDoc : u.startState.doc,
      });
      if (!u.view.compositionStarted) flush(u.view);
    }),
    EditorView.domEventHandlers({
      compositionend: (_e, view) => {
        // CM commits the composed text right after this event; report whatever remains.
        setTimeout(() => {
          if (!view.compositionStarted) flush(view);
        }, 0);
        return false;
      },
    }),
  ];
}

// ---- Language data ------------------------------------------------------------------

export interface LanguageSpec {
  /** closeBrackets pairs, e.g. ["(", "[", "{", "$"]. */
  brackets?: string[];
  /** Characters before which closeBrackets still auto-closes (CM default ")]}:;>"). */
  before?: string;
  lineComment?: string;
  blockComment?: { open: string; close: string };
}

/** closeBrackets and toggleComment configuration for a view without a CM language. */
export function languageData(spec: LanguageSpec): Extension {
  const data: Record<string, unknown> = {};
  if (spec.brackets) data.closeBrackets = { brackets: spec.brackets, before: spec.before };
  if (spec.lineComment || spec.blockComment) {
    data.commentTokens = { line: spec.lineComment, block: spec.blockComment };
  }
  return Prec.high(EditorState.languageData.of(() => [data]));
}

/**
 * Indent unit used by a file: a tab if tab-indented lines dominate, else the most common
 * indentation step (2, 4 or 3 spaces) between consecutive lines, else `fallback`.
 */
export function detectIndentUnit(text: string, fallback = "  "): string {
  let tabs = 0;
  let spaced = 0;
  let prev = 0;
  const steps = new Map<number, number>();
  const lines = text.split("\n", 10000);
  for (const line of lines) {
    if (!line.trim()) continue;
    const ws = /^[ \t]*/.exec(line)![0];
    if (ws.startsWith("\t")) {
      tabs++;
      continue;
    }
    if (ws.length) spaced++;
    const d = Math.abs(ws.length - prev);
    if (d) steps.set(d, (steps.get(d) ?? 0) + 1);
    prev = ws.length;
  }
  if (tabs > spaced) return "\t";
  // A 4-space file also dedents by 8; a 2-space file also by 6 (4 counts for 4 spaces).
  const count = (d: number) => steps.get(d) ?? 0;
  const candidates: [number, number][] = [[4, count(4) + count(8)], [2, count(2) + count(6)], [3, count(3)]];
  const [unit, n] = candidates.reduce((a, b) => (b[1] > a[1] ? b : a));
  return n >= 2 ? " ".repeat(unit) : fallback;
}

/** indentUnit detected from the file text. */
export function indentUnitFor(text: string, fallback = "  "): Extension {
  return indentUnit.of(detectIndentUnit(text, fallback));
}

// ---- Math delimiters ----------------------------------------------------------------

/**
 * CodeMirror's closeBrackets default `before` (")]}:;>") plus Chinese and Japanese closing
 * punctuation: a pair opens before these, whitespace or the line end. mathInput uses it for
 * `$` after CJK text and for `\(` / `\[`; pass it to languageData's `before` for the brackets.
 */
export const CLOSE_BEFORE = ")]}:;>，。：；）、！？」』";

export interface MathInputOptions {
  /** `$` typed inside an empty `$|$` becomes open|close (default ["$$", "$$"]; null: off). */
  display?: [string, string] | null;
  /** LaTeX: `\(` / `\[` insert `\)` / `\]`, and typing `\)` / `\]` steps over that closer. */
  latexDelimiters?: boolean;
  /** What `$` after CJK text, `\(` and `\[` pair before, besides whitespace (default CLOSE_BEFORE). */
  closeBefore?: string;
}

const unescapedBackslashBefore = (state: EditorState, pos: number): boolean => {
  let n = 0;
  while (pos - n - 1 >= 0 && state.sliceDoc(pos - n - 1, pos - n) === "\\") n++;
  return n % 2 === 1;
};

/** Characters closeBrackets may pair or step over; after a backslash they are escapes. */
const ESCAPABLE = "$(){}[]\"";
/** The line ends in CJK text (Han, kana, Hangul): inline math follows it without a space. */
const CJK_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
/** Math is open at the end of `text`: an odd number of unescaped `$` delimiters (`$$` counts once). */
const mathOpen = (text: string): boolean =>
  (text.match(/\\[\s\S]|\$\$?/g) ?? []).filter((m) => m[0] === "$").length % 2 === 1;

/**
 * Input rules on top of closeBrackets (with "$" among its brackets, which already pairs,
 * wraps a selection and steps over `$`). Mount next to closeBrackets(); it runs first.
 *   - `$` inside an empty `$|$` opens display math (`display`).
 *   - `$` right after CJK text opens a pair before whitespace, the line end or `closeBefore`
 *     (`设|，则` -> `设$|$，则`): closeBrackets never pairs `$` after a word character, where
 *     it usually closes math, and CJK characters are word characters. With math open on the
 *     line (`$a \in 集|`) that `$` closes it and stays single. closeBrackets only steps over
 *     closers it inserted itself, so `$` in front of the closer of such a pair steps over it.
 *   - LaTeX `\(` / `\[` pair before whitespace, the line end, `$` or `closeBefore`.
 *   - A bracket or `$` typed after an unescaped backslash (`\$`, `\{`, `\}`, Typst `\(`) is
 *     an escaped character: inserted as is, never paired and never stepping over a closer.
 */
export function mathInput(opts: MathInputOptions = {}): Extension {
  const display = opts.display === undefined ? (["$$", "$$"] as [string, string]) : opts.display;
  const closeBefore = opts.closeBefore ?? CLOSE_BEFORE;
  const opensBefore = (next: string) => next === "" || /\s/.test(next) || closeBefore.includes(next);
  return Prec.high(
    EditorView.inputHandler.of((view, from, to, text) => {
      const { state } = view;
      if (view.compositionStarted || from !== to || text.length !== 1 || state.readOnly) return false;
      const sel = state.selection;
      if (sel.ranges.length > 1 || !sel.main.empty || sel.main.head !== from) return false;
      const before = state.sliceDoc(from - 1, from);
      const after = state.sliceDoc(from, from + 2);
      const beforePair = state.sliceDoc(from - 2, from - 1);
      const emptyPair = before === "$" && after[0] === "$" && beforePair !== "$" && beforePair !== "\\";
      if (text === "$" && display && emptyPair) {
        view.dispatch({
          changes: { from: from - 1, to: from + 1, insert: display[0] + display[1] },
          selection: { anchor: from - 1 + display[0].length },
          userEvent: "input.type",
          scrollIntoView: true,
        });
        return true;
      }
      const escaped = unescapedBackslashBefore(state, from);
      if (text === "$" && !escaped) {
        // After CJK text: open a pair, or step over the closer of such a pair.
        const line = state.doc.lineAt(from);
        const lineBefore = line.text.slice(0, from - line.from);
        const open = /\$[^$]+$/.exec(lineBefore); // the math this `$` would close
        let spec: TransactionSpec | null = null;
        if (CJK_END.test(lineBefore) && opensBefore(after.slice(0, 1)) && !mathOpen(lineBefore)) {
          spec = { changes: { from, insert: "$$" }, selection: { anchor: from + 1 } };
        } else if (after[0] === "$" && after[1] !== "$" && open && CJK_END.test(lineBefore.slice(0, open.index))) {
          spec = { selection: { anchor: from + 1 } };
        }
        if (!spec) return false;
        view.dispatch({ ...spec, userEvent: "input.type", scrollIntoView: true });
        return true;
      }
      if (!escaped) return false;
      if (opts.latexDelimiters && (text === "(" || text === "[")) {
        const closer = text === "(" ? "\\)" : "\\]";
        const next = after[0] ?? "";
        const pair = next === "$" || opensBefore(next);
        view.dispatch({
          changes: { from, insert: pair ? text + closer : text },
          selection: { anchor: from + 1 },
          userEvent: "input.type",
          scrollIntoView: true,
        });
        return true; // never let closeBrackets add a bare `]` / `)` after a backslash
      }
      if (opts.latexDelimiters && (text === ")" || text === "]") && after === "\\" + text) {
        view.dispatch({
          changes: { from: from - 1, to: from + 2, insert: "\\" + text },
          selection: { anchor: from + 1 },
          userEvent: "input.type",
          scrollIntoView: true,
        });
        return true;
      }
      if (!ESCAPABLE.includes(text)) return false;
      view.dispatch({
        changes: { from, insert: text },
        selection: { anchor: from + 1 },
        userEvent: "input.type",
        scrollIntoView: true,
      });
      return true;
    }),
  );
}

/**
 * Backspace in an empty `\(|\)` or `\[|\]` (as mathInput pairs them) deletes both
 * delimiters; closeBracketsKeymap only knows one-character pairs. Bind it before
 * closeBracketsKeymap in a LaTeX view's keymap.
 */
export const deleteMathPair: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  let other = false;
  const tr = state.changeByRange((r) => {
    const pair = state.sliceDoc(r.from - 2, r.from + 2);
    if (r.empty && (pair === "\\(\\)" || pair === "\\[\\]") && unescapedBackslashBefore(state, r.from - 1)) {
      return { changes: { from: r.from - 2, to: r.from + 2 }, range: EditorSelection.cursor(r.from - 2) };
    }
    other = true;
    return { range: r };
  });
  if (other) return false;
  view.dispatch(state.update(tr, { userEvent: "delete.backward", scrollIntoView: true }));
  return true;
};

/** Enter between `\[|\]` or `$$|$$`: open the block on its own indented line. */
export const mathEnter: Command = (view) => {
  const { state } = view;
  const r = state.selection.main;
  if (state.selection.ranges.length > 1 || !r.empty || state.readOnly) return false;
  const open = state.sliceDoc(r.from - 2, r.from);
  const close = state.sliceDoc(r.from, r.from + 2);
  if (!((open === "\\[" && close === "\\]") || (open === "$$" && close === "$$"))) return false;
  const indent = /^\s*/.exec(state.doc.lineAt(r.from).text)![0];
  const inner = "\n" + indent + state.facet(indentUnit);
  view.dispatch({
    changes: { from: r.from, insert: inner + "\n" + indent },
    selection: { anchor: r.from + inner.length },
    userEvent: "input",
    scrollIntoView: true,
  });
  return true;
};

// ---- Commands -----------------------------------------------------------------------

/**
 * Toggle `before`/`after` around each selection (Mod-B / Mod-I): wraps, or unwraps when
 * the markers already surround (or are included in) the selection. An empty selection
 * gets the pair with the cursor between.
 */
export function wrapSelection(view: EditorView, before: string, after: string): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const tr = state.changeByRange((range) => {
    const outside =
      range.from >= before.length &&
      state.sliceDoc(range.from - before.length, range.from) === before &&
      state.sliceDoc(range.to, range.to + after.length) === after;
    if (outside) {
      return {
        changes: [
          { from: range.from - before.length, to: range.from },
          { from: range.to, to: range.to + after.length },
        ],
        range: EditorSelection.range(range.anchor - before.length, range.head - before.length),
      };
    }
    const inner = state.sliceDoc(range.from, range.to);
    const long = inner.length >= before.length + after.length;
    if (!range.empty && long && inner.startsWith(before) && inner.endsWith(after)) {
      return {
        changes: [
          { from: range.from, to: range.from + before.length },
          { from: range.to - after.length, to: range.to },
        ],
        range: EditorSelection.range(range.from, range.to - before.length - after.length),
      };
    }
    return {
      changes: [{ from: range.from, insert: before }, { from: range.to, insert: after }],
      range: EditorSelection.range(range.anchor + before.length, range.head + before.length),
    };
  });
  view.dispatch(state.update(tr, { userEvent: "input", scrollIntoView: true }));
  return true;
}

/**
 * Tab without a popup, ghost text or snippet field: indent the lines when the cursor is in
 * leading whitespace or text is selected, else insert spaces to the next indent stop (never
 * shift the whole line from the middle of a word).
 */
export const indentOrInsertTab: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const inIndent = (pos: number) => /^\s*$/.test(state.sliceDoc(state.doc.lineAt(pos).from, pos));
  if (state.selection.ranges.some((r) => !r.empty || inIndent(r.head))) return indentMore(view);
  const unit = state.facet(indentUnit);
  const width = getIndentUnit(state);
  view.dispatch(
    state.changeByRange((r) => {
      const col = r.head - state.doc.lineAt(r.head).from;
      const insert = unit.includes("\t") ? "\t" : " ".repeat(width - (col % width));
      return { changes: { from: r.head, insert }, range: EditorSelection.cursor(r.head + insert.length) };
    }),
    { userEvent: "input", scrollIntoView: true },
  );
  return true;
};

/** `{ key: "Tab", run: indentOrInsertTab, shift: indentLess }` for the end of the view keymap. */
export const indentTabBinding: KeyBinding = { key: "Tab", run: indentOrInsertTab, shift: indentLess };

/** The view's showSearch(replace): Obsidian's "Search current file" (Mod-F) calls it. */
export function showSearch(view: EditorView, replace = false): void {
  openSearchPanel(view);
  if (replace) view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus();
}

// ---- Obsidian hotkey scope ----------------------------------------------------------------

export type EditorScopeAction =
  | "comment"
  | "nextOccurrence"
  | "findNext"
  | "findPrevious"
  | "blankLine"
  | "replace"
  | "bold"
  | "italic"
  | "preview";

/**
 * Keys Obsidian's global hotkeys consume before CodeMirror sees them (its editor commands
 * no-op outside Markdown views but still eat the key). Mod-S (saves these views) and Mod-F
 * (calls view.showSearch) keep their Obsidian meaning and are not listed.
 */
export const EDITOR_SCOPE_KEYS: readonly {
  modifiers: Modifier[];
  key: string;
  action: EditorScopeAction;
}[] = [
  { modifiers: ["Mod"], key: "/", action: "comment" },
  { modifiers: ["Mod"], key: "d", action: "nextOccurrence" },
  { modifiers: ["Mod"], key: "g", action: "findNext" },
  { modifiers: ["Mod", "Shift"], key: "g", action: "findPrevious" },
  { modifiers: ["Mod"], key: "Enter", action: "blankLine" },
  { modifiers: ["Mod", "Alt"], key: "f", action: "replace" },
  { modifiers: ["Mod"], key: "b", action: "bold" },
  { modifiers: ["Mod"], key: "i", action: "italic" },
  { modifiers: ["Mod"], key: "e", action: "preview" },
];

export interface EditorScopeOptions {
  /** Markers for Mod-B / Mod-I, e.g. ["\\textbf{", "}"] or ["*", "*"]. */
  bold?: [string, string];
  italic?: [string, string];
  /** Mod-E: open or toggle the preview. */
  togglePreview?: () => void;
}

/**
 * Register EDITOR_SCOPE_KEYS on the view's Obsidian scope (`this.scope = new
 * Scope(app.scope)` in the view constructor). Each handler runs the editor command itself
 * and returns false, so Obsidian stops the event; keys without a configured action are
 * not registered.
 */
export function registerEditorScope(
  scope: Scope,
  getView: () => EditorView | null,
  opts: EditorScopeOptions = {},
): void {
  const actions: Record<EditorScopeAction, ((view: EditorView) => unknown) | undefined> = {
    comment: toggleComment,
    nextOccurrence: selectNextOccurrence,
    findNext,
    findPrevious,
    blankLine: insertBlankLine,
    replace: (view) => showSearch(view, true),
    bold: opts.bold && ((view) => wrapSelection(view, opts.bold![0], opts.bold![1])),
    italic: opts.italic && ((view) => wrapSelection(view, opts.italic![0], opts.italic![1])),
    preview: opts.togglePreview && (() => opts.togglePreview!()),
  };
  for (const { modifiers, key, action } of EDITOR_SCOPE_KEYS) {
    const run = actions[action];
    if (!run) continue;
    scope.register(modifiers, key, () => {
      const view = getView();
      if (view) run(view);
      return false;
    });
  }
}
