import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { EditorState } from "@codemirror/state";
import { Bibliographies, searchCitations } from "../src/editor/bibliographies";
import { latexBackend } from "../src/editor/latexCompletion";
import { offsetToLspPos } from "../src/editor/shared/lspCompletion";

test("Whole-project citations pass texlab's 50 limit, search full author/year/title/key and preserve full fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-bib-index-"));
  try {
    const root = join(dir, "main.tex"), bib = join(dir, "one.bib"), more = join(dir, "more.bib");
    writeFileSync(root, String.raw`\documentclass{article}\addbibresource{one.bib}\input{chapter}\begin{document}Text\end{document}`);
    writeFileSync(join(dir, "chapter.tex"), String.raw`\bibliography{more}\section{A}`);
    writeFileSync(bib, Array.from({ length: 175 }, (_, i) => `@article{key${i},author={Ada Lovelace and Alan Turing},title={Computing paper ${i}},year={2026},doi={10/test${i}},abstract={Complete abstract}}`).join("\n"));
    writeFileSync(more, '@book{second,author={Grace Hopper},title={Compilers},year={1952},publisher={Example Press}}');
    const buffers = new Map<string, string>(), index = new Bibliographies(() => buffers);
    const entries = await index.load(root); assert.equal(entries.length, 176);
    assert.equal((await index.load(root)), entries, "cached no reparse while typing");
    assert.equal(searchCitations(entries, "Ada 2026 paper 174")[0].entry.key, "key174");
    assert.equal(entries[0].entry.fields?.abstract, "Complete abstract"); assert.ok(entries[0].entry.source?.includes("doi"));
    let lspRequests = 0;
    const backend = latexBackend({ triggerCharacters: () => [], request: async () => { lspRequests++; return null; } }, { citations: () => index.load(root) });
    const state = EditorState.create({ doc: String.raw`\cite{Ada` });
    const result = await backend.request(offsetToLspPos(state.doc, state.doc.length), { triggerKind: 1 }, state) as { items: { label: string; documentation: { value: string }; textEdit: { newText: string } }[] };
    assert.equal(result.items.length, 176); assert.equal(lspRequests, 0); assert.equal(result.items.at(-1)!.label, "second");
    assert.ok(result.items[174].documentation.value.includes("Complete abstract")); assert.equal(result.items[174].textEdit.newText, "key174");
    buffers.set(more, '@book{unsaved,author={Grace Hopper},title={Changed},year={1953}}'); index.invalidate();
    assert.equal((await index.load(root)).at(-1)!.entry.key, "unsaved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Multiline library paths invalidate on committed edits and external writes; inactive declarations stay inactive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-bib-multiline-"));
  try {
    const root = join(dir, "main.tex");
    const text = String.raw`\documentclass{article}
\addbibresource{
one.bib
}
\begin{document}
\begin{verbatim}\bibliography{missing}\end{verbatim}
\iffalse
\bibliography{also-missing}
\fi
\newcommand{\unused}{\bibliography{missing-macro}}
\end{document}`;
    writeFileSync(root, text);
    writeFileSync(join(dir, "one.bib"), '@book{one,title={One}}'); writeFileSync(join(dir, "two.bib"), '@book{two,title={Two}}');
    const buffers = new Map<string, string>(), index = new Bibliographies(() => buffers);
    assert.equal((await index.load(root))[0].entry.key, "one");
    const state = EditorState.create({ doc: text }), at = text.indexOf("one.bib");
    const transaction = state.update({ changes: { from: at, to: at + 3, insert: "two" } });
    buffers.set(root, transaction.newDoc.toString()); index.edited(root, transaction.changes, state.doc, transaction.newDoc);
    assert.equal((await index.load(root))[0].entry.key, "two");
    buffers.clear(); writeFileSync(root, text); await index.fileModified(root);
    assert.equal((await index.load(root))[0].entry.key, "one");
    const unchanged = state.update({ changes: { from: text.indexOf("end{document}"), insert: " " } });
    const cached = await index.load(root); index.edited(root, unchanged.changes, state.doc, unchanged.newDoc);
    assert.equal(await index.load(root), cached, "ordinary prose changes retain the index");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Ordinary typing on a very long soft-wrapped line reads a bounded window", () => {
  const state = EditorState.create({ doc: "word ".repeat(100_000) }), position = 250_000;
  const tr = state.update({ changes: { from: position, insert: "x" } });
  const sizes: number[] = [];
  const instrument = (doc: import("@codemirror/state").Text) => {
    const value = Object.create(doc) as import("@codemirror/state").Text;
    value.sliceString = (from, to = doc.length) => { sizes.push(to - from); return doc.sliceString(from, to); };
    value.lineAt = () => { throw new Error("A line-wide read would scan half a megabyte on every key."); };
    return value;
  };
  const index = new Bibliographies(() => new Map());
  index.edited("/project/chapter.tex", tr.changes, instrument(state.doc), instrument(tr.newDoc));
  assert.equal(sizes.length, 2); assert.ok(Math.max(...sizes) <= 129, String(sizes));
});
