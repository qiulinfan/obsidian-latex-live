import "./support/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { proseWords, countProse, parseDelimitedTable, tableLatex } from "../src/tex/prose";
import { checkProseSpelling, clipboardTable, proseSpelling, showSpelling } from "../src/editor/proseTools";

test("Prose excludes preamble, math, identifiers, comments, definitions and code; retains text arguments", () => {
  const src = String.raw`\documentclass{article}
\newcommand{\macro}{mispeling}
\begin{document}
\section[Short]{Long title}
This is \emph{ordinary prose} with $mispeling=\command$ and \ref{mispeling}.
% mispeling
\begin{proof}Proof text 中文。\end{proof}
\verb|mispeling| \begin{tikzpicture}mispeling\end{tikzpicture}
\iffalse
mispeling
\fi
\href{https://mispeling.example}{Link text}
\end{document}
ignored`;
  const words = proseWords(src);
  assert.deepEqual(words.map(w => w.text), ["Long", "title", "This", "is", "ordinary", "prose", "with", "and", "Proof", "text", "中", "文", "Link", "text"]);
  for (const w of words) assert.equal(src.slice(w.from, w.to), w.text);
  assert.deepEqual(countProse(words), { words: 12, hanCharacters: 2 });
});
test("Delimited spreadsheet quoted fields, newline and special characters produce valid escaped tabular/booktabs", () => {
  const rows = parseDelimitedTable('Name\tValue\r\n"A\tB"\t"100% & $x$"\r\n"line\nnext"\t"a_b\\c"\r\n')!;
  assert.equal(rows.length, 3); assert.equal(rows[1][0], "A\tB");
  const table = tableLatex(rows, true);
  assert.ok(table.includes("\\toprule\n")); assert.ok(table.includes("\\midrule\n"));
  assert.ok(table.includes("100\\% \\& \\$x\\$")); assert.ok(table.includes("a\\_b\\textbackslash{}c"));
  assert.ok(table.includes("line next")); assert.ok(table.endsWith("\\end{tabular}"));
  assert.deepEqual(parseDelimitedTable("indented prose\nother prose"), [["indented prose"], ["other prose"]]);
  assert.deepEqual(parseDelimitedTable("A,B"), [["A", "B"]]);
  assert.ok(!tableLatex([["A", "B"]], true).includes("\\midrule"));
  assert.equal(parseDelimitedTable("a\tb\nc"), null);
  assert.throws(() => parseDelimitedTable('a\tb\n"unterminated\tc'));
});
test("Clipboard HTML tables never execute markup or silently flatten merged cells", () => {
  {
    const rows = clipboardTable("", '<table><tr><th>A</th><th>B</th></tr><tr><td><img src=x onerror="window.bad=1">x</td><td>&lt;script&gt;</td></tr></table>', document)!;
    assert.deepEqual(rows, [["A", "B"], ["x", "<script>"]]);
    assert.throws(() => clipboardTable("", '<table><tr><td colspan="2">merged</td></tr></table>', document));
    assert.equal(document.querySelector("img"), null);
  }
});
test("Clipboard tables discard active HTML content while preserving cell text and merge detection", () => {
  const html = '<table><tr><td><strong>A &amp; B</strong><script>window.clipboardAttack=1</script></td><td><iframe srcdoc="bad">hidden frame</iframe><img src=x onerror="window.clipboardAttack=2">100%</td></tr></table>';
  assert.deepEqual(clipboardTable("", html, document), [["A & B", "100%"]]);
  assert.throws(() => clipboardTable("", '<table><tr><td rowspan="2">merged</td><td>A</td></tr><tr><td>B</td></tr></table>', document), /Merged cells/);
  assert.equal(document.querySelector("script,iframe,img"), null);
});
test("Spelling checks prose only, yields/cancels, caches repeated words and clears stale decorations", async () => {
  const src = String.raw`mispeling $mispeling$ \ref{mispeling} 中文 mispeling good`;
  const calls: string[] = [];
  const words = await checkProseSpelling(proseWords(src), { isWordMisspelled: word => { calls.push(word); return word === "mispeling"; }, getWordSuggestions: () => ["misspelling"] }, () => false);
  assert.equal(words.length, 2); assert.deepEqual(calls, ["mispeling", "good"]);
  const state = EditorState.create({ doc: src, extensions: [proseSpelling] }).update({ effects: showSpelling.of(words) }).state;
  assert.equal(state.field(proseSpelling).size, 2);
  assert.equal(state.update({ changes: { from: src.length, insert: "!" } }).state.field(proseSpelling).size, 0);
  const cancelled = await checkProseSpelling(proseWords(src), { isWordMisspelled: () => { throw new Error("cancel must precede dictionary work"); }, getWordSuggestions: () => [] }, () => true);
  assert.deepEqual(cancelled, []);
});

