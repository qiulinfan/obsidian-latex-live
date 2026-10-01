// Shared live-preview core (src/editor/shared/livePreview.ts), identical in both repositories:
// a fake language (`$..$` inline, `$$..$$` display) and fake renderers on the real CodeMirror.
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cursorDocEnd,
  cursorDocStart,
  history,
  selectAll,
  selectDocEnd,
  simplifySelection,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { closeSearchPanel, openSearchPanel, searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, Extension, RangeSet, SelectionRange, Text } from "@codemirror/state";
import {
  BlockWrapper,
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  activateHover,
  keymap,
  showTooltip,
} from "@codemirror/view";
import { HistoryCache, setTypingDiagnostics, typingDiagnostics } from "../src/editor/shared/editorKit";
import {
  Construct,
  FragmentRenderer,
  LiveLanguage,
  RenderRequest,
  RenderResult,
  RenderWidget,
  TextWidget,
  isLive,
  liveInput,
  livePreview,
  livePreviewCompartment,
  refreshLive,
  renderConstruct,
  renderStats,
  replacedAt,
} from "../src/editor/shared/livePreview";
import { cursorPreview, renderHover } from "../src/editor/shared/renderHover";
import { fakeYolo } from "./support/fakeYolo";
import { GOLDEN, STATES, matrixRow, press, setup, sleep } from "./support/keyMatrix";

// jsdom has no layout: CodeMirror's vertical motion runs past the (empty) content rectangle
// there, and that branch returns a cursor without the goal column every real line move
// carries. `enterBlocks` corrects only line moves (those with a goal column): give it one.
const moveVertically = EditorView.prototype.moveVertically;
EditorView.prototype.moveVertically = function (this: EditorView, start: SelectionRange, forward: boolean, distance?: number) {
  const r = moveVertically.call(this, start, forward, distance);
  return r.goalColumn === undefined && r.head !== start.head ? EditorSelection.cursor(r.head, r.assoc, undefined, 0) : r;
};

// ---- fakes ---------------------------------------------------------------------------------

interface Math extends Construct {
  src: string;
  display: boolean;
}

/** `$$..$$` (a block when alone on its lines) and `$..$`, like the real scanners' output. */
function scanMath(doc: Text): Math[] {
  const text = doc.toString();
  const out: Math[] = [];
  for (const m of text.matchAll(/\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    if (m[1] !== undefined) {
      const a = doc.lineAt(from);
      const b = doc.lineAt(to);
      const block = !text.slice(a.from, from).trim() && !text.slice(to, b.to).trim();
      out.push({ from, to, block, src: m[1], display: true });
    } else {
      out.push({ from, to, src: m[2], display: false });
    }
  }
  return out;
}

let scans = 0;
const language: LiveLanguage<Math> = {
  scan: (doc) => (scans++, scanMath(doc)),
  decorate: (c, ctx) => renderConstruct(ctx, c, ctx.request("math", c.src, c.display, c.from)),
};

function node(src: string): Element {
  const el = document.createElement("span");
  el.className = "fake";
  el.textContent = `[${src.trim()}]`;
  return el;
}

/** Synchronous (MathJax-like); a source containing "bad" fails. */
class SyncRenderer implements FragmentRenderer {
  epoch = 0;
  calls: string[] = [];
  flushes = 0;
  private listeners = new Set<() => void>();
  render(req: RenderRequest): RenderResult {
    this.calls.push(req.src);
    if (req.src.includes("quiet")) return { ok: false, message: "needs the code around it", quiet: true };
    return req.src.includes("bad") ? { ok: false, message: `cannot draw ${req.src}` } : { ok: true, node: node(req.src) };
  }
  flush(): void {
    this.flushes++;
  }
  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
  bump(): void {
    this.epoch++;
    for (const f of this.listeners) f();
  }
  get subscribers(): number {
    return this.listeners.size;
  }
}

/**
 * Asynchronous (tinymist-like): each render waits until the test settles it. Its nodes carry
 * the request's key (`data-key`, the epoch first); `fails` decides which requests fail.
 */
class AsyncRenderer implements FragmentRenderer {
  epoch = 0;
  calls: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  fails = (req: RenderRequest) => req.src.includes("bad");
  private waiting: { req: RenderRequest; resolve: (r: RenderResult) => void }[] = [];
  private listeners = new Set<() => void>();
  render(req: RenderRequest): Promise<RenderResult> {
    this.calls.push(req.src);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise((resolve) => this.waiting.push({ req, resolve }));
  }
  /** Answer the oldest request. */
  settle(): string | null {
    const w = this.waiting.shift();
    if (!w) return null;
    this.inFlight--;
    if (this.fails(w.req)) w.resolve({ ok: false, message: `cannot draw ${w.req.src}` });
    else {
      const el = node(w.req.src);
      el.setAttribute("data-key", w.req.key);
      w.resolve({ ok: true, node: el });
    }
    return w.req.src;
  }
  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
  bump(): void {
    this.epoch++;
    for (const f of this.listeners) f();
  }
}

// ---- helpers -----------------------------------------------------------------------------------

// jsdom has neither ResizeObserver nor requestIdleCallback: the core must cope without them.
const settle = () => sleep(40); // CodeMirror reports focus changes asynchronously

interface MountOptions {
  renderer?: FragmentRenderer;
  anchor?: number;
  focus?: boolean;
  extensions?: Extension[];
  live?: boolean;
}

async function mount(doc: string, o: MountOptions = {}) {
  const renderer = o.renderer ?? new SyncRenderer();
  const refreshes: number[] = [];
  const state = EditorState.create({
    doc,
    selection: { anchor: o.anchor ?? 0 },
    extensions: [
      liveInput(),
      livePreviewCompartment.of(o.live === false ? [] : livePreview({ language, renderer })),
      history(),
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) if (tr.effects.some((e) => e.is(refreshLive))) refreshes.push(Date.now());
      }),
      o.extensions ?? [],
    ],
  });
  const view = new EditorView({ state, parent: document.body });
  if (o.focus !== false) view.focus();
  await settle();
  return { view, renderer, refreshes };
}

/** Rendered widgets in place of source (not the previews below revealed blocks). */
const widgets = (view: EditorView) => view.contentDOM.querySelectorAll(".lsp-lp-render:not(.is-below)").length;
const below = (view: EditorView) => view.contentDOM.querySelector<HTMLElement>(".lsp-lp-render.is-below");
const text = (view: EditorView) => view.contentDOM.textContent ?? "";
/** Put the selection somewhere (no user event: never redirected). */
const move = (view: EditorView, anchor: number, head = anchor) => view.dispatch({ selection: EditorSelection.single(anchor, head) });
/** A line move as the arrow keys make it (userEvent "select" and a goal column; or another event). */
const step = (view: EditorView, anchor: number, head = anchor, userEvent = "select") =>
  view.dispatch({ selection: EditorSelection.create([EditorSelection.range(anchor, head, 0)]), userEvent });
/** A jump without a goal column (Mod-End, Mod-Home, Select All), userEvent "select". */
const jump = (view: EditorView, anchor: number, head = anchor) =>
  view.dispatch({ selection: EditorSelection.single(anchor, head), userEvent: "select" });
const head = (view: EditorView) => view.state.selection.main.head;
const lineOf = (view: EditorView) => view.state.doc.lineAt(head(view)).number;
const blur = async (view: EditorView) => {
  view.contentDOM.blur();
  await settle();
};

// ---- T-S1 reveal ---------------------------------------------------------------------------

test("T-S1 reveal: inclusive at both ends, only while focused; blurred, everything renders", async () => {
  // "$x$" is 2..5, "$y$" is 8..11.
  const { view } = await mount("a $x$ b $y$ c", { focus: false });
  assert.equal(widgets(view), 2, "blurred: all rendered");
  assert.equal(text(view), "a [x] b [y] c");
  view.focus();
  await settle();
  assert.equal(widgets(view), 2, "focused, cursor elsewhere");
  move(view, 2);
  assert.equal(text(view), "a $x$ b [y] c", "cursor at the opening $");
  move(view, 5);
  assert.equal(text(view), "a $x$ b [y] c", "cursor right after the closing $");
  move(view, 6);
  assert.equal(text(view), "a [x] b [y] c", "one character away");
  move(view, 3, 9);
  assert.equal(widgets(view), 0, "a selection over both reveals both");
  move(view, 9);
  await blur(view);
  assert.equal(text(view), "a [x] b [y] c", "blurred with the cursor inside $y$");
  view.destroy();
});

test("T-S1 the search panel's current match reveals the formula it is in (the focus stays in the panel)", async () => {
  const { view } = await mount("Some text here and $\\alpha + \\beta$ end.", { extensions: [keymap.of(searchKeymap)] });
  assert.equal(widgets(view), 1);
  openSearchPanel(view);
  const field = view.dom.querySelector<HTMLInputElement>(".cm-search input[name=search]")!;
  field.focus();
  await settle();
  assert.ok(!view.hasFocus, "the focus is in the panel's field");
  field.value = "beta";
  field.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
  const { from, to } = view.state.selection.main;
  assert.equal(view.state.sliceDoc(from, to), "beta", "findNext selected the match");
  assert.equal(widgets(view), 0, "the match shows");
  assert.ok(text(view).includes("$\\alpha + \\beta$"));
  closeSearchPanel(view); // focuses the editor: the match stays revealed
  await settle();
  assert.ok(view.hasFocus);
  assert.equal(widgets(view), 0);
  await blur(view);
  assert.equal(widgets(view), 1, "no panel, no focus: rendered");
  view.destroy();
});

test("T-S1 blur survives updates before CodeMirror's queued focus transaction", async () => {
  const { view } = await mount("$x$ b", { anchor: 1 });
  assert.equal(widgets(view), 0, "focused: the inline formula is source");
  view.contentDOM.blur();
  move(view, 2);
  view.dispatch({ effects: refreshLive.of([]) });
  await sleep(0);
  assert.equal(view.hasFocus, false, "the content DOM lost focus");
  assert.equal(widgets(view), 1, "blurred: the formula renders again");
  view.destroy();
});

