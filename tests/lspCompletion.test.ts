import "./support/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  Completion,
  CompletionContext,
  acceptCompletion,
  autocompletion,
  closeBrackets,
  completionStatus,
  currentCompletions,
  selectedCompletion,
  setSelectedCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, undo } from "@codemirror/commands";
import { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { acceptWouldChange, keyArbiter } from "../src/editor/shared/keyArbiter";
import {
  LspCompletionBackend,
  LspCompletionContext,
  LspCompletionItem,
  LspCompletionOptions,
  LspPosition,
  defaultGlyph,
  labelDescription,
  labelEvidence,
  lspCompletionSource,
  lspGlyphColumn,
  lspQueryEmpty,
} from "../src/editor/shared/lspCompletion";

interface FixtureCase {
  doc: string;
  offset: number;
  position: LspPosition;
  context: LspCompletionContext;
  response: unknown;
  resolved?: Record<string, unknown>;
}
interface Fixture {
  triggerCharacters: string[];
  cases: Record<string, FixtureCase>;
}
// Recorded from tinymist 0.15.2 / texlab 5.26.0 on small synthetic projects (see "note").
const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/${name}`, "utf8")) as Fixture;
const TINYMIST = fixture("tinymist-completion.json");
const TEXLAB = fixture("texlab-completion.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A backend answering from recorded responses: a request matches a case by document text
 * and position (what the real server saw). `answer` overrides the lookup.
 */
function fixtureBackend(fx: Fixture, answer?: (state: EditorState, pos: LspPosition) => unknown) {
  const calls: { pos: LspPosition; context: LspCompletionContext; doc: string }[] = [];
  const backend: LspCompletionBackend = {
    triggerCharacters: () => fx.triggerCharacters,
    async request(pos, context, state) {
      const doc = state.doc.toString();
      calls.push({ pos, context, doc });
      if (answer) return structuredClone(answer(state, pos));
      const hit = Object.values(fx.cases).find(
        (c) => c.doc === doc && c.position.line === pos.line && c.position.character === pos.character,
      );
      return hit ? structuredClone(hit.response) : null;
    },
    async resolve(item) {
      for (const c of Object.values(fx.cases)) {
        const r = c.resolved?.[item.label];
        if (r) return structuredClone(r);
      }
      return item;
    },
  };
  return { backend, calls };
}

function makeView(
  doc: string,
  cursor: number,
  source: ReturnType<typeof lspCompletionSource>,
  extra: Extension[] = [],
) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [...extra, history(), autocompletion({ override: [source], addToOptions: [lspGlyphColumn] })],
    }),
    parent: document.body,
  });
}

function type(view: EditorView, text: string) {
  for (const ch of text) {
    const head = view.state.selection.main.head;
    view.dispatch({
      changes: { from: head, insert: ch },
      selection: { anchor: head + 1 },
      userEvent: "input.type",
    });
  }
}

/** Wait for the query to settle and the popup to pass interactionDelay (75 ms). */
async function settle(view: EditorView) {
  await sleep(130);
  for (let i = 0; i < 100 && completionStatus(view.state) === "pending"; i++) await sleep(10);
  await sleep(90);
}

async function typeSlowly(view: EditorView, text: string, gap: number) {
  for (const ch of text) {
    type(view, ch);
    await sleep(gap);
  }
  await settle(view);
}

const labels = (view: EditorView) => currentCompletions(view.state).map((c) => c.displayLabel ?? c.label);

function select(view: EditorView, label: string) {
  const i = labels(view).indexOf(label);
  assert.ok(i >= 0, `${label} not offered: ${labels(view).slice(0, 10).join(", ")}`);
  view.dispatch({ effects: setSelectedCompletion(i) });
}

/** The line around the cursor with `|` at the cursor. */
function lineAtCursor(view: EditorView) {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return line.text.slice(0, head - line.from) + "|" + line.text.slice(head - line.from);
}

/** Document of a case with the text right before the cursor removed (to type it). */
function before(c: FixtureCase, typed: string) {
  assert.equal(c.doc.slice(c.offset - typed.length, c.offset), typed);
  return { doc: c.doc.slice(0, c.offset - typed.length) + c.doc.slice(c.offset), cursor: c.offset - typed.length };
}

async function openAt(fx: Fixture, name: string, opts?: LspCompletionOptions, extra?: Extension[]) {
  const c = fx.cases[name];
  const { backend, calls } = fixtureBackend(fx);
  const view = makeView(c.doc, c.offset, lspCompletionSource(backend, opts), extra);
  startCompletion(view);
  await settle(view);
  return { view, calls };
}

// ---- tinymist ---------------------------------------------------------------------

test("tinymist: the whole list reaches CM (no 300 cut); theta (item #363) wins after typing", async () => {
  const c = TINYMIST.cases.math_t;
  const items = (c.response as { items: LspCompletionItem[] }).items;
  assert.equal(items.length, 400);
  assert.ok(items.findIndex((i) => i.label === "theta") > 300);
  const direct = await lspCompletionSource(fixtureBackend(TINYMIST).backend)(
    new CompletionContext(EditorState.create({ doc: c.doc }), c.offset, true),
  );
  assert.equal(direct!.options.length, 400);
  assert.ok(direct!.validFor, "complete list: CM may filter it locally");
  const { view, calls } = await openAt(TINYMIST, "math_t");
  await typeSlowly(view, "heta", 150);
  assert.equal(calls.length, 1, "complete list: filtered locally");
  assert.equal(labels(view)[0], "theta");
  assert.equal(acceptWouldChange(view.state), false);
  view.destroy();
});

test("tinymist: theta typed with 150 ms gaps, then Enter keeps it lowercase and breaks the line", async () => {
  const { doc, cursor } = before(TINYMIST.cases.math_th, "th");
  const { backend, calls } = fixtureBackend(TINYMIST);
  const view = makeView(doc, cursor, lspCompletionSource(backend), [keyArbiter(), keymap.of(defaultKeymap)]);
  await typeSlowly(view, "theta", 150);
  assert.deepEqual(calls.map((x) => x.context), [{ triggerKind: 1 }], "one request, at 'th'");
  assert.equal(labels(view)[0], "theta");
  const enter = { key: "Enter", keyCode: 13, bubbles: true, cancelable: true };
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", enter));
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  assert.equal(view.state.doc.line(line.number - 1).text, "$ x = theta");
  assert.equal(line.text, "$");
  view.destroy();
});

test("tinymist: a 1-letter word does not query; the server's sortText orders equal matches", async () => {
  const { doc, cursor } = before(TINYMIST.cases.math_th, "th");
  const { backend, calls } = fixtureBackend(TINYMIST);
  const view = makeView(doc, cursor, lspCompletionSource(backend));
  type(view, "t");
  await settle(view);
  assert.equal(calls.length, 0);
  type(view, "h");
  await settle(view);
  assert.equal(calls.length, 1);
  assert.deepEqual(labels(view).slice(0, 5), ["theorem", "therefore", "theta", "thick", "thin"]);
  view.destroy();
});

test("tinymist: postfix items apply additionalTextEdits in one undoable transaction", async () => {
  for (const [pick, expected] of [
    ["bb", "$bb(arrow)|$"],
    ["abs(", "$abs(|, arrow)$"],
    ["r", "$arrow.r|$"],
  ]) {
    const { doc, cursor } = before(TINYMIST.cases.postfix, ".");
    const { backend, calls } = fixtureBackend(TINYMIST);
    let edits = 0;
    const count = EditorView.updateListener.of((u) => {
      for (const tr of u.transactions) if (tr.docChanged) edits++;
    });
    const view = makeView(doc, cursor, lspCompletionSource(backend), [count]);
    type(view, ".");
    await settle(view);
    assert.deepEqual(calls[0].context, { triggerKind: 2, triggerCharacter: "." });
    select(view, pick);
    const typed = view.state.doc.toString();
    edits = 0;
    assert.ok(acceptCompletion(view));
    assert.equal(lineAtCursor(view), expected);
    assert.equal(edits, 1, `${pick}: one transaction`);
    undo(view);
    assert.equal(view.state.doc.toString(), typed, `${pick}: one undo step`);
    view.destroy();
  }
});

test("tinymist: a range ending past the cursor replaces the rest of the word", async () => {
  const { view } = await openAt(TINYMIST, "mid_word");
  select(view, "figure");
  assert.ok(acceptCompletion(view));
  assert.equal(lineAtCursor(view), "#figure|");
  view.destroy();
});

test("tinymist: labels after @ and <, cursor after the insertion", async () => {
  for (const [name, trigger, expected] of [
    ["labels_at", "@", "See @basics|"],
    ["labels_lt", "<", "#ref(<basics>|)"],
  ]) {
    const { doc, cursor } = before(TINYMIST.cases[name], trigger);
    const { backend, calls } = fixtureBackend(TINYMIST);
    const view = makeView(doc, cursor, lspCompletionSource(backend));
    type(view, trigger);
    await settle(view);
    assert.deepEqual(calls[0].context, { triggerKind: 2, triggerCharacter: trigger });
    assert.deepEqual(labels(view), ["basics", "chebyshev-inequality", "eq-sum"]);
    assert.equal(currentCompletions(view.state)[0].detail, "Probability basics");
    type(view, "ba");
    await settle(view);
    assert.equal(calls.length, 1);
    assert.ok(acceptCompletion(view));
    assert.equal(lineAtCursor(view), expected);
    view.destroy();
  }
});

test("tinymist: figure labels read 'Figure · A box', not the run-together ': A boxFigure'", async () => {
  const c = TINYMIST.cases.labels_figure;
  const raw = (c.response as { items: LspCompletionItem[] }).items;
  const box = raw.find((i) => i.label === "fig:box")!;
  // What tinymist 0.15.2 sends: the caption's plain text is separator + caption + supplement.
  assert.equal(box.labelDetails?.description, ": A boxFigure");
  assert.equal(box.detail, ": A boxFigure");
  assert.equal(box.documentation, undefined);

  const { doc, cursor } = before(c, "@");
  const { backend } = fixtureBackend(TINYMIST);
  const view = makeView(doc, cursor, lspCompletionSource(backend));
  type(view, "@");
  await settle(view);
  const details = Object.fromEntries(currentCompletions(view.state).map((o) => [o.label, o.detail]));
  assert.deepEqual(details, {
    "sec:measure": "Measure theory",
    "fig:box": "Figure · A box",
    "tab:vals": "Table · Values: raw",
    "fig:plain": "No supplement", // supplement: none
    "thm:all": "Theorem · Every set is measurable.", // no caption: "figure(..)" + detail
    "fig:fr": "Fig. · Une boîte", // French separator ". – "
    "fig:zh": "图 · 一个盒子", // em-space separator; the document writes [一个盒子]
    "eq:sum": "x + y",
  });
  for (const o of currentCompletions(view.state)) assert.equal(lspGlyphColumn.render(o), null, o.label);
  view.destroy();

  const label = (description: string, detail?: string) =>
    labelDescription({ label: "x", kind: 18, detail: detail ?? description, labelDetails: { description } });
  assert.equal(label(": Results for GPTFigure"), "Figure · Results for GPT");
  assert.equal(label(": Fig."), "Fig.", "empty caption");
  assert.equal(label("figure(..)", "Figure"), "Figure", "no caption, no body text");
  assert.equal(label(".NET internals"), null, "a heading");
  assert.equal(label("text(..)", "Text"), null);
  // texlab labels (kind 9/21, detail "Equation", no labelDetails) keep their detail.
  const { items: refs } = TEXLAB.cases.ref.response as { items: LspCompletionItem[] };
  for (const item of refs) assert.equal(labelDescription(item), null, item.label);
});

test("tinymist: a label's text is cut into caption and supplement only where that is certain", async () => {
  // Recorded with chap.typ (#include'd: Chapter box, Performance of JavaScript with
  // supplement: none, a Theorem-supplement figure) and refs.bib (knuth84, a title
  // starting with ": ").
  const c = TINYMIST.cases.labels_edge;
  const { doc, cursor } = before(c, "@");
  const { backend } = fixtureBackend(TINYMIST);
  const view = makeView(doc, cursor, lspCompletionSource(backend));
  type(view, "@");
  await settle(view);
  const details = Object.fromEntries(currentCompletions(view.state).map((o) => [o.label, o.detail]));
  assert.deepEqual(details, {
    // From chap.typ: only Typst's own supplement is certain.
    "c:box": "Figure · Chapter box",
    "c:js": "Performance of JavaScript", // not "Script · Performance of Java"
    "c:thm": "Every set is measurable.Theorem", // a custom supplement, caption not in this document
    // Written in this document.
    "fig:js": "Performance of JavaScript", // supplement: none
    "fig:td": "Top-Down", // supplement: none
    "fig:multi": "Supplementary Figure · A box",
    "tab:cells": "Table · NameAge", // no caption; the cells [Name][Age] are no caption
    "fig:markup": "Figure · Sales of iPhone", // [Sales of *iPhone*]
    "blk:colon": ": starts with colon", // #block[: starts with colon]
    "fig:flow": "流程图", // supplement: none, not "图 · 流程"
    "thm:zh": "定理 · 每个集合都可测。",
    // Bibliography: the key keeps its title (a title starting with ": " too), the title its key.
    knuth84: "Literate Programming",
    colon: ": A Document Preparation SystemManual",
    "Literate Programming": "knuth84",
    ": A Document Preparation SystemManual": "colon",
  });
  view.destroy();

  // Without the document (a label from another file): Typst's own supplements only.
  const label = (description: string) =>
    labelDescription({ label: "x", kind: 18, detail: description, labelDetails: { description } });
  assert.equal(label(": Map of ParisFigure"), "Figure · Map of Paris");
  assert.equal(label(": ÜberblickAbbildung"), "Abbildung · Überblick");
  assert.equal(label("\u2003一个盒子图"), "图 · 一个盒子");
  assert.equal(label(": Performance of JavaScript"), "Performance of JavaScript");
  assert.equal(label(": Scores/Accuracy"), "Scores/Accuracy");
  assert.equal(label(": Sales of iPhone"), "Sales of iPhone");
  assert.equal(label(": Ends in Table"), "Ends in Table", "not glued to the caption");
  assert.equal(label(": Sistemi stabili"), "Sistemi stabili", "Hausa's 'tabili' inside a word");
  assert.equal(label(": A boxSupplementary Figure"), "A boxSupplementary Figure");
  // With it: the written caption settles a custom or lowercase supplement.
  const items = [
    { label: "x", kind: 18, detail: ": QQQtabili", labelDetails: { description: ": QQQtabili" } },
    { label: "y", kind: 18, detail: ": Map of ParisDiagram", labelDetails: { description: ": Map of ParisDiagram" } },
  ];
  const evidence = labelEvidence(items, '#figure(rect(), caption: [QQQ])\n#figure(rect(), caption: "Map of Paris")\n');
  assert.deepEqual(
    items.map((i) => labelDescription(i, evidence)),
    ["tabili · QQQ", "Diagram · Map of Paris"],
  );
});

test("tinymist: import paths (empty filterText is ignored) and member lists after '.'", async () => {
  const imp = await openAt(TINYMIST, "import_partial");
  assert.deepEqual(labels(imp.view), ["diagrams.typ"]);
  assert.ok(acceptCompletion(imp.view));
  assert.equal(lineAtCursor(imp.view), '#import "diagrams.typ|"');
  imp.view.destroy();

  const { doc, cursor } = before(TINYMIST.cases.calc_dot, ".");
  const { backend, calls } = fixtureBackend(TINYMIST);
  const view = makeView(doc, cursor, lspCompletionSource(backend));
  type(view, ".");
  await settle(view);
  assert.equal(calls.length, 1);
  assert.equal(currentCompletions(view.state).length, 53);
  select(view, "pi");
  assert.ok(acceptCompletion(view));
  assert.equal(lineAtCursor(view), "#calc.pi|");
  view.destroy();
});

test("tinymist: a snippet with one field puts the cursor in it", async () => {
  const { view } = await openAt(TINYMIST, "theo");
  assert.ok(acceptCompletion(view));
  assert.equal(lineAtCursor(view), "#theorem(|)");
  view.destroy();
});

test("tinymist: glyph column and detail", async () => {
  const { doc, cursor } = before(TINYMIST.cases.math_th, "th");
  const { backend } = fixtureBackend(TINYMIST);
  const view = makeView(doc, cursor, lspCompletionSource(backend));
  type(view, "th");
  await settle(view);
  type(view, "e");
  await settle(view);
  const theta = currentCompletions(view.state).find((c) => c.label === "theta")!;
  assert.equal(theta.detail, undefined, "the glyph is not repeated as detail");
  assert.equal((lspGlyphColumn.render(theta) as HTMLElement).textContent, "θ");
  const theorem = currentCompletions(view.state).find((c) => c.label === "theorem")!;
  assert.equal(lspGlyphColumn.render(theorem), null);
  assert.equal(theorem.detail, "(any, title: none | text) => block");
  view.destroy();
});

test("tinymist: the server's null after '(' closes nothing and throws nothing", async () => {
  const { view, calls } = await openAt(TINYMIST, "figure_paren");
  assert.equal(calls.length, 1);
  assert.equal(completionStatus(view.state), null);
  view.destroy();
});

// ---- texlab -------------------------------------------------------------------------

test("texlab: an incomplete command list is re-queried on every key (triggerKind 3)", async () => {
  const c = TEXLAB.cases.cmd_fr;
  assert.equal((c.response as { isIncomplete: boolean }).isIncomplete, true);
  const { doc, cursor } = before(c, "fr");
  const { backend, calls } = fixtureBackend(TEXLAB, (state) => {
    const d = state.doc.toString();
    // `\fr` as recorded; `\fra` answered with the complete mid-word list shape.
    return d === c.doc ? c.response : null;
  });
  const view = makeView(doc, cursor, lspCompletionSource(backend));
  type(view, "fr");
  await settle(view);
  assert.equal(calls.length, 1);
  assert.equal(labels(view)[0], "frac");
  type(view, "a");
  await settle(view);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].context, { triggerKind: 3 });
  view.destroy();
});

test("texlab: an incomplete list is re-queried only while the new query continues it", async () => {
  // `\fr` gives an incomplete list; accepting `frac` brings `{}{}` after the cursor. A `\`
  // typed in the field is a new start, which this activation policy declines (as LaTeX
  // Live's does); it must not pass as a re-query of the finished `\fr` list.
  for (const triggers of [TEXLAB.triggerCharacters, []]) {
    const { backend, calls } = fixtureBackend({ ...TEXLAB, triggerCharacters: triggers }, (state, pos) => {
      const before = state.doc.line(pos.line + 1).text.slice(0, pos.character);
      const w = /\\([A-Za-z]*)$/.exec(before);
      if (!w) return null;
      const range = { start: { line: pos.line, character: pos.character - w[1].length }, end: pos };
      const item = (label: string, newText = label) => ({ label, insertTextFormat: 2, textEdit: { range, newText } });
      return { isIncomplete: true, items: [item("frac", "frac{$1}{$2}"), item("frame"), item("alpha")] };
    });
    const activate = (ctx: CompletionContext) => ctx.matchBefore(/\\[A-Za-z]+$/) !== null;
    const view = makeView("", 0, lspCompletionSource(backend, { activate }));
    const kinds = () => calls.map((c) => c.context.triggerKind).join(",");
    type(view, "\\fr");
    await settle(view);
    type(view, "a");
    await settle(view);
    assert.equal(kinds(), "1,3", "typing on re-queries");
    assert.ok(acceptCompletion(view));
    assert.equal(lineAtCursor(view), "\\frac{|}{}");
    type(view, triggers.length ? "\\" : "x");
    await settle(view);
    assert.equal(kinds(), "1,3", `${triggers.length ? "trigger" : "rest of line"}: no stale re-query`);
    type(view, triggers.length ? "al" : "\\al");
    await settle(view);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].context.triggerKind, 1, "a fresh request");
    view.destroy();
  }
});

test("a complete list answers its query and what extends it: backspacing into the query asks again", async () => {
  // A server that filters complete lists by the query, fuzzily (as texlab does). The list
  // for `alp` must not survive `alp` backspaced away: `bet` filtered against it once gave
  // `setmathalphabet` (b..e..t) instead of `beta`, which that list never held.
  const WORDS = ["alpha", "alph", "algebra", "mathalpha", "setmathalphabet", "beta", "between"];
  const fuzzy = (q: string, w: string) => [...w].reduce((i, ch) => (ch === q[i] ? i + 1 : i), 0) === q.length;
  const queries: string[] = [];
  const backend: LspCompletionBackend = {
    triggerCharacters: () => [],
    async request(pos, _context, state) {
      const q = /[a-z]*$/.exec(state.doc.line(pos.line + 1).text.slice(0, pos.character))![0];
      queries.push(q);
      const range = { start: { line: pos.line, character: pos.character - q.length }, end: pos };
      const items = WORDS.filter((w) => fuzzy(q, w)).map((label) => ({ label, textEdit: { range, newText: label } }));
      return { isIncomplete: false, items };
    },
  };
  const backspace = (view: EditorView) => {
    const head = view.state.selection.main.head;
    view.dispatch({ changes: { from: head - 1, to: head }, selection: { anchor: head - 1 }, userEvent: "delete.backward" });
  };

  // Typing on filters locally; backspacing into `alp` asks for `al` (algebra is back).
  const view = makeView("x ", 2, lspCompletionSource(backend));
  await typeSlowly(view, "alp", 20);
  assert.deepEqual(queries, ["alp"]);
  assert.ok(!labels(view).includes("algebra"));
  type(view, "h");
  await settle(view);
  assert.deepEqual(queries, ["alp"], "extending the query filters locally");
  backspace(view);
  backspace(view);
  await settle(view);
  assert.deepEqual(queries, ["alp", "al"]);
  assert.ok(labels(view).includes("algebra"), labels(view).join(" "));
  view.destroy();

  // An explicit list survives Backspace down to its start in CM; it must ask again too.
  queries.length = 0;
  const explicit = makeView("x alp", 5, lspCompletionSource(backend));
  startCompletion(explicit);
  await settle(explicit);
  for (let i = 0; i < 3; i++) backspace(explicit);
  await settle(explicit);
  await typeSlowly(explicit, "bet", 20);
  assert.equal(queries[0], "alp");
  assert.equal(queries.at(-1), "", "asked again once `alp` was backspaced away");
  assert.equal(selectedCompletion(explicit.state)?.label, "beta", labels(explicit).join(" "));
  assert.ok(acceptCompletion(explicit));
  assert.equal(lineAtCursor(explicit), "x beta|");
  explicit.destroy();
});

test("lspQueryEmpty: a list a trigger character opened, until something is typed", async () => {
  const items = (preselect: boolean): LspCompletionItem[] => [{ label: "abs" }, { label: "pow", preselect }];
  let pre = false;
  const backend: LspCompletionBackend = { triggerCharacters: () => ["."], request: async () => ({ items: items(pre) }) };
  const view = makeView("x", 1, lspCompletionSource(backend));
  type(view, ".");
  await settle(view);
  assert.equal(selectedCompletion(view.state)?.label, "abs");
  assert.equal(lspQueryEmpty(view.state), true);
  type(view, "a");
  await settle(view);
  assert.equal(selectedCompletion(view.state)?.label, "abs");
  assert.equal(lspQueryEmpty(view.state), false, "typed on");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "x." }, selection: { anchor: 2 } });
  startCompletion(view);
  await settle(view);
  assert.equal(lspQueryEmpty(view.state), false, "an explicit request");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "y" }, selection: { anchor: 1 } });
  pre = true;
  type(view, ".");
  await settle(view);
  assert.equal(selectedCompletion(view.state)?.label, "pow");
  assert.equal(lspQueryEmpty(view.state), false, "the server preselected it");
  select(view, "abs");
  assert.equal(lspQueryEmpty(view.state), true);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "x ab" }, selection: { anchor: 4 } });
  type(view, "s");
  await settle(view);
  assert.equal(selectedCompletion(view.state)?.label, "abs");
  assert.equal(lspQueryEmpty(view.state), false, "opened by a word, not a trigger");
  view.destroy();
});

test("texlab: \\fr then accept frac; mid-word \\fr|ac does not duplicate the tail", async () => {
  const a = await openAt(TEXLAB, "cmd_fr");
  assert.ok(acceptCompletion(a.view));
  assert.equal(lineAtCursor(a.view), "\\frac|");
  a.view.destroy();
  const b = await openAt(TEXLAB, "cmd_fr_mid");
  select(b.view, "frac");
  assert.ok(acceptCompletion(b.view));
  assert.equal(lineAtCursor(b.view), "\\frac|");
  b.view.destroy();
});

test("texlab: end of file without a trailing newline (CR-4)", async () => {
  const bare = TEXLAB.cases.eof_no_newline;
  const sent = TEXLAB.cases.eof_sent_with_newline;
  assert.equal((bare.response as { items: unknown[] }).items.length, 0, "texlab 5.26 bug as recorded");
  assert.equal(sent.doc, bare.doc + "\n");
  // The texlab client sends the document plus "\n"; positions are unchanged.
  const { backend } = fixtureBackend(TEXLAB, () => sent.response);
  const view = makeView(bare.doc, bare.offset, lspCompletionSource(backend));
  startCompletion(view);
  await settle(view);
  assert.equal(labels(view)[0], "frac");
  assert.ok(acceptCompletion(view));
  assert.ok(view.state.doc.toString().endsWith("\\frac"));
  assert.equal(view.state.selection.main.head, view.state.doc.length);
  view.destroy();
});

test("texlab: environments keep closeBrackets' brace; augment can insert the \\end pair", async () => {
  const plain = await openAt(TEXLAB, "env_begin");
  assert.ok(acceptCompletion(plain.view));
  assert.equal(lineAtCursor(plain.view), "\\begin{align|}");
  plain.view.destroy();

  const withEnd = await openAt(TEXLAB, "env_begin", {
    augment(item, _option, edit, ctx) {
      if (item.kind !== 13 || ctx.state.sliceDoc(edit.to, edit.to + 1) !== "}") return;
      edit.to += 1;
      edit.text = `${item.label}}\n\t$0\n\\end{${item.label}}`;
      edit.snippet = true;
    },
  });
  assert.ok(acceptCompletion(withEnd.view));
  const text = withEnd.view.state.doc.toString();
  assert.ok(text.includes("\\begin{align}\n  \n\\end{align}\n\\section"), text.slice(0, 400));
  assert.equal(lineAtCursor(withEnd.view), "  |");
  withEnd.view.destroy();
});

test("texlab: labels with spaces and CJK stay filtered locally with a label validFor", async () => {
  const { doc, cursor } = before(TEXLAB.cases.ref, "{");
  const { backend, calls } = fixtureBackend(TEXLAB);
  const source = lspCompletionSource(backend, { validFor: () => /^[^{}\\,]*$/ });
  const view = makeView(doc, cursor, source, [closeBrackets()]);
  type(view, "{");
  await settle(view);
  assert.deepEqual(calls[0].context, { triggerKind: 2, triggerCharacter: "{" });
  assert.equal(labels(view).length, 4);
  type(view, "distribution fun");
  await settle(view);
  assert.equal(calls.length, 1);
  assert.equal(labels(view)[0], "distribution function 的性质");
  assert.ok(acceptCompletion(view));
  assert.equal(lineAtCursor(view), "\\ref{distribution function 的性质|}");
  view.destroy();
});

test("texlab: citations match author/title through filterText; resolve fills the info panel", async () => {
  const { view, calls } = await openAt(TEXLAB, "cite");
  type(view, "Masked");
  await settle(view);
  assert.deepEqual(labels(view), ["he2022mae", "li2023mage"], "title words, any case");
  type(view, " Auto");
  await settle(view);
  assert.equal(calls.length, 1);
  assert.deepEqual(labels(view), ["he2022mae"]);
  const option = selectedCompletion(view.state)!;
  const info = (await (option.info as (c: Completion) => Promise<Node>)(option)) as HTMLElement;
  assert.match(info.textContent!, /Masked Autoencoders Are Scalable Vision Learners/);
  assert.ok(acceptCompletion(view));
  assert.equal(lineAtCursor(view), "\\cite{he2022mae|}", "the typed query is replaced");
  view.destroy();
});

test("texlab: glyph split out of detail", () => {
  assert.equal(defaultGlyph({ label: "alpha", detail: "α, built-in" }), "α");
  assert.equal(defaultGlyph({ label: "frac", detail: "built-in" }), null);
  assert.equal(defaultGlyph({ label: "theta", labelDetails: { description: "θ" } }), "θ");
  assert.equal(defaultGlyph({ label: "abs", labelDetails: { description: "(content) => content" } }), null);
  const { items } = TEXLAB.cases.math_su.response as { items: LspCompletionItem[] };
  const su = items.find((i) => i.label === "subset")!;
  assert.equal(defaultGlyph(su), "⊂");
});

// ---- generic --------------------------------------------------------------------------

test("no request while an IME composition is open", async () => {
  const { doc, cursor } = before(TINYMIST.cases.math_th, "th");
  const { backend, calls } = fixtureBackend(TINYMIST);
  const view = makeView(doc, cursor, lspCompletionSource(backend));
  view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  assert.equal(view.compositionStarted, true);
  type(view, "th");
  startCompletion(view);
  await settle(view);
  assert.equal(calls.length, 0);
  view.destroy();
});

test("backend failures and plain item arrays", async () => {
  const failing: LspCompletionBackend = {
    triggerCharacters: () => [],
    request: () => Promise.reject(new Error("down")),
  };
  const v1 = makeView("ab", 2, lspCompletionSource(failing));
  startCompletion(v1);
  await settle(v1);
  assert.equal(completionStatus(v1.state), null);
  v1.destroy();

  const array: LspCompletionBackend = {
    triggerCharacters: () => [],
    request: async () => [{ label: "abc" }, { label: "abd", insertText: "abd()", insertTextFormat: 1 }],
  };
  const v2 = makeView("ab", 2, lspCompletionSource(array));
  startCompletion(v2);
  await settle(v2);
  assert.deepEqual(labels(v2), ["abc", "abd"]);
  type(v2, "d");
  await settle(v2);
  assert.ok(acceptCompletion(v2));
  assert.equal(lineAtCursor(v2), "abd()|");
  v2.destroy();
});

test("augment can drop items and rank can reorder them", async () => {
  const backend: LspCompletionBackend = {
    triggerCharacters: () => [],
    request: async () => ({
      isIncomplete: false,
      items: [{ label: "alpha" }, { label: "also" }, { label: "alt" }],
    }),
  };
  const source = lspCompletionSource(backend, {
    augment: (item) => item.label !== "also",
    rank: (options) => options.map((o) => (o.label === "alt" ? { ...o, boost: 10 } : o)),
  });
  const view = makeView("al", 2, source);
  startCompletion(view);
  await settle(view);
  assert.deepEqual(labels(view), ["alt", "alpha"]);
  view.destroy();
});
