import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeBrackets, insertBracket } from "@codemirror/autocomplete";
import { history, toggleComment, undo, undoDepth } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { search } from "@codemirror/search";
import { ChangeSet, EditorState, Extension, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Scope } from "obsidian";
import {
  EDITOR_SCOPE_KEYS,
  HistoryCache,
  applyEphemeralState,
  darkThemeExtension,
  detectIndentUnit,
  editNotifier,
  getEphemeralState,
  indentOrInsertTab,
  languageData,
  mathEnter,
  mathInput,
  minimalChange,
  registerEditorScope,
  setDocText,
  showSearch,
  syncDarkTheme,
  wrapSelection,
} from "../src/editor/shared/editorKit";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeView(doc: string, cursor: number | { anchor: number; head: number }, extensions: Extension[] = []) {
  const selection = typeof cursor === "number" ? { anchor: cursor } : cursor;
  return new EditorView({ state: EditorState.create({ doc, selection, extensions }), parent: document.body });
}

/** Type like the DOM input path: input handlers first (closeBrackets, mathInput), else insert. */
function typeInput(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection.main;
    const insert = () =>
      view.state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    const handled = view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, insert));
    if (!handled) view.dispatch(insert());
  }
}

function withCursor(view: EditorView) {
  const doc = view.state.doc.toString();
  const { from, to } = view.state.selection.main;
  if (from === to) return doc.slice(0, from) + "|" + doc.slice(from);
  return doc.slice(0, from) + "[" + doc.slice(from, to) + "]" + doc.slice(to);
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1} some words`).join("\n");

// ---- external text ----------------------------------------------------------------

test("minimalChange: prefix/suffix diff that never splits a surrogate pair", () => {
  assert.equal(minimalChange("abc", "abc"), null);
  assert.deepEqual(minimalChange("abcdef", "abXYef"), { from: 2, to: 4, insert: "XY" });
  assert.deepEqual(minimalChange("abc", "abcd"), { from: 3, to: 3, insert: "d" });
  assert.deepEqual(minimalChange("aab", "ab"), { from: 1, to: 2, insert: "" });
  // 𝔼 = \ud835\udd3c, 𝔽 = \ud835\udd3d share the high surrogate.
  assert.deepEqual(minimalChange("x𝔼y", "x𝔽y"), { from: 1, to: 3, insert: "𝔽" });
});

test("setDocText: an external edit keeps the cursor, the unsaved typing and its own undo step", () => {
  const doc = lines(30);
  const line20 = Text.of(doc.split("\n")).line(20);
  const view = makeView(doc, line20.from + 7, [history()]);
  const head = view.state.selection.main.head;
  view.dispatch({ changes: { from: head, insert: "XY" }, selection: { anchor: head + 2 }, userEvent: "input.type" });
  const typed = view.state.doc.toString();
  // Obsidian merged the external change (a new first line) with the unsaved typing.
  const merged = "INSERTED BY GIT\n" + typed;
  assert.equal(setDocText(view, merged), "applied");
  assert.equal(view.state.doc.toString(), merged);
  assert.equal(view.state.selection.main.head, head + 2 + "INSERTED BY GIT\n".length);
  assert.match(withCursor(view), /line 20XY\| some words/);
  undo(view);
  assert.equal(view.state.doc.toString(), typed, "the external change is one undo step");
  undo(view);
  assert.equal(view.state.doc.toString(), doc);
  view.destroy();
});

test("setDocText: unchanged text (also with CRLF) dispatches nothing", () => {
  let transactions = 0;
  const count = EditorView.updateListener.of((u) => (transactions += u.transactions.length));
  const view = makeView("a\nb\n", 0, [count]);
  assert.equal(setDocText(view, "a\r\nb\r\n"), "unchanged");
  assert.equal(transactions, 0);
  view.destroy();
});

test("setDocText: waits for compositionend and applies the last text", async () => {
  const view = makeView("hello", 5);
  view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  assert.equal(setDocText(view, "hello world"), "deferred");
  assert.equal(setDocText(view, "hello there"), "deferred");
  assert.equal(view.state.doc.toString(), "hello");
  view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await sleep(20);
  assert.equal(view.state.doc.toString(), "hello there");
  view.destroy();
});

// ---- history cache ----------------------------------------------------------------------

test("HistoryCache: reopening an unchanged file restores selection and undo history", () => {
  const cache = new HistoryCache(2);
  const view = makeView("abc", 3, [history()]);
  view.dispatch({ changes: { from: 3, insert: "d" }, selection: { anchor: 4 }, userEvent: "input.type" });
  cache.save("a.typ", view.state);
  view.destroy();

  const restored = cache.restore("a.typ", "abcd", { extensions: [history()] })!;
  assert.ok(restored);
  assert.equal(undoDepth(restored), 1);
  assert.equal(restored.selection.main.head, 4);
  const v2 = new EditorView({ state: restored, parent: document.body });
  undo(v2);
  assert.equal(v2.state.doc.toString(), "abc");
  v2.destroy();

  assert.equal(cache.restore("a.typ", "abcd changed on disk", { extensions: [history()] }), null);
  assert.ok(cache.restore("a.typ", "abcd".replace(/\n/g, "\r\n"), { extensions: [history()] }));
  cache.rename("a.typ", "b.typ");
  assert.equal(cache.restore("a.typ", "abcd", { extensions: [history()] }), null);
  assert.ok(cache.restore("b.typ", "abcd", { extensions: [history()] }));
  cache.save("c.typ", EditorState.create({ doc: "c" }));
  cache.save("d.typ", EditorState.create({ doc: "d" }));
  assert.equal(cache.restore("b.typ", "abcd", { extensions: [history()] }), null, "oldest entry dropped");
});

// ---- ephemeral state ------------------------------------------------------------------

test("ephemeral state: cursor round trip, link line, clamping", () => {
  const view = makeView(lines(10), { anchor: 3, head: 30 });
  const st = getEphemeralState(view);
  assert.deepEqual(st.cursor, { from: { line: 0, ch: 3 }, to: { line: 1, ch: 12 } });
  assert.equal(typeof st.scroll, "number");

  const other = makeView(lines(10), 0);
  applyEphemeralState(other, { cursor: st.cursor });
  assert.deepEqual([other.state.selection.main.anchor, other.state.selection.main.head], [3, 30]);
  applyEphemeralState(other, { line: 4 });
  assert.equal(other.state.doc.lineAt(other.state.selection.main.head).number, 5);
  applyEphemeralState(other, { cursor: { from: { line: 99, ch: 99 }, to: { line: 99, ch: 99 } } });
  assert.equal(other.state.selection.main.head, other.state.doc.length);
  applyEphemeralState(other, null);
  view.destroy();
  other.destroy();
});

// ---- dark theme -------------------------------------------------------------------------

test("dark theme compartment follows the UI theme", () => {
  const view = makeView("x", 0, [darkThemeExtension(false)]);
  assert.equal(view.state.facet(EditorView.darkTheme), false);
  syncDarkTheme(view, true);
  assert.equal(view.state.facet(EditorView.darkTheme), true);
  document.body.classList.remove("theme-dark");
  syncDarkTheme(view);
  assert.equal(view.state.facet(EditorView.darkTheme), false);
  const plain = makeView("x", 0);
  syncDarkTheme(plain, true); // no compartment: nothing to do
  assert.equal(plain.state.facet(EditorView.darkTheme), false);
  view.destroy();
  plain.destroy();
});

// ---- edit notifier ------------------------------------------------------------------------

test("editNotifier: committed edits only; a composition is reported once after compositionend", async () => {
  const seen: { changes: ChangeSet; startDoc: Text; doc: string }[] = [];
  const notifier = editNotifier((v, changes, startDoc) => seen.push({ changes, startDoc, doc: v.state.doc.toString() }));
  const view = makeView("ab", 2, [notifier]);
  view.dispatch({ changes: { from: 2, insert: "c" }, userEvent: "input.type" });
  assert.equal(seen.length, 1);

  view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  view.dispatch({ changes: { from: 3, insert: "n" }, userEvent: "input.type.compose" });
  view.dispatch({ changes: { from: 3, to: 4, insert: "ni" }, userEvent: "input.type.compose" });
  view.dispatch({ changes: { from: 3, to: 5, insert: "你" }, userEvent: "input.type.compose" });
  assert.equal(seen.length, 1, "nothing while composing");
  view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await sleep(20);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].startDoc.toString(), "abc");
  assert.equal(seen[1].changes.apply(seen[1].startDoc).toString(), "abc你");
  view.destroy();
});

// ---- language data -------------------------------------------------------------------------

test("languageData: $ pairs and wraps, LaTeX quotes are not paired, % comments", () => {
  const latex = [languageData({ brackets: ["(", "[", "{", "$"], lineComment: "%" }), closeBrackets()];
  const view = makeView("area ", 5, latex);
  typeInput(view, "$x");
  assert.equal(withCursor(view), "area $x|$");
  typeInput(view, "$");
  assert.equal(withCursor(view), "area $x$|", "steps over the closer");

  const sel = makeView("area of x^2 here", { anchor: 8, head: 11 }, latex);
  const tr = insertBracket(sel.state, "$");
  assert.ok(tr);
  sel.dispatch(tr!);
  assert.equal(sel.state.doc.toString(), "area of $x^2$ here");

  const quotes = makeView("", 0, latex);
  typeInput(quotes, "``quoted text''");
  assert.equal(quotes.state.doc.toString(), "``quoted text''");
  typeInput(quotes, ' "a');
  assert.equal(quotes.state.doc.toString(), "``quoted text'' \"a");

  const comment = makeView("a line", 0, latex);
  toggleComment(comment);
  assert.equal(comment.state.doc.toString(), "% a line");
  const typst = makeView("x", 0, [languageData({ lineComment: "//", blockComment: { open: "/*", close: "*/" } })]);
  toggleComment(typst);
  assert.equal(typst.state.doc.toString(), "// x");
  for (const v of [view, sel, quotes, comment, typst]) v.destroy();
});

test("detectIndentUnit: 4-space LaTeX, 2-space Typst, tabs, fallback", () => {
  const tex = [
    "\\begin{itemize}",
    "    \\item a",
    "    \\begin{enumerate}",
    "        \\item b",
    "    \\end{enumerate}",
    "\\end{itemize}",
    "\\begin{proof}",
    "    x",
    "\\end{proof}",
  ].join("\n");
  assert.equal(detectIndentUnit(tex, "  "), "    ");
  const typ = "#let f(x) = {\n  if x {\n    1\n  } else {\n    2\n  }\n}\n- a\n  - b\n";
  assert.equal(detectIndentUnit(typ, "    "), "  ");
  assert.equal(detectIndentUnit("a\n\tb\n\t\tc\n\td\n", "  "), "\t");
  assert.equal(detectIndentUnit("no\nindent\n", "  "), "  ");
});

// ---- math delimiters --------------------------------------------------------------------------

test("mathInput: $ inside an empty $|$ opens display math; Typst variant", () => {
  const exts = [mathInput(), languageData({ brackets: ["(", "[", "{", "$"] }), closeBrackets()];
  const view = makeView("", 0, exts);
  typeInput(view, "$");
  assert.equal(withCursor(view), "$|$");
  typeInput(view, "$");
  assert.equal(withCursor(view), "$$|$$");
  const typst = makeView("", 0, [
    mathInput({ display: ["$ ", " $"] }),
    languageData({ brackets: ["(", "[", "{", '"', "$"] }),
    closeBrackets(),
  ]);
  typeInput(typst, "$$");
  assert.equal(withCursor(typst), "$ | $");
  view.destroy();
  typst.destroy();
});

test("mathInput + mathEnter: \\[ and \\( pair, Enter opens the block, \\] steps over (no stray ])", () => {
  const exts = [
    mathInput({ latexDelimiters: true }),
    languageData({ brackets: ["(", "[", "{", "$"] }),
    closeBrackets(),
    indentUnit.of("  "),
  ];
  const view = makeView("", 0, exts);
  typeInput(view, "\\[");
  assert.equal(withCursor(view), "\\[|\\]");
  assert.ok(mathEnter(view));
  assert.equal(withCursor(view), "\\[\n  |\n\\]");
  typeInput(view, "x^2");
  assert.equal(view.state.doc.toString(), "\\[\n  x^2\n\\]");

  const inline = makeView("see ", 4, exts);
  typeInput(inline, "\\(a\\)");
  assert.equal(withCursor(inline), "see \\(a\\)|");

  const escaped = makeView("a \\\\", 4, exts); // `\\[2pt]` is a line break, not math
  typeInput(escaped, "[");
  assert.equal(withCursor(escaped), "a \\\\[|]");
  const noPair = makeView("x", 0, exts);
  typeInput(noPair, "\\[");
  assert.equal(withCursor(noPair), "\\[|x", "no closer before a word, and no bare ]");
  for (const v of [view, inline, escaped, noPair]) v.destroy();
});

// ---- commands -----------------------------------------------------------------------------

test("wrapSelection toggles markers around selections and the cursor", () => {
  const view = makeView("make bold here", { anchor: 5, head: 9 });
  wrapSelection(view, "\\textbf{", "}");
  assert.equal(withCursor(view), "make \\textbf{[bold]} here");
  wrapSelection(view, "\\textbf{", "}");
  assert.equal(withCursor(view), "make [bold] here");
  const inner = makeView("a *b* c", { anchor: 2, head: 5 });
  wrapSelection(inner, "*", "*");
  assert.equal(withCursor(inner), "a [b] c");
  const empty = makeView("x ", 2);
  wrapSelection(empty, "_", "_");
  assert.equal(withCursor(empty), "x _|_");
  for (const v of [view, inner, empty]) v.destroy();
});

test("indentOrInsertTab: spaces to the next stop mid-line, indentMore in leading whitespace", () => {
  const mid = makeView("\\item text", 7, [indentUnit.of("    ")]);
  assert.ok(indentOrInsertTab(mid));
  assert.equal(withCursor(mid), "\\item t |ext", "column 7 -> 8");
  assert.ok(indentOrInsertTab(mid));
  assert.equal(withCursor(mid), "\\item t     |ext", "column 8 -> 12");
  const lead = makeView("  \\item text", 0, [indentUnit.of("  ")]);
  assert.ok(indentOrInsertTab(lead));
  assert.equal(lead.state.doc.toString(), "    \\item text");
  mid.destroy();
  lead.destroy();
});

test("registerEditorScope runs editor commands and consumes the keys", () => {
  const registered: { modifiers: string[]; key: string; func: () => unknown }[] = [];
  const scope = {
    register: (modifiers: string[], key: string, func: () => unknown) => registered.push({ modifiers, key, func }),
  };
  const view = makeView("a line", { anchor: 0, head: 1 }, [languageData({ lineComment: "%" }), search()]);
  registerEditorScope(scope as unknown as Scope, () => view, { bold: ["\\textbf{", "}"] });
  const keys = registered.map((r) => r.modifiers.join("+") + "+" + r.key);
  assert.ok(keys.includes("Mod+/") && keys.includes("Mod+b") && keys.includes("Mod+Shift+g"));
  assert.ok(!keys.includes("Mod+i") && !keys.includes("Mod+e"), "unconfigured actions are skipped");
  assert.ok(!keys.some((k) => k === "Mod+s" || k === "Mod+f"), "Mod-S / Mod-F keep Obsidian's meaning");
  assert.equal(registered.length, EDITOR_SCOPE_KEYS.length - 2);
  const run = (k: string) => registered.find((r) => r.modifiers.join("+") + "+" + r.key === k)!.func();
  assert.equal(run("Mod+b"), false);
  assert.equal(view.state.doc.toString(), "\\textbf{a} line");
  run("Mod+/");
  assert.equal(view.state.doc.toString(), "% \\textbf{a} line");
  run("Mod+Alt+f");
  assert.ok(view.dom.querySelector(".cm-search"), "search panel open");
  view.destroy();
});

test("showSearch opens the search panel", () => {
  const view = makeView("find me", 0, [search()]);
  showSearch(view, false);
  assert.ok(view.dom.querySelector(".cm-search input[name=search]"));
  view.destroy();
});
