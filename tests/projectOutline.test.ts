import "./support/dom";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type LatexLivePlugin from "../src/main";
import { ProjectOutlineView, VIEW_TYPE_PROJECT_OUTLINE, invalidateProjectOutline, registerProjectOutline, renderProjectOutline } from "../src/editor/projectOutline";
import { buildProjectOutline } from "../src/tex/outline";
import { readProjectSnapshot } from "../src/tex/projectIndex";
import { Plugin, WorkspaceLeaf, testApp } from "./support/obsidian";

const temps: string[] = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function project() {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-outline-panel-"));
  temps.push(dir);
  mkdirSync(join(dir, "chapters"));
  const root = join(dir, "main.tex");
  const chapter = join(dir, "chapters/ch1.tex");
  writeFileSync(root, "\\documentclass{book}\n\\begin{document}\n\\chapter{Root}\n\\input{chapters/ch1}\n\\end{document}\n");
  writeFileSync(chapter, "  \\section{Chapter section}\nBody.\n");
  return { root, chapter };
}

function host(root: string) {
  const app = testApp();
  const refs = new Set<{ event: string; callback: (...args: unknown[]) => void }>();
  const events = {
    on: (event: string, callback: (...args: unknown[]) => void) => { const ref = { event, callback }; refs.add(ref); return ref; },
    offref: (ref: { event: string; callback: (...args: unknown[]) => void }) => refs.delete(ref),
  };
  let activeRoot = root;
  let composition = false;
  const tex = { getViewType: () => "latex-live-editor", absolutePath: () => activeRoot, get editorView() { return { compositionStarted: composition }; } };
  Object.assign(app.workspace, events, { activeLeaf: { view: tex } });
  Object.assign(app.vault, events);
  const buffers = new Map<string, string>();
  const opened: { path: string; line: number; column: number }[] = [];
  const calls = { snapshotBuffers: 0 };
  const plugin = Object.assign(new Plugin(app), {
    rootFor: (abs: string) => abs,
    texViews: () => [tex],
    editorBuffers: (committed: boolean) => { assert.equal(committed, true); calls.snapshotBuffers++; return buffers; },
    openLocation: async (path: string, line: number, column: number) => { opened.push({ path, line, column }); },
  });
  return { app, plugin: plugin as unknown as LatexLivePlugin, refs, calls, buffers, opened, tex, setRoot: (r: string) => { activeRoot = r; }, compose: (c: boolean) => { composition = c; } };
}

test("DOM outline is hierarchical, uses safe text, shows source context and preserves exact click locations", async () => {
  const { root, chapter } = project();
  const snapshot = await readProjectSnapshot(root, new Map([[chapter, "  \\section{<img src=x onerror=bad> $x$}\nBody.\n"]]));
  const outline = buildProjectOutline(snapshot.plan);
  const container = document.createElement("nav");
  const opened: string[] = [];
  renderProjectOutline(container, outline, (h) => opened.push(`${h.file}:${h.line}:${h.column}`), ["Missing <unsafe> source"]);
  assert.equal(container.querySelectorAll("ul ul").length, 1);
  assert.equal(container.querySelector("img"), null);
  const child = container.querySelectorAll<HTMLButtonElement>(".ll-outline-heading")[1];
  assert.equal(child.textContent, "<img src=x onerror=bad> x");
  assert.ok(child.title.includes("chapters/ch1.tex:1"));
  child.click();
  assert.deepEqual(opened, [`${chapter}:1:2`]);
  assert.ok(container.querySelector(".ll-outline-warnings")?.textContent?.includes("Missing <unsafe> source"));
});

test("outline pane loads committed project sources and navigation survives focus moving into the side pane", async () => {
  const { root, chapter } = project();
  const h = host(root);
  const view = new ProjectOutlineView(new WorkspaceLeaf(h.app) as never, h.plugin);
  try {
    await view.onOpen();
    await sleep(25);
    assert.equal(view.root, root);
    assert.equal(view.contentEl.querySelectorAll(".ll-outline-heading").length, 2);
    Object.assign(h.app.workspace, { activeLeaf: { view } });
    for (const ref of h.refs) if (ref.event === "active-leaf-change") ref.callback();
    view.contentEl.querySelectorAll<HTMLButtonElement>(".ll-outline-heading")[1].click();
    assert.deepEqual(h.opened, [{ path: chapter, line: 1, column: 2 }]);
    assert.equal(view.root, root);
  } finally { await view.onClose(); view.containerEl.remove(); }
});