test("T-S1 focus reconciliation keeps the cursor preview's focus effect with live input's", async () => {
  const preview = cursorPreview({
    enabled: () => true,
    target: (state) => scanMath(state.doc).find((c) => c.from <= state.selection.main.head && state.selection.main.head <= c.to) ?? null,
    render: (c) => node(c.src) as HTMLElement,
  });
  const { view } = await mount("$x$ b", { focus: false, extensions: [preview] });
  const hasTooltip = () => view.state.facet(showTooltip).some((tip) => tip !== null);
  assert.equal(hasTooltip(), false, "blurred: no cursor preview");
  view.focus();
  move(view, 1);
  view.dispatch({ effects: refreshLive.of([]) });
  await sleep(0);
  assert.equal(widgets(view), 0, "the formula is source");
  assert.equal(hasTooltip(), true, "both focus hooks landed together");
  view.contentDOM.blur();
  move(view, 2);
  view.dispatch({ effects: refreshLive.of([]) });
  await sleep(0);
  assert.equal(widgets(view), 1, "blurred: the formula renders again");
  assert.equal(hasTooltip(), false, "blur also reaches the cursor preview");
  view.destroy();
});

// ---- T-S2 below-preview ------------------------------------------------------------------

test("T-S2 a revealed block keeps a preview below; pending or failed keeps the last rendering", async () => {
  // Lines: 1 "p", 2 "$$", 3 "x^2", 4 "$$", 5 "q".
  const doc = "p\n$$\nx^2\n$$\nq";
  const { view } = await mount(doc);
  const block = view.contentDOM.querySelector<HTMLElement>(".lsp-lp-render.is-block")!;
  assert.ok(block && !block.classList.contains("is-below"), "a block widget over lines 2-4");
  assert.equal(block.tagName, "DIV");
  move(view, view.state.doc.line(3).from + 1);
  assert.equal(widgets(view), 0, "revealed");
  assert.ok(text(view).includes("x^2"), "source visible");
  const preview = below(view)!;
  assert.ok(preview, "a preview below the source");
  assert.equal(preview.className, "lsp-lp-render lsp-lp-math is-display is-block is-below", "classes resynced");
  assert.equal(preview.textContent, "[x^2]");
  // A failing edit: the last rendering stays, marked, and the source gets the error underline.
  const at = view.state.doc.line(3).from;
  view.dispatch({ changes: { from: at, to: at + 3, insert: "bad" }, userEvent: "input.type" });
  assert.ok(below(view)!.classList.contains("is-pending"), "until the microtask renders it");
  await sleep(0);
  const failed = below(view)!;
  assert.ok(failed.classList.contains("is-error"));
  assert.equal(failed.textContent, "[x^2]", "the last good rendering stays");
  assert.equal(failed.title, "cannot draw \nbad\n");
  assert.ok(view.contentDOM.querySelector(".lsp-lp-error"), "dotted underline on the source");
  view.dispatch({ changes: { from: at, to: at + 3, insert: "y^3" }, userEvent: "input.type" });
  await sleep(0);
  assert.equal(below(view)!.textContent, "[y^3]");
  assert.ok(!below(view)!.classList.contains("is-error"));
  assert.equal(below(view)!.title, "");
  assert.equal(view.contentDOM.querySelector(".lsp-lp-error"), null);
  view.destroy();

  // Asynchronous: while the new source renders, the old rendering shows, marked pending.
  const r = new AsyncRenderer();
  const m = await mount(doc, { renderer: r, focus: false });
  r.settle();
  await settle();
  assert.equal(widgets(m.view), 1);
  m.view.focus();
  await settle();
  move(m.view, m.view.state.doc.line(3).from);
  assert.equal(below(m.view)!.textContent, "[x^2]");
  m.view.dispatch({ changes: { from: m.view.state.doc.line(3).from, insert: "2" }, userEvent: "input.type" });
  await sleep(0);
  assert.ok(below(m.view)!.classList.contains("is-pending"));
  assert.equal(below(m.view)!.textContent, "[x^2]");
  assert.equal(r.settle(), "\n2x^2\n");
  await settle();
  assert.ok(!below(m.view)!.classList.contains("is-pending"));
  assert.equal(below(m.view)!.textContent, "[2x^2]");
  m.view.destroy();
});

test("T-S2 a block typed from scratch has an empty pending preview, then its rendering", async () => {
  const r = new AsyncRenderer();
  const { view } = await mount("p\n", { renderer: r });
  view.dispatch({ changes: { from: 2, insert: "$$\nz\n$$" }, selection: { anchor: 5 }, userEvent: "input.type" });
  await sleep(0);
  const pending = below(view)!;
  assert.ok(pending.classList.contains("is-pending"));
  assert.equal(pending.childNodes.length, 0);
  r.settle();
  await settle();
  assert.equal(below(view)!.textContent, "[z]");
  view.destroy();
});

test("T-S2 a failed preview below never shows another block's rendering", async () => {
  // Lines 2-4 and 6-8 are blocks; the cursor is in the second (revealed, rendering below).
  const doc = ["Intro.", "$$", "x a", "$$", "Middle.", "$$", "y a", "$$", "End."].join("\n");
  const { view } = await mount(doc, { anchor: doc.indexOf("y a") + 3 });
  assert.equal(below(view)!.textContent, "[y a]");
  assert.equal(view.contentDOM.querySelector(".lsp-lp-render.is-block:not(.is-below)")!.textContent, "[x a]");
  // One transaction (replace all, several cursors) breaks both: the first goes back to source,
  // and CodeMirror offers its dropped widget's DOM to the preview below the second.
  const changes = [...doc.matchAll(/ a\n/g)].map((m) => ({ from: m.index! + 1, to: m.index! + 2, insert: "bad" }));
  view.dispatch({ changes, userEvent: "input.replace.all" });
  await sleep(0);
  const failed = below(view)!;
  assert.equal(failed.textContent, "[y a]", "its own last rendering");
  assert.ok(failed.classList.contains("is-error"));
  assert.equal(widgets(view), 0, "the first block shows its source");
  view.destroy();
});

// ---- T-S3 mouse freeze -------------------------------------------------------------------------

test("T-S3 mouse down: selections only map until mouseup, then the decorations rebuild", async () => {
  const { view } = await mount("a $x$ b $y$ c", { anchor: 13 });
  assert.equal(widgets(view), 2);
  view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  step(view, 3, 3, "select.pointer");
  step(view, 3, 9, "select.pointer");
  assert.equal(widgets(view), 2, "nothing reveals under a drag");
  view.dispatch({ changes: { from: 0, insert: "0" } });
  assert.equal(text(view), "0a [x] b [y] c", "an edit meanwhile only maps");
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
  assert.equal(widgets(view), 2, "still frozen until the mouseup's timeout");
  await sleep(10);
  assert.equal(widgets(view), 0, "rebuilt: the selection reveals both");
  assert.deepEqual([view.state.selection.main.anchor, head(view)], [4, 10], "the selection is kept");
  view.destroy();
});

// ---- T-S4 composition ----------------------------------------------------------------------------

test("T-S4 composition transactions only map; compositionend refreshes", async () => {
  const { view, refreshes } = await mount("a $x$ b", { anchor: 5 });
  assert.equal(widgets(view), 0, "the cursor right after $x$ reveals it");
  // Pinyin right after the formula: the cursor leaves it, but nothing collapses mid-composition.
  view.dispatch({ changes: { from: 5, insert: "n" }, selection: { anchor: 6 }, userEvent: "input.type.compose" });
  view.dispatch({ changes: { from: 5, to: 6, insert: "ni" }, selection: { anchor: 7 }, userEvent: "input.type.compose" });
  assert.equal(widgets(view), 0, "still revealed while composing");
  view.dispatch({ changes: { from: 5, to: 7, insert: "你" }, selection: { anchor: 6 }, userEvent: "input.type.compose" });
  assert.equal(text(view), "a $x$你 b");
  const before = refreshes.length;
  view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
  assert.equal(refreshes.length, before, "not during the event");
  await sleep(10);
  // The refresh, then the render of $x$ (never asked for while revealed) and its refresh.
  assert.equal(refreshes.length, before + 2);
  assert.equal(text(view), "a [x]你 b", "rebuilt: the cursor no longer touches $x$");
  view.destroy();
});

// ---- T-S5 selection shortcut ------------------------------------------------------------

test("T-S5 a cursor move that neither enters nor leaves a construct keeps the decorations", async () => {
  // Lines: 1 "text one", 2 "text two", 3 "$x$ and more".
  const { view } = await mount("text one\ntext two\n$x$ and more");
  const sets = () => view.state.facet(EditorView.decorations).filter((d) => typeof d !== "function");
  const builds = () => renderStats(view).builds;
  const b0 = builds();
  const s0 = sets();
  move(view, 3);
  move(view, 11);
  assert.equal(builds(), b0, "no rebuild between lines without constructs");
  assert.deepEqual(
    sets().map((s, i) => s === s0[i]),
    s0.map(() => true),
    "the same decoration sets",
  );
  move(view, view.state.doc.line(3).from + 8);
  assert.equal(builds(), b0 + 1, "entering a construct's line rebuilds");
  assert.equal(widgets(view), 1, "not touching $x$ yet");
  move(view, view.state.doc.line(3).from + 10);
  assert.equal(builds(), b0 + 2, "a move on a construct's line re-decorates it (decorate may test it)");
  move(view, 0);
  assert.equal(builds(), b0 + 3, "leaving it rebuilds");
  view.destroy();
});

// "::: title" .. ":::" boxes (a wrapper, a title chip, the closing line collapsed) around math:
// constructs nest, so a move inside a box re-decorates the box and its formulas, unless the
// language says with `reveals` that a box tests the selection on its first and last line only.
interface Node extends Construct {
  kind: "box" | "math";
  src: string;
  display: boolean;
  beginTo: number;
  endFrom: number;
}

