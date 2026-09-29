import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as autocomplete from "@codemirror/autocomplete";
import { Completion } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { EditorState, StateField } from "@codemirror/state";
import { Command, EditorView } from "@codemirror/view";
import type { App } from "obsidian";
import { acceptWouldChange, keyArbiter } from "../src/editor/shared/keyArbiter";
import { YoloBridge, bindYolo } from "../src/editor/shared/yoloBridge";
import { FakeYolo, fakeYolo } from "./support/fakeYolo";
import {
  Ctx, GOLDEN, KEYS, STATES, SetupOptions, applySnippet, diff, ghost, matrixRow, openPopup, press, quietSettings,
  settle, setup, sleep, snap, triggerSettings, typeText,
} from "./support/keyMatrix";

let last: FakeYolo | null = null;
const makeFake = (o: Parameters<typeof fakeYolo>[0] = {}) => (last = fakeYolo(o));
const make = (o: SetupOptions = {}) => setup(makeFake, o);
const yoloOf = (c: Ctx) => c.yolo as FakeYolo;
const done = (c: Ctx) => {
  c.view.destroy();
  c.bridge.destroy();
};
// CM's internal Escape-then-Tab focus escape: -1 when off.
const tabFocusMode = (view: EditorView) => (view as unknown as { inputState: { tabFocusMode: number } }).inputState.tabFocusMode;

// ---- golden matrix (70 rows) -------------------------------------------------------------
for (const state of Object.keys(STATES)) {
  test(`matrix: ${state} x ${KEYS.join(", ")}`, async () => {
    const hijacked: string[] = [];
    const row = await matrixRow(makeFake, state, () => hijacked.push(...last!.hijacked));
    assert.deepEqual(row, GOLDEN[state]);
    assert.deepEqual(hijacked, [], "YOLO's own keymap must never be mounted");
  });
}

test("the arbiter's autocomplete imports exist in the pinned version", () => {
  for (const k of [
    "acceptCompletion", "clearSnippet", "closeCompletion", "completionStatus", "currentCompletions",
    "hasNextSnippetField", "hasPrevSnippetField", "moveCompletionSelection", "nextSnippetField",
    "prevSnippetField", "selectedCompletion", "selectedCompletionIndex",
  ]) assert.equal(typeof (autocomplete as Record<string, unknown>)[k], "function", k);
});

// ---- Enter ----------------------------------------------------------------------------------
test("X1 smart Enter: an exact match inserts a newline, a prefix accepts", async () => {
  for (const [typed, want] of [
    ["\\alpha", 'doc="\\\\alpha\\n" sel=7 popup:active->null'],
    ["\\alp", 'doc="\\\\alpha" sel=6 popup:active->null'],
  ]) {
    const c = make();
    typeText(c.view, typed);
    await openPopup(c.view);
    const b = snap(c);
    press(c.view, "Enter");
    await sleep(0);
    assert.equal(diff(b, snap(c)), want, typed);
    done(c);
  }
});

test("X1b smart Enter dry-runs function applies (LSP-style items)", async () => {
  const lspLike = (text: string): Completion => ({
    label: text,
    apply: (view, completion, from, to) => view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      annotations: autocomplete.pickedCompletion.of(completion),
    }),
  });
  const touchesView = (text: string): Completion => ({
    label: text,
    apply: (view, completion, from, to) => {
      view.focus(); // not on the dry-run stand-in: counts as a change, so Enter accepts
      view.dispatch({ changes: { from, to, insert: text }, annotations: autocomplete.pickedCompletion.of(completion) });
    },
  });
  for (const [options, typed, changes, want] of [
    [[lspLike("\\alpha")], "\\alpha", false, 'doc="\\\\alpha\\n" sel=7 popup:active->null'],
    [[lspLike("\\alpha")], "\\alp", true, 'doc="\\\\alpha" sel=6 popup:active->null'],
    [[touchesView("\\alpha")], "\\alpha", true, "popup:active->null"],
  ] as [Completion[], string, boolean, string][]) {
    const c = make({ options });
    typeText(c.view, typed);
    await openPopup(c.view);
    assert.equal(acceptWouldChange(c.view.state), changes, typed);
    const b = snap(c);
    press(c.view, "Enter");
    await sleep(0);
    assert.equal(diff(b, snap(c)), want, typed);
    done(c);
  }
});

