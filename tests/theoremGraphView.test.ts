import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, activateHover } from "@codemirror/view";
import { latexTooltipPortal, theoremGraphHover, theoremReferenceAt, theoremReferences, type TheoremGraphHoverOptions } from "../src/editor/theoremGraphView";
import type { TheoremGraph, TheoremNode, TheoremSource } from "../src/tex/theoremGraph";
import { latexLiveLanguage } from "../src/editor/latexLive";
import { DEFAULT_REF_NAMES, type LatexRefs } from "../src/editor/latexRefs";
import { livePreview } from "../src/editor/shared/livePreview";
import { texEditorExtensions } from "../src/editor/texExtensions";

const sleep = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const source = (i: number): TheoremSource => ({ file: "/tmp/main.tex", key: "main.tex", visit: 0, from: i * 20, to: i * 20 + 19, bodyFrom: i * 20 + 1, bodyTo: i * 20 + 18, line: i + 1, nodes: [] });
function graph(size = 3): TheoremGraph {
  const nodes = new Map<string, TheoremNode>();
  for (let i = 0; i < size; i++) nodes.set(String(i), { id: String(i), env: "theorem", name: "Theorem", title: `Statement ${i}`, labels: [`T${i}`], number: String(i + 1), statement: source(i), proofs: [] });
  return { nodes, byLabel: new Map([...nodes].map(([id]) => [`T${id}`, [id]])), edges: size === 3 ? [{ from: "0", to: "1", key: "T1", evidence: source(0) }, { from: "1", to: "2", key: "T2", evidence: source(1) }, { from: "2", to: "0", key: "T0", evidence: source(2) }] : [...nodes.keys()].slice(1).map(id => ({ from: "0", to: id, key: `T${id}`, evidence: source(0) })), unresolved: [] };
}
function makeView(options: Partial<TheoremGraphHoverOptions> = {}, extra: Extension[] = [], text = String.raw`Read \ref{T0} here.`) {
  const data = graph();
  const calls = { load: 0, render: 0, source: 0 };
  const extension = theoremGraphHover({
    load: async (_view, key) => { calls.load++; return { graph: data, selectedId: data.byLabel.get(key)?.[0] ?? null, key }; },
    renderContent: async (_view, node) => { calls.render++; const dom = document.createElement("div"); dom.textContent = `Full statement and proof ${node.id}`; return dom; },
    openSource: () => { calls.source++; },
    hoverTime: 10,
    ...options,
  });
  const view = new EditorView({ state: EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [extra, extension] }), parent: document.body });
  return { view, calls, data };
}
function open(view: EditorView) { const ref = theoremReferences(view.state.doc)[0]; activateHover(view, ref.from + 2, 1); }
const popup = (view: EditorView) => view.dom.querySelector<HTMLElement>(".ll-theorem-graph");

test("LaTeX tooltip portal: outside clipped pane, scoped styles and editor theme, cleanup", async () => {
  const pane = document.body.appendChild(document.createElement("div"));
  Object.assign(pane.style, { overflow: "hidden", transform: "translateZ(0)" });
  const theme = EditorView.theme({}, { dark: true });
  const { view } = makeView({}, [latexTooltipPortal(), theme]); pane.appendChild(view.dom);
  await sleep(); open(view); await sleep();
  const parent = document.body.querySelector<HTMLElement>(".ll-tooltip-portal")!;
  assert.ok(parent); assert.equal(parent.parentElement, document.body);
  assert.equal(pane.contains(parent), false); assert.equal(view.dom.contains(parent), false);
  const dom = parent.querySelector<HTMLElement>(".ll-theorem-graph")!; assert.ok(dom);
  assert.ok(dom.closest(".ll-editor-content.lsp-cm-view")); assert.ok(dom.closest(".cm-editor"));
  const themed = parent.querySelector(".cm-editor")!.firstElementChild!;
  assert.equal(themed.className, view.themeClasses, "CM's external container retains the active editor theme");
  view.destroy(); assert.equal(parent.isConnected, false); pane.remove();
});