function boxLanguage(reveals: boolean): LiveLanguage<Node> & { decorated: Node[] } {
  const decorated: Node[] = [];
  return {
    decorated,
    scan(doc) {
      const out: Node[] = [];
      for (const m of scanMath(doc)) out.push({ ...m, kind: "math", beginTo: 0, endFrom: 0 });
      const text = doc.toString();
      for (const b of text.matchAll(/^::: (.*)\n[\s\S]*?\n:::$/gm)) {
        const from = b.index ?? 0;
        const to = from + b[0].length;
        out.push({ from, to, block: true, kind: "box", src: b[1], display: false, beginTo: doc.lineAt(from).to, endFrom: doc.lineAt(to).from });
      }
      return out.sort((a, b) => a.from - b.from);
    },
    reveals: reveals ? (c) => (c.kind === "box" ? [[c.from, c.from], [c.endFrom, c.endFrom]] : null) : undefined,
    decorate(c, ctx) {
      decorated.push(c);
      if (c.kind === "math") return renderConstruct(ctx, c, ctx.request("math", c.src, c.display, c.from));
      ctx.wrap(c.from, c.to, { tagName: "div", attributes: { class: "lsp-lp-box is-main" } });
      if (!ctx.touchLines(c.from, c.from)) ctx.replace(c.from, c.beginTo, Decoration.replace({ widget: new TextWidget(c.src, "lsp-lp-box-title") }));
      if (!ctx.touchLines(c.endFrom, c.to)) ctx.replace(c.endFrom, c.to, Decoration.replace({ block: true }));
    },
  };
}

async function mountBoxes(doc: string, language: LiveLanguage<Node>): Promise<EditorView> {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [liveInput(), livePreview({ language, renderer: new SyncRenderer() }), EditorState.allowMultipleSelections.of(true)],
    }),
    parent: document.body,
  });
  view.focus();
  await settle();
  return view;
}

/** Random selection moves, each compared with a full build of the same state; how many patched. */
function sameAsFullBuild(view: EditorView, moves: number): number {
  // What the view draws: the field's sets and the one-line replacements near the viewport.
  const sets = () => ({
    deco: view.state.facet(EditorView.decorations).map((d) => (typeof d === "function" ? d(view) : d)),
    wraps: view.state.facet(EditorView.blockWrappers).filter((d) => typeof d !== "function") as RangeSet<BlockWrapper>[],
  });
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  const len = view.state.doc.length;
  let patched = 0;
  for (let i = 0; i < moves; i++) {
    const a = rand(len + 1);
    const ranges = [EditorSelection.range(a, rand(4) === 0 ? rand(len + 1) : a)];
    if (rand(5) === 0) ranges.push(EditorSelection.cursor(rand(len + 1)));
    const builds = renderStats(view).builds;
    view.dispatch({ selection: EditorSelection.create(ranges) });
    if (renderStats(view).builds > builds) patched++;
    const after = sets();
    view.dispatch({ effects: refreshLive.of(null) }); // a full build of the same state
    const full = sets();
    assert.ok(RangeSet.eq(after.deco, full.deco), `decorations after move ${i}`);
    assert.ok(RangeSet.eq(after.wraps, full.wraps), `wrappers after move ${i}`);
  }
  return patched;
}

const boxesDoc = (): string => {
  const lines: string[] = [];
  for (let i = 0; i < 12; i++) {
    lines.push(`Text ${i} with $a_${i}$ and $b_${i}$.`, "::: Theorem " + i, `Body $c_${i}$ here.`, "$$", `d_${i}`, "$$", ":::", "Plain line.");
  }
  return lines.join("\n");
};

test("T-S5 selection moves re-decorate only their lines, with the same result as a full build", async () => {
  const view = await mountBoxes(boxesDoc(), boxLanguage(false));
  const patched = sameAsFullBuild(view, 150);
  assert.ok(patched > 50, `moves that re-decorated: ${patched}`);
  view.destroy();
});

test("T-S5 `reveals`: a move inside a long box re-decorates only its lines' constructs, one onto its first line the box", async () => {
  const withReveals = await mountBoxes(boxesDoc(), boxLanguage(true));
  const patched = sameAsFullBuild(withReveals, 150);
  assert.ok(patched > 50, `moves that re-decorated: ${patched}`);
  withReveals.destroy();

  // A box of 300 body lines with two formulas each: more than a patch covers (PATCH_MAX).
  const body = Array.from({ length: 300 }, (_, i) => `Line ${i} with $x_${i}$ and $y_${i}$.`);
  const doc = ["Before.", "::: Long", ...body, ":::", "After $z$."].join("\n");
  for (const reveals of [true, false]) {
    const language = boxLanguage(reveals);
    const view = await mountBoxes(doc, language);
    const at = (line: number) => view.state.doc.line(line).from + 2;
    move(view, at(100));
    language.decorated.length = 0;
    move(view, at(101));
    const kinds = language.decorated.map((c) => (c.kind === "math" ? view.state.doc.lineAt(c.from).number : c.kind));
    if (reveals) assert.deepEqual(kinds, [100, 100, 101, 101], "only the formulas on the lines moved over");
    else assert.ok(kinds.length > 600, `without reveals the whole box and its body: ${kinds.length}`);
    language.decorated.length = 0;
    move(view, at(2));
    assert.ok(language.decorated.some((c) => c.kind === "box"), "onto the box's first line: the box re-decorates");
    assert.equal(view.contentDOM.querySelectorAll(".lsp-lp-box-title").length, 0, "its title revealed");
    view.destroy();
  }
});

// ---- T-S6 block decorations need a state field ---------------------------------------------

test("T-S6 block and line-break replacements come from the field, never a ViewPlugin", async () => {
  class Blank extends WidgetType {
    toDOM() {
      return document.createElement("div");
    }
  }
  const fromPlugin = (deco: Decoration, from: number, to: number) =>
    ViewPlugin.define(() => ({ decorations: Decoration.set([deco.range(from, to)]) }), {
      decorations: (p) => p.decorations,
    });
  for (const [deco, from, to, message] of [
    [Decoration.replace({ widget: new Blank(), block: true }), 0, 5, /Block decorations may not be specified via plugins/],
    [Decoration.replace({}), 3, 8, /Decorations that replace line breaks may not be specified via plugins/],
  ] as const) {
    assert.throws(() => {
      const v = new EditorView({ state: EditorState.create({ doc: "hello\nworld", extensions: [fromPlugin(deco, from, to)] }) });
      v.destroy();
    }, message);
  }
  const { view } = await mount("$$\nx\n$$\n$$ y $$", { focus: false });
  assert.equal(view.contentDOM.querySelectorAll(".lsp-lp-render.is-block").length, 2, "block widgets over lines");
  assert.equal(view.state.doc.lines, 4);
  view.destroy();
});

// ---- T-S7 vertical motion --------------------------------------------------------------------

test("T-S7 enterBlocks: one-line steps over hidden lines stop on the block, other jumps do not", async () => {
  // 1 top, 2-4 block A, 5 mid, 6-8 block B, 9-11 block C, 12 end.
  const doc = ["top", "$$", "a", "$$", "mid", "$$", "b", "$$", "$$", "c", "$$", "end"].join("\n");
  const { view } = await mount(doc, { extensions: [EditorState.allowMultipleSelections.of(true)] });
  const L = (n: number) => view.state.doc.line(n);
  assert.equal(widgets(view), 3);
  // Down from line 1 over A lands on A's start, which reveals it.
  move(view, L(1).from);
  step(view, L(5).from);
  assert.equal(head(view), L(2).from, "stopped on block A");
  assert.equal(widgets(view), 2, "A revealed");
  // Line by line through the revealed source: nothing hidden in between, no redirect.
  step(view, L(3).from);
  step(view, L(4).from);
  step(view, L(5).from);
  assert.equal(head(view), L(5).from);
  // Up from line 5 over A lands on A's end.
  step(view, L(1).from);
  assert.equal(head(view), L(4).to, "stopped on A's last line");
  // Two adjacent blocks form one hidden run: down stops on B, up (from 12) on C's end.
  move(view, L(5).from);
  step(view, L(12).from);
  assert.equal(head(view), L(6).from, "stopped on block B");
  move(view, L(12).from);
  step(view, L(5).from);
  assert.equal(head(view), L(11).to, "stopped on block C's end");
  // A visible line in between (PageDown): no redirect.
  move(view, L(1).from);
  step(view, L(12).to);
  assert.equal(head(view), L(12).to, "doc end reached");
  // No goal column (Mod-End, Select All): never redirected, even from right above a block.
  move(view, L(5).from);
  jump(view, L(12).from);
  assert.equal(head(view), L(12).from);
  // Pointer and search selections are never redirected.
  move(view, L(1).from);
  step(view, L(5).from, L(5).from, "select.pointer");
  assert.equal(head(view), L(5).from);
  move(view, L(1).from);
  step(view, L(5).from, L(5).from, "select.search");
  assert.equal(head(view), L(5).from);
  // Shift-extend keeps the anchor.
  move(view, L(1).from);
  step(view, L(1).from, L(5).from);
  assert.deepEqual([view.state.selection.main.anchor, head(view)], [L(1).from, L(2).from]);
  // Several cursors are corrected one by one.
  const lineMove = (pos: number) => EditorSelection.cursor(pos, 0, undefined, 0);
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(L(1).from), EditorSelection.cursor(L(12).from)]) });
  view.dispatch({ selection: EditorSelection.create([lineMove(L(5).from), lineMove(L(5).to)]), userEvent: "select" });
  assert.deepEqual(
    view.state.selection.ranges.map((r) => r.head),
    [L(2).from, L(11).to],
  );
  view.destroy();

  // A line move into a block at the document's end (or start) lands inside it, at the end (or
  // start): it stops on the block's first (or last) line. Mod-End and Mod-Home do not.
  const end = await mount("top\n$$\nx\n$$");
  move(end.view, 0);
  step(end.view, end.view.state.doc.length);
  assert.equal(head(end.view), end.view.state.doc.line(2).from, "ArrowDown into a block at the end");
  move(end.view, 0);
  jump(end.view, end.view.state.doc.length);
  assert.equal(head(end.view), end.view.state.doc.length, "Mod-End");
  end.view.destroy();
  const start = await mount("$$\nx\n$$\nbelow");
  const L4 = start.view.state.doc.line(4).from;
  move(start.view, L4);
  step(start.view, 0);
  assert.equal(head(start.view), start.view.state.doc.line(3).to, "ArrowUp into a block at the start");
  move(start.view, L4);
  jump(start.view, 0);
  assert.equal(head(start.view), 0, "Mod-Home");
  start.view.destroy();
});

