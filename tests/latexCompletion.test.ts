import "./support/dom";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  completionStatus,
  currentCompletions,
  hasNextSnippetField,
  selectedCompletionIndex,
  setSelectedCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexBackend, latexCompletionSource, latexContext, typingCommand } from "../src/editor/latexCompletion";
import {
  LspCompletionBackend,
  LspCompletionContext,
  LspCompletionItem,
  LspPosition,
  defaultGlyph,
} from "../src/editor/shared/lspCompletion";
import { TexEditorOptions, texEditorExtensions } from "../src/editor/texExtensions";
import { TexlabServer, resolveTexlab, texlabSettings } from "../src/lsp/texlab";
import { scanDefinitions } from "../src/tex/macros";
import { applySnippet, press } from "./support/keyMatrix";

interface FixtureCase {
  doc: string;
  offset: number;
  position: LspPosition;
  response: { isIncomplete?: boolean; items: LspCompletionItem[] };
}
// Recorded from texlab 5.26.0 on tests/fixtures/texproj (see the fixture's "note").
const TEXLAB = JSON.parse(readFileSync("tests/fixtures/texlab-completion.json", "utf8")) as {
  triggerCharacters: string[];
  cases: Record<string, FixtureCase>;
};
const CASE = TEXLAB.cases;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A backend answering with `answer(state, pos)`; records every request. */
function backend(answer: (state: EditorState, pos: LspPosition) => unknown = () => null) {
  const calls: { pos: LspPosition; context: LspCompletionContext; before: string }[] = [];
  const b: LspCompletionBackend = {
    triggerCharacters: () => TEXLAB.triggerCharacters,
    async request(pos, context, state) {
      const line = state.doc.line(pos.line + 1);
      calls.push({ pos, context, before: line.text.slice(0, pos.character) });
      return structuredClone(answer(state, pos) ?? null);
    },
  };
  return { backend: b, calls };
}

/** Answers with a recorded case when the request matches its document and position. */
const recorded = (state: EditorState, pos: LspPosition) =>
  Object.values(CASE).find(
    (c) => c.doc === state.doc.toString() && c.position.line === pos.line && c.position.character === pos.character,
  )?.response;

/** The real editor stack with `source`; `|` in `text` marks the cursor. */
function editor(
  text: string,
  source: ReturnType<typeof latexCompletionSource>,
  onEdit?: TexEditorOptions["onEdit"],
): EditorView {
  const cursor = text.indexOf("|");
  const doc = text.slice(0, cursor) + text.slice(cursor + 1);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: texEditorExtensions({ text: doc, completion: source, onEdit }),
    }),
    parent: document.body,
  });
  view.focus();
  return view;
}

/** A recorded case's document with `typed` removed before the cursor, `|` at the cursor. */
function before(c: FixtureCase, typed: string): string {
  assert.equal(c.doc.slice(c.offset - typed.length, c.offset), typed);
  return c.doc.slice(0, c.offset - typed.length) + "|" + c.doc.slice(c.offset);
}

/** Type through the input handlers (closeBrackets adds `}` after `{`). */
function typeKeys(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection.main;
    const insert = () => view.state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    if (!view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, insert))) view.dispatch(insert());
  }
}

function type(view: EditorView, text: string) {
  for (const ch of text) {
    const head = view.state.selection.main.head;
    view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 }, userEvent: "input.type" });
  }
}

/** Wait until the query settles and the popup is past interactionDelay. */
async function settle(view: EditorView, timeout = 3000) {
  await sleep(130);
  const t0 = Date.now();
  while (completionStatus(view.state) === "pending" && Date.now() - t0 < timeout) await sleep(10);
  await sleep(90);
}

const labels = (view: EditorView) => currentCompletions(view.state).map((c) => c.label);
function lineAtCursor(view: EditorView) {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return line.text.slice(0, head - line.from) + "|" + line.text.slice(head - line.from);
}
const range = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});
const item = (label: string, detail: string, r: ReturnType<typeof range>, kind = 3): LspCompletionItem => ({
  label,
  detail,
  kind,
  textEdit: { range: r, newText: label },
});

// ---- context detection -------------------------------------------------------------------

test("latexContext: commands, argument braces, escapes", () => {
  const at = (text: string) => {
    const i = text.indexOf("|");
    return latexContext(EditorState.create({ doc: text.replace("|", "") }), i);
  };
  assert.deepEqual(at("a \\fr|ac b"), { kind: "command", word: "fr", from: 3, to: 7 });
  assert.deepEqual(at("\\|"), { kind: "command", word: "", from: 1, to: 1 });
  assert.equal(at("a \\\\fr|"), null, "\\\\ is a line break, not a command");
  assert.deepEqual(at("\\ref{sec:in|}"), { kind: "argument", command: "ref", arg: "label", query: "sec:in", from: 5, to: 11 });
  assert.equal((at("\\cite{a, b|}") as { query: string }).query, "b");
  assert.equal((at("\\includegraphics[width=0.5\\linewidth]{fig|}") as { arg: string }).arg, "file");
  assert.equal((at("\\begin{al|}") as { arg: string }).arg, "env");
  assert.equal(at("\\frac{a|}"), null, "not an argument with a list");
  assert.equal(at("plain text|"), null);
});

test("scanDefinitions: arities, aliases, operators, colors, environments", () => {
  const d = scanDefinitions(
    [
      "\\newcommand{\\innerprod}[2]{\\langle #1, #2 \\rangle}",
      "\\newcommand\\opt[2][x]{#1#2}",
      "\\newcommand{\\nc}{\\newcommand}",
      "\\nc{\\bP}{\\mathbb{P}}",
      "\\DeclareMathOperator*{\\argmax}{arg\\,max}",
      "\\def\\pair#1#2{(#1,#2)}",
      "\\NewDocumentCommand{\\norm}{m}{\\lVert #1\\rVert}",
      "\\definecolor{mageblue}{RGB}{0,0,255}",
      "\\newtheorem{lemma}{Lemma}",
      "% \\newcommand{\\hidden}[1]{}",
    ].join("\n"),
  );
  assert.deepEqual(d.macros.get("innerprod"), { args: 2, optional: false });
  assert.deepEqual(d.macros.get("opt"), { args: 2, optional: true });
  assert.deepEqual(d.macros.get("bP"), { args: 0, optional: false });
  assert.deepEqual(d.macros.get("argmax"), { args: 0, optional: false, math: true });
  assert.deepEqual(d.macros.get("pair"), { args: 2, optional: false });
  assert.deepEqual(d.macros.get("norm"), { args: 1, optional: false });
  assert.equal(d.macros.has("hidden"), false);
  assert.ok(d.colors.has("mageblue"));
  assert.ok(d.environments.has("lemma"));
});