test("X3b Enter inside interactionDelay inserts a newline", async () => {
  const c = make();
  typeText(c.view, "a \\fr");
  await openPopup(c.view, { settleMs: 0 });
  const b = snap(c);
  press(c.view, "Enter");
  assert.equal(diff(b, snap(c)), 'doc="a \\\\fr\\n" sel=6 popup:active->null');
  done(c);
});

test("Enter hooks run after the popup check, in order, first true wins", async () => {
  const calls: string[] = [];
  const hook = (name: string, result: boolean): Command => (view) => {
    calls.push(name);
    if (result) view.dispatch(view.state.replaceSelection(`<${name}>`));
    return result;
  };
  const c = make({ enter: [hook("a", false), hook("b", true), hook("c", true)] });
  typeText(c.view, "x");
  await settle(c.view);
  press(c.view, "Enter");
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(c.view.state.doc.toString(), "x<b>");
  // A usable popup takes Enter before any hook.
  calls.length = 0;
  typeText(c.view, " \\alp");
  await openPopup(c.view);
  press(c.view, "Enter");
  assert.deepEqual(calls, []);
  assert.equal(c.view.state.doc.toString(), "x<b> \\alpha");
  done(c);
});

test("L+G: an Enter hook wins over a visible ghost, which is dismissed", async () => {
  const close: Command = (view) => {
    view.dispatch(view.state.replaceSelection("\n  \n\\end{itemize}"));
    view.dispatch({ selection: { anchor: 18 } });
    return true;
  };
  const c = make({ doc: "\\begin{itemize}", enter: close });
  c.view.dispatch({ selection: { anchor: 15 } });
  await ghost(c, "\\item first");
  const b = snap(c);
  press(c.view, "Enter");
  await sleep(0);
  assert.equal(diff(b, snap(c)), 'doc="\\\\begin{itemize}\\n  \\n\\\\end{itemize}" sel=18 ai:"\\\\item first"->null');
  done(c);
});

// ---- Tab-ahead --------------------------------------------------------------------------------
test("X2 Tab before the popup is usable accepts once it is", async () => {
  const c = make();
  typeText(c.view, "a \\fr");
  const b = snap(c);
  assert.equal(b.cmp, "pending");
  const r = press(c.view, "Tab");
  assert.equal(r.handled, true);
  assert.equal(diff(b, snap(c)), "no-op");
  await sleep(350);
  assert.equal(diff(b, snap(c)), 'doc="a \\\\frac{}{}" sel=8 popup:pending->null snippet:off->f0');
  done(c);
});

test("X2b Tab-ahead with nothing to accept is a no-op (never indents mid-word)", async () => {
  const c = make();
  typeText(c.view, "a zz");
  const b = snap(c);
  assert.equal(b.cmp, "pending");
  press(c.view, "Tab");
  await sleep(350);
  assert.equal(diff(b, snap(c)), "popup:pending->null");
  done(c);
});

test("X3 Tab inside interactionDelay accepts when the delay ends", async () => {
  const c = make();
  typeText(c.view, "a \\fr");
  await openPopup(c.view, { settleMs: 0 });
  const b = snap(c);
  press(c.view, "Tab");
  assert.equal(diff(b, snap(c)), "no-op");
  await sleep(150);
  assert.equal(diff(b, snap(c)), 'doc="a \\\\frac{}{}" sel=8 popup:active->null snippet:off->f0');
  done(c);
});

test("X2c Tab while loading inside a snippet field moves to the next field", async () => {
  const c = make();
  typeText(c.view, "a ");
  await settle(c.view);
  applySnippet(c.view, "\\frac{${1}}{${2}}");
  typeText(c.view, "\\al");
  const b = snap(c);
  assert.equal(b.cmp, "pending");
  press(c.view, "Tab");
  await sleep(300);
  assert.equal(diff(b, snap(c)), "sel=13 popup:pending->null snippet:f0->off");
  done(c);
});

test("X2d Tab-ahead waits for an async source, up to the deadline", async () => {
  for (const [ms, wait, want] of [
    [40, 400, 'doc="a \\\\frac{}{}" sel=8 popup:pending->null snippet:off->f0'],
    [700, 900, "popup:pending->active"],
  ] as [number, number, string][]) {
    const c = make({ sourceDelay: ms });
    typeText(c.view, "a \\fr");
    const b = snap(c);
    press(c.view, "Tab");
    await sleep(wait);
    assert.equal(diff(b, snap(c)), want, `${ms} ms`);
    done(c);
  }
});