test("T-S7 enterBlocks: a move one line past a block where the drawn viewport ends stops on the block", async () => {
  // CodeMirror estimates the lines outside the viewport it drew by their characters: past a
  // block the viewport ends at, a short line gets almost no height and a line move lands one
  // line further (measured in Chrome). jsdom has no layout: the test says what was drawn.
  const drawTo = (view: EditorView, from: number, to: number) => {
    Object.defineProperty(view, "viewport", { configurable: true, get: () => ({ from, to }) });
    view.dispatch({}); // the view reports what it drew at its next update
  };
  // 1 top, 2-4 block, 5 "" (right after it), 6 next, 7 end.
  const down = await mount(["top", "$$", "a", "$$", "", "next", "end"].join("\n"));
  const L = (n: number) => down.view.state.doc.line(n);
  try {
    drawTo(down.view, 0, L(4).to);
    move(down.view, L(1).from);
    step(down.view, L(6).from);
    assert.equal(head(down.view), L(2).from, "stopped on the block");
    // Line 5 drawn: CodeMirror placed it, so the move went over it (PageDown).
    drawTo(down.view, 0, L(5).to);
    move(down.view, L(1).from);
    step(down.view, L(6).from);
    assert.equal(head(down.view), L(6).from);
    // Two lines past the block: a longer jump.
    drawTo(down.view, 0, L(4).to);
    move(down.view, L(1).from);
    step(down.view, L(7).from);
    assert.equal(head(down.view), L(7).from);
  } finally {
    delete (down.view as { viewport?: unknown }).viewport;
    down.view.destroy();
  }
  // Up, the viewport starting at the block: 1 top, 2 "", 3-5 block, 6 bottom.
  const up = await mount(["top", "", "$$", "b", "$$", "bottom"].join("\n"), { anchor: 0 });
  const U = (n: number) => up.view.state.doc.line(n);
  try {
    drawTo(up.view, U(3).from, up.view.state.doc.length);
    move(up.view, U(6).from);
    step(up.view, U(1).from);
    assert.equal(head(up.view), U(5).to, "stopped on the block's last line");
    drawTo(up.view, 0, up.view.state.doc.length);
    move(up.view, U(6).from);
    step(up.view, U(1).from);
    assert.equal(head(up.view), U(1).from);
  } finally {
    delete (up.view as { viewport?: unknown }).viewport;
    up.view.destroy();
  }
});

test("T-S7 enterBlocks leaves Select All, Mod-End/Home, Shift-Mod-End and Escape alone", async () => {
  // Lines: 1 "Intro.", 2-4 a block, 5 "The end." (the last line right after the block).
  const doc = "Intro.\n$$\na\n$$\nThe end.";
  const len = doc.length;
  const { view } = await mount(doc, { anchor: 3, extensions: [EditorState.allowMultipleSelections.of(true)] });
  const sel = () => view.state.selection.ranges.map((r) => [r.anchor, r.head]);
  assert.equal(widgets(view), 1);
  selectAll(view);
  assert.deepEqual(sel(), [[0, len]], "Select All");
  move(view, 3);
  cursorDocEnd(view);
  assert.deepEqual(sel(), [[len, len]], "Mod-End");
  cursorDocStart(view);
  assert.deepEqual(sel(), [[0, 0]], "Mod-Home");
  move(view, 3);
  selectDocEnd(view);
  assert.deepEqual(sel(), [[3, len]], "Shift-Mod-End");
  // Escape with two cursors keeps the main one (the second): ranges no longer pair by index.
  const line5 = view.state.doc.line(5).from;
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(3), EditorSelection.cursor(line5)], 1) });
  simplifySelection(view);
  assert.deepEqual(sel(), [[line5, line5]], "Escape");
  view.destroy();
});

// jsdom has no layout: CodeMirror's vertical motion there jumps to the document's end or
// start, which is enough to see the filter on the real key path (keyArbiter declines, the
// view keymap's cursorLineDown/Up run). Line-by-line motion is the browser smoke's B1.
test("T-S7 real ArrowDown/ArrowUp through keyArbiter stop on a block and reveal it", async () => {
  const doc = ["top", "$$", "a", "$$", "end"].join("\n");
  const c = setup(null, { doc, extensions: [liveInput(), livePreviewCompartment.of(livePreview({ language, renderer: new SyncRenderer() }))] });
  c.view.dispatch({ selection: { anchor: 0 } });
  await settle();
  assert.equal(widgets(c.view), 1);
  assert.deepEqual(press(c.view, "ArrowDown"), { handled: true, propagated: true });
  assert.equal(lineOf(c.view), 2);
  assert.equal(widgets(c.view), 0, "revealed");
  c.view.dispatch({ selection: { anchor: c.view.state.doc.length } });
  assert.equal(widgets(c.view), 1);
  press(c.view, "ArrowUp");
  assert.equal(head(c.view), c.view.state.doc.line(4).to);
  assert.equal(widgets(c.view), 0);
  c.view.destroy();
  c.bridge.destroy();
});

test("T-S7 focus survives a render refresh before CodeMirror's queued focus transaction", async () => {
  const doc = ["top", "$$", "a", "$$", "end"].join("\n");
  const c = setup(null, { doc, extensions: [liveInput(), livePreviewCompartment.of(livePreview({ language, renderer: new SyncRenderer() }))] });
  await settle();
  await blur(c.view);
  assert.equal(widgets(c.view), 1, "blurred: the display is rendered");
  c.view.focus();
  // The first update makes CodeMirror queue its focus effect. A render refresh changes
  // the state before that microtask, so CodeMirror discards the queued transaction.
  move(c.view, c.view.state.doc.line(2).from);
  c.view.dispatch({ effects: refreshLive.of([]) });
  await sleep(0);
  assert.equal(c.view.hasFocus, true, "the content DOM kept focus");
  assert.equal(replacedAt(c.view.state, head(c.view)), false, "the cursor's block is source");
  assert.equal(widgets(c.view), 0, "the focused selection reveals the display");
  // jsdom has no line geometry: submit the goal-column moves the arrow command
  // produces, verifying that hidden/atomic ranges cannot trap the cursor here.
  step(c.view, c.view.state.doc.line(3).from);
  assert.equal(lineOf(c.view), 3, "Down enters the display body");
  step(c.view, c.view.state.doc.line(4).from);
  assert.equal(lineOf(c.view), 4, "Down reaches its closing line");
  c.view.destroy();
  c.bridge.destroy();
});

// ---- T-S8 widgets ------------------------------------------------------------------------------

test("T-S8 RenderWidget: eq by key, mode and result; updateDOM resyncs everything; clicks go to CodeMirror", async () => {
  const req = (src: string): RenderRequest => ({ key: `0|math|1|${src}`, src, display: true, kind: "math", pos: 0 });
  const ok: RenderResult = { ok: true, node: node("a") };
  const bad: RenderResult = { ok: false, message: "nope" };
  const a = req("a");
  assert.ok(new RenderWidget(a, ok, "block").eq(new RenderWidget(req("a"), ok, "block")));
  assert.ok(!new RenderWidget(a, ok, "block").eq(new RenderWidget(req("b"), ok, "block")), "key");
  assert.ok(!new RenderWidget(a, ok, "block").eq(new RenderWidget(a, ok, "below")), "mode");
  assert.ok(!new RenderWidget(a, ok, "block").eq(new RenderWidget(a, undefined, "block")), "result");
  assert.equal(new RenderWidget(a, ok, "inline").ignoreEvent(), false);
  assert.equal(new RenderWidget(a, ok, "inline").estimatedHeight, -1);
  assert.equal(new RenderWidget(req("x\ny\nz"), ok, "block").estimatedHeight, 120, "unmeasured: 40 per line");

  const { view } = await mount("");
  const block = new RenderWidget(a, ok, "block");
  const dom = block.toDOM(view);
  assert.equal(dom.className, "lsp-lp-render lsp-lp-math is-display is-block");
  assert.equal(dom.textContent, "[a]");
  // Handed to the preview below the block once revealed (what CodeMirror does): classes follow.
  const shown = new RenderWidget(a, ok, "below");
  assert.ok(shown.updateDOM(dom, view, block));
  assert.equal(dom.className, "lsp-lp-render lsp-lp-math is-display is-block is-below");
  // The source is edited: pending, then failing, the last rendering stays.
  const pending = new RenderWidget(req("a2"), undefined, "below");
  assert.ok(pending.updateDOM(dom, view, shown));
  assert.equal(dom.className, "lsp-lp-render lsp-lp-math is-display is-block is-below is-pending");
  assert.equal(dom.textContent, "[a]", "pending keeps the rendering");
  const failing = new RenderWidget(req("a3"), bad, "below");
  assert.ok(failing.updateDOM(dom, view, pending));
  assert.equal(dom.className, "lsp-lp-render lsp-lp-math is-display is-block is-below is-error");
  assert.equal(dom.title, "nope");
  assert.equal(dom.textContent, "[a]", "failed keeps the rendering");
  // Another block's DOM is refused while the result is pending or failed (it would show that
  // block's rendering), taken when there is a rendering to show.
  const other = new RenderWidget(req("z"), { ok: true, node: node("z") }, "block");
  const otherDom = other.toDOM(view);
  assert.equal(new RenderWidget(req("a4"), undefined, "below").updateDOM(otherDom, view, other), false, "pending");
  assert.equal(new RenderWidget(req("a4"), bad, "below").updateDOM(otherDom, view, other), false, "failed");
  assert.equal(otherDom.textContent, "[z]");
  assert.ok(new RenderWidget(req("b"), { ok: true, node: node("b") }, "block").updateDOM(dom, view, failing));
  assert.equal(dom.className, "lsp-lp-render lsp-lp-math is-display is-block");
  assert.equal(dom.title, "");
  assert.equal(dom.textContent, "[b]");
  assert.equal(new RenderWidget(a, ok, "inline").updateDOM(dom, view, block), false, "a span cannot become a div");
  const fresh = new RenderWidget(req("c"), bad, "below").toDOM(view);
  assert.equal(fresh.querySelector(".lsp-lp-message")?.textContent, "nope", "nothing shown yet: the message");
  assert.notEqual(dom.firstChild, ok.node, "the template is cloned, never moved");

  const chip = new TextWidget("1.2", "lsp-lp-chip is-ref", "\\ref{a}");
  assert.ok(chip.eq(new TextWidget("1.2", "lsp-lp-chip is-ref", "\\ref{a}")));
  assert.ok(!chip.eq(new TextWidget("1.3", "lsp-lp-chip is-ref", "\\ref{a}")));
  const el = chip.toDOM(view);
  assert.deepEqual([el.tagName, el.className, el.textContent, el.title], ["SPAN", "lsp-lp-chip is-ref", "1.2", "\\ref{a}"]);
  assert.equal(chip.ignoreEvent(), false);
  view.destroy();
});

