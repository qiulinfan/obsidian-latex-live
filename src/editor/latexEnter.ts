// Enter hooks for keyArbiter (run after the completion popup check, first match wins).
//
// closeEnvironmentOnEnter: Enter after `\begin{env}` closes the environment.
//   \begin{proof}|         ->  \begin{proof}
//                                |
//                              \end{proof}
// Applies when the cursor ends a `\begin{name}` (optionally followed by [..]/{..}
// arguments) with only whitespace after it, or sits in `\begin{name|}` with only `}`
// after it (closeBrackets inserted the brace). Skipped when a matching `\end{name}` that
// is not claimed by a later `\begin{name}` follows (the environment is already closed).
// List environments get their first `\item `.
//
// continueItem (UX-12): Enter on an `\item` line inside itemize/enumerate/description
// starts the next `\item`; Enter on an empty `\item` leaves the list.
//
// Heuristics: comments are ignored per line; verbatim-like environments are not special.
import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { Command } from "@codemirror/view";
import { LIST_ENVIRONMENTS } from "./latexCommands";
import { mathEnter } from "./shared/editorKit";

const BEGIN_DONE = /\\begin\{([A-Za-z@*]+)\}((?:\[[^\]\n]*\]|\{[^{}\n]*\})*)\s*$/;
const BEGIN_OPEN = /\\begin\{([A-Za-z@*]+)$/;
const ITEM = /^(\s*)\\item\b(?:\s*\[[^\]\n]*\])?\s*/;
const SCAN_LIMIT = 200_000;

const escapeName = (name: string) => name.replace(/[*]/g, "\\*");
const code = (text: string) => text.replace(/(^|[^\\])%.*$/, "$1");

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

export const closeEnvironmentOnEnter: Command = (view) => {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length > 1) return false;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const before = line.text.slice(0, sel.head - line.from);
  const after = line.text.slice(sel.head - line.from);
  let name: string | null = null;
  let insertAt = sel.head;
  const done = BEGIN_DONE.exec(before);
  if (done && after.trim() === "") {
    name = done[1];
  } else {
    const open = BEGIN_OPEN.exec(before);
    if (open && /^\}\s*$/.test(after)) {
      name = open[1];
      insertAt = sel.head + 1;
    }
  }
  if (!name || isEnvironmentClosed(state, line.to, name)) return false;
  const indent = /^\s*/.exec(line.text)![0];
  const body = "\n" + indent + state.facet(indentUnit) + (LIST_ENVIRONMENTS.has(name) ? "\\item " : "");
  view.dispatch({
    changes: { from: insertAt, to: line.to, insert: body + "\n" + indent + `\\end{${name}}` },
    selection: { anchor: insertAt + body.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
};

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

/** keyArbiter's LaTeX Enter hooks, in order (mathEnter: Enter in `\[|\]` or `$$|$$` opens a body line). */
export const latexEnterHooks: Command[] = [closeEnvironmentOnEnter, continueItem, mathEnter];