// ---- recorded texlab responses ---------------------------------------------------------------

test("\\fr + Tab inserts \\frac{|}{} and Tab walks its fields", async () => {
  const { backend: b } = backend(recorded);
  const view = editor(before(CASE.cmd_fr, "fr"), latexCompletionSource(b));
  type(view, "fr");
  await settle(view);
  assert.equal(labels(view)[0], "frac");
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "\\frac{|}{}");
  assert.ok(hasNextSnippetField(view.state));
  type(view, "a");
  press(view, "Tab");
  type(view, "b");
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "\\frac{a}{b}|", "the last Tab leaves the braces");
  view.destroy();
});

test("\\begin{al + Enter inserts the align pair with the cursor in the body", async () => {
  const { backend: b } = backend(recorded);
  const view = editor(before(CASE.env_begin, "al"), latexCompletionSource(b));
  type(view, "al");
  await settle(view);
  assert.equal(labels(view)[0], "align");
  press(view, "Enter");
  const text = view.state.doc.toString();
  assert.ok(/\\begin\{align\}\n +\n\\end\{align\}\n\\section/.test(text), text.slice(80, 200));
  assert.match(lineAtCursor(view), /^ +\|$/);
  view.destroy();
});

test("mid-word: \\fr|ac becomes \\frac{|}{} without duplicating the tail", async () => {
  const c = CASE.cmd_fr_mid;
  const { backend: b } = backend(recorded);
  const view = editor(c.doc.slice(0, c.offset) + "|" + c.doc.slice(c.offset), latexCompletionSource(b));
  startCompletion(view);
  await settle(view);
  assert.equal(labels(view).filter((l) => l === "frac").length, 1, "the edited word is not offered twice");
  assert.equal(labels(view)[0], "frac");
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "\\frac{|}{}");
  view.destroy();
});

test("the word being edited is not offered back from the document's own uses", async () => {
  const state = EditorState.create({ doc: "$\\alX + \\alpha$" });
  const list = (await latexBackend(null).request({ line: 0, character: 4 }, { triggerKind: 1 }, state)) as {
    items: LspCompletionItem[];
  };
  const names = list.items.map((i) => i.label);
  assert.ok(names.includes("alpha") && !names.includes("alX"), names.join(" "));
  assert.deepEqual((list.items[0].textEdit as { range: unknown }).range, range(0, 2, 5), "replaces the whole word");
});

test("inside math, math symbols rank first; in text, text commands do", async () => {
  const c = CASE.math_su;
  const math = backend(recorded);
  const view = editor(before(c, "su"), latexCompletionSource(math.backend));
  type(view, "su");
  await settle(view);
  const inMath = labels(view);
  assert.equal(inMath[0], "sum");
  assert.ok(inMath.indexOf("subset") < inMath.indexOf("subsection"), inMath.slice(0, 8).join(" "));
  view.destroy();

  // Same response, same offsets, but `$` replaced by a space: text mode.
  const textDoc = c.doc.replace("$\\su$", " \\su ");
  const text = backend(() => c.response);
  const tv = editor(textDoc.slice(0, c.offset - 2) + "|" + textDoc.slice(c.offset), latexCompletionSource(text.backend));
  type(tv, "su");
  await settle(tv);
  const inText = labels(tv);
  assert.ok(inText.indexOf("subsection") < inText.indexOf("sum"), inText.slice(0, 8).join(" "));
  tv.destroy();
});

test("user macros get argument snippets from their [n]", async () => {
  const { backend: b } = backend(recorded);
  const view = editor(before(CASE.user_macro, "inner"), latexCompletionSource(b));
  type(view, "inner");
  await settle(view);
  assert.equal(labels(view)[0], "innerprod");
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "$\\innerprod{|}{}$");
  view.destroy();
});

test("frequent commands missing from texlab's page are added (\\al without alpha)", async () => {
  // With algorithmicx loaded, texlab's `\al` page is 50 algorithmicx commands, no alpha (TL-02).
  const { backend: b } = backend((_s, pos) => ({
    isIncomplete: true,
    items: ["aleph:ℵ, built-in", "algblock:algpseudocode.sty", "algorithmicend:algpseudocode.sty"].map((e) => {
      const [label, detail] = e.split(":");
      return item(label, detail, range(pos.line, pos.character - 2, pos.character));
    }),
  }));
  const view = editor("text $x = |$", latexCompletionSource(b));
  type(view, "\\al");
  await settle(view);
  const top = currentCompletions(view.state)[0];
  assert.equal(top.label, "alpha");
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "text $x = \\alpha|$");
  view.destroy();
});

test("commands used in the document rank above unused ones", async () => {
  const { backend: b } = backend((_s, pos) => ({
    isIncomplete: true,
    items: ["mathbb", "mathbf", "mathcal"].map((l, i) => ({
      ...item(l, "built-in", range(pos.line, 2, pos.character)),
      sortText: String(i).padStart(2, "0"),
    })),
  }));
  const view = editor("$\\mathcal{A} \\mathcal{B}$\n$|$", latexCompletionSource(b));
  type(view, "\\mat");
  await settle(view);
  assert.equal(labels(view)[0], "mathcal");
  view.destroy();
});

