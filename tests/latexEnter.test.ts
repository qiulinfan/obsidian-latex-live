import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { enclosingEnvironment, isEnvironmentClosed } from "../src/editor/latexEnter";
import { texEditorExtensions } from "../src/editor/texExtensions";
import { press } from "./support/keyMatrix";

/** The real editor stack (keyArbiter + Enter hooks); `|` marks the cursor. */
function editor(text: string): EditorView {
  const cursor = text.indexOf("|");
  const doc = text.replace("|", "");
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: texEditorExtensions({ text: doc }) }),
    parent: document.body,
  });
  view.focus();
  return view;
}

/** Press Enter; the document with `|` at the cursor. */
function enter(text: string): string {
  const view = editor(text);
  press(view, "Enter");
  const head = view.state.selection.main.head;
  const out = view.state.sliceDoc(0, head) + "|" + view.state.sliceDoc(head);
  view.destroy();
  return out;
}

test("Enter after \\begin{env} closes the environment (4-space unit by default)", () => {
  assert.equal(enter("\\begin{proof}|"), "\\begin{proof}\n    |\n\\end{proof}");
  assert.equal(enter("  \\begin{tabular}{ll}|"), "  \\begin{tabular}{ll}\n      |\n  \\end{tabular}");
  assert.equal(enter("\\begin{proof|}"), "\\begin{proof}\n    |\n\\end{proof}", "inside closeBrackets' brace");
  assert.equal(enter("\\begin{theorem}[Title]{label}|"), "\\begin{theorem}[Title]{label}\n    |\n\\end{theorem}");
});

test("list environments start with \\item", () => {
  assert.equal(enter("\\begin{itemize}|"), "\\begin{itemize}\n    \\item |\n\\end{itemize}");
  assert.equal(enter("\\begin{enumerate}|"), "\\begin{enumerate}\n    \\item |\n\\end{enumerate}");
});

test("an environment that is already closed only gets a newline", () => {
  assert.equal(enter("\\begin{align}|\n\\end{align}"), "\\begin{align}\n|\n\\end{align}");
  // A later pair of the same name does not count as the closer.
  assert.equal(
    enter("\\begin{itemize}|\n\\begin{itemize}\n\\end{itemize}"),
    "\\begin{itemize}\n    \\item |\n\\end{itemize}\n\\begin{itemize}\n\\end{itemize}",
  );
  // A commented-out \end does not count either.
  assert.equal(enter("\\begin{proof}|\n% \\end{proof}"), "\\begin{proof}\n    |\n\\end{proof}\n% \\end{proof}");
  // Text after the cursor: a plain newline.
  assert.ok(!enter("\\begin{itemize}| foo").includes("\\end"));
});

test("Enter on an \\item line continues the list; an empty \\item leaves it", () => {
  assert.equal(
    enter("\\begin{itemize}\n    \\item first|\n\\end{itemize}"),
    "\\begin{itemize}\n    \\item first\n    \\item |\n\\end{itemize}",
  );
  assert.equal(
    enter("\\begin{enumerate}\n  \\item[(a)] first|\n\\end{enumerate}"),
    "\\begin{enumerate}\n  \\item[(a)] first\n  \\item |\n\\end{enumerate}",
  );
  // Leaving: the empty item goes, the cursor continues after \end{itemize}.
  assert.equal(
    enter("x\n\\begin{itemize}\n    \\item first\n    \\item |\n\\end{itemize}\nafter"),
    "x\n\\begin{itemize}\n    \\item first\n\\end{itemize}\n|\nafter",
  );
  // Nested lists continue the innermost one.
  assert.equal(
    enter("\\begin{itemize}\n  \\item a\n  \\begin{enumerate}\n    \\item b|\n  \\end{enumerate}\n\\end{itemize}"),
    "\\begin{itemize}\n  \\item a\n  \\begin{enumerate}\n    \\item b\n    \\item |\n  \\end{enumerate}\n\\end{itemize}",
  );
  // Not a list, or the cursor before the \item: a plain newline.
  assert.ok(!enter("\\begin{center}\n\\item x|\n\\end{center}").includes("\\item x\n\\item"));
  assert.ok(!enter("\\begin{itemize}\n|\\item x\n\\end{itemize}").includes("\\item \n"));
});

test("Enter between \\[ \\] and $$ $$ opens an indented body line", () => {
  assert.equal(enter("\\[|\\]"), "\\[\n    |\n\\]");
  assert.equal(enter("$$|$$"), "$$\n    |\n$$");
});

test("isEnvironmentClosed and enclosingEnvironment", () => {
  const state = EditorState.create({
    doc: "\\begin{itemize}\n\\item a\n\\begin{center}x\\end{center}\n\\item b\n\\end{itemize}",
  });
  assert.equal(isEnvironmentClosed(state, 15, "itemize"), true);
  assert.equal(isEnvironmentClosed(state, 15, "proof"), false);
  const inB = state.doc.toString().indexOf("\\item b");
  assert.deepEqual(enclosingEnvironment(state, inB), { name: "itemize", from: 0 });
  const inX = state.doc.toString().indexOf("x\\end");
  assert.equal(enclosingEnvironment(state, inX)?.name, "center");
  assert.equal(enclosingEnvironment(state, state.doc.length), null);
});
