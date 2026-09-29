// The LaTeX editor's real extension stack (texEditorExtensions) with a fake YOLO and the
// built-in completion layer (no texlab): key arbitration end to end, real DOM key events.
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { completionStatus, currentCompletions } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App } from "obsidian";
import { latexCompletionSource } from "../src/editor/latexCompletion";
import { YoloBridge } from "../src/editor/shared/yoloBridge";
import { texEditorExtensions } from "../src/editor/texExtensions";
import { FakeYolo, fakeYolo } from "./support/fakeYolo";
import { Ctx, diff, ghost, press, quietSettings, sleep, snap, typeText } from "./support/keyMatrix";

interface TexCtx extends Ctx {
  yolo: FakeYolo;
}

/** A LaTeX editor as TexView builds it; `|` marks the cursor. */
function make(text: string, edits: string[] = []): TexCtx {
  const cursor = text.indexOf("|");
  const doc = text.replace("|", "");
  const yolo = fakeYolo({ settings: quietSettings() });
  const app = { plugins: { plugins: { yolo: yolo.plugin } } };
  const flags = { enabled: true };
  const bridge = new YoloBridge(app as unknown as App, { name: "test", enabled: () => flags.enabled });
  const freshState = () =>
    EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: texEditorExtensions({
        text: doc,
        inline: () => bridge.inline,
        yolo: bridge.extension(() => "notes.tex"),
        completion: latexCompletionSource(null),
        onEdit: (view) => edits.push(view.state.doc.toString()),
      }),
    });
  const view = new EditorView({ state: freshState(), parent: document.body });
  view.focus();
  return { view, bridge, yolo, app, flags, freshState };
}

/** Wait for the completion query and the popup's interactionDelay. */
async function settle(view: EditorView) {
  await sleep(130);
  for (let i = 0; i < 100 && completionStatus(view.state) === "pending"; i++) await sleep(10);
  await sleep(90);
}

function done(c: TexCtx) {
  assert.deepEqual(c.yolo.hijacked, [], "YOLO's own keymap must never be mounted");
  c.view.destroy();
  c.bridge.destroy();
}

const line = (view: EditorView) => {
  const head = view.state.selection.main.head;
  const l = view.state.doc.lineAt(head);
  return l.text.slice(0, head - l.from) + "|" + l.text.slice(head - l.from);
};

test("popup: Tab accepts \\frac with fields; the ghost never competes", async () => {
  const c = make("x |");
  typeText(c.view, "\\fra");
  await settle(c.view);
  assert.equal(currentCompletions(c.view.state)[0]?.label, "frac");
  // YOLO's timer fires while the popup is open: the bridge hides the ghost at once.
  await ghost(c, "c{1}{2}", { timer: true });
  await sleep(0);
  assert.equal(snap(c).ghost, null);
  const r = press(c.view, "Tab");
  assert.equal(r.handled, true);
  assert.equal(line(c.view), "x \\frac{|}{}");
  done(c);
});

test("ghost: Tab accepts the raw AI text in one undo step; YOLO sees the .tex title", async () => {
  const c = make("We have $x |");
  await ghost(c, "< y$ for all <x>.");
  assert.equal(c.yolo.runCalls[0]?.title, "notes.tex");
  assert.equal(snap(c).ghost !== null, true);
  press(c.view, "Tab");
  assert.equal(c.view.state.doc.toString(), "We have $x < y$ for all <x>.", "no Markdown escaping");
  undo(c.view);
  assert.equal(c.view.state.doc.toString(), "We have $x ");
  done(c);
});

test("Enter after \\begin{itemize} closes it and dismisses a visible ghost", async () => {
  const c = make("\\begin{itemize}|");
  await ghost(c, "\\item first");
  const b = snap(c);
  press(c.view, "Enter");
  await sleep(0);
  assert.equal(diff(b, snap(c)), 'doc="\\\\begin{itemize}\\n    \\\\item \\n\\\\end{itemize}" sel=26 ai:"\\\\item first"->null');
  done(c);
});

test("smart Enter: an exact match makes a newline, Enter never accepts AI", async () => {
  const c = make("$|$");
  typeText(c.view, "\\alpha");
  await settle(c.view);
  assert.equal(currentCompletions(c.view.state)[0]?.label, "alpha");
  press(c.view, "Enter");
  assert.equal(c.view.state.doc.toString(), "$\\alpha\n$");
  done(c);

  const g = make("text|");
  await ghost(g, " more");
  press(g.view, "Enter");
  assert.equal(g.view.state.doc.toString(), "text\n");
  done(g);
});

test("Tab with nothing to accept inserts spaces mid-word, indents in leading space", () => {
  const c = make("    \\item te|xt");
  press(c.view, "Tab");
  // Spaces to the next indent stop (4-space unit), the line itself does not move.
  assert.equal(c.view.state.doc.toString(), "    \\item te    xt");
  c.view.dispatch({ selection: { anchor: 0 } });
  press(c.view, "Tab");
  assert.equal(c.view.state.doc.toString(), "        \\item te    xt");
  done(c);
});

test("Escape with nothing to close is swallowed but still reaches the document", () => {
  const c = make("a|");
  const r = press(c.view, "Escape");
  assert.deepEqual(r, { handled: true, propagated: true });
  done(c);
});

test("$ pairs, wraps a selection, and $|$ + $ becomes display math; \\[ gets its \\]", () => {
  const c = make("see |");
  const input = (text: string) => {
    const { from, to } = c.view.state.selection.main;
    const handled = c.view.state.facet(EditorView.inputHandler).some((h) => h(c.view, from, to, text, () => c.view.state.update({ changes: { from, to, insert: text } })));
    if (!handled) c.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  };
  input("$");
  assert.equal(line(c.view), "see $|$");
  input("$");
  assert.equal(line(c.view), "see $$|$$");
  c.view.dispatch({ changes: { from: 0, to: c.view.state.doc.length, insert: "area x^2 here" }, selection: { anchor: 5, head: 8 } });
  input("$");
  assert.equal(c.view.state.doc.toString(), "area $x^2$ here");
  c.view.dispatch({ changes: { from: 0, to: c.view.state.doc.length, insert: "a \\" }, selection: { anchor: 3 } });
  input("[");
  assert.equal(line(c.view), "a \\[|\\]");
  c.view.dispatch({ changes: { from: 0, to: c.view.state.doc.length, insert: "$$" }, selection: { anchor: 1 } });
  press(c.view, "Backspace");
  assert.equal(c.view.state.doc.toString(), "", "Backspace deletes an empty $|$ pair");
  done(c);
});

test("edits are reported once committed; an IME composition waits for compositionend", async () => {
  const edits: string[] = [];
  const c = make("|", edits);
  typeText(c.view, "a");
  assert.equal(edits.length, 1);
  c.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  typeText(c.view, "ni");
  assert.equal(edits.length, 1, "nothing saved or synced mid-composition");
  c.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await sleep(10);
  assert.equal(edits.at(-1), "ani");
  done(c);
});
