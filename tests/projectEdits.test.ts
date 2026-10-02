import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { applyProjectEdits, indexProjectLabels, previewEnvironmentRename, previewLabelRename, previewReplace, searchProject, undoProjectEdits, type EditState, type ProjectEditHost } from "../src/tex/projectEdits";
import { normalizedText, projectBodyFiles, readProjectSnapshot, type ProjectSnapshot } from "../src/tex/projectIndex";

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
async function project(body: string, files: Record<string, string> = {}, edits: Record<string, string> = {}, preamble = "", cls = "article") {
  const dir = mkdtempSync(join(tmpdir(), "ll-project-edit-")); dirs.push(dir);
  const root = join(dir, "paper", "main.tex");
  const all = { "paper/main.tex": `\\documentclass{${cls}}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`, ...files };
  for (const [key, text] of Object.entries(all)) { mkdirSync(dirname(join(dir, key)), { recursive: true }); writeFileSync(join(dir, key), text); }
  const buffers = new Map(Object.entries(edits).map(([key, text]) => [join(dir, key), text]));
  return { dir, root, snapshot: await readProjectSnapshot(root, buffers), buffers };
}
function memoryHost(snapshot: ProjectSnapshot) {
  const states = new Map<string, EditState>(snapshot.files.map(file => [file.path, { text: file.text, diskText: file.diskText, writable: true }]));
  const writes: string[] = [];
  const host: ProjectEditHost = {
    read: async path => ({ ...states.get(path)! }),
    write: async (path, expected, text, lineEnding) => {
      assert.deepEqual(states.get(path), expected, "CAS compares original disk and buffer");
      const state = { ...expected, text, diskText: lineEnding === "\r\n" ? text.replace(/\n/g, "\r\n") : text };
      states.set(path, state); writes.push(path); return { ...state };
    },
  };
  return { host, states, writes };
}

test("snapshots follow current root, ../ inputs, preamble inputs, imports, includeonly and unsaved buffers", async () => {
  const t = await project(String.raw`\input{../shared}
\import{parts/}{a}
\include{enabled}
\include{disabled}`, {
    "shared.tex": "Shared original.\n", "paper/setup.tex": String.raw`\newcommand{\myname}{test}`,
    "paper/parts/a.tex": String.raw`\input{b}`, "paper/parts/b.tex": "Imported child.\n",
    "paper/enabled.tex": "Enabled.\n", "paper/disabled.tex": "Must be excluded.\n", "paper/unrelated.tex": "Unrelated.\n",
  }, { "shared.tex": "Shared unsaved.\n" }, String.raw`\input{setup}\includeonly{enabled}`);
  assert.deepEqual(t.snapshot.files.map(file => file.path.replace(t.dir + "/", "")).sort(), ["paper/enabled.tex", "paper/main.tex", "paper/parts/a.tex", "paper/parts/b.tex", "paper/setup.tex", "shared.tex"]);
  assert.equal(t.snapshot.files.find(file => file.path === join(t.dir, "shared.tex"))?.text, "Shared unsaved.\n");
  assert.ok(projectBodyFiles(t.snapshot).some(file => file.path === join(t.dir, "shared.tex")));
  assert.ok(!projectBodyFiles(t.snapshot).some(file => file.path.endsWith("setup.tex")));
  assert.equal(t.snapshot.warnings.length, 0);
});

test("symlink inputs are indexed once physically; repeated visits retain their contexts", async () => {
  const t = await project(String.raw`\input{../shared}\input{link}`, { "shared.tex": String.raw`\label{one}One.` });
  symlinkSync(join(t.dir, "shared.tex"), join(t.dir, "paper/link.tex"));
  const snapshot = await readProjectSnapshot(t.root, new Map());
  assert.equal(snapshot.files.filter(file => file.text.includes("\\label{one}")).length, 1);
  assert.equal(snapshot.plan.visits.length, 3);
  assert.equal(indexProjectLabels(snapshot).occurrences.filter(item => item.kind === "definition").length, 1);
  assert.throws(() => previewLabelRename(snapshot, "one", "two"), /repeatedly/);
});