test("typing activates only after \\ + a letter or inside argument braces", async () => {
  const { backend: b, calls } = backend();
  const view = editor("|", latexCompletionSource(b));
  type(view, "Some prose, with spaces ");
  await settle(view);
  type(view, "\\");
  await settle(view);
  type(view, "\\ alpha");
  await settle(view);
  assert.equal(calls.length, 0, calls.map((c) => c.before).join(" | "));
  type(view, " \\f");
  await settle(view);
  assert.equal(calls.length, 1);
  type(view, " \\ref{");
  await settle(view);
  assert.equal(calls.at(-1)!.before.endsWith("\\ref{"), true);
  view.destroy();
});

test("accepting \\ref opens the label list inside the braces; taking a label ends the snippet after `}`", async () => {
  const c = CASE.ref;
  const { backend: b, calls } = backend((state, pos) => {
    const line = state.doc.line(pos.line + 1).text.slice(0, pos.character);
    if (line.endsWith("\\ref{")) return c.response;
    if (line.endsWith("\\re")) return { items: [item("ref", "built-in", range(pos.line, 1, pos.character))] };
    return null;
  });
  // The recorded document has `\ref{}`: type `re`, accept, and get it back.
  const start = c.doc.slice(0, c.offset - 4) + "|" + c.doc.slice(c.offset + 1);
  const view = editor(start, latexCompletionSource(b));
  type(view, "re");
  await settle(view);
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "\\ref{|}");
  await settle(view);
  assert.deepEqual(labels(view).sort(), ["distribution function 的性质", "eq:cdf", "eq:main", "sec:intro"]);
  assert.deepEqual(calls.at(-1)!.context, { triggerKind: 2, triggerCharacter: "{" }, "opened as if `{` was typed");
  press(view, "ArrowDown");
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "\\ref{eq:cdf}|", "the `\\ref{#1}#0` snippet's last stop, after the brace");
  assert.equal(hasNextSnippetField(view.state), false, "the snippet is over");
  view.destroy();
  // Nothing typed or selected in that list yet: Enter is a newline, as after `\ref{` typed.
  const enter = editor(start, latexCompletionSource(b));
  type(enter, "re");
  await settle(enter);
  press(enter, "Tab");
  await settle(enter);
  assert.ok(labels(enter).length);
  press(enter, "Enter");
  assert.equal(completionStatus(enter.state), null);
  assert.match(enter.state.doc.toString(), /\\begin\{document\}\n\\ref\{\n\s*\n\}\n/);
  enter.destroy();
});

test("a citation typed by title before the list opened: texlab's key-only miss falls back", async () => {
  // texlab answers `\cite{Masked|}` with nothing (recorded); the full list comes from a
  // request with the query removed, i.e. the recorded `\cite{|}` case.
  const { backend: b, calls } = backend(recorded);
  const view = editor(before(CASE.cite, ""), latexCompletionSource(b));
  type(view, "Masked");
  await settle(view);
  assert.deepEqual(labels(view), ["he2022mae", "li2023mage"], "MAGE's title says MAsked");
  assert.deepEqual(
    calls.map((c) => c.before),
    ["\\cite{Masked", "\\cite{"],
  );
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "\\cite{he2022mae|}");
  view.destroy();
});

test("math operators from \\DeclareMathOperator rank as math commands", async () => {
  const { backend: b } = backend((_s, pos) => ({
    isIncomplete: true,
    items: [item("succ", "≻, built-in", range(pos.line, 2, pos.character)), item("supp", "user-defined", range(pos.line, 2, pos.character))],
  }));
  const view = editor("\\DeclareMathOperator{\\supp}{supp}\n$|$", latexCompletionSource(b));
  type(view, "\\su");
  await settle(view);
  const ls = labels(view);
  assert.ok(ls.indexOf("supp") < ls.indexOf("succ") && ls.indexOf("supp") < ls.indexOf("subsection"), ls.join(" "));
  view.destroy();
});

test("without texlab: built-in commands, environments and project colors", async () => {
  const view = editor("\\definecolor{mageblue}{RGB}{0,0,255}\n|", latexCompletionSource(null));
  type(view, "\\fra");
  await settle(view);
  assert.equal(labels(view)[0], "frac");
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "\\frac{|}{}");
  press(view, "Escape");

  view.dispatch({ selection: { anchor: view.state.doc.length } });
  type(view, "\n\\begi");
  await settle(view);
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "\\begin{|}");
  await settle(view);
  assert.ok(labels(view).includes("itemize"), labels(view).join(" "));
  type(view, "item");
  await settle(view);
  press(view, "Tab");
  assert.ok(view.state.doc.toString().endsWith("\\begin{itemize}\n    \\item \n\\end{itemize}"), view.state.doc.toString());

  view.dispatch({ selection: { anchor: view.state.doc.length } });
  type(view, "\n\\textcolor{mag");
  await settle(view);
  assert.deepEqual(labels(view), ["mageblue"]);
  view.destroy();
});

test("\\input{ drops .tex from texlab's file items (sent as kind 1) and shows the file icon", async () => {
  const { backend: b } = backend((state, pos) => {
    const text = state.doc.line(pos.line + 1).text;
    const from = text.lastIndexOf("/", pos.character) + 1;
    return {
      items: [
        { label: "02-random-variables.tex", kind: 1, textEdit: { range: range(pos.line, from, pos.character), newText: "02-random-variables.tex" } },
        { label: "0sub", kind: 1, textEdit: { range: range(pos.line, from, pos.character), newText: "0sub" } },
      ],
    };
  });
  const view = editor("\\input{chapters/|}", latexCompletionSource(b));
  type(view, "0");
  await settle(view);
  assert.deepEqual(currentCompletions(view.state).map((c) => `${c.label}:${c.type}`), ["02-random-variables.tex:file", "0sub:text"]);
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "\\input{chapters/02-random-variables}|", "a file is the whole argument");
  view.destroy();
  // A folder (no extension): the path goes on inside the braces.
  const folder = editor("\\input{chapters/|}", latexCompletionSource(b));
  type(folder, "0");
  await settle(folder);
  press(folder, "ArrowDown");
  press(folder, "Enter");
  assert.equal(lineAtCursor(folder), "\\input{chapters/0sub|}");
  folder.destroy();
});