// ---- T-S9 diagnostics ------------------------------------------------------------------------------

test("T-S9 a construct with an error diagnostic stays source until the diagnostic clears", async () => {
  // Line 1 "$x$ + $y$", line 2 "text".
  const { view } = await mount("$x$ + $y$\ntext", { anchor: 14, extensions: [typingDiagnostics()] });
  assert.equal(widgets(view), 2);
  setTypingDiagnostics(view, [{ from: 7, to: 8, severity: "error", message: "undefined" }]);
  assert.equal(text(view), "[x] + $y$text", "the formula with the error shows its source");
  setTypingDiagnostics(view, [{ from: 7, to: 8, severity: "warning", message: "style" }]);
  assert.equal(widgets(view), 2, "warnings do not keep the source");
  setTypingDiagnostics(view, [{ from: 7, to: 8, severity: "error", message: "undefined" }]);
  assert.equal(widgets(view), 1);
  setTypingDiagnostics(view, []);
  assert.equal(widgets(view), 2, "rendered again once cleared");
  view.destroy();
});

test("T-S9 an error next to a construct is not in it; an empty one at its edge is", async () => {
  // "\foo$x$ end": texlab-like, an undefined control sequence right before the formula (4..7).
  const { view } = await mount("\\foo$x$ end\ntext", { anchor: 16, extensions: [typingDiagnostics()] });
  assert.equal(text(view), "\\foo[x] endtext");
  setTypingDiagnostics(view, [{ from: 0, to: 4, severity: "error", message: "undefined" }]);
  assert.equal(text(view), "\\foo[x] endtext", "ends where the formula starts");
  setTypingDiagnostics(view, [{ from: 7, to: 10, severity: "error", message: "after" }]);
  assert.equal(text(view), "\\foo[x] endtext", "starts where the formula ends");
  setTypingDiagnostics(view, [{ from: 3, to: 5, severity: "error", message: "overlapping" }]);
  assert.equal(text(view), "\\foo$x$ endtext");
  setTypingDiagnostics(view, [{ from: 7, to: 7, severity: "error", message: "unclosed" }]);
  assert.equal(text(view), "\\foo$x$ endtext", "an empty error at the formula's end");
  view.destroy();
});

test("T-S9 a revealed block with an error diagnostic keeps its rendering below; left, it stays source", async () => {
  // Lines: 1 "p", 2 "$$", 3 "x^2", 4 "$$", 5 "q"; the cursor on line 3.
  const { view } = await mount("p\n$$\nx^2\n$$\nq", { anchor: 5 });
  assert.equal(below(view)!.textContent, "[x^2]");
  // Typed into a failing state; then the error diagnostic lands (a typing pause).
  const at = view.state.doc.line(3).from;
  view.dispatch({ changes: { from: at, to: at + 3, insert: "bad" }, userEvent: "input.type" });
  await sleep(0);
  setTypingDiagnostics(view, [{ from: at, to: at + 3, severity: "error", message: "unknown" }]);
  const shown = below(view);
  assert.ok(shown, "the preview below stays");
  assert.equal(shown.textContent, "[x^2]", "with the last rendering");
  assert.ok(shown.classList.contains("is-error"), "marked: the new source fails");
  assert.equal(view.contentDOM.querySelector(".lsp-lp-error"), null, "the lint underline shows, not the dotted one");
  // The cursor leaves: never replaced while the error is in it, and no preview.
  move(view, view.state.doc.length);
  assert.equal(widgets(view), 0);
  assert.equal(below(view), null);
  assert.ok(text(view).includes("bad"));
  // Fixed: rendered again.
  view.dispatch({ changes: { from: at, to: at + 3, insert: "y^3" } });
  setTypingDiagnostics(view, []);
  await sleep(0);
  assert.equal(widgets(view), 1);
  assert.equal(text(view), "p[y^3]q");
  view.destroy();
});

// ---- T-S10 mode toggle ---------------------------------------------------------------------------

test("T-S10 the compartment toggle keeps doc, selection and history; HistoryCache restores the mode", async () => {
  const { view, renderer } = await mount("a $x$ b\n", { anchor: 8 });
  view.dispatch({ changes: { from: 8, insert: "c" }, selection: { anchor: 9 }, userEvent: "input.type" });
  assert.ok(isLive(view.state));
  const doc = view.state.doc.toString();
  const depth = undoDepth(view.state);
  view.dispatch({ effects: livePreviewCompartment.reconfigure([]) });
  assert.ok(!isLive(view.state));
  assert.equal(widgets(view), 0);
  assert.deepEqual([view.state.doc.toString(), head(view), undoDepth(view.state)], [doc, 9, depth]);
  view.dispatch({ effects: livePreviewCompartment.reconfigure(livePreview({ language, renderer })) });
  assert.ok(isLive(view.state));
  assert.equal(widgets(view), 1);
  assert.deepEqual([view.state.doc.toString(), head(view), undoDepth(view.state)], [doc, 9, depth]);
  undo(view);
  assert.equal(view.state.doc.toString(), "a $x$ b\n");

  const cache = new HistoryCache();
  cache.save("f.tex", view.state);
  const extensions = (live: boolean) => [
    liveInput(),
    livePreviewCompartment.of(live ? livePreview({ language, renderer }) : []),
    history(),
  ];
  const restored = cache.restore("f.tex", "a $x$ b\n", { extensions: extensions(true) })!;
  assert.ok(isLive(restored));
  assert.equal(undoDepth(restored), undoDepth(view.state));
  assert.ok(!isLive(cache.restore("f.tex", "a $x$ b\n", { extensions: extensions(false) })!));
  view.destroy();
});

// ---- T-S11 scheduler -------------------------------------------------------------------------------

test("T-S11 a synchronous renderer fills the viewport before the next frame, one refresh per batch", async () => {
  const renderer = new SyncRenderer();
  let frames = 0;
  const raf = window.requestAnimationFrame;
  const refreshes: string[] = [];
  const view = new EditorView({
    state: EditorState.create({
      doc: "$a$ $b$\n$$\nc\n$$\n$a$",
      extensions: [
        liveInput(),
        livePreview({ language, renderer }),
        EditorView.updateListener.of((u) => {
          for (const tr of u.transactions) if (tr.effects.some((e) => e.is(refreshLive))) refreshes.push("refresh");
        }),
      ],
    }),
    parent: document.body,
  });
  window.requestAnimationFrame = (f) => raf((t) => (frames++, f(t)));
  try {
    assert.equal(widgets(view), 0, "nothing cached yet: source");
    await Promise.resolve();
    assert.equal(frames, 0);
    assert.equal(widgets(view), 4, "rendered in a microtask");
    assert.deepEqual(renderer.calls, ["a", "b", "\nc\n"], "each key once, in document order");
    assert.deepEqual(refreshes, ["refresh"]);
    assert.equal(renderer.flushes, 1);
    const stats = renderStats(view);
    assert.equal(stats.renders, 3);
    assert.equal(stats.pending, 0);
    assert.ok(stats.hits >= 4 && stats.misses === 4, JSON.stringify(stats));
  } finally {
    window.requestAnimationFrame = raf;
  }
  // A new epoch drops the cache and re-renders (the renderer calls its subscribers).
  assert.equal(renderer.subscribers, 1);
  renderer.bump();
  await settle();
  assert.deepEqual(renderer.calls.slice(3), ["a", "b", "\nc\n"]);
  assert.equal(widgets(view), 4);
  view.destroy();
  assert.equal(renderer.subscribers, 0, "unsubscribed with the last view");
});

test("T-S11 an asynchronous renderer: one request in flight, in order; stale epochs dropped", async () => {
  const r = new AsyncRenderer();
  const { view, refreshes } = await mount("$a$ $b$ $c$ $d$", { renderer: r, focus: false });
  assert.deepEqual(r.calls, ["a"], "one in flight");
  assert.equal(r.settle(), "a");
  await sleep(0);
  assert.deepEqual(r.calls, ["a", "b"]);
  r.settle();
  await sleep(0);
  r.settle();
  await sleep(0);
  assert.equal(r.maxInFlight, 1);
  const before = refreshes.length;
  await settle();
  assert.ok(refreshes.length - before <= 1, "results are refreshed once per frame");
  assert.equal(widgets(view), 3);
  assert.deepEqual(r.calls, ["a", "b", "c", "d"]);
  // The epoch moves while "d" renders: its result is dropped and "d" renders again.
  r.bump();
  r.settle();
  await settle();
  assert.equal(widgets(view), 3, "the new epoch's keys miss: a, b and c keep their renderings, d is source");
  assert.equal(r.calls.at(-1), "a", "re-rendering from the top");
  for (let i = 0; i < 4; i++) {
    r.settle();
    await sleep(0);
  }
  await settle();
  assert.equal(widgets(view), 4);
  assert.equal(r.maxInFlight, 1);
  view.destroy();
});

/** The epoch each rendered widget's node was rendered under, in document order (AsyncRenderer). */
const epochs = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll(".lsp-lp-render:not(.is-below) .fake")].map((el) => el.getAttribute("data-key")?.split("|")[0]);

