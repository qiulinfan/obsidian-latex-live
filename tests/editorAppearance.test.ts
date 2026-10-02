import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEditorAppearance, type EditorAppearance } from "../src/editor/editorAppearance";

const defaults: EditorAppearance = {
  editorFontSize: 0,
  editorLineHeight: 0,
  editorFontFamily: "",
  mathPreviewScale: 1,
};
const variables = ["--font-text-size", "--line-height-normal", "--ll-editor-font-family", "--ll-math-preview-scale", "--ll-editor-math-font-size"];
const values = (element: HTMLElement) => variables.map(name => element.style.getPropertyValue(name));

test("editor appearance: overrides stay on one container and preserve unrelated styles", () => {
  const parent = document.createElement("div");
  parent.style.setProperty("--font-text-size", "17px");
  const editor = parent.appendChild(document.createElement("div"));
  const sibling = parent.appendChild(document.createElement("div"));
  editor.style.setProperty("color", "red");
  editor.style.setProperty("--unrelated", "retained");
  const parentBefore = parent.style.cssText, bodyBefore = document.body.style.cssText;
  applyEditorAppearance(editor, {
    editorFontSize: 21,
    editorLineHeight: 1.75,
    editorFontFamily: '"JetBrains Mono", monospace',
    mathPreviewScale: 1.25,
  });
  assert.deepEqual(values(editor), ["21px", "1.75", '"JetBrains Mono", monospace', "1.25", "21px"]);
  assert.equal(editor.style.color, "red");
  assert.equal(editor.style.getPropertyValue("--unrelated"), "retained");
  assert.equal(parent.style.cssText, parentBefore);
  assert.equal(document.body.style.cssText, bodyBefore);
  assert.deepEqual(values(sibling), ["", "", "", "", ""]);
});

test("editor appearance: following the host removes local properties instead of hardcoding defaults", () => {
  const parent = document.createElement("div"), editor = parent.appendChild(document.createElement("div"));
  for (const name of variables) parent.style.setProperty(name, "inherited");
  applyEditorAppearance(editor, { editorFontSize: 22, editorLineHeight: 1.8, editorFontFamily: "Menlo", mathPreviewScale: 1.5 });
  applyEditorAppearance(editor, { ...defaults, editorFontFamily: "  \t  " });
  assert.deepEqual(values(editor), ["", "", "", "", ""]);
  assert.deepEqual(values(parent), ["inherited", "inherited", "inherited", "inherited", "inherited"]);
  applyEditorAppearance(editor, defaults);
  assert.equal(editor.style.length, 0);
});

test("editor appearance: positive out-of-range values stay within supported typography bounds", () => {
  const editor = document.createElement("div");
  applyEditorAppearance(editor, { ...defaults, editorFontSize: 1, editorLineHeight: 0.1, mathPreviewScale: 0 });
  assert.deepEqual(values(editor), ["10px", "1.1", "", "0.5", "10px"]);
  applyEditorAppearance(editor, { ...defaults, editorFontSize: 1000, editorLineHeight: 1000, mathPreviewScale: 1000 });
  assert.deepEqual(values(editor), ["40px", "2.4", "", "2", "40px"]);
});

test("editor appearance: invalid persisted values clear stale overrides without emitting invalid CSS", () => {
  const editor = document.createElement("div");
  for (const value of [NaN, Infinity, -Infinity, "20", null, undefined]) {
    applyEditorAppearance(editor, { editorFontSize: 20, editorLineHeight: 1.6, editorFontFamily: "Menlo", mathPreviewScale: 1.2 });
    applyEditorAppearance(editor, {
      editorFontSize: value,
      editorLineHeight: value,
      editorFontFamily: 42,
      mathPreviewScale: value,
    } as unknown as EditorAppearance);
    assert.deepEqual(values(editor), ["", "", "", "", ""]);
  }
  applyEditorAppearance(editor, { ...defaults, editorFontSize: -1, editorLineHeight: -1, mathPreviewScale: -1 });
  assert.deepEqual(values(editor), ["", "", "", "0.5", ""]);
});

test("editor appearance: CSS font lists are trimmed and applied as one local property", () => {
  const editor = document.createElement("div");
  applyEditorAppearance(editor, { ...defaults, editorFontFamily: '  "Fira Code", Menlo, monospace  ' });
  assert.equal(editor.style.getPropertyValue("--ll-editor-font-family"), '"Fira Code", Menlo, monospace');
  assert.equal(editor.style.length, 1);
});