test("without an inline provider or options the arbiter still owns the keys", async () => {
  const view = new EditorView({
    state: EditorState.create({ doc: "x", extensions: [keyArbiter(), autocomplete.autocompletion({ override: [] })] }),
    parent: document.body,
  });
  view.dispatch({ selection: { anchor: 1 } });
  const r = press(view, "Escape");
  assert.deepEqual(r, { handled: true, propagated: true });
  assert.equal(tabFocusMode(view), -1);
  view.destroy();
});

// ---- the YOLO bridge ----------------------------------------------------------------------------
test("X5 non-user doc changes clear YOLO (no invisible accept)", async () => {
  for (const [label, spec, tab] of [
    ["external, no selection", (v: EditorView) => ({
      changes: { from: 0, to: v.state.doc.length, insert: v.state.doc.toString() + "\n% synced" },
    }), 'doc="  x = 1\\n% tail\\n% synced" sel=2'],
    ["external, selection kept", (v: EditorView) => ({
      changes: { from: 0, to: v.state.doc.length, insert: v.state.doc.toString() + "\n% synced" },
      selection: { anchor: v.state.selection.main.head },
    }), 'doc="  x = 1\\n% tail\\n% synced" sel=7'],
    ["LSP edit after the cursor", (v: EditorView) => ({ changes: { from: v.state.doc.length, insert: "!" } }),
      'doc="  x = 1\\n% tail!" sel=7'],
  ] as [string, (v: EditorView) => object, string][]) {
    const c = make({ doc: "x = 1\n% tail" });
    c.view.dispatch({ selection: { anchor: 5 } });
    await ghost(c, " + 2");
    assert.equal(snap(c).ai, "+ 2");
    c.view.dispatch(spec(c.view));
    await sleep(0);
    const mid = snap(c);
    assert.deepEqual({ ai: mid.ai, ghost: mid.ghost, armed: mid.armed }, { ai: null, ghost: null, armed: false }, label);
    press(c.view, "Tab");
    await sleep(0);
    assert.equal(diff(mid, snap(c)), tab, label);
    done(c);
  }
});

test("X7 user edits arm YOLO through its own trigger path with the file name", async () => {
  const c = make({ settings: triggerSettings({ idleTriggerEnabled: false }) });
  for (const ch of "we have x, ") {
    typeText(c.view, ch);
    await sleep(5);
  }
  await sleep(0);
  assert.equal(snap(c).armed, true);
  await sleep(80);
  assert.deepEqual(yoloOf(c).runCalls, [{ title: "notes.typ", head: 11, replaceFromOffset: null }]);
  assert.equal(snap(c).ai, "(generating)");
  // Non-user changes never arm.
  c.view.dispatch({ changes: { from: c.view.state.doc.length, insert: "y, " } });
  await sleep(80);
  assert.equal(yoloOf(c).runCalls.length, 1);
  done(c);
});

test("X8 no arming while the popup is visible; closing it arms", async () => {
  const c = make({ settings: triggerSettings({ idleTriggerEnabled: true, autoTriggerDelayMs: 60 }) });
  typeText(c.view, "some text \\fr");
  await openPopup(c.view);
  typeText(c.view, "a");
  await sleep(0);
  assert.equal(snap(c).armed, false);
  await sleep(100);
  assert.equal(yoloOf(c).runCalls.length, 0);
  press(c.view, "Escape");
  await sleep(0);
  assert.equal(snap(c).armed, true);
  await sleep(100);
  assert.equal(yoloOf(c).runCalls.length, 1);
  done(c);
});

test("X9 a ghost arriving under the popup is dismissed (popup wins)", async () => {
  const c = make();
  typeText(c.view, "a \\fr");
  await openPopup(c.view);
  await ghost(c, "ac{1}{2}", { timer: true });
  await sleep(0);
  const s = snap(c);
  assert.deepEqual({ ai: s.ai, ghost: s.ghost, cmp: s.cmp }, { ai: null, ghost: null, cmp: "active" });
  done(c);
});