test("T-S11 a new epoch: each construct keeps its rendering until its new render lands, or fails", async () => {
  const r = new AsyncRenderer();
  // "$a$" 0-3, "$b$" 4-7, a block over lines 2-4, "$e$" on line 5.
  const { view } = await mount("$a$ $b$\n$$\nc\n$$\n$e$", { renderer: r, focus: false });
  while (r.settle() !== null) await sleep(0);
  await settle();
  assert.deepEqual(epochs(view), ["0", "0", "0", "0"]);

  // A template changed (a new epoch): every key misses, yet nothing flashes back to source.
  r.bump();
  await settle();
  assert.equal(widgets(view), 4);
  assert.deepEqual(epochs(view), ["0", "0", "0", "0"], "the renderings from before");
  assert.equal(renderStats(view).pending, 4, "all rendering again");
  assert.equal(view.contentDOM.querySelector(".is-pending, .is-error, .lsp-lp-error"), null, "shown as they were");
  // Another epoch before any render landed: the renderings from before carry over.
  r.bump();
  assert.equal(r.settle(), "a"); // of epoch 1: dropped
  await settle();
  assert.deepEqual(epochs(view), ["0", "0", "0", "0"]);
  assert.equal(r.settle(), "a"); // of epoch 2
  await settle();
  assert.deepEqual(epochs(view), ["2", "0", "0", "0"], "a's own render replaced its old one");

  // A construct's own text changed: no rendering from before is its.
  view.dispatch({ changes: { from: 5, insert: "b" } });
  assert.ok(text(view).startsWith("[a] $bb$"), text(view));
  assert.deepEqual(epochs(view), ["2", "0", "0"]);
  // A new render that fails: the source with its error mark, not the rendering from before.
  r.fails = (req) => req.src === "e";
  while (r.settle() !== null) await sleep(0);
  await settle();
  assert.deepEqual(epochs(view), ["2", "2", "2"], "a, bb and the block");
  assert.ok(text(view).endsWith("$e$"));
  assert.equal(view.contentDOM.querySelector(".lsp-lp-error")?.textContent, "$e$");
  const stats = renderStats(view);
  assert.equal(stats.pending, 0);
  assert.equal(stats.cached, 5, "epoch 2's a, b, bb, block and e; nothing from before left");
  // Revealing is unchanged: peek never answers with an earlier epoch's rendering.
  r.bump();
  view.focus();
  await settle();
  move(view, 1);
  assert.ok(text(view).startsWith("$a$ [bb]"), text(view));
  view.destroy();
});

test("T-S11 renderings kept across epochs count against the cache's bound", async () => {
  const w = window as unknown as { requestIdleCallback?: unknown };
  const saved = w.requestIdleCallback;
  w.requestIdleCallback = (f: (d: { didTimeout: boolean; timeRemaining(): number }) => void) =>
    setTimeout(() => f({ didTimeout: false, timeRemaining: () => 10 }), 0);
  try {
    const lines = Array.from({ length: 2600 }, (_, i) => `$g_{${i}}$`);
    const renderer = new SyncRenderer();
    const { view } = await mount(lines.join("\n"), { renderer, focus: false });
    let max = 0;
    const done = async () => {
      for (let i = 0; i < 300 && renderStats(view).pending; i++) {
        max = Math.max(max, renderStats(view).cached);
        await sleep(20);
      }
      assert.equal(renderStats(view).pending, 0);
    };
    try {
      await done();
      assert.equal(renderStats(view).cached, 2600);
      renderer.bump();
      await settle();
      assert.equal(widgets(view) > 0 && widgets(view), view.contentDOM.querySelectorAll(".fake").length, "shown throughout");
      max = 0;
      await done();
      assert.equal(renderer.calls.length, 5200, "each construct rendered once per epoch");
      assert.equal(max, 2600, "held while rendering again: one rendering per construct");
      assert.equal(renderStats(view).cached, 2600, "those from before went as the new ones landed");
      // A new epoch, then other text: renderings nothing shows any more go first.
      renderer.bump();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: lines.join("\n").replace(/g_/g, "h_") } });
      max = 0;
      await done();
      assert.equal(renderer.calls.length, 7800);
      assert.ok(max <= 2600 + 200 && renderStats(view).cached <= 2600 + 200, `${max}, ${renderStats(view).cached}`);
    } finally {
      view.destroy();
    }
  } finally {
    w.requestIdleCallback = saved;
  }
});

test("T-S11 prefetch: constructs out of view render in idle chunks, then show without a rebuild miss", async () => {
  const lines: string[] = [];
  for (let i = 0; i < 3000; i++) lines.push(i % 10 === 0 ? `$f_{${i}}$ text` : `line ${i}`);
  const renderer = new SyncRenderer();
  const { view } = await mount(lines.join("\n"), { renderer, focus: false });
  const { from, to } = view.viewport;
  assert.ok(to < view.state.doc.length, `jsdom viewport ${from}-${to} is part of the document`);
  const firstBatch = renderer.calls.length;
  assert.ok(firstBatch > 0 && firstBatch < 300, `viewport first: ${firstBatch}`);
  for (let i = 0; i < 100 && renderStats(view).pending; i++) await sleep(60);
  assert.equal(renderer.calls.length, 300, "the rest was prefetched");
  assert.equal(renderStats(view).pending, 0);
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length) });
  await settle();
  assert.equal(renderer.calls.length, 300, "scrolling renders nothing new");
  view.destroy();
});

test("T-S11 more constructs than the cache holds: all kept while used, none rendered twice", async () => {
  const w = window as unknown as { requestIdleCallback?: unknown };
  const saved = w.requestIdleCallback;
  w.requestIdleCallback = (f: (d: { didTimeout: boolean; timeRemaining(): number }) => void) =>
    setTimeout(() => f({ didTimeout: false, timeRemaining: () => 10 }), 0);
  try {
    const lines: string[] = [];
    for (let i = 0; i < 2600; i++) lines.push(`$g_{${i}}$`);
    const renderer = new SyncRenderer();
    const { view } = await mount(lines.join("\n"), { renderer, focus: false });
    try {
      for (let i = 0; i < 200 && renderStats(view).pending; i++) await sleep(20);
      assert.equal(renderStats(view).pending, 0);
      assert.equal(renderer.calls.length, 2600);
      await sleep(100);
      view.dispatch({ changes: { from: 0, insert: " " } });
      await settle();
      assert.equal(renderer.calls.length, 2600, "an edit re-renders nothing: every render was kept");
    } finally {
      view.destroy(); // a cache that evicted what the view uses would re-render forever
    }
  } finally {
    w.requestIdleCallback = saved;
  }
});

/**
 * Counts queueMicrotask calls between two macrotasks (the scheduler's `schedule` uses it).
 * Past `cap` in one turn it drops them: a runaway chain then fails the test instead of starving
 * every timer, node:test's timeout included.
 */
function microtaskChains(cap = 10_000) {
  const real = globalThis.queueMicrotask;
  let turn = 0;
  let max = 0;
  globalThis.queueMicrotask = (f: () => void) => {
    max = Math.max(max, ++turn);
    if (turn <= cap) real(f);
  };
  const timer = setInterval(() => (turn = 0), 0);
  return {
    get max() {
      return max;
    },
    restore() {
      clearInterval(timer);
      globalThis.queueMicrotask = real;
    },
  };
}

const formulaEvery = (n: number, lines: number) =>
  Array.from({ length: lines }, (_, i) => (i % n === 0 ? `a $x_{${i}}$ b` : `plain ${i}`)).join("\n");

test("T-S11 a refresh held by the mouse, with visible renders cached, does not spin the scheduler", async () => {
  const chains = microtaskChains();
  const r = new AsyncRenderer();
  const view = new EditorView({
    state: EditorState.create({ doc: formulaEvery(5, 2000), extensions: [liveInput(), livePreview({ language, renderer: r })] }),
    parent: document.body,
  });
  try {
    await sleep(0);
    // The button goes down while the visible renders land (a click after a `#let` edit).
    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
    for (let i = 0; i < 500 && r.settle() !== null; i++) await sleep(0);
    await sleep(300); // jsdom has no requestIdleCallback: the idle prefetch is a 50 ms timeout
    assert.ok(chains.max < 100, `microtasks chained in one turn: ${chains.max}`);
    const held = renderStats(view).pending;
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    for (let i = 0; i < 20; i++) {
      r.settle();
      await sleep(0);
    }
    await sleep(100);
    assert.ok(renderStats(view).pending < held, `the prefetch goes on after mouseup: ${renderStats(view).pending} of ${held}`);
  } finally {
    view.destroy();
    chains.restore();
  }

  // Synchronous: the viewport moves under the held button (drag autoscroll, wheel).
  const chains2 = microtaskChains();
  const renderer = new SyncRenderer();
  const sync = new EditorView({
    state: EditorState.create({ doc: formulaEvery(5, 2000), extensions: [liveInput(), livePreview({ language, renderer })] }),
    parent: document.body,
  });
  try {
    await sleep(0);
    sync.contentDOM.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
    sync.dispatch({ effects: EditorView.scrollIntoView(sync.state.doc.line(1500).from, { y: "center" }) });
    await sleep(300);
    assert.ok(chains2.max < 100, `microtasks chained in one turn: ${chains2.max}`);
    assert.ok(renderer.calls.length > 100, `the prefetch went on while the button was down: ${renderer.calls.length}`);
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    for (let i = 0; i < 100 && renderStats(sync).pending; i++) await sleep(60);
    assert.equal(renderStats(sync).pending, 0);
  } finally {
    sync.destroy();
    chains2.restore();
  }
});

