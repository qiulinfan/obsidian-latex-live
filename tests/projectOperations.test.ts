import "./support/dom";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, undoDepth } from "@codemirror/commands";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { modals, TFile } from "./support/obsidian";
import type LatexLivePlugin from "../src/main";
import { ProjectEditPreviewModal, ProjectLabelsModal, ProjectSearchModal, projectEditHost, renderProjectMatches, type ProjectOperationsUiHost } from "../src/editor/projectOperations";
import { applyProjectEdits, previewLabelRename, previewReplace, searchProject, undoProjectEdits, type EditReceipt } from "../src/tex/projectEdits";
import { normalizedText, readProjectSnapshot, type ProjectSnapshot } from "../src/tex/projectIndex";
import { setDocText } from "../src/editor/shared/editorKit";

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const settle = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(done => setTimeout(done, 10));
  assert.ok(predicate(), "async operation settled");
};
const findButton = (parent: HTMLElement, name: string): HTMLButtonElement => [...parent.querySelectorAll("button")].find(button => button.textContent === name)!;

async function fixture(multi = false) {
  const dir = mkdtempSync(join(tmpdir(), "ll-project-ui-")); dirs.push(dir);
  const root = join(dir, "main.tex"), child = join(dir, "child.tex");
  const main = "\\documentclass{article}\n\\begin{document}\n\\label{old}By \\ref{old}.\\input{child}\n\\end{document}\n";
  writeFileSync(root, main); writeFileSync(child, "Use \\ref{old}.\r\n");
  const editor = new EditorView({ state: EditorState.create({ doc: main, extensions: [history()] }), parent: document.body });
  const views = [editor, ...(multi ? [new EditorView({ state: EditorState.create({ doc: main, extensions: [history()] }), parent: document.body })] : [])].map(editorView => ({
    editorView, absolutePath: () => root, getCommittedText: () => editorView.state.doc.toString(),
    flush: async () => { writeFileSync(root, editorView.state.doc.toString()); },
    acceptProjectData: (text: string) => { setDocText(editorView, text); },
  }));
  const writes: string[] = [];
  const vault = {
    getAbstractFileByPath: (path: string) => readFileSync(join(dir, path), "utf8") !== undefined ? new TFile(path) : null,
    process: async (file: TFile, fn: (data: string) => string) => { const path = join(dir, file.path); const next = fn(readFileSync(path, "utf8")); writeFileSync(path, next); writes.push(path); return next; },
  };
  const plugin = {
    app: { vault }, texViews: () => views, vaultBase: () => dir,
    vaultPath: (path: string) => { const rel = relative(dir, path); return rel && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel : null; },
  } as unknown as LatexLivePlugin;
  const host = projectEditHost(plugin);
  const snapshot = await readProjectSnapshot(root, new Map([[root, editor.state.doc.toString()]]));
  return { dir, root, child, editor, views, writes, vault, host, snapshot, plugin, close: () => { for (const view of views) view.editorView.destroy(); } };
}

test("real CodeMirror panes receive rename transactions and project Undo restores both files with CRLF", async () => {
  const t = await fixture(true);
  try {
    const plan = previewLabelRename(t.snapshot, "old", "new");
    const receipt = await applyProjectEdits(plan, t.host);
    assert.ok(t.views.every(view => view.editorView.state.doc.toString().includes("\\label{new}")));
    assert.equal(undoDepth(t.editor.state), 1);
    assert.equal(readFileSync(t.child, "utf8"), "Use \\ref{new}.\r\n");
    assert.equal(t.writes.length, 2, "one CAS write per file, no second TextFileView save");
    await undoProjectEdits(receipt, t.host);
    assert.ok(t.views.every(view => view.editorView.state.doc.toString() === t.snapshot.files[0].text));
    assert.equal(readFileSync(t.child, "utf8"), "Use \\ref{old}.\r\n");
    assert.ok(undo(t.editor), "ordinary CM history remains usable");
  } finally { t.close(); }
});