test("committed edit notifications coalesce and closing unsubscribes without reading any project", async () => {
  const { root, chapter } = project();
  const h = host(root);
  const view = new ProjectOutlineView(new WorkspaceLeaf(h.app) as never, h.plugin);
  await view.onOpen();
  await sleep(25);
  const before = h.calls.snapshotBuffers;
  h.buffers.set(chapter, "\\section{New committed title}\nMore.\n");
  for (let i = 0; i < 100; i++) invalidateProjectOutline(h.plugin);
  assert.equal(h.calls.snapshotBuffers, before);
  await sleep(850);
  assert.equal(h.calls.snapshotBuffers, before + 1);
  assert.ok(view.contentEl.textContent?.includes("New committed title"));
  invalidateProjectOutline(h.plugin);
  await view.onClose();
  assert.equal(h.refs.size, 0);
  for (let i = 0; i < 100; i++) invalidateProjectOutline(h.plugin);
  await sleep(850);
  assert.equal(h.calls.snapshotBuffers, before + 1);
  view.containerEl.remove();
});

test("outline defers IME and root changes discard pending snapshots", async () => {
  const first = project();
  const second = project();
  const h = host(first.root);
  h.compose(true);
  const view = new ProjectOutlineView(new WorkspaceLeaf(h.app) as never, h.plugin);
  try {
    await view.onOpen();
    await sleep(25);
    assert.equal(h.calls.snapshotBuffers, 0);
    h.compose(false);
    h.setRoot(second.root);
    for (const ref of h.refs) if (ref.event === "active-leaf-change") ref.callback();
    await sleep(25);
    assert.equal(view.root, second.root);
    assert.equal(h.calls.snapshotBuffers, 1);
    view.contentEl.querySelectorAll<HTMLButtonElement>(".ll-outline-heading")[1].click();
    assert.equal(h.opened[0].path, second.chapter);
  } finally { await view.onClose(); view.containerEl.remove(); }
});

test("outline command registers a side-pane ItemView and opens/reuses it", async () => {
  const { root } = project();
  const h = host(root);
  const leaf = { setViewState: async (state: unknown) => { states.push(state); } };
  const states: unknown[] = [];
  const reveals: unknown[] = [];
  let exists = false;
  Object.assign(h.app.workspace, {
    getLeavesOfType: (type: string) => { assert.equal(type, VIEW_TYPE_PROJECT_OUTLINE); return exists ? [leaf] : []; },
    getRightLeaf: (split: boolean) => { assert.equal(split, false); return leaf; },
    revealLeaf: async (target: unknown) => { reveals.push(target); },
  });
  registerProjectOutline(h.plugin);
  const registered = h.plugin as unknown as Plugin;
  assert.equal(registered.views.has(VIEW_TYPE_PROJECT_OUTLINE), true);
  const command = registered.commands.find((c) => c.id === "open-project-outline")!;
  (command.callback as () => void)();
  await sleep(5);
  exists = true;
  (command.callback as () => void)();
  await sleep(5);
  assert.deepEqual(states, [{ type: VIEW_TYPE_PROJECT_OUTLINE, active: true }]);
  assert.deepEqual(reveals, [leaf, leaf]);
});

test("opening a sidebar keeps the invoking project when another project's editor is first", async () => {
  const first = project(), active = project();
  const h = host(active.root);
  Object.assign(h.plugin, { texViews: () => [{ absolutePath: () => first.root }, h.tex] });
  let side: ProjectOutlineView | null = null;
  const leaf = {
    get view() { return side; },
    setViewState: async () => {
      const factory = (h.plugin as unknown as Plugin).views.get(VIEW_TYPE_PROJECT_OUTLINE)!;
      side = factory(new WorkspaceLeaf(h.app)) as ProjectOutlineView;
      Object.assign(h.app.workspace, { activeLeaf: { view: side } });
      await side.onOpen();
    },
  };
  Object.assign(h.app.workspace, { getLeavesOfType: () => [], getRightLeaf: () => leaf, revealLeaf: async () => {} });
  registerProjectOutline(h.plugin);
  const command = (h.plugin as unknown as Plugin).commands[0];
  (command.callback as () => void)();
  await sleep(25);
  const view = side as unknown as ProjectOutlineView;
  try {
    assert.equal(view.root, active.root);
    view.contentEl.querySelectorAll<HTMLButtonElement>(".ll-outline-heading")[1].click();
    assert.equal(h.opened[0].path, active.chapter);
  } finally { await view.onClose(); view.containerEl.remove(); }
});