test("literal search reports exact LF offsets and original CRLF persists on replace and Undo", async () => {
  const t = await project(String.raw`\input{crlf}`, { "paper/crlf.tex": "中文 Alpha\r\nalpha beta ALPHA\r\n" });
  const matches = searchProject(t.snapshot, "alpha", { wholeWord: true });
  assert.deepEqual(matches.map(match => [match.line, match.column, match.text]), [[1, 3, "Alpha"], [2, 0, "alpha"], [2, 11, "ALPHA"]]);
  const plan = previewReplace(t.snapshot, "alpha", "Gamma", { wholeWord: true });
  const memory = memoryHost(t.snapshot);
  const receipt = await applyProjectEdits(plan, memory.host);
  assert.equal(memory.states.get(join(t.dir, "paper/crlf.tex"))?.diskText, "中文 Gamma\r\nGamma beta Gamma\r\n");
  await undoProjectEdits(receipt, memory.host);
  assert.equal(memory.states.get(join(t.dir, "paper/crlf.tex"))?.diskText, "中文 Alpha\r\nalpha beta ALPHA\r\n");
});

test("case-insensitive Unicode matching preserves original offsets without lowercasing expansion", async () => {
  const t = await project("İ alpha Α β ALPHA alphabets $a+b$.");
  assert.equal(searchProject(t.snapshot, "ALPHA", { wholeWord: true }).length, 2);
  const formula = searchProject(t.snapshot, "$a+b$");
  assert.equal(formula[0].text, "$a+b$");
  assert.equal(t.snapshot.files[0].text.slice(formula[0].from, formula[0].to), "$a+b$");
});

test("label indexing includes math, cleveref lists/ranges and hyperref but ignores comments/verbatim", async () => {
  const t = await project(String.raw`\label{old}\label{other}
% \ref{old}
\verb|\ref{old}| \begin{verbatim}\label{bad}\ref{old}\end{verbatim}
$\eqref{old}$ \[\ref{old}\] \cref{ other, old } \Crefrange{old}{other}\hyperref[old]{link}
\input{../shared}`, { "shared.tex": String.raw`\ref*{old}\nameref{old}\vref{old}` });
  const index = indexProjectLabels(t.snapshot);
  assert.equal(index.unsafe.length, 0);
  assert.equal(index.occurrences.filter(item => item.key === "old").length, 9);
  assert.ok(index.occurrences.every(item => item.text === item.key));
  const plan = previewLabelRename(t.snapshot, "old", "renamed");
  assert.equal(plan.count, 9);
  assert.ok(plan.files.find(file => file.path === t.root)!.after.includes("% \\ref{old}"));
  assert.ok(plan.files.find(file => file.path === t.root)!.after.includes("\\verb|\\ref{old}|"));
  assert.ok(plan.files.find(file => file.path === t.root)!.after.includes("\\cref{ other, renamed }"));
});

test("safe rename rejects duplicate definitions, collisions, dynamic refs and reference-generating definitions", async () => {
  const duplicate = await project(String.raw`\label{old}\input{second}`, { "paper/second.tex": String.raw`\label{old}` });
  assert.throws(() => previewLabelRename(duplicate.snapshot, "old", "new"), /duplicate/);
  const collision = await project(String.raw`\label{old}\label{new}`);
  assert.throws(() => previewLabelRename(collision.snapshot, "old", "new"), /already exists/);
  const dynamic = await project(String.raw`\label{old}\ref{\computed}`);
  assert.throws(() => previewLabelRename(dynamic.snapshot, "old", "new"), /dynamic/);
  const macro = await project(String.raw`\label{old}`, {}, {}, String.raw`\newcommand{\link}[1]{\ref{#1}}`);
  assert.throws(() => previewLabelRename(macro.snapshot, "old", "new"), /reference-generating/);
});

test("missing/dynamic/cyclic project sources are visible and block a complete rename", async () => {
  for (const body of [String.raw`\label{old}\input{missing}`, String.raw`\label{old}\input{\dynamic}`, String.raw`\label{old}\input{main}`]) {
    const t = await project(body);
    assert.ok(t.snapshot.warnings.length);
    assert.throws(() => previewLabelRename(t.snapshot, "old", "new"), /project inputs/);
  }
  const generated = await project(String.raw`\label{old}\loadchapter`, { "paper/hidden.tex": String.raw`\ref{old}` }, {}, String.raw`\newcommand{\loadchapter}{\input{hidden}}`);
  assert.ok(generated.snapshot.warnings.some(warning => warning.includes("macro generates")));
  assert.throws(() => previewLabelRename(generated.snapshot, "old", "new"), /project inputs/);
});