test("triggerNow closes an open popup so the ghost can show", async () => {
  const c = make();
  typeText(c.view, "a \\fr");
  await openPopup(c.view);
  await ghost(c, "ac{1}{2}");
  await sleep(0);
  const s = snap(c);
  assert.deepEqual({ ai: s.ai, ghost: s.ghost, cmp: s.cmp }, { ai: "ac{1}{2}", ghost: "ac{1}{2}", cmp: null });
  done(c);
});

test("X10 the title patch chains across two bridges and uninstalls in either order", async () => {
  const yolo = fakeYolo({ settings: quietSettings() });
  const app = { plugins: { plugins: { yolo: yolo.plugin } } } as unknown as App;
  const b1 = new YoloBridge(app, { name: "tinymist", enabled: () => true });
  const b2 = new YoloBridge(app, { name: "latex", enabled: () => true });
  const mk = (b: YoloBridge, title: string) => {
    const v = new EditorView({
      state: EditorState.create({ doc: "hello world, ", extensions: [keyArbiter({ inline: () => b.inline }), b.extension(() => title)] }),
      parent: document.body,
    });
    v.dispatch({ selection: { anchor: 13 } });
    return v;
  };
  const v1 = mk(b1, "a.typ");
  const v2 = mk(b2, "b.tex");
  await sleep(0);
  b1.triggerNow(v1);
  b2.triggerNow(v2);
  assert.deepEqual(yolo.runCalls.map((r) => r.title), ["a.typ", "b.tex"]);
  const title = () => yolo.tab.deps.getActiveFileTitle();
  b1.destroy(); // the inner wrapper first
  b2.triggerNow(v2);
  assert.equal(yolo.runCalls[2].title, "b.tex");
  yolo.tab.tabCompletionPending = { editor: {} }; // a Markdown editor: YOLO's own title
  assert.equal(title(), "yolo-basename");
  b2.destroy();
  yolo.tab.tabCompletionPending = null;
  assert.equal(title(), "yolo-basename");
  v1.destroy();
  v2.destroy();
});

test("X11 a reloaded YOLO is remounted and the old one released", async () => {
  const c = make();
  typeText(c.view, "x = 1");
  await settle(c.view);
  await ghost(c, " + 2");
  const old = yoloOf(c);
  const fresh = fakeYolo({ settings: quietSettings() });
  c.app.plugins.plugins.yolo = fresh.plugin;
  c.view.dispatch({ selection: { anchor: 5 } }); // any update notices the swap
  await sleep(5);
  c.yolo = fresh;
  await ghost(c, " * 3");
  assert.equal(old.tab.tabCompletionSuggestion, null);
  assert.equal(snap(c).ghost, "* 3");
  press(c.view, "Tab");
  assert.equal(c.view.state.doc.toString(), "x = 1* 3");
  assert.deepEqual([...old.hijacked, ...fresh.hijacked], []);
  done(c);
});

test("X12 YOLO disabled at runtime: ghost gone, Tab indents", async () => {
  const c = make();
  typeText(c.view, "x = 1");
  await settle(c.view);
  await ghost(c, " + 2");
  delete c.app.plugins.plugins.yolo;
  c.view.dispatch({ selection: { anchor: 5 } });
  await sleep(5);
  const b = snap(c);
  assert.equal(b.ghost, null);
  press(c.view, "Tab");
  assert.equal(diff(b, snap(c)), 'doc="  x = 1" sel=7');
  assert.equal(c.bridge.describe(), "YOLO not available");
  done(c);
});

test("X13 a throwing YOLO disables the bridge once and keys keep working", async () => {
  const c = make({ settings: triggerSettings() });
  yoloOf(c).plugin.handleTabCompletionEditorChange = () => {
    throw new Error("boom");
  };
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try {
    typeText(c.view, "a \\fr");
    await sleep(0);
    await sleep(0);
  } finally {
    console.error = origError;
  }
  await openPopup(c.view);
  const b = snap(c);
  press(c.view, "Tab");
  await sleep(0);
  assert.equal(c.bridge.describe(), "disabled after an error: boom");
  assert.equal(errors.length, 1);
  assert.equal(diff(b, snap(c)), 'doc="a \\\\frac{}{}" sel=8 popup:active->null snippet:off->f0');
  const fields = (yoloOf(c).inline.createExtension() as unknown[]).filter((e) => e instanceof StateField) as StateField<unknown>[];
  assert.equal(fields.filter((f) => c.view.state.field(f, false) !== undefined).length, 0);
  done(c);
});

