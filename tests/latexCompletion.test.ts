import "./support/dom";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  completionStatus,
  currentCompletions,
  hasNextSnippetField,
  selectedCompletionIndex,
  startCompletion,
} from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexBackend, latexCompletionSource, latexContext } from "../src/editor/latexCompletion";
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
import { press } from "./support/keyMatrix";

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
  // eecs559's `\al` page: 50 algorithmicx commands, no alpha (TL-02).
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

test("accepting \\ref opens the label list inside the braces", async () => {
  const c = CASE.ref;
  const { backend: b } = backend((state, pos) => {
    const line = state.doc.line(pos.line + 1).text.slice(0, pos.character);
    if (line.endsWith("\\ref{")) return c.response;
    if (line.endsWith("\\re")) return { items: [item("ref", "built-in", range(pos.line, 1, pos.character))] };
    return null;
  });
  // The recorded document has `\ref{}`: type `re`, accept, and get it back.
  const view = editor(c.doc.slice(0, c.offset - 4) + "|" + c.doc.slice(c.offset + 1), latexCompletionSource(b));
  type(view, "re");
  await settle(view);
  press(view, "Tab");
  assert.equal(lineAtCursor(view), "\\ref{|}");
  await settle(view);
  assert.deepEqual(labels(view).sort(), ["distribution function 的性质", "eq:cdf", "eq:main", "sec:intro"]);
  press(view, "ArrowDown");
  press(view, "Tab");
  assert.match(lineAtCursor(view), /^\\ref\{[^}]+\|\}$/);
  view.destroy();
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
  assert.equal(lineAtCursor(view), "\\input{chapters/02-random-variables|}");
  view.destroy();
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
      assert.equal(lineAtCursor(view), "\\input{chapters/one|}");
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
