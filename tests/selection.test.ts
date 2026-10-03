import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { texEditorExtensions } from "../src/editor/texExtensions";

test("nonempty selections remove the opaque active-line paint flag; empty carets restore it", () => {
  const text = "First line.\nSecond line.\nThird line.";
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: text, extensions: texEditorExtensions({ text }) }) });
  try {
    const doc = view.state.doc;
    assert.equal(view.dom.classList.contains("ll-has-selection"), false);
    for (const [anchor, head] of [[1, 31], [31, 1], [13, 18]]) {
      view.dispatch({ selection: { anchor, head } });
      assert.equal(view.dom.classList.contains("ll-has-selection"), true);
      assert.equal(view.state.doc, doc, "only painting changes; selected text stays unchanged");
      assert.equal(view.state.selection.main.anchor, anchor); assert.equal(view.state.selection.main.head, head);
      assert.ok(view.contentDOM.querySelector(".cm-activeLine"), "the active-line decoration remains available for empty selections");
    }
    view.dispatch({ selection: { anchor: 31 } }); assert.equal(view.dom.classList.contains("ll-has-selection"), false);
  } finally { view.destroy(); }
});
test("a secondary nonempty range is included without replacing other editor classes", () => {
  const text = "One.\nTwo.\nThree.";
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: text, extensions: [texEditorExtensions({ text }), EditorView.editorAttributes.of({ class: "other-editor-class" })] }) });
  try {
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.range(6, 13)]) });
    assert.ok(view.dom.classList.contains("ll-has-selection")); assert.ok(view.dom.classList.contains("other-editor-class"));
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(8)]) });
    assert.equal(view.dom.classList.contains("ll-has-selection"), false); assert.ok(view.dom.classList.contains("other-editor-class"));
  } finally { view.destroy(); }
});