test("elegantbook native labels rename their suffix and all refs while retaining the prefix", async () => {
  const t = await project(String.raw`\begin{theorem}{Title}{result}Statement.\end{theorem}\ref{thm:result}`, {}, {}, "", "elegantbook");
  assert.equal(indexProjectLabels(t.snapshot).occurrences[0].key, "thm:result");
  const plan = previewLabelRename(t.snapshot, "thm:result", "thm:renamed");
  assert.equal(plan.count, 2);
  assert.ok(plan.files[0].after.includes("{Title}{renamed}"));
  assert.throws(() => previewLabelRename(t.snapshot, "thm:result", "other:key"), /prefix/);
});

test("paired environment rename chooses the nested pair, not comments or other same-name pairs", async () => {
  const source = String.raw`\begin{proof}
\begin{quote}Inside.\end{quote}
% \end{proof}
\end{proof}
\begin{quote}Another.\end{quote}`;
  const t = await project(source);
  const plan = previewEnvironmentRename(t.snapshot, t.root, t.snapshot.files[0].text.indexOf("Inside"), "quotation");
  assert.equal(plan.count, 2);
  assert.ok(plan.files[0].after.includes("\\begin{quotation}Inside.\\end{quotation}"));
  assert.ok(plan.files[0].after.includes("\\begin{quote}Another.\\end{quote}"));
});

test("paired math environments are supported; incomplete and invalid names are rejected", async () => {
  const t = await project(String.raw`\begin{align}a=b\end{align}`);
  const plan = previewEnvironmentRename(t.snapshot, t.root, t.snapshot.files[0].text.indexOf("a=b"), "align*");
  assert.ok(plan.files[0].after.includes("\\begin{align*}a=b\\end{align*}"));
  assert.throws(() => previewEnvironmentRename(t.snapshot, t.root, 0, "align"), /complete/);
  assert.throws(() => previewEnvironmentRename(t.snapshot, t.root, 1, "a}\\ref{x"), /literal/);
});

test("complete preflight rejects stale disk, stale buffer, composing, conflicting panes and outside-vault targets before any writes", async () => {
  const t = await project("old\\input{second}", { "paper/second.tex": "old" });
  const plan = previewReplace(t.snapshot, "old", "new");
  for (const override of [{ text: "new user text" }, { diskText: "external disk edit" }, { composing: true }, { conflicting: true }, { writable: false }]) {
    const memory = memoryHost(t.snapshot);
    Object.assign(memory.states.get(plan.files.at(-1)!.path)!, override);
    await assert.rejects(applyProjectEdits(plan, memory.host));
    assert.equal(memory.writes.length, 0);
  }
});

test("per-file stale checks catch a race after preflight and roll back earlier writes", async () => {
  const t = await project("old\\input{second}", { "paper/second.tex": "old" });
  const plan = previewReplace(t.snapshot, "old", "new");
  const memory = memoryHost(t.snapshot);
  const write = memory.host.write;
  memory.host.write = async (...args) => {
    const result = await write(...args);
    if (memory.writes.length === 1) memory.states.get(plan.files[1].path)!.text = "new user edit";
    return result;
  };
  await assert.rejects(applyProjectEdits(plan, memory.host), /stale/);
  assert.equal(memory.states.get(plan.files[0].path)?.text, plan.files[0].before);
  assert.equal(memory.states.get(plan.files[1].path)?.text, "new user edit");
});

test("Undo refuses newer text before reverting any file", async () => {
  const t = await project("old\\input{second}", { "paper/second.tex": "old" });
  const plan = previewReplace(t.snapshot, "old", "new");
  const memory = memoryHost(t.snapshot);
  const receipt = await applyProjectEdits(plan, memory.host);
  memory.states.get(plan.files[1].path)!.text += " newer";
  const writes = memory.writes.length;
  await assert.rejects(undoProjectEdits(receipt, memory.host), /stale/);
  assert.equal(memory.writes.length, writes);
});

test("project operations leave unrelated source and disk untouched", async () => {
  const t = await project(String.raw`\label{old}\ref{old}`, { "paper/unrelated.tex": String.raw`\ref{old}` });
  const unrelated = readFileSync(join(t.dir, "paper/unrelated.tex"), "utf8");
  const memory = memoryHost(t.snapshot);
  await applyProjectEdits(previewLabelRename(t.snapshot, "old", "new"), memory.host);
  assert.equal(memory.writes.length, 1);
  assert.equal(readFileSync(join(t.dir, "paper/unrelated.tex"), "utf8"), unrelated);
  assert.equal(normalizedText(t.snapshot.files[0].diskText), t.snapshot.files[0].text);
});