test("accepting a name after \\end{ lands after closeBrackets' brace; Enter then starts a line", async () => {
  const { backend: b } = backend((_s, pos) => ({
    items: [{ label: "align", kind: 1, preselect: true, textEdit: { range: range(pos.line, 5, pos.character), newText: "align" } }],
  }));
  const view = editor("\\begin{align}\n  a\n\\end{|}", latexCompletionSource(b));
  type(view, "al");
  await settle(view);
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "\\end{align}|");
  press(view, "Enter");
  assert.equal(view.state.doc.toString(), "\\begin{align}\n  a\n\\end{align}\n");
  view.destroy();
});

test("a single value lands after its brace (Enter or Tab); a list keeps the cursor inside for `, key`", async () => {
  const { backend: b } = backend(recorded);
  // The recorded `\ref{|}` / `\cite{|}` documents with `{` typed through closeBrackets.
  const typedBrace = (c: FixtureCase) => c.doc.slice(0, c.offset - 1) + "|" + c.doc.slice(c.offset + 1);
  const cases: [FixtureCase, string[], string][] = [
    [CASE.ref, ["ArrowDown", "Enter"], "\\ref{eq:cdf}|"],
    [CASE.ref, ["ArrowDown", "Tab"], "\\ref{eq:cdf}|"],
    [CASE.ref, ["Tab"], "\\ref{distribution function 的性质}|"],
    [CASE.cite, ["ArrowDown", "Enter"], "\\cite{he2022mae|}"],
    [CASE.cite, ["Tab"], "\\cite{durrett2019probability|}"],
  ];
  for (const [c, keys, want] of cases) {
    const view = editor(typedBrace(c), latexCompletionSource(b));
    typeKeys(view, "{");
    assert.match(lineAtCursor(view), /\{\|\}$/);
    await settle(view);
    for (const key of keys) press(view, key);
    assert.equal(lineAtCursor(view), want, keys.join(" + "));
    assert.equal(completionStatus(view.state), null);
    undo(view);
    assert.match(lineAtCursor(view), /\{\|\}$/, "one undo step");
    view.destroy();
  }
  // \usepackage takes a list too.
  const pkg = editor(before(CASE.pkg, "amsm"), latexCompletionSource(b));
  type(pkg, "amsm");
  await settle(pkg);
  assert.equal(labels(pkg)[0], "amsmath");
  press(pkg, "Tab");
  assert.equal(lineAtCursor(pkg), "\\usepackage{amsmath|}");
  pkg.destroy();
});

test("a single value without its `}` gets one, unless a `}` later on the line closes the group", async () => {
  const { backend: b } = backend((state, pos) => {
    const query = /\{([^{},]*)$/.exec(state.doc.line(pos.line + 1).text.slice(0, pos.character))?.[1] ?? "";
    const r = range(pos.line, pos.character - query.length, pos.character);
    return { items: ["eq:main", "sec:intro"].map((l) => ({ label: l, kind: 1, textEdit: { range: r, newText: l } })) };
  });
  for (const [start, want] of [
    ["See \\ref|", "See \\ref{sec:intro}|"],
    ["See \\ref| % why", "See \\ref{sec:intro}| % why"],
    ["\\textbf{see \\ref|, then} more", "\\textbf{see \\ref{sec:intro|, then} more"],
  ]) {
    const view = editor(start, latexCompletionSource(b));
    type(view, "{"); // no closeBrackets
    await settle(view);
    press(view, "ArrowDown");
    press(view, "Enter");
    assert.equal(lineAtCursor(view), want);
    undo(view);
    assert.equal(lineAtCursor(view), start.replace("|", "{|"), "one undo step");
    view.destroy();
  }
});

test("\\include: texlab's extensionless file leaves the braces once isFolder tells it from a folder", async () => {
  const { backend: b } = backend((_s, pos) => ({
    items: ["chapters", "main"].map((l) => ({ label: l, kind: 1, textEdit: { range: range(pos.line, pos.character, pos.character), newText: l } })),
  }));
  const isFolder = (path: string) => path === "chapters";
  const cases: [Parameters<typeof latexCompletionSource>[1], number, string, string][] = [
    [{ isFolder }, 1, "\\include{main}|", "main:file"],
    [{ isFolder }, 0, "\\include{chapters|}", "chapters:text"],
    [{}, 1, "\\include{main|}", "main:text"], // without the file system it could be a folder
  ];
  for (const [env, pick, want, typed] of cases) {
    const view = editor("\\include|", latexCompletionSource(b, env));
    typeKeys(view, "{");
    await settle(view);
    const option = currentCompletions(view.state)[pick];
    assert.equal(`${option.label}:${option.type}`, typed);
    view.dispatch({ effects: setSelectedCompletion(pick) });
    press(view, "Tab");
    assert.equal(lineAtCursor(view), want);
    view.destroy();
  }
});

test("built-in items leave the braces too: \\begin{ of a closed environment, colors, a color field", async () => {
  const colors = "\\definecolor{mageblue}{RGB}{0,0,255}\n";
  const env = editor("|\n  \\item a\n\\end{itemize}", latexCompletionSource(null));
  typeKeys(env, "\\begin{ite");
  await settle(env);
  assert.equal(labels(env)[0], "itemize");
  press(env, "Enter");
  assert.equal(lineAtCursor(env), "\\begin{itemize}|", "already closed: no second \\end");
  env.destroy();

  const color = editor(colors + "|", latexCompletionSource(null));
  typeKeys(color, "\\textcolor{mag");
  await settle(color);
  press(color, "Tab");
  assert.equal(lineAtCursor(color), "\\textcolor{mageblue}|");
  color.destroy();

  // \textc + Tab: the color list opens in the first field; taking a color goes on to the second.
  const field = editor(colors + "|", latexCompletionSource(null));
  type(field, "\\textco");
  await settle(field);
  assert.equal(labels(field)[0], "textcolor");
  press(field, "Tab");
  assert.equal(lineAtCursor(field), "\\textcolor{|}{}");
  await settle(field);
  assert.deepEqual(labels(field), ["mageblue"]);
  type(field, "ma"); // Enter takes from an untouched list only after something is typed
  await settle(field);
  press(field, "Enter");
  assert.equal(lineAtCursor(field), "\\textcolor{mageblue}{|}");
  type(field, "blue text");
  press(field, "Tab");
  assert.equal(lineAtCursor(field), "\\textcolor{mageblue}{blue text}|");
  field.destroy();
});

test("a label taken inside another snippet's field stays in that field", async () => {
  const { backend: b } = backend((state, pos) => {
    if (!state.doc.line(pos.line + 1).text.slice(0, pos.character).endsWith("\\ref{")) return null;
    const r = range(pos.line, pos.character, pos.character);
    return { items: ["eq:main", "sec:intro"].map((l) => ({ label: l, kind: 1, textEdit: { range: r, newText: l } })) };
  });
  const view = editor("$|$", latexCompletionSource(b));
  applySnippet(view, "\\frac{${1}}{${2}}");
  typeKeys(view, "\\ref{");
  await settle(view);
  assert.equal(lineAtCursor(view), "$\\frac{\\ref{|}}{}$");
  press(view, "ArrowDown");
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "$\\frac{\\ref{sec:intro}|}{}$");
  assert.ok(hasNextSnippetField(view.state), "still in \\frac's first field");
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "$\\frac{\\ref{sec:intro}}{|}$");
  view.destroy();
});