test("T-S11 renders that land re-decorate only the constructs waiting for them", async () => {
  let decorated = 0;
  const counting: LiveLanguage<Math> = { scan: scanMath, decorate: (c, ctx) => (decorated++, language.decorate(c, ctx)) };
  const lines = Array.from({ length: 20 }, (_, i) => `Line ${i} with $f_${i}$.`);
  const doc = [...lines, "$$", "x^2", "$$", "end"].join("\n");
  const inBlock = doc.indexOf("x^2") + 3;
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: inBlock }, extensions: [liveInput(), livePreview({ language: counting, renderer: new SyncRenderer() })] }),
    parent: document.body,
  });
  view.focus();
  await settle();
  assert.equal(widgets(view), 20);
  assert.equal(below(view)!.textContent, "[x^2]");
  // Typing in the revealed block: the edit rebuilds everything, the preview's render landing
  // re-decorates the block alone.
  decorated = 0;
  view.dispatch({ changes: { from: inBlock, insert: "+1" }, userEvent: "input.type" });
  assert.equal(decorated, 21, "the edit: a full build");
  await sleep(0);
  assert.equal(below(view)!.textContent, "[x^2+1]");
  assert.equal(decorated, 22, "the landed render: the block only");
  const drawn = view.state.facet(EditorView.decorations).map((d) => (typeof d === "function" ? d(view) : d));
  view.dispatch({ effects: refreshLive.of(null) });
  const full = view.state.facet(EditorView.decorations).map((d) => (typeof d === "function" ? d(view) : d));
  assert.ok(RangeSet.eq(drawn, full), "the same decorations as a full build");
  view.destroy();
});

interface Mixed extends Math {
  pic: boolean;
}

/**
 * `$..$` formulas and `[[name]]` pictures: a slow kind (asynchronous, like a PDF page), epoch-free
 * (the definitions do not change a picture).
 */
const mixedLanguage: LiveLanguage<Mixed> = {
  scan: (doc) =>
    [...doc.toString().matchAll(/\[\[(\w+)\]\]|\$([^$\n]+)\$/g)].map((m) => ({
      from: m.index!,
      to: m.index! + m[0].length,
      src: m[1] ?? m[2],
      display: false,
      pic: m[1] !== undefined,
    })),
  decorate: (c, ctx) => renderConstruct(ctx, c, ctx.request(c.pic ? "pic" : "math", c.src, false, c.from, c.pic)),
};

/** MathJax-like formulas (`math`, a SyncRenderer), pictures answered when the test settles them. */
class MixedRenderer implements FragmentRenderer {
  readonly math = new SyncRenderer();
  pics: { src: string; resolve: () => void }[] = [];
  picCalls: string[] = [];
  get epoch(): number {
    return this.math.epoch;
  }
  subscribe(f: () => void): () => void {
    return this.math.subscribe(f);
  }
  render(req: RenderRequest): RenderResult | Promise<RenderResult> {
    if (req.kind !== "pic") return this.math.render(req);
    this.picCalls.push(req.src);
    return new Promise((ok) => this.pics.push({ src: req.src, resolve: () => ok({ ok: true, node: node(`pic ${req.src}`) }) }));
  }
  /** Answer the oldest picture. */
  settlePic(): string | null {
    const p = this.pics.shift();
    p?.resolve();
    return p?.src ?? null;
  }
}

test("T-S11 a renderer mixing kinds: formulas render while a picture is in flight; pictures one at a time", async () => {
  const r = new MixedRenderer();
  const view = new EditorView({
    state: EditorState.create({ doc: "[[p]] $a$ [[q]] $b$ $c$", extensions: [liveInput(), livePreview({ language: mixedLanguage, renderer: r })] }),
    parent: document.body,
  });
  try {
    await sleep(0);
    assert.deepEqual(r.picCalls, ["p"], "one picture in flight");
    assert.deepEqual(r.math.calls, ["a", "b", "c"], "the formulas after it did not wait");
    assert.equal(text(view), "[[p]] [a] [[q]] [b] [c]");
    assert.equal(r.settlePic(), "p");
    await settle();
    assert.deepEqual(r.picCalls, ["p", "q"], "then the next picture");
    assert.equal(r.settlePic(), "q");
    await settle();
    assert.equal(text(view), "[pic p] [a] [pic q] [b] [c]");
    // Typing a formula while a picture renders: the formula renders at once.
    view.dispatch({ changes: { from: view.state.doc.length, insert: " [[s]] $d$" } });
    await sleep(0);
    assert.deepEqual(r.picCalls, ["p", "q", "s"]);
    assert.equal(r.math.calls.at(-1), "d");
    assert.ok(text(view).endsWith("[[s]] [d]"), text(view));
    r.settlePic();
    await settle();
    assert.equal(renderStats(view).pending, 0);
  } finally {
    view.destroy();
  }
});

test("T-S11 epoch-free requests keep their renders across a new epoch; the others render again", async () => {
  const r = new MixedRenderer();
  const view = new EditorView({
    state: EditorState.create({ doc: "[[p]] $a$", extensions: [liveInput(), livePreview({ language: mixedLanguage, renderer: r })] }),
    parent: document.body,
  });
  try {
    await sleep(0);
    r.settlePic();
    await settle();
    assert.equal(text(view), "[pic p] [a]");
    r.math.bump();
    await settle();
    assert.deepEqual(r.math.calls, ["a", "a"], "the formula rendered again");
    assert.deepEqual(r.picCalls, ["p"], "the picture did not");
    assert.equal(text(view), "[pic p] [a]");
    assert.equal(renderStats(view).pending, 0);
    // A picture landing after the epoch moved is kept (the epoch does not change it).
    view.dispatch({ changes: { from: view.state.doc.length, insert: " [[q]]" } });
    await sleep(0);
    r.math.bump();
    r.settlePic();
    await settle();
    assert.deepEqual(r.picCalls, ["p", "q"]);
    assert.equal(text(view), "[pic p] [a] [pic q]");
  } finally {
    view.destroy();
  }
});

// ---- T-S12 keys ------------------------------------------------------------------------------------

const liveKeys = (): Extension[] => [
  liveInput(),
  livePreviewCompartment.of(livePreview({ language, renderer: new SyncRenderer() })),
];

test("T-S12 live preview binds no keys", () => {
  const state = EditorState.create({ extensions: liveKeys() });
  assert.deepEqual(state.facet(keymap), [], "no keymap");
});

for (const state of Object.keys(STATES)) {
  test(`T-S12 matrix with live preview on: ${state}`, async () => {
    const row = await matrixRow((o) => fakeYolo(o), state, undefined, { extensions: liveKeys() });
    assert.deepEqual(row, GOLDEN[state]);
  });
}

/** Each key once in a fresh view: the outcome in source mode and in live mode. */
async function keyRow(doc: string, anchor: number, keys: readonly string[]) {
  const out: Record<string, { source: string; live: string }> = {};
  for (const key of keys) {
    const res: string[] = [];
    for (const live of [false, true]) {
      const c = setup(null, { doc, extensions: live ? liveKeys() : [] });
      c.view.dispatch({ selection: { anchor } });
      await settle();
      const shown = widgets(c.view);
      const r = press(c.view, key);
      await sleep(0);
      const sel = c.view.state.selection.main;
      res.push(
        `${r.handled}/${r.propagated} doc=${JSON.stringify(c.view.state.doc.toString())} sel=${sel.anchor}-${sel.head}` +
          (live ? ` widgets=${shown}->${widgets(c.view)}` : ""),
      );
      c.view.destroy();
      c.bridge.destroy();
    }
    out[key] = { source: res[0], live: res[1] };
  }
  return out;
}

const same = (row: Record<string, { source: string; live: string }>, key: string) =>
  assert.equal(row[key].live.replace(/ widgets=.*/, ""), row[key].source, key);

test("T-S12 cursor next to a collapsed inline formula: Tab, Enter, Escape as in source mode", async () => {
  // "a $x$ b": the cursor at 6 (before "b") does not touch $x$ (2..5).
  const row = await keyRow("a $x$ b", 6, ["Tab", "Shift-Tab", "Enter", "Escape", "ArrowUp", "ArrowDown"]);
  for (const key of ["Tab", "Shift-Tab", "Enter", "Escape", "ArrowUp", "ArrowDown"]) same(row, key);
  assert.match(row.Enter.live, /doc="a \$x\$ \\nb" sel=7-7 widgets=1->1/);
  assert.match(row.Tab.live, /widgets=1->1/);
});

test("T-S12 cursor next to a collapsed block: Tab, Enter, Escape as in source mode; arrows enter it", async () => {
  // Line 1 "a", lines 2-4 "$$ / x / $$", line 5 "b".
  const doc = "a\n$$\nx\n$$\nb";
  const above = await keyRow(doc, 0, ["Tab", "Shift-Tab", "Enter", "Escape", "ArrowDown"]);
  for (const key of ["Tab", "Shift-Tab", "Enter", "Escape"]) same(above, key);
  // (jsdom's vertical motion jumps to the doc end: the filter brings it back to the block.)
  assert.match(above.ArrowDown.live, /^true\/true .* sel=2-2 widgets=1->0/, "ArrowDown lands on the block and reveals it");
  const after = await keyRow(doc, 10, ["Tab", "Enter", "Escape", "ArrowUp"]);
  for (const key of ["Tab", "Enter", "Escape"]) same(after, key);
  assert.match(after.ArrowUp.live, /^true\/true .* sel=9-9 widgets=1->0/, "ArrowUp lands on the block's last line");
});

// ---- more: replacedAt, hover, limits, heights ------------------------------------------------------

test("replacedAt: positions a widget renders, not revealed or unrendered ones", async () => {
  const { view } = await mount("a $x$ b $bad$ c", { anchor: 0 });
  assert.equal(text(view), "a [x] b $bad$ c", "a failed render stays source");
  assert.ok(view.contentDOM.querySelector(".lsp-lp-error"));
  assert.ok(replacedAt(view.state, 2) && replacedAt(view.state, 4) && replacedAt(view.state, 5));
  assert.ok(!replacedAt(view.state, 1) && !replacedAt(view.state, 6), "outside");
  assert.ok(!replacedAt(view.state, 10), "the failed formula");
  move(view, 3);
  assert.ok(!replacedAt(view.state, 3), "revealed");
  assert.ok(!replacedAt(EditorState.create({ doc: "a $x$" }), 3), "not live");
  view.destroy();
});

test("a quiet failure keeps the source without the error underline", async () => {
  const { view } = await mount("a $quiet$ b\n$$\nquiet\n$$", { anchor: 0 });
  assert.equal(widgets(view), 0);
  assert.equal(view.contentDOM.querySelector(".lsp-lp-error"), null);
  move(view, view.state.doc.line(3).from);
  const preview = below(view)!;
  assert.ok(preview && !preview.classList.contains("is-error") && preview.childNodes.length === 0, "nothing below");
  view.destroy();
});