test("X13b toggling the setting unmounts and remounts", async () => {
  const c = make();
  typeText(c.view, "x = 1");
  await settle(c.view);
  await ghost(c, " + 2");
  c.flags.enabled = false;
  c.bridge.refresh();
  await sleep(5);
  const off = snap(c);
  assert.deepEqual([off.ghost, off.ai], [null, null]);
  c.flags.enabled = true;
  c.bridge.refresh();
  await sleep(5);
  await ghost(c, " + 9");
  assert.equal(snap(c).ghost, "+ 9");
  done(c);
});

test("bindYolo rejects unexpected YOLO shapes", () => {
  assert.equal(bindYolo({}), "missing plugin.getInlineSuggestionController()");
  const y = fakeYolo();
  assert.equal(typeof bindYolo(y.plugin), "object");
  const inline = y.inline as unknown as { createExtension(): unknown[] };
  const orig = inline.createExtension.bind(inline);
  inline.createExtension = () => orig().filter((e) => e instanceof StateField);
  assert.equal(bindYolo(y.plugin), "unexpected createExtension() shape (0 keymaps, 1 fields)");
});

test("negative control: YOLO's unfiltered keymap would hijack Tab", async () => {
  const y = fakeYolo();
  const view = new EditorView({
    state: EditorState.create({ doc: "x", extensions: y.inline.createExtension() as never }),
    parent: document.body,
  });
  press(view, "Tab");
  assert.deepEqual(y.hijacked, ["Tab"]);
  view.destroy();
});

test("X14 Escape: consumed ones stop at the editor, unhandled ones propagate; no focus escape", async () => {
  const cases: [string, (c: Ctx) => Promise<void>, boolean, number][] = [
    ["popup", async (c) => { typeText(c.view, "a \\fr"); await openPopup(c.view); }, false, 0],
    ["ghost", async (c) => { typeText(c.view, "x = 1"); await settle(c.view); await ghost(c, " + 2"); }, false, 1],
    ["ghost pending", async (c) => {
      typeText(c.view, "x = 1"); await settle(c.view); await ghost(c, "", { pending: true });
    }, false, 1],
    ["snippet", async (c) => { applySnippet(c.view, "\\frac{${1}}{${2}}"); await sleep(0); }, false, 0],
    ["nothing", async (c) => { typeText(c.view, "x = 1"); await settle(c.view); }, true, 0],
  ];
  for (const [label, prep, reachesDocument, controllers] of cases) {
    const c = make();
    await prep(c);
    assert.equal(yoloOf(c).activeAbortControllers.size, controllers, label);
    const r = press(c.view, "Escape");
    const t = press(c.view, "Tab");
    await sleep(0);
    assert.deepEqual(
      { handled: r.handled, reachedDocument: r.propagated, controllers: yoloOf(c).activeAbortControllers.size, tab: t.handled, tabFocus: tabFocusMode(c.view) },
      { handled: true, reachedDocument: reachesDocument, controllers: 0, tab: true, tabFocus: -1 },
      label,
    );
    done(c);
  }
});

test("X15 Shift-Tab dismisses a visible ghost only; a pending one is cancelled silently", async () => {
  const indented = async (c: Ctx) => {
    c.view.dispatch({ changes: { from: 0, insert: "  x = 1" }, selection: { anchor: 7 } });
    await sleep(0);
  };
  const cases: [string, (c: Ctx) => Promise<void>, string, string][] = [
    ["visible", async (c) => { await indented(c); await ghost(c, " + 2"); }, 'ai:"+ 2"->null', 'doc="x = 1" sel=5'],
    ["pending", async (c) => { await indented(c); await ghost(c, "", { pending: true }); },
      'doc="x = 1" sel=5 ai:"(generating)"->null', "no-op"],
    ["in snippet field 2", async (c) => {
      applySnippet(c.view, "\\frac{${1}}{${2}}${0}");
      await sleep(0);
      press(c.view, "Tab");
      await sleep(0);
      await ghost(c, "b");
    }, 'ai:"b"->null', "sel=6 snippet:f>0->f0"],
  ];
  for (const [label, prep, first, second] of cases) {
    const c = make();
    await prep(c);
    const b = snap(c);
    const r = press(c.view, "Shift-Tab");
    await sleep(0);
    const a1 = snap(c);
    press(c.view, "Shift-Tab");
    await sleep(0);
    assert.deepEqual([r.handled, diff(b, a1), diff(a1, snap(c))], [true, first, second], label);
    done(c);
  }
});