test("a built-in never takes over texlab's range past the word (`\\frac{\\|}{}` reads as `\\}`)", async () => {
  // texlab 5.26 at `\frac{\|}{}`: only the control symbol `\}`, its range covering the `}`.
  const { backend: b } = backend((_s, pos) => ({
    items: [{ label: "}", kind: 1, textEdit: { range: range(pos.line, pos.character, pos.character + 1), newText: "}" } }],
  }));
  const view = editor("\\frac{|}{}", latexCompletionSource(b));
  type(view, "\\");
  startCompletion(view);
  await settle(view);
  type(view, "alp");
  await settle(view);
  assert.equal(labels(view)[0], "alpha");
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "\\frac{\\alpha|}{}");
  view.destroy();
});

test("a bare `\\` before `}` or `$`: texlab's control symbol keeps the closer; the next letter asks again", async () => {
  // texlab 5.26 (probed): at `\frac{\|}{}` / `$\|$` only the control symbol `\}` / `\$`, a
  // complete list whose range covers the closer; at `\alp|` its commands, range `alp`.
  const { backend: b, calls } = backend((state, pos) => {
    const text = state.doc.line(pos.line + 1).text;
    const word = /[A-Za-z]*$/.exec(text.slice(0, pos.character))![0];
    if (!word) {
      const symbol = text[pos.character];
      return { items: [{ label: symbol, kind: 1, textEdit: { range: range(pos.line, pos.character, pos.character + 1), newText: symbol } }] };
    }
    const r = range(pos.line, pos.character - word.length, pos.character);
    return { items: ["alph", "aleph"].filter((l) => l.startsWith(word)).map((l) => item(l, "texlab", r)) };
  });
  for (const [start, symbol, want] of [
    ["\\frac{|}{}", "}", "\\frac{\\}|}{}"],
    ["see \\textbf{|} here", "}", "see \\textbf{\\}|} here"],
    ["$|$", "$", "$\\$|$"],
    ["$$x = |$$", "$", "$$x = \\$|$$"],
    ["$a|,b$", ",", "$a\\,|b$"], // not a closer: texlab's range turns the comma into `\,`
    ["Cost |$5$ more", "$", "Cost \\$|5$ more"], // a `$` opening math: texlab's range escapes it
  ]) {
    const view = editor(start, latexCompletionSource(b));
    type(view, "\\");
    startCompletion(view);
    await settle(view);
    const i = labels(view).indexOf(symbol);
    assert.ok(i >= 0, labels(view).join(" "));
    view.dispatch({ effects: setSelectedCompletion(i) });
    press(view, "Tab");
    assert.equal(lineAtCursor(view), want, `${start}: picking \`\\${symbol}\``);
    view.destroy();
  }
  const view = editor("$\\frac{|}{}$", latexCompletionSource(b));
  type(view, "\\");
  startCompletion(view);
  await settle(view);
  calls.length = 0;
  type(view, "alp");
  await settle(view);
  assert.equal(calls.at(-1)?.before, "$\\frac{\\alp", "texlab is asked again, not the one-symbol answer filtered");
  assert.ok(labels(view).includes("alph"), labels(view).join(" "));
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "$\\frac{\\alpha|}{}$");
  view.destroy();
});

test("in a snippet field a fast Tab after a command name waits for its list (typingCommand)", async () => {
  const at = (text: string) => {
    const i = text.indexOf("|");
    return typingCommand(EditorState.create({ doc: text.replace("|", ""), selection: { anchor: i } }));
  };
  assert.deepEqual(
    ["$\\alp|$", "\\sec|tion", "$\\|$", "a \\\\al|", "\\ref{se|}", "plain|"].map(at),
    [true, true, false, false, false, false],
  );
  const { backend: b } = backend(async (state, pos) => {
    await sleep(30);
    const word = /\\([A-Za-z]*)$/.exec(state.doc.line(pos.line + 1).text.slice(0, pos.character))?.[1];
    if (word === undefined) return null;
    const r = range(pos.line, pos.character - word.length, pos.character);
    return { items: ["alpha", "alph", "beta"].filter((l) => l.startsWith(word)).map((l) => item(l, "texlab", r)) };
  });
  for (const [typed, after, want] of [
    ["\\alp", "", "$\\frac{\\alpha|}{}$"],
    ["\\alpha", "", "$\\frac{\\alpha}{|}$"], // the list only holds the word as typed
    ["\\alp", "2", "$\\frac{\\alp}{2|}$"], // typed on before the list came: the Tab went first
    ["\\\\al", "", "$\\frac{\\\\al}{|}$"], // `\\` is a line break, `al` plain text
  ]) {
    const view = editor("$|$", latexCompletionSource(b));
    applySnippet(view, "\\frac{${1}}{${2}}");
    typeKeys(view, typed);
    press(view, "Tab");
    typeKeys(view, after);
    await sleep(400);
    assert.equal(lineAtCursor(view), want, `${typed} Tab ${after}`);
    view.destroy();
  }
});

