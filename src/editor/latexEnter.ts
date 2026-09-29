// Enter hooks for keyArbiter (run after the completion popup check, first match wins), and
// the indentation of new lines.
//
// closeEnvironmentOnEnter: Enter after `\begin{env}` closes the environment.
//   \begin{proof}|         ->  \begin{proof}
//                                |
//                              \end{proof}
// Applies when the cursor ends a `\begin{name}` (optionally followed by [..]/{..}
// arguments) with only whitespace after it, or sits in `\begin{name|}` with only `}`
// after it (closeBrackets inserted the brace). Skipped when a matching `\end{name}` that
// is not claimed by a later `\begin{name}` follows (the environment is already closed);
// then Enter in `\begin{name|}`, like Enter in `\end{name|}`, steps over the brace and
// starts a new line instead of splitting the brace off. List environments get their first
// `\item `; the body of `document` is not indented.
// Enter in `\begin{name|}` or `\end{name|}` while the name's completion is loading or
// inside the popup's interactionDelay waits for it (up to 400 ms, like Tab-ahead):
// `\begin{ali` + a fast Enter completes `align` rather than closing an undefined `ali`.
// Typing on or moving the cursor in the meantime drops that Enter.
//
// continueItem (UX-12): Enter on an `\item` line inside itemize/enumerate/description
// starts the next `\item`; Enter on an empty `\item` (no label) leaves the list. A
// label-only `\item[(a)]` gets a plain newline: its text goes on the next line.
//
// latexIndent: a new line is one unit deeper after `\begin{name}` (not `document`) and
// after an open `{`, `[` or `(` at the end of the line; a line starting with `\end{name}`
// lines up with its `\begin`. Anything else keeps the line's indentation (CM's default).
//
// Heuristics: comments are ignored per line; verbatim-like environments are not special.
import { acceptCompletion, closeCompletion, completionStatus } from "@codemirror/autocomplete";
import { IndentContext, getIndentation, indentService, indentString, indentUnit } from "@codemirror/language";
import { EditorState, Extension, countColumn } from "@codemirror/state";
import { Command, EditorView } from "@codemirror/view";
import { LIST_ENVIRONMENTS } from "./latexCommands";
import { mathEnter } from "./shared/editorKit";
import { acceptWouldChange, popupUsable } from "./shared/keyArbiter";