test("LaTeX tooltip portal: reused state and popout adoption use each view's actual document", async () => {
  const { view } = makeView({}, [latexTooltipPortal()]); await sleep();
  const old = document.querySelector(".ll-tooltip-portal")!;
  const state = view.state; view.destroy(); assert.equal(old.isConnected, false);
  const restored = new EditorView({ state, parent: document.body }); await sleep();
  const current = document.querySelector(".ll-tooltip-portal")!; assert.ok(current); assert.notEqual(current, old);
  const popout = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  popout.window.document.body.appendChild(restored.dom); restored.setRoot(popout.window.document);
  restored.dispatch({}); await sleep();
  const moved = popout.window.document.querySelector(".ll-tooltip-portal")!;
  assert.ok(moved); assert.equal(moved.ownerDocument, restored.dom.ownerDocument);
  assert.equal(moved.parentElement, popout.window.document.body); assert.equal(current.isConnected, false);
  open(restored); await sleep(); assert.ok(moved.querySelector(".ll-theorem-graph"));
  restored.destroy(); assert.equal(moved.isConnected, false); popout.window.close();
});

test("theorem graph adoption: new-window mouseup releases drag, old-window mouseup cannot", async () => {
  const { view, calls } = makeView({}, [latexTooltipPortal()]); await sleep();
  const popout = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  popout.window.Range.prototype.getClientRects = Range.prototype.getClientRects;
  popout.window.Range.prototype.getBoundingClientRect = Range.prototype.getBoundingClientRect;
  popout.window.document.body.appendChild(view.dom); view.setRoot(popout.window.document);
  const line = view.contentDOM.querySelector(".cm-line")!;
  // No state transaction between adoption and the first native-style mouse press.
  line.dispatchEvent(new popout.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  open(view); await sleep(); assert.equal(calls.load, 0);
  popout.window.document.body.dispatchEvent(new popout.window.MouseEvent("mouseup", { bubbles: true }));
  open(view); await sleep(); assert.equal(calls.load, 1);
  assert.ok(popout.window.document.querySelector(".ll-theorem-graph"));
  line.dispatchEvent(new popout.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  open(view); await sleep(); assert.equal(calls.load, 1, "old window no longer owns the held gesture");
  assert.equal(popout.window.document.querySelector(".ll-theorem-graph"), null);
  popout.window.document.body.dispatchEvent(new popout.window.Event("pointercancel", { bubbles: true }));
  open(view); await sleep(); assert.equal(calls.load, 2);
  view.destroy(); assert.equal(popout.window.document.querySelector(".ll-tooltip-portal"), null);
  popout.window.close();
});

// Source syntax and math source share the graph-specific lexer; no regex across code regions.
test("theorem graph reference detection: source/math refs, literal comma keys, no code/verbatim/comment matches", () => {
  const doc = EditorState.create({ doc: String.raw`% \ref{bad-comment}
\newcommand{\foo}{\ref{bad-definition}}
\begin{verbatim}\ref{bad-verbatim}\end{verbatim}
Read \ref{T0}, $x=\ref{math,key}$ and \(\text{see \ref{T1}}\).
\begin{align}x &= \ref{T2}\end{align}` }).doc;
  const actual = theoremReferences(doc);
  assert.deepEqual(actual.map(ref => ref.key), ["T0", "math,key", "T1", "T2"]);
  for (const ref of actual) assert.ok(doc.sliceString(ref.from, ref.to).startsWith("\\ref{"));
});

test("theorem graph popup: default one level, lazy card, one-more-level control, cycle, source button", async () => {
  const { view, calls } = makeView();
  open(view); await sleep();
  const dom = popup(view)!; assert.ok(dom); assert.equal(dom.getAttribute("aria-label"), "证明引用关系");
  assert.equal(dom.querySelectorAll(".ll-theorem-graph-node").length, 2); assert.equal(calls.render, 0);
  const first = dom.querySelector<HTMLButtonElement>('[data-node-id="0"].ll-theorem-graph-node')!;
  first.focus(); first.click(); await sleep();
  assert.equal(calls.render, 1); assert.match(dom.textContent!, /Full statement and proof 0/);
  assert.ok(dom.contains(document.activeElement));
  dom.querySelector<HTMLElement>('[data-node-id="1"] .ll-theorem-graph-expand')!.click();
  assert.equal(dom.querySelectorAll(".ll-theorem-graph-node").length, 3);
  dom.querySelector<HTMLElement>('[data-node-id="2"] .ll-theorem-graph-expand')!.click();
  assert.equal(dom.querySelectorAll(".ll-theorem-graph-node").length, 3); assert.match(dom.textContent!, /回环/);
  dom.querySelector<HTMLElement>(".ll-theorem-graph-source")!.click(); assert.equal(calls.source, 1);
  view.destroy();
});

test("theorem graph popup: content ref links traverse through graph labels by delegation", async () => {
  const { view } = makeView({ renderContent: (_view, node) => {
    const dom = document.createElement("div"); const link = dom.appendChild(document.createElement("a")); link.href = "#T1"; link.dataset.llTheoremKey = "T1"; link.textContent = `reference from ${node.id}`; return dom;
  } });
  open(view); await sleep(); popup(view)!.querySelector<HTMLElement>(".ll-theorem-graph-node")!.click(); await sleep();
  popup(view)!.querySelector<HTMLElement>("[data-ll-theorem-key]")!.click(); await sleep();
  assert.equal(popup(view)!.querySelector(".ll-theorem-node.is-selected")?.getAttribute("data-node-id"), "1");
  view.destroy();
});

test("theorem graph popup: ambiguous labels demand explicit candidate, max25 and diagnostics", async () => {
  const many = graph(30); const ambiguous = { ...many, byLabel: new Map([["T0", ["0", "1"]]]) };
  const { view } = makeView({ load: async (_v, key) => ({ graph: ambiguous, selectedId: null, key }) });
  open(view); await sleep(); const dom = popup(view)!; assert.match(dom.textContent!, /多个定理/);
  assert.equal(dom.querySelectorAll(".ll-theorem-graph-node").length, 0);
  dom.querySelector<HTMLButtonElement>(".ll-theorem-graph-notices button")!.click();
  assert.equal(dom.querySelectorAll(".ll-theorem-graph-node").length, 25); assert.match(dom.textContent!, /最多显示 25/);
  view.destroy();
});

test("theorem graph popup: pending load and content never land after selection change or destroy", async () => {
  const pending = deferred<ReturnType<TheoremGraphHoverOptions["load"]> extends Promise<infer T> ? T : never>();
  let signal: AbortSignal | undefined;
  const { view, data } = makeView({ load: (_v, _k, s) => { signal = s; return pending.promise; } });
  open(view); view.dispatch({ selection: { anchor: 0 } });
  pending.resolve({ graph: data, selectedId: "0", key: "T0" }); await sleep(); assert.equal(popup(view), null); assert.equal(signal?.aborted, true); view.destroy();
  const content = deferred<HTMLElement>(); let contentSignal: AbortSignal | undefined;
  const other = makeView({ renderContent: (_v, _n, s) => { contentSignal = s; return content.promise; } });
  open(other.view); await sleep(); other.view.dom.querySelector<HTMLElement>(".ll-theorem-graph-node")!.click();
  other.view.destroy(); const late = document.createElement("div"); late.textContent = "Late content"; content.resolve(late); await sleep();
  assert.equal(late.isConnected, false); assert.equal(contentSignal?.aborted, true);
});

test("theorem graph popup: compositionStarted blocks loads; invalidation subscriber closes pending/shown UI", async () => {
  let changed!: () => void, unsubscribed = false, composing = true;
  const { view, calls } = makeView({ subscribe: (_view, cb) => { changed = cb; return () => { unsubscribed = true; }; } });
  Object.defineProperty(view, "compositionStarted", { configurable: true, get: () => composing });
  open(view); await sleep(); assert.equal(calls.load, 0);
  composing = false; open(view); await sleep(); assert.ok(popup(view));
  changed(); await sleep(); assert.equal(popup(view), null);
  view.destroy(); assert.equal(unsubscribed, true);
});

test("theorem graph popup: entering composition closes once without a close-effect update loop", async () => {
  const { view } = makeView(); let composing = false, updates = 0;
  Object.defineProperty(view, "compositionStarted", { configurable: true, get: () => composing });
  open(view); await sleep(); assert.ok(popup(view));
  const originalDispatch = view.dispatch.bind(view);
  Object.assign(view, { dispatch: (...args: Parameters<EditorView["dispatch"]>) => { updates++; originalDispatch(...args); } });
  composing = true; view.dispatch({ selection: { anchor: 0 } }); await sleep();
  assert.equal(popup(view), null); assert.ok(updates < 5, `composition unexpectedly dispatched ${updates} updates`);
  view.destroy();
});

test("theorem graph popup: failed lookup is owned by lifecycle and disappears when invalidated", async () => {
  let invalidate!: () => void;
  const { view } = makeView({ load: async () => { throw new Error("source unavailable"); }, subscribe: (_view, changed) => { invalidate = changed; return () => {}; } });
  open(view); await sleep(); assert.match(popup(view)!.textContent!, /source unavailable/);
  invalidate(); await sleep(); assert.equal(popup(view), null); view.destroy();
});

test("theorem graph popup: a held selection drag suppresses graph work until mouseup outside editor", async () => {
  const { view, calls } = makeView();
  const line = view.contentDOM.querySelector(".cm-line")!;
  line.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  open(view); await sleep(); assert.equal(calls.load, 0); assert.equal(popup(view), null);
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  open(view); await sleep(); assert.equal(calls.load, 1); assert.ok(popup(view));
  line.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  await sleep(); assert.equal(popup(view), null);
  window.dispatchEvent(new Event("blur")); open(view); await sleep(); assert.ok(popup(view));
  view.destroy();
});

test("theorem graph live chip metadata maps current position and leaves source-edit events ordinary", async () => {
  const text = String.raw`Read \ref{T0} here.`;
  const references: LatexRefs = { numbers: new Map([["T0", "1"]]), labels: new Map(), cites: new Map(), names: DEFAULT_REF_NAMES, theorems: new Map(), checkpoints: new Map() };
  const renderer = { epoch: 0, render: () => ({ ok: true as const, node: document.createElement("span") }), subscribe: () => () => {} };
  const extra = texEditorExtensions({ text, live: livePreview({ language: latexLiveLanguage({ refs: () => references }), renderer }) });
  const { view } = makeView({}, extra, text); await sleep();
  const chip = view.contentDOM.querySelector<HTMLElement>("[data-ll-ref-key]")!; assert.ok(chip); assert.equal(chip.dataset.llRefKey, "T0");
  const ref = theoremReferenceAt(view, 0, 1, chip)!; assert.equal(ref.key, "T0"); assert.equal(ref.from, text.indexOf("\\ref"));
  view.dispatch({ changes: { from: 0, insert: "prefix " } }); await sleep();
  const mappedChip = view.contentDOM.querySelector<HTMLElement>("[data-ll-ref-key]")!;
  const mapped = theoremReferenceAt(view, 0, 1, mappedChip)!; assert.equal(mapped.from, ref.from + 7);
  let delegates = false;
  for (const extension of view.state.facet(EditorView.decorations)) {
    const set = typeof extension === "function" ? extension(view) : extension;
    set.between(0, view.state.doc.length, (_from, _to, decoration) => {
      const widget = decoration.spec.widget;
      if (widget?.key === "T0") delegates = widget.ignoreEvent(new MouseEvent("mousedown")) === false;
    });
  }
  assert.equal(delegates, true, "reference widget still delegates click/drag to CodeMirror");
  open(view); await sleep(); assert.ok(popup(view)); view.destroy();
});