test("glyphs: texlab detail and built-in symbols", () => {
  assert.equal(defaultGlyph({ label: "alpha", detail: "α, built-in" }), "α");
  const su = CASE.math_su.response.items.find((i) => i.label === "sum")!;
  assert.equal(defaultGlyph(su), "∑");
});

// ---- live texlab ----------------------------------------------------------------------------

const TEXLAB_BIN = process.env.TEXLAB_BIN || resolveTexlab("");

test("live texlab on a copied project", { skip: !TEXLAB_BIN && "texlab not found (set TEXLAB_BIN)" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ll-texlab-"));
  cpSync("tests/fixtures/texproj", dir, { recursive: true });
  const main = join(dir, "main.tex");
  const original = readFileSync(main, "utf8");
  const server = new TexlabServer({
    binary: () => TEXLAB_BIN,
    root: dir,
    env: () => process.env,
    settings: () => texlabSettings(null),
  });
  const texlab: LspCompletionBackend = {
    triggerCharacters: () => server.triggerCharacters(),
    request: (pos, context, state) => server.completion(main, state.doc, pos, context),
    resolve: (i) => server.resolve(i),
  };
  /**
   * main.tex with `line` (containing `|`) inserted after \begin{document}. Edits reach
   * texlab incrementally, as in the plugin.
   */
  const open = (line: string, doc = original.replace("\\begin{document}\n", `\\begin{document}\n${line}\n`)) => {
    const view = editor(doc, latexCompletionSource(texlab), (v, changes, startDoc) =>
      server.change(main, v.state.doc, changes, startDoc),
    );
    server.open(main, view.state.doc);
    return view;
  };
  const done = (view: EditorView) => {
    server.close(main);
    view.destroy();
  };
  try {
    assert.equal(await server.ensureStarted(), true);

    await t.test("\\fr + Tab gives \\frac{|}{} with fields", async () => {
      const view = open("|");
      type(view, "\\fr");
      await settle(view);
      assert.equal(labels(view)[0], "frac");
      press(view, "Tab");
      assert.equal(lineAtCursor(view), "\\frac{|}{}");
      assert.ok(hasNextSnippetField(view.state));
      done(view);
    });

    await t.test("\\begin{ali + Enter inserts the align pair", async () => {
      const view = open("|");
      type(view, "\\begin{ali");
      await settle(view);
      assert.ok(labels(view).includes("align"), labels(view).join(" "));
      press(view, "Enter");
      assert.ok(view.state.doc.toString().includes("\\begin{align}\n  \n\\end{align}\n"), view.state.doc.toString());
      assert.equal(lineAtCursor(view), "  |");
      done(view);
    });

    await t.test("\\begin{ali + an immediate Enter still inserts the align pair (KY-2)", async () => {
      const view = open("|");
      typeKeys(view, "\\begin{ali");
      assert.equal(lineAtCursor(view), "\\begin{ali|}");
      press(view, "Enter");
      await sleep(600);
      assert.ok(view.state.doc.toString().includes("\\begin{align}\n  \n\\end{align}\n"), view.state.doc.toString());
      assert.equal(lineAtCursor(view), "  |");
      done(view);
    });

    await t.test("\\input{chapters/o + Tab inserts the chapter without .tex", async () => {
      const view = open("|");
      typeKeys(view, "\\input{chapters/o");
      await settle(view);
      assert.deepEqual(labels(view), ["one.tex"]);
      press(view, "Tab");
      assert.equal(lineAtCursor(view), "\\input{chapters/one}|");
      done(view);
    });

    await t.test("\\ref{ lists labels from \\input chapters", async () => {
      const view = open("|");
      type(view, "\\ref{");
      await settle(view);
      const ls = labels(view);
      for (const l of ["eq:cdf", "distribution function 的性质", "sec:intro", "eq:main"]) assert.ok(ls.includes(l), ls.join(" | "));
      done(view);
    });

    await t.test("end of file without a trailing newline still completes (CR-4)", async () => {
      const doc = original.trimEnd() + "\n|";
      const view = open("", doc);
      assert.ok(!view.state.doc.toString().endsWith("\n\n"));
      type(view, "\\fr");
      await settle(view);
      assert.equal(labels(view)[0], "frac");
      // texlab's own items, not only the built-in layer's.
      assert.ok(labels(view).includes("framebox"), labels(view).join(" "));
      press(view, "Tab");
      assert.equal(lineAtCursor(view), "\\frac{|}{}");
      done(view);
    });

    await t.test("inside $..$, \\al ranks \\alpha above text commands", async () => {
      const view = open("Let $x = |$ be given.");
      type(view, "\\al");
      await settle(view);
      const ls = labels(view);
      assert.equal(ls[0], "alpha", ls.slice(0, 6).join(" "));
      assert.equal(selectedCompletionIndex(view.state), 0);
      done(view);
    });

    await t.test("\\cite{Masked Au typed at once finds the entry by title", async () => {
      const view = open("|");
      type(view, "\\cite{Masked Au");
      await settle(view);
      assert.equal(labels(view)[0], "he2022mae", labels(view).join(" "));
      press(view, "Tab");
      assert.equal(lineAtCursor(view), "\\cite{he2022mae|", "the whole query is replaced");
      done(view);
    });

    await t.test("hover shows the glyph; definition maps back to the vault path", async () => {
      const view = open("$\\alpha$ see \\ref{sec:intro}|");
      const doc = view.state.doc;
      const line = doc.line(7);
      const hv = (await server.hover(main, doc, { line: 6, character: 3 })) as { contents: { value: string } };
      assert.equal(hv.contents.value, "α");
      const defs = await server.definition(main, doc, { line: 6, character: line.text.indexOf("sec:intro") + 2 });
      assert.equal(defs[0]?.path, main);
      done(view);
    });

  } finally {
    await server.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live texlab: smart Enter on untouched argument lists; no stale re-query after a snippet", { skip: !TEXLAB_BIN && "texlab not found (set TEXLAB_BIN)" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ll-texlab-keys-"));
  cpSync("tests/fixtures/texproj", dir, { recursive: true });
  mkdirSync(join(dir, "chapters", "parts"));
  writeFileSync(join(dir, "chapters", "parts", "two.tex"), "Two.\n");
  const isFolder = (path: string) => {
    try {
      return statSync(join(dir, path)).isDirectory();
    } catch {
      return false;
    }
  };
  const main = join(dir, "main.tex");
  const original = readFileSync(main, "utf8");
  const server = new TexlabServer({
    binary: () => TEXLAB_BIN,
    root: dir,
    env: () => process.env,
    settings: () => texlabSettings(null),
  });
  /** Every request as "text before the cursor|triggerKind". */
  const calls: string[] = [];
  const texlab: LspCompletionBackend = {
    triggerCharacters: () => server.triggerCharacters(),
    request: (pos, context, state) => {
      calls.push(state.doc.line(pos.line + 1).text.slice(0, pos.character) + "|" + context.triggerKind);
      return server.completion(main, state.doc, pos, context);
    },
  };
  const open = (line: string) => {
    const doc = original.replace("\\begin{document}\n", () => `\\begin{document}\n${line}\n`); // a function keeps `$$` in `line`
    const view = editor(doc, latexCompletionSource(texlab, { isFolder }), (v, changes, startDoc) =>
      server.change(main, v.state.doc, changes, startDoc),
    );
    server.open(main, view.state.doc);
    return view;
  };
  const done = (view: EditorView) => {
    server.close(main);
    view.destroy();
  };
  try {
    assert.equal(await server.ensureStarted(), true);

    await t.test("\\ref{ + Enter right away is a newline; ArrowDown + Enter takes a label", async () => {
      const view = open("See |");
      typeKeys(view, "\\ref{");
      await settle(view);
      assert.ok(labels(view).includes("sec:intro"), labels(view).join(" | "));
      press(view, "Enter");
      assert.equal(completionStatus(view.state), null);
      assert.match(view.state.doc.toString(), /See \\ref\{\n\s*\n\}/);
      done(view);
      const nav = open("See |");
      typeKeys(nav, "\\ref{");
      await settle(nav);
      const second = labels(nav)[1];
      press(nav, "ArrowDown");
      press(nav, "Enter");
      assert.equal(lineAtCursor(nav), `See \\ref{${second}}|`, "the label is the whole argument: the cursor leaves the braces");
      done(nav);
    });

    await t.test("\\end{ + Enter takes the environment texlab preselects", async () => {
      const view = open("\\begin{align}\n  a\n|");
      typeKeys(view, "\\end{");
      await settle(view);
      assert.equal(labels(view)[0], "align");
      press(view, "Enter");
      assert.equal(lineAtCursor(view), "\\end{align}|");
      done(view);
    });

    await t.test("a single value (label, file, class) lands after its brace; \\cite and \\usepackage keep the cursor inside", async () => {
      const cases: [string, (view: EditorView) => void, string[], RegExp | string][] = [
        ["See |", (v) => typeKeys(v, "\\ref{"), ["ArrowDown", "Tab"], /^See \\ref\{[^}]+\}\|$/],
        ["See |", (v) => typeKeys(v, "\\eqref{"), ["ArrowDown", "Enter"], "See \\eqref{eq:main}|"],
        ["See |", (v) => type(v, "\\ref{"), ["ArrowDown", "Enter"], /^See \\ref\{[^}]+\}\|$/], // no closeBrackets: `}` added
        ["See |", (v) => typeKeys(v, "\\cite{"), ["ArrowDown", "Enter"], /^See \\cite\{[^}]+\|\}$/],
        ["See |", (v) => typeKeys(v, "\\cite{he"), ["Tab"], "See \\cite{he2022mae|}"],
        ["|", (v) => typeKeys(v, "\\input{chapters/o"), ["Enter"], "\\input{chapters/one}|"],
        ["|", (v) => typeKeys(v, "\\input{chap"), ["Tab"], "\\input{chapters|}"], // a folder
        ["|", (v) => typeKeys(v, "\\include{chapters/o"), ["Tab"], "\\include{chapters/one}|"], // texlab drops .tex: isFolder
        ["|", (v) => typeKeys(v, "\\include{chapters/p"), ["Tab"], "\\include{chapters/parts|}"],
        ["|", (v) => typeKeys(v, "\\documentclass{artic"), ["Tab"], "\\documentclass{article}|"],
        ["|", (v) => typeKeys(v, "\\usepackage{amsm"), ["Tab"], "\\usepackage{amsmath|}"],
        // Names the built-in layer adds or handles: an environment already closed below, a project color.
        ["|\n  \\item a\n\\end{itemize}", (v) => typeKeys(v, "\\begin{itemi"), ["Tab"], "\\begin{itemize}|"],
        ["\\definecolor{mageblue}{RGB}{0,0,255}\nSee |", (v) => typeKeys(v, "\\textcolor{mageb"), ["Enter"], "See \\textcolor{mageblue}|"],
      ];
      for (const [line, typing, keys, want] of cases) {
        const view = open(line);
        typing(view);
        await settle(view);
        assert.ok(labels(view).length, `${lineAtCursor(view)}: no list`);
        const before = lineAtCursor(view);
        for (const key of keys) press(view, key);
        if (typeof want === "string") assert.equal(lineAtCursor(view), want, `${before} ${keys.join(" + ")}`);
        else assert.match(lineAtCursor(view), want, `${before} ${keys.join(" + ")}`);
        done(view);
      }
    });

    await t.test("\\fr + Tab, then \\ in \\frac{|}{}: nothing is asked until a letter follows", async () => {
      const view = open("Let $x = |$ be.");
      type(view, "\\fr");
      await settle(view);
      press(view, "Tab");
      assert.equal(lineAtCursor(view), "Let $x = \\frac{|}{}$ be.");
      calls.length = 0;
      type(view, "\\");
      await settle(view);
      assert.deepEqual(calls, [], "the finished \\fr list is not re-queried");
      type(view, "alp");
      await settle(view);
      assert.equal(calls[0], "Let $x = \\frac{\\alp|1", calls.join(" ; "));
      press(view, "Tab");
      assert.equal(lineAtCursor(view), "Let $x = \\frac{\\alpha|}{}$ be.");
      done(view);
    });

    await t.test("\\re + Tab opens the label list as if typed: Enter right away is a newline, Tab takes a label", async () => {
      const view = open("See |");
      type(view, "\\re");
      await settle(view);
      assert.equal(labels(view)[0], "ref");
      press(view, "Tab");
      assert.equal(lineAtCursor(view), "See \\ref{|}");
      await settle(view);
      assert.ok(labels(view).includes("sec:intro"), labels(view).join(" | "));
      press(view, "Enter");
      assert.equal(completionStatus(view.state), null);
      assert.match(view.state.doc.toString(), /See \\ref\{\n\s*\n\}/);
      done(view);
      const tab = open("See |");
      type(tab, "\\re");
      await settle(tab);
      press(tab, "Tab");
      await settle(tab);
      const first = labels(tab)[0];
      press(tab, "Tab");
      assert.equal(lineAtCursor(tab), `See \\ref{${first}}|`);
      assert.equal(hasNextSnippetField(tab.state), false, "the \\ref{#1}#0 snippet ended");
      done(tab);
    });

    await t.test("a bare \\ before } or $: texlab's control symbol keeps the closer; letters ask texlab again", async () => {
      // texlab reads `\}` / `\$` there and its range covers the closer of the group.
      for (const [line, symbol, want] of [
        ["Let $x = \\frac{|}{}$ be.", "}", "Let $x = \\frac{\\}|}{}$ be."],
        ["Let $|$ be.", "$", "Let $\\$|$ be."],
        ["See \\textbf{|} here.", "}", "See \\textbf{\\}|} here."],
        ["Let $a|,b$ be.", ",", "Let $a\\,|b$ be."], // not a closer: the comma becomes `\,`
        ["Let $$x = |$$ be.", "$", "Let $$x = \\$|$$ be."],
        ["Cost |$5$ more.", "$", "Cost \\$|5$ more."], // a `$` opening math is escaped as texlab says
      ]) {
        const view = open(line);
        type(view, "\\");
        startCompletion(view);
        await settle(view);
        const i = labels(view).indexOf(symbol);
        assert.ok(i >= 0, labels(view).slice(0, 10).join(" "));
        view.dispatch({ effects: setSelectedCompletion(i) });
        press(view, "Tab");
        assert.equal(lineAtCursor(view), want);
        done(view);
      }
      // `\`, Ctrl-Space, a pause, then letters: texlab's commands for `\alp`, the `}` kept.
      const view = open("Let $x = \\frac{|}{}$ be.");
      type(view, "\\");
      startCompletion(view);
      await settle(view);
      calls.length = 0;
      for (const ch of "alp") {
        type(view, ch);
        await sleep(130);
      }
      await settle(view);
      assert.equal(calls.at(-1), "Let $x = \\frac{\\alp|1", calls.join(" ; "));
      assert.ok(labels(view).includes("alph"), labels(view).join(" "));
      press(view, "Tab");
      assert.equal(lineAtCursor(view), "Let $x = \\frac{\\alpha|}{}$ be.");
      done(view);
    });

    await t.test("an explicit list is asked again once its query is backspaced away", async () => {
      // Ctrl-Space at `\alp` (or at a bare `\`, then `alp`), Backspace x3, `bet`: texlab's
      // list for `alp` once stayed open and `bet` picked `\SetMathAlphabet` from it.
      for (const explicitAt of ["\\alp", "\\"]) {
        const view = open("Let $x = |$ be.");
        type(view, explicitAt);
        await settle(view);
        startCompletion(view);
        await settle(view);
        for (const ch of "\\alp".slice(explicitAt.length)) {
          type(view, ch);
          await sleep(130);
        }
        await settle(view);
        calls.length = 0;
        for (let i = 0; i < 3; i++) {
          press(view, "Backspace");
          await sleep(130);
        }
        await settle(view);
        assert.equal(calls.at(-1), "Let $x = \\|1", calls.join(" ; "));
        for (const ch of "bet") {
          type(view, ch);
          await sleep(130);
        }
        await settle(view);
        assert.equal(labels(view)[0], "beta", labels(view).slice(0, 6).join(" "));
        press(view, "Tab");
        assert.equal(lineAtCursor(view), "Let $x = \\beta|$ be.", `Ctrl-Space at ${explicitAt}`);
        done(view);
      }
    });

    await t.test("\\frac{|}{}: a fast Tab after \\alp completes it; after a full name the next key goes on", async () => {
      // [typed at 40 ms a key, then Tab 40 ms later, then typed right away, want]
      for (const [typed, after, want] of [
        ["\\alp", "", "Let $x = \\frac{\\alpha|}{}$ be."],
        ["\\alpha", "2", "Let $x = \\frac{\\alpha}{2|}$ be."],
        ["\\alpha", "", "Let $x = \\frac{\\alpha}{|}$ be."],
      ]) {
        const view = open("Let $x = |$ be.");
        type(view, "\\fr");
        await settle(view);
        press(view, "Tab");
        assert.equal(lineAtCursor(view), "Let $x = \\frac{|}{}$ be.");
        for (const ch of typed) {
          typeKeys(view, ch);
          await sleep(40);
        }
        press(view, "Tab");
        typeKeys(view, after);
        await sleep(500);
        assert.equal(lineAtCursor(view), want, `${typed} Tab ${after}`);
        done(view);
      }
    });
  } finally {
    await server.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