test("native host rejects different same-file panes and real IME composition before disk writes", async () => {
  const t = await fixture(true);
  try {
    const plan = previewReplace(t.snapshot, "old", "new");
    t.views[1].editorView.dispatch({ changes: { from: 0, insert: "different" } });
    await assert.rejects(applyProjectEdits(plan, t.host), /Two open panes/);
    assert.equal(t.writes.length, 0);
    t.views[1].editorView.dispatch({ changes: { from: 0, to: "different".length } });
    t.editor.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await assert.rejects(applyProjectEdits(plan, t.host), /IME composition/);
    assert.equal(t.writes.length, 0);
    t.editor.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  } finally { t.close(); }
});

test("physical alias panes participate in the same conflict check", async () => {
  const t = await fixture(true);
  try {
    const alias = join(t.dir, "alias.tex"); symlinkSync(t.root, alias);
    t.views[1].absolutePath = () => alias;
    t.views[1].editorView.dispatch({ changes: { from: 0, insert: "different physical alias text" } });
    await assert.rejects(applyProjectEdits(previewReplace(t.snapshot, "old", "new"), t.host), /Two open panes/);
    assert.equal(t.writes.length, 0);
  } finally { t.close(); }
});

test("overlapping project Apply calls are serialized before any writes", async () => {
  const t = await fixture();
  try {
    const plan = previewReplace(t.snapshot, "old", "new");
    const first = applyProjectEdits(plan, t.host);
    await assert.rejects(applyProjectEdits(plan, t.host), /Another project operation/);
    await first;
    assert.equal(t.writes.length, 2);
  } finally { t.close(); }
});

test("vault.process rechecks the current editor buffer after async preflight", async () => {
  const t = await fixture();
  try {
    const process = t.vault.process;
    t.vault.process = async (file, fn) => { t.editor.dispatch({ changes: { from: 0, insert: "new user text" } }); return process(file, fn); };
    await assert.rejects(applyProjectEdits(previewReplace(t.snapshot, "old", "new"), t.host), /stale/);
    assert.equal(t.writes.length, 0);
    assert.equal(readFileSync(t.root, "utf8"), t.snapshot.files[0].diskText);
    assert.ok(t.editor.state.doc.toString().startsWith("new user text"));
  } finally { t.close(); }
});

test("a symlink physically outside the vault cannot be silently written", async () => {
  const t = await fixture();
  try {
    const outside = mkdtempSync(join(tmpdir(), "ll-project-outside-")); dirs.push(outside);
    writeFileSync(join(outside, "other.tex"), "old\n");
    mkdirSync(join(t.dir, "links")); symlinkSync(join(outside, "other.tex"), join(t.dir, "links/other.tex"));
    assert.equal((await t.host.read(join(t.dir, "links/other.tex"))).writable, false);
  } finally { t.close(); }
});

test("project search modal groups exact locations, navigates by click, and replacement only previews", async () => {
  const t = await fixture();
  try {
    const navigated: number[] = [];
    const host: ProjectOperationsUiHost = { app: {} as never, editHost: t.host, snapshot: async () => t.snapshot, navigate: async match => { navigated.push(match.from); } };
    const modal = new ProjectSearchModal(host, t.snapshot); modal.open();
    modal.contentEl.querySelector<HTMLInputElement>('input[aria-label="Find"]')!.value = "old";
    modal.contentEl.querySelector<HTMLInputElement>('input[aria-label="Replace with"]')!.value = "new";
    findButton(modal.contentEl, "Search").click();
    assert.equal(modal.contentEl.querySelectorAll(".ll-project-group").length, 2);
    modal.contentEl.querySelector<HTMLButtonElement>(".ll-project-match")!.click();
    assert.deepEqual(navigated, [searchProject(t.snapshot, "old")[0].from]);
    findButton(modal.contentEl, "Preview replacement").click();
    const preview = modals.at(-1) as unknown as ProjectEditPreviewModal;
    assert.ok(preview instanceof ProjectEditPreviewModal);
    assert.equal(preview.plan.count, 3);
    assert.equal(t.writes.length, 0);
    assert.ok(preview.contentEl.textContent!.includes("− old\n+ new"));
    preview.close(); modal.close();
  } finally { t.close(); }
});