test("X16 Tab inserts the raw candidate (no Markdown escaping) as one undo step", async () => {
  const c = make();
  typeText(c.view, "= Intro ");
  await settle(c.view);
  await ghost(c, "<intro>\nSee @intro, and $x> 0$.");
  press(c.view, "Tab");
  assert.equal(c.view.state.doc.toString(), "= Intro <intro>\nSee @intro, and $x> 0$.");
  undo(c.view);
  assert.equal(c.view.state.doc.toString(), "= Intro ");
  done(c);
});

test("X16b a replace trigger's range is replaced on accept", async () => {
  const c = make();
  typeText(c.view, "ab: ");
  await settle(c.view);
  c.bridge.triggerNow(c.view);
  yoloOf(c).tab.tabCompletionSuggestion!.replaceFromOffset = 2;
  yoloOf(c).respond(" := value");
  await sleep(0);
  press(c.view, "Tab");
  assert.equal(c.view.state.doc.toString(), "ab:= value");
  done(c);
});

test("X17 setState (file switch) and destroy release YOLO's suggestion", async () => {
  const c = make();
  typeText(c.view, "x = 1");
  await settle(c.view);
  await ghost(c, " + 2");
  c.view.setState(c.freshState());
  await sleep(0);
  assert.equal(yoloOf(c).tab.tabCompletionSuggestion, null);
  typeText(c.view, "y = 2");
  await settle(c.view);
  await ghost(c, " + 3");
  assert.equal(snap(c).ai, "+ 3");
  c.view.destroy();
  await sleep(0);
  assert.equal(yoloOf(c).tab.tabCompletionSuggestion, null);
  c.bridge.destroy();
});

test("X18 compositionstart dismisses and disarms", async () => {
  const c = make({ settings: triggerSettings() });
  typeText(c.view, "x, ");
  await sleep(0);
  assert.equal(snap(c).armed, true);
  c.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  await sleep(0);
  assert.equal(snap(c).armed, false);
  await sleep(80);
  assert.equal(yoloOf(c).runCalls.length, 0);
  done(c);
});

test("X19 Backspace while generating deletes and re-arms", async () => {
  const c = make({ settings: triggerSettings({ idleTriggerEnabled: false }) });
  typeText(c.view, "x, y");
  await sleep(0);
  await ghost(c, "", { pending: true });
  const b = snap(c);
  const r = press(c.view, "Backspace");
  await sleep(0);
  assert.equal(r.handled, true);
  assert.equal(diff(b, snap(c)), 'doc="x, " sel=3 ai:"(generating)"->null');
  assert.equal(snap(c).armed, true);
  done(c);
});

test("X21 arrows cycle two or more candidates, otherwise move the cursor", async () => {
  const setupGhost = async (second: string | null) => {
    const c = make({ doc: "x = 1\nnext line" });
    c.view.dispatch({ selection: { anchor: 5 } });
    await sleep(0);
    await ghost(c, " + 2", { second });
    return c;
  };
  // One candidate: ArrowDown is cursor motion (where it lands in jsdom depends on the
  // @codemirror/view version); moving clears the ghost, so Tab then indents.
  let c = await setupGhost(null);
  press(c.view, "ArrowDown");
  await sleep(0);
  const a = snap(c);
  assert.equal(a.ai, null);
  assert.equal(c.view.state.doc.lineAt(c.view.state.selection.main.head).number, 2);
  press(c.view, "Tab");
  assert.equal(c.view.state.doc.toString(), "x = 1\n  next line");
  done(c);
  // Two candidates: ArrowDown switches, Tab accepts the one on screen.
  c = await setupGhost(" - 3");
  const b = snap(c);
  press(c.view, "ArrowDown");
  await sleep(0);
  const a2 = snap(c);
  press(c.view, "Tab");
  await sleep(0);
  assert.deepEqual([diff(b, a2), diff(a2, snap(c))], ['ai:"+ 2"->"- 3"', 'doc="x = 1- 3\\nnext line" sel=8 ai:"- 3"->null']);
  done(c);
});