test("Table preview inserts one row or column as one undoable editor operation and refuses IME", async () => {
  const { TablePasteModal } = await import("../src/editor/proseTools");
  const { EditorView } = await import("@codemirror/view");
  const { history, undo } = await import("@codemirror/commands");
  const { testApp } = await import("./support/obsidian");
  const editor = new EditorView({ parent: document.body.appendChild(document.createElement("div")), state: EditorState.create({ doc: "Before", extensions: [history()] }) });
  try {
    const view = { editorView: editor } as unknown as import("../src/editor/texView").TexView;
    const plugin = { app: testApp() } as unknown as import("../src/main").default;
    const modal = new TablePasteModal(plugin, view, () => ({ text: "A,B", html: "" })); modal.open();
    const preview = modal.contentEl.querySelector("textarea")!;
    assert.ok(preview.value.includes("\\begin{tabular}{ll}"));
    const mode = modal.contentEl.querySelector("select")!; mode.value = "booktabs"; mode.dispatchEvent(new Event("change"));
    assert.ok(preview.value.includes("\\toprule")); assert.ok(!preview.value.includes("\\midrule"));
    modal.contentEl.querySelector("button")!.click();
    assert.ok(editor.state.doc.toString().includes("\\begin{tabular}")); assert.ok(undo(editor)); assert.equal(editor.state.doc.toString(), "Before");
    const composing = new TablePasteModal(plugin, view, () => ({ text: "A\nB", html: "" })); composing.open();
    Object.defineProperty(editor, "compositionStarted", { value: true, configurable: true });
    composing.contentEl.querySelector("button")!.click(); assert.equal(editor.state.doc.toString(), "Before"); composing.close();
  } finally { editor.destroy(); }
});

test("Spelling modal uses project signatures in an ElegantBook chapter, leaves theorem labels out", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("fs"); const { tmpdir } = await import("os"); const { join } = await import("path");
  const { EditorView } = await import("@codemirror/view"); const { SpellingModal } = await import("../src/editor/proseTools"); const { testApp } = await import("./support/obsidian");
  const dir = mkdtempSync(join(tmpdir(), "ll-spelling-project-")), root = join(dir, "main.tex"), chapter = join(dir, "chapter.tex");
  const source = String.raw`\begin{theorem}{Named result}{key}
Good text mispeling. \ref{thm:key} $mispeling$
\end{theorem}`;
  writeFileSync(root, String.raw`\documentclass{elegantbook}\begin{document}\input{chapter}\end{document}`); writeFileSync(chapter, source);
  const editor = new EditorView({ parent: document.body.appendChild(document.createElement("div")), state: EditorState.create({ doc: source, extensions: [proseSpelling] }) });
  try {
    const plugin = { app: testApp(), rootFor: () => root, editorBuffers: () => new Map([[chapter, source]]) } as unknown as import("../src/main").default;
    const view = { editorView: editor, absolutePath: () => chapter } as unknown as import("../src/editor/texView").TexView;
    const checked: string[] = [];
    const modal = new SpellingModal(plugin, view, { isWordMisspelled: word => { checked.push(word); return word === "mispeling" || word === "qzxqzxqzx"; }, getWordSuggestions: () => ["misspelling"] }); modal.open();
    for (let i = 0; i < 40 && !modal.contentEl.textContent?.includes("possible spelling errors"); i++) await new Promise(done => setTimeout(done, 5));
    assert.ok(modal.contentEl.textContent?.includes("1 possible spelling errors"), modal.contentEl.textContent ?? "");
    assert.ok(!checked.includes("key") && !checked.includes("thm"), checked.join(","));
    assert.equal(checked.filter(w => w === "mispeling").length, 1);
    const correction = [...modal.contentEl.querySelectorAll("button")].find(b => b.textContent === "misspelling")!; correction.click();
    assert.ok(editor.state.doc.toString().includes("Good text misspelling.")); assert.ok(editor.state.doc.toString().includes("$mispeling$"));
  } finally { editor.destroy(); rmSync(dir, { recursive: true, force: true }); }
});