test("preview Apply and Undo buttons write a real recovery backup and use checked CM transactions", async () => {
  const t = await fixture();
  try {
    let receipt: EditReceipt | null = null, backup = "";
    const host: ProjectOperationsUiHost = { app: {} as never, editHost: t.host, snapshot: async () => t.snapshot, navigate: async () => {}, applied: (value, path) => { receipt = value; backup = path; } };
    const modal = new ProjectEditPreviewModal(host, previewLabelRename(t.snapshot, "old", "new")); modal.open();
    findButton(modal.contentEl, "Apply changes").click();
    await settle(() => receipt !== null);
    const recovery = JSON.parse(readFileSync(backup, "utf8"));
    assert.equal(recovery.plan.files[0].before, t.snapshot.files[0].text);
    assert.ok(t.editor.state.doc.toString().includes("\\label{new}"));
    findButton(modal.contentEl, "Undo this operation").click();
    await settle(() => modal.contentEl.textContent!.includes("Operation undone."));
    assert.equal(t.editor.state.doc.toString(), t.snapshot.files[0].text);
    modal.close();
  } finally { t.close(); }
});

test("a stale preview Apply button preserves newer CM edits and reports refresh", async () => {
  const t = await fixture();
  try {
    const host: ProjectOperationsUiHost = { app: {} as never, editHost: t.host, snapshot: async () => t.snapshot, navigate: async () => {} };
    const modal = new ProjectEditPreviewModal(host, previewReplace(t.snapshot, "old", "new")); modal.open();
    t.editor.dispatch({ changes: { from: 0, insert: "% new edit\n" } });
    findButton(modal.contentEl, "Apply changes").click();
    await settle(() => modal.contentEl.textContent!.includes("stale"));
    assert.equal(t.writes.length, 0);
    assert.ok(t.editor.state.doc.toString().startsWith("% new edit"));
    modal.close();
  } finally { t.close(); }
});

test("references UI lists definitions and all refs and preview rename remains separate", async () => {
  const t = await fixture();
  try {
    const host: ProjectOperationsUiHost = { app: {} as never, editHost: t.host, snapshot: async () => t.snapshot, navigate: async () => {} };
    const modal = new ProjectLabelsModal(host, t.snapshot, true, "old"); modal.open();
    assert.equal(modal.contentEl.querySelectorAll(".ll-project-match").length, 3);
    modal.contentEl.querySelector<HTMLInputElement>('input[aria-label="New label"]')!.value = "new";
    findButton(modal.contentEl, "Preview rename").click();
    const preview = modals.at(-1) as unknown as ProjectEditPreviewModal;
    assert.ok(preview.plan.files.length === 2);
    assert.equal(t.writes.length, 0);
    preview.close(); modal.close();
  } finally { t.close(); }
});

test("large search results keep DOM bounded with explicit load-more and preserve every result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-project-many-")); dirs.push(dir);
  const root = join(dir, "main.tex"); writeFileSync(root, "\\documentclass{article}\n\\begin{document}\n" + "needle\n".repeat(550) + "\\end{document}");
  const snapshot: ProjectSnapshot = await readProjectSnapshot(root, new Map());
  const parent = document.createElement("div");
  renderProjectMatches(parent, snapshot, searchProject(snapshot, "needle"), async () => {});
  assert.equal(parent.querySelectorAll(".ll-project-match").length, 200);
  findButton(parent, "Show 200 more results").click();
  assert.equal(parent.querySelectorAll(".ll-project-match").length, 400);
  findButton(parent, "Show 200 more results").click();
  assert.equal(parent.querySelectorAll(".ll-project-match").length, 550);
});

test("search refresh reports incomplete snapshots instead of claiming global completeness", async () => {
  const t = await fixture();
  try {
    const snapshot = { ...t.snapshot, warnings: ["Cannot read project input: missing.tex"] };
    const host: ProjectOperationsUiHost = { app: {} as never, editHost: t.host, snapshot: async () => snapshot, navigate: async () => {} };
    const modal = new ProjectSearchModal(host, snapshot); modal.open();
    assert.ok(modal.contentEl.textContent!.includes("Incomplete project snapshot"));
    modal.close();
    assert.equal(normalizedText(readFileSync(t.root, "utf8")), t.editor.state.doc.toString());
  } finally { t.close(); }
});