const BEGIN_DONE = /\\begin\{([A-Za-z@*]+)\}((?:\[[^\]\n]*\]|\{[^{}\n]*\})*)\s*$/;
const BEGIN_OPEN = /\\begin\{([A-Za-z@*]+)$/;
const END_OPEN = /\\end\{[A-Za-z@*]+$/;
const ITEM = /^(\s*)\\item\b(\s*\[[^\]\n]*\])?\s*/;
const SCAN_LIMIT = 200_000;
/** How long Enter in `\begin{name|}` or `\end{name|}` waits for the name's completion (as Tab-ahead does). */
const NAME_WAIT_MS = 400;

const escapeName = (name: string) => name.replace(/[*]/g, "\\*");
const code = (text: string) => text.replace(/(^|[^\\])%.*$/, "$1");
/** The body of `\begin{document}` stays at the environment's own indentation. */
const bodyIndented = (name: string) => name !== "document";

/** Whether an unclaimed `\end{name}` follows `from` (the environment is already closed). */
export function isEnvironmentClosed(state: EditorState, from: number, name: string): boolean {
  return findEnd(state, from, name) !== null;
}

/** The innermost environment open at `pos`: its name and the position of its `\begin`. */
export function enclosingEnvironment(state: EditorState, pos: number): { name: string; from: number } | null {
  const stop = Math.max(0, pos - SCAN_LIMIT);
  const closed = new Map<string, number>();
  let line = state.doc.lineAt(pos);
  let text = line.text.slice(0, pos - line.from);
  for (;;) {
    const found = [...code(text).matchAll(/\\(begin|end)\{([^{}\n]+)\}/g)];
    for (let i = found.length - 1; i >= 0; i--) {
      const [, kind, name] = found[i];
      const open = closed.get(name) ?? 0;
      if (kind === "end") closed.set(name, open + 1);
      else if (open > 0) closed.set(name, open - 1);
      else return { name, from: line.from + found[i].index! };
    }
    if (line.from <= stop || line.number === 1) return null;
    line = state.doc.line(line.number - 1);
    text = line.text;
  }
}

export const closeEnvironmentOnEnter: Command = (view) => closeEnvironment(view, true);

/** `wait`: while the name's completion is pending, wait for it instead of acting now. */
function closeEnvironment(view: EditorView, wait: boolean): boolean {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length > 1) return false;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const before = line.text.slice(0, sel.head - line.from);
  const after = line.text.slice(sel.head - line.from);
  const brace = /^\}\s*$/.test(after);
  let name: string | null = null;
  let insertAt = sel.head;
  const done = BEGIN_DONE.exec(before);
  if (done && after.trim() === "") {
    name = done[1];
  } else if (brace && END_OPEN.test(before)) {
    if (wait && completionStatus(state) !== null) return awaitName(view);
    return stepOverBrace(view);
  } else {
    const open = BEGIN_OPEN.exec(before);
    if (open && brace) {
      if (wait && completionStatus(state) !== null) return awaitName(view);
      name = open[1];
      insertAt = sel.head + 1;
    }
  }
  if (!name) return false;
  if (isEnvironmentClosed(state, line.to, name)) return insertAt > sel.head && stepOverBrace(view);
  const indent = /^\s*/.exec(line.text)![0];
  const unit = bodyIndented(name) ? state.facet(indentUnit) : "";
  const body = "\n" + indent + unit + (LIST_ENVIRONMENTS.has(name) ? "\\item " : "");
  view.dispatch({
    changes: { from: insertAt, to: line.to, insert: body + "\n" + indent + `\\end{${name}}` },
    selection: { anchor: insertAt + body.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/**
 * Enter in `\begin{name|}` / `\end{name|}` while completions load or the popup is inside
 * interactionDelay: swallow the Enter and wait like Tab-ahead. Accept the name when that
 * changes the text (`ali` -> align, whose snippet brings the `\end`); otherwise, or when
 * nothing comes in time, close the environment or step over the brace under the typed
 * name. Typing on or moving the cursor drops the Enter.
 */
function awaitName(view: EditorView): boolean {
  const { doc } = view.state;
  const head = view.state.selection.main.head;
  const deadline = Date.now() + NAME_WAIT_MS;
  const tick = () => {
    const s = view.state;
    const sel = s.selection.main;
    if (!view.dom.isConnected || s.doc !== doc || !sel.empty || sel.head !== head) return;
    const late = Date.now() > deadline;
    if (popupUsable(s) && acceptWouldChange(s)) {
      if (acceptCompletion(view)) return;
      if (!late) return void setTimeout(tick, 15); // inside interactionDelay
    } else if (!popupUsable(s) && completionStatus(s) !== null && !late) {
      return void setTimeout(tick, 15); // still loading
    }
    if (completionStatus(s) !== null) closeCompletion(view);
    closeEnvironment(view, false);
  };
  tick();
  return true;
}

/** Enter in `name|}`: step over closeBrackets' `}` and start an indented line after it. */
function stepOverBrace(view: EditorView): boolean {
  const { state } = view;
  const at = state.selection.main.head + 1;
  const line = state.doc.lineAt(at);
  const cols =
    getIndentation(new IndentContext(state, { simulateBreak: at }), at) ??
    countColumn(/^\s*/.exec(line.text)![0], state.tabSize);
  const insert = "\n" + indentString(state, cols);
  view.dispatch({
    changes: { from: at, to: line.to, insert },
    selection: { anchor: at + insert.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

export const continueItem: Command = (view) => {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length > 1) return false;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const item = ITEM.exec(line.text);
  if (!item || sel.head - line.from < item[0].length) return false;
  const env = enclosingEnvironment(state, line.from);
  if (!env || !LIST_ENVIRONMENTS.has(env.name)) return false;
  const indent = item[1];
  if (line.text.trim() === item[0].trim() && sel.head === line.to) {
    // `\item[(a)]` with no text yet: the text goes on the next line (a plain newline).
    if (item[2]) return false;
    return leaveList(view, line.from, line.to, env.name);
  }
  const insert = "\n" + indent + "\\item ";
  view.dispatch({
    changes: { from: sel.head, insert },
    selection: { anchor: sel.head + insert.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
};

/** Remove the empty `\item` line and continue after the list's `\end` (or dedent). */
function leaveList(view: Parameters<Command>[0], from: number, to: number, name: string): boolean {
  const { state } = view;
  const endLine = findEnd(state, to, name);
  if (endLine) {
    const lineIndent = /^\s*/.exec(endLine.text)![0];
    const removeTo = Math.min(to + 1, state.doc.length);
    const changes = state.changes([
      { from, to: removeTo },
      { from: endLine.to, insert: "\n" + lineIndent },
    ]);
    view.dispatch({
      changes,
      selection: { anchor: changes.mapPos(endLine.to, 1) },
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  }
  const text = state.sliceDoc(from, to);
  const indent = /^\s*/.exec(text)![0];
  const unit = state.facet(indentUnit);
  const outdented = indent.endsWith(unit) ? indent.slice(0, indent.length - unit.length) : "";
  view.dispatch({
    changes: { from, to, insert: outdented },
    selection: { anchor: from + outdented.length },
    userEvent: "input",
  });
  return true;
}

/** The line holding the first `\end{name}` after `from` not claimed by a later `\begin{name}`. */
function findEnd(state: EditorState, from: number, name: string) {
  const re = new RegExp(`\\\\(begin|end)\\{${escapeName(name)}\\}`, "g");
  const end = Math.min(state.doc.length, from + SCAN_LIMIT);
  let depth = 0;
  for (let pos = from; pos <= end; ) {
    const line = state.doc.lineAt(pos);
    const text = code(line.text.slice(pos - line.from));
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)); ) {
      if (m[1] === "begin") depth++;
      else if (depth-- === 0) return line;
    }
    if (line.to >= end) break;
    pos = line.to + 1;
  }
  return null;
}

/**
 * Indentation of the line that starts at `pos` (a line break CodeMirror is about to insert,
 * or an existing line when re-indenting): see the header. `undefined` leaves the line's
 * own indentation (CodeMirror's fallback without a syntax tree).
 */
export const latexIndent: Extension = indentService.of((cx, pos) => {
  const { doc } = cx.state;
  const line = doc.lineAt(pos);
  let prev: string;
  let prevFrom: number;
  let next: string;
  if (cx.simulatedBreak === pos) {
    prev = line.text.slice(0, pos - line.from);
    prevFrom = line.from;
    next = cx.textAfterPos(pos); // "" between brackets (CM's explode puts the closer below)
  } else if (pos === line.from && line.number > 1) {
    const p = doc.line(line.number - 1);
    prev = p.text;
    prevFrom = p.from;
    next = line.text;
  } else {
    return undefined;
  }
  if (/^\s*\\end\s*\{/.test(next)) {
    const env = enclosingEnvironment(cx.state, pos);
    return env ? cx.lineIndent(env.from) : undefined;
  }
  const text = code(prev).trimEnd();
  const base = cx.lineIndent(prevFrom, -1);
  const begin = BEGIN_DONE.exec(text);
  if (begin) return bodyIndented(begin[1]) ? base + cx.unit : base;
  if (/[{[(]$/.test(text)) return base + cx.unit;
  return undefined;
});

/** keyArbiter's LaTeX Enter hooks, in order (mathEnter: Enter in `\[|\]` or `$$|$$` opens a body line). */
export const latexEnterHooks: Command[] = [closeEnvironmentOnEnter, continueItem, mathEnter];