test("renderHover skips positions a live widget renders, without its own replacedAt", async () => {
  let renders = 0;
  const hover = renderHover({
    enabled: () => true,
    target: (state, pos) => scanMath(state.doc).find((m) => m.from <= pos && pos <= m.to) ?? null,
    render: (t) => {
      renders++;
      const el = document.createElement("span");
      el.className = "hover-render";
      el.textContent = String(t.from);
      return el;
    },
  });
  // "$x$" (2..5) is rendered, "$y$" (8..11) revealed by the cursor.
  const { view } = await mount("a $x$ b $y$", { anchor: 9, extensions: [hover] });
  assert.equal(text(view), "a [x] b $y$");
  activateHover(view, 3, 1);
  assert.equal(view.dom.querySelector(".hover-render"), null, "over the widget");
  activateHover(view, 9, 1);
  assert.equal(view.dom.querySelector(".hover-render")?.textContent, "8", "over visible source");
  assert.equal(renders, 1);
  view.destroy();
});

test("one-line replacements are drawn near the viewport; atomic ranges and replacedAt cover the document", async () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `Line ${i} with $f_{${i}}$ inline.`);
  const { view } = await mount(lines.join("\n"), { focus: false });
  for (let i = 0; i < 100 && renderStats(view).pending; i++) await sleep(60);
  assert.equal(renderStats(view).pending, 0);
  const drawn = () =>
    view.state.facet(EditorView.decorations)
      .filter((d) => typeof d === "function")
      .reduce((n, f) => n + f(view).size, 0);
  const atomic = view.state.facet(EditorView.atomicRanges).reduce((n, f) => n + f(view).size, 0);
  assert.equal(atomic, 3000, "every formula is atomic");
  assert.ok(drawn() > 0 && drawn() < 1000, `drawn near the viewport: ${drawn()}`);
  const far = view.state.doc.line(2900);
  const inFar = far.from + far.text.indexOf("$") + 1;
  assert.ok(replacedAt(view.state, inFar), "replacedAt reads the whole document");
  view.dispatch({ effects: EditorView.scrollIntoView(far.from, { y: "center" }) });
  await settle();
  assert.ok(text(view).includes("Line 2900 with [f_{2900}] inline."), "drawn once in view");
  assert.ok(drawn() < 1000);
  // The main cursor's line is drawn wherever it is (CodeMirror draws it too).
  const first = view.state.doc.line(1);
  view.dispatch({ selection: { anchor: first.to } });
  let onFirst = false;
  for (const d of view.state.facet(EditorView.decorations)) {
    if (typeof d === "function") d(view).between(first.from, first.to, () => void (onFirst = true));
  }
  assert.ok(onFirst, "the cursor's line keeps its replacements");
  view.destroy();
});

test("a scanner that throws leaves the text as source and the editor usable (logged once)", async () => {
  const errors: unknown[] = [];
  const throwing: LiveLanguage<Math> = {
    scan(doc) {
      if (doc.toString().includes("boom")) throw new RangeError("Maximum call stack size exceeded");
      return scanMath(doc);
    },
    decorate: language.decorate,
  };
  const view = new EditorView({
    state: EditorState.create({
      doc: "a $x$ b",
      extensions: [liveInput(), livePreview({ language: throwing, renderer: new SyncRenderer() }), EditorView.exceptionSink.of((e) => errors.push(e))],
    }),
    parent: document.body,
  });
  await settle();
  assert.equal(widgets(view), 1);
  view.dispatch({ changes: { from: 0, insert: "boom " } });
  assert.equal(text(view), "boom a $x$ b", "source");
  view.dispatch({ changes: { from: 0, insert: "boom " } });
  assert.equal(errors.length, 1, "logged once");
  view.dispatch({ changes: { from: 0, to: 10 } });
  await settle();
  assert.equal(text(view), "a [x] b", "rendered again");
  view.destroy();
});

test("a `reveals` that throws: every construct tests its own lines (logged once)", async () => {
  const errors: unknown[] = [];
  const throwing: LiveLanguage<Math> = {
    ...language,
    reveals: () => {
      throw new Error("reveals bug");
    },
  };
  const view = new EditorView({
    state: EditorState.create({
      doc: "a $x$ b\nc $y$ d",
      extensions: [liveInput(), livePreview({ language: throwing, renderer: new SyncRenderer() }), EditorView.exceptionSink.of((e) => errors.push(e))],
    }),
    parent: document.body,
  });
  view.focus();
  await settle();
  move(view, 3);
  assert.equal(text(view), "a $x$ bc [y] d", "the formula at the cursor reveals");
  move(view, view.state.doc.line(2).from + 3);
  assert.equal(text(view), "a [x] bc $y$ d", "a move re-decorates both lines");
  view.dispatch({ changes: { from: 0, insert: "e " } });
  assert.equal(errors.length, 1, "logged once");
  view.destroy();
});

test("documents over maxLines get no decorations; isLive still reports the mode", async () => {
  const renderer = new SyncRenderer();
  const view = new EditorView({
    state: EditorState.create({
      doc: "$a$\n$b$\n$c$",
      extensions: [liveInput(), livePreview({ language, renderer, maxLines: 2 })],
    }),
    parent: document.body,
  });
  await settle();
  assert.equal(widgets(view), 0);
  assert.ok(isLive(view.state));
  assert.deepEqual(renderer.calls, []);
  view.dispatch({ changes: { from: 7, to: 11 } });
  await settle();
  assert.equal(widgets(view), 2, "back under the limit");
  view.destroy();
});

test("overlapping replaces: the first one wins; wraps and marks come through", async () => {
  interface Box extends Construct {
    kind: "box" | "inner";
  }
  const boxes: LiveLanguage<Box> = {
    // "[[ab]]": the outer range replaces 0..6; the inner 2..4 overlaps and is dropped.
    scan: () => [
      { from: 0, to: 6, kind: "box" },
      { from: 2, to: 4, kind: "inner" },
    ],
    decorate(c, ctx) {
      if (c.kind === "box") {
        ctx.replace(c.from, c.to, Decoration.replace({ widget: new TextWidget("BOX", "outer") }));
        ctx.wrap(0, ctx.state.doc.line(2).to, { tagName: "div", attributes: { class: "lsp-lp-box is-main" } });
        ctx.mark(ctx.state.doc.line(2).from, ctx.state.doc.line(2).from, Decoration.line({ class: "lsp-lp-h2" }));
      } else {
        ctx.replace(c.from, c.to, Decoration.replace({ widget: new TextWidget("IN", "inner") }));
      }
    },
  };
  const view = new EditorView({
    state: EditorState.create({
      doc: "[[ab]]\nsecond",
      extensions: [liveInput(), livePreview({ language: boxes, renderer: new SyncRenderer() })],
    }),
    parent: document.body,
  });
  assert.equal(view.contentDOM.querySelector(".outer")?.textContent, "BOX");
  assert.equal(view.contentDOM.querySelector(".inner"), null);
  const box = view.contentDOM.querySelector(".lsp-lp-box.is-main");
  assert.ok(box, "a BlockWrapper element");
  assert.equal(box!.querySelectorAll(".cm-line").length, 2, "around both lines");
  assert.ok(view.contentDOM.querySelector(".cm-line.lsp-lp-h2"));
  view.destroy();
});

test("a resized block widget bumps a line attribute once per frame, so CodeMirror measures again", async () => {
  const observers: { cb: () => void; target: Element | null }[] = [];
  class FakeRO {
    private entry: { cb: () => void; target: Element | null };
    constructor(cb: () => void) {
      observers.push((this.entry = { cb, target: null }));
    }
    observe(el: Element) {
      this.entry.target = el;
    }
    disconnect() {
      this.entry.target = null;
    }
  }
  const w = window as unknown as { ResizeObserver?: unknown };
  const saved = w.ResizeObserver;
  w.ResizeObserver = FakeRO;
  try {
    const { view } = await mount("p\n$$\nx\n$$\n$$\ny\n$$", { focus: false });
    const gen = () => view.contentDOM.querySelector(".cm-line")!.getAttribute("data-lp-gen");
    assert.equal(observers.length, 2, "one observer per block widget");
    let height = 20;
    for (const o of observers) o.target!.getBoundingClientRect = () => ({ height }) as DOMRect;
    for (const o of observers) o.cb(); // first size: CodeMirror's own measurement
    await sleep(40);
    assert.equal(gen(), "0");
    height = 48; // glyph CSS arrived
    for (const o of observers) o.cb();
    await sleep(40);
    assert.equal(gen(), "1", "two resizes in one frame: one remeasure");
    const est = new RenderWidget({ key: `0|math|1|\nx\n`, src: "\nx\n", display: true, kind: "math", pos: 0 }, undefined, "block");
    assert.equal(est.estimatedHeight, 48, "the measured height is the estimate");
    view.destroy();
    assert.ok(observers.every((o) => o.target === null), "disconnected with the widgets");
  } finally {
    w.ResizeObserver = saved;
  }
});

test("focus is read again when the state is replaced on a focused editor", async () => {
  const { view, renderer } = await mount("$x$ b", { anchor: 0 });
  assert.equal(widgets(view), 0, "revealed");
  view.setState(
    EditorState.create({
      doc: "$x$ b",
      selection: { anchor: 0 },
      extensions: [liveInput(), livePreview({ language, renderer })],
    }),
  );
  await sleep(0);
  assert.equal(view.hasFocus, true, "replacing the state keeps DOM focus");
  assert.equal(widgets(view), 0, "still focused: still revealed");
  view.destroy();
});

test("scans are memoized per document", async () => {
  const { view } = await mount("$x$ $y$\nline");
  const before = scans;
  move(view, 1);
  move(view, 2);
  move(view, 9);
  view.dispatch({ effects: refreshLive.of(null) });
  assert.equal(scans, before, "selection moves and refreshes reuse the scan");
  view.dispatch({ changes: { from: 0, insert: " " } });
  assert.equal(scans, before + 1);
  view.destroy();
});
