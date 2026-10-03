import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorView } from "@codemirror/view";
import { NewTexFileModal, registerNewTexFile, texFileName } from "../src/editor/newTexFile";
import type LatexLivePlugin from "../src/main";
import { TexView } from "../src/editor/texView";
import { TFile, TFolder, modals, notices, testApp, WorkspaceLeaf } from "./support/obsidian";

const pause = () => new Promise<void>(done => setTimeout(done, 0));
function host(folderPath = "课程/中文目录") {
  const folder = new TFolder(folderPath) as unknown as import("obsidian").TFolder, root = folder.isRoot() ? folder : new TFolder("/");
  const entries = new Map<string, unknown>([[folder.path, folder]]), contents = new Map<string, string>();
  const created: string[] = [], opened: TFile[] = [], commands: Record<string, unknown>[] = [], cleanup: (() => void)[] = [];
  let menu: (menu: unknown, file: unknown) => void = () => {}, failCreate = false, failOpen = false, waitCreate: (() => Promise<void>) | undefined;
  const event = {};
  const plugin = {
    app: {
      vault: {
        getRoot: () => root, getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
        create: async (path: string, data: string) => { created.push(path); await waitCreate?.(); if (failCreate) throw new Error("write failed"); if (entries.has(path)) throw new Error("already exists"); const file = new TFile(path); entries.set(path, file); contents.set(path, data); return file; },
      },
      fileManager: { getNewFileParent: (path: string) => { assert.equal(path, "课程/active.tex"); return folder; } },
      workspace: {
        on: (name: string, callback: typeof menu) => { assert.equal(name, "file-menu"); menu = callback; return event; },
        getActiveFile: () => new TFile("课程/active.tex"),
        getLeaf: (mode: string) => { assert.equal(mode, "tab", "creation must not replace the preview"); return { openFile: async (file: TFile) => { if (failOpen) throw new Error("open failed"); opened.push(file); } }; },
      },
    },
    register: (cb: () => void) => cleanup.push(cb), registerEvent: (ref: unknown) => assert.equal(ref, event),
    addCommand: (command: Record<string, unknown>) => commands.push(command),
  } as unknown as LatexLivePlugin;
  return { plugin, folder, root, entries, contents, created, opened, commands, cleanup, fireMenu: (target: unknown, file: unknown) => menu(target, file), failCreate: () => { failCreate = true; }, failOpen: (value: boolean) => { failOpen = value; }, waitCreate: (wait: () => Promise<void>) => { waitCreate = wait; } };
}
function elements(modal: NewTexFileModal) { return { input: modal.contentEl.querySelector("input")!, form: modal.contentEl.querySelector("form")!, status: modal.contentEl.querySelector('[role="status"]')!, create: modal.contentEl.querySelector<HTMLButtonElement>('button[type="submit"]')!, cancel: modal.contentEl.querySelector<HTMLButtonElement>('button[type="button"]')! }; }
function submit(modal: NewTexFileModal, name: string) { const e = elements(modal); e.input.value = name; e.form.dispatchEvent(new Event("submit", { cancelable: true })); }

test("folder context menu has the localized creation item in the existing new-action group; files do not", () => {
  const h = host(); registerNewTexFile(h.plugin);
  const items: { title: string; section: string; run: () => void }[] = [];
  const menu = { addItem: (build: (item: unknown) => void) => { const data = { title: "", section: "", run: () => {} }; const item = { setTitle: (v: string) => (data.title = v, item), setIcon: () => item, setSection: (v: string) => (data.section = v, item), onClick: (v: () => void) => (data.run = v, item) }; build(item); items.push(data); } };
  h.fireMenu(menu, new TFile("课程/note.tex")); assert.equal(items.length, 0);
  h.fireMenu(menu, h.folder); assert.equal(items.length, 1); assert.equal(items[0].title, "新建 TeX 文件"); assert.equal(items[0].section, "action-primary");
  items[0].run(); assert.ok(modals.at(-1) instanceof NewTexFileModal); h.cleanup[0](); assert.equal(modals.at(-1)!.isOpen, false);
  (h.commands[0].callback as () => void)(); assert.equal(modals.at(-1)!.titleEl.textContent, "新建 TeX 文件"); h.cleanup[0]();
});
test("names receive one lowercase .tex suffix, NFC and no URL decoding; invalid paths never pass", () => {
  assert.equal(texFileName("  证明神 e\u0301.TeX  "), "证明神 é.tex"); assert.equal(texFileName("notes.v1"), "notes.v1.tex"); assert.equal(texFileName("100%20"), "100%20.tex");
  for (const name of ["", " ", ".tex", ".", "..", "../escape", "folder/file", "folder\\file", "x\nfile", "a\0b", "a:b", "<name>", "CON", "LPT1.tex"]) assert.equal(texFileName(name), null, name);
});
for (const folder of ["课程/中文 空格", "/"]) test(`create empty TeX and open a new editor tab in ${folder}`, async () => {
  const h = host(folder), modal = new NewTexFileModal(h.plugin, h.folder); modal.open(); submit(modal, "论文"); await pause();
  const path = folder === "/" ? "论文.tex" : `${folder}/论文.tex`;
  assert.deepEqual(h.created, [path]); assert.equal(h.contents.get(path), ""); assert.equal(h.opened[0].path, path); assert.equal((modal as unknown as import("./support/obsidian").Modal).isOpen, false);
});
test("existing file/folder names and unsafe input preserve contents; default names avoid collisions", async () => {
  const h = host(); h.entries.set(h.folder.path + "/未命名.tex", new TFile(h.folder.path + "/未命名.tex"));
  const file = h.folder.path + "/existing.tex"; h.entries.set(file, new TFile(file)); h.contents.set(file, "Keep me"); h.entries.set(h.folder.path + "/directory.tex", new TFolder(h.folder.path + "/directory.tex"));
  const modal = new NewTexFileModal(h.plugin, h.folder); modal.open(); assert.equal(elements(modal).input.value, "未命名 1.tex");
  for (const name of ["existing", "directory", "../outside"]) { submit(modal, name); await pause(); assert.ok(elements(modal).status.textContent); }
  assert.equal(h.created.length, 0); assert.equal(h.contents.get(file), "Keep me"); modal.close();
});
test("cancel and a removed/renamed target folder create nothing", async () => {
  const h = host(), modal = new NewTexFileModal(h.plugin, h.folder); modal.open(); elements(modal).cancel.click(); submit(modal, "cancelled"); assert.equal(h.created.length, 0);
  const moved = new NewTexFileModal(h.plugin, h.folder); moved.open(); h.entries.delete(h.folder.path); submit(moved, "lost"); await pause(); assert.equal(h.created.length, 0); assert.match(elements(moved).status.textContent!, /移动或删除/); moved.close();
});
test("repeated submissions create once; an IME confirmation does not create a file", async () => {
  const h = host(); let release!: () => void; h.waitCreate(() => new Promise(done => { release = done; }));
  const modal = new NewTexFileModal(h.plugin, h.folder); modal.open();
  const e = elements(modal); e.input.dispatchEvent(new CompositionEvent("compositionstart")); submit(modal, "输入法");
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }); e.input.dispatchEvent(enter); assert.equal(enter.defaultPrevented, true); assert.equal(h.created.length, 0);
  e.input.dispatchEvent(new CompositionEvent("compositionend")); submit(modal, "输入法"); submit(modal, "输入法"); assert.equal(h.created.length, 1); release(); await pause(); assert.equal(h.opened.length, 1);
});
test("create failures and concurrent same-name files never overwrite or open a different file", async () => {
  const h = host(); h.failCreate(); const modal = new NewTexFileModal(h.plugin, h.folder); modal.open(); submit(modal, "failed"); await pause(); assert.equal((modal as unknown as import("./support/obsidian").Modal).isOpen, true); assert.equal(h.opened.length, 0); assert.match(elements(modal).status.textContent!, /write failed/); modal.close();
  const race = host(); race.waitCreate(async () => { race.entries.set(race.folder.path + "/race.tex", new TFile(race.folder.path + "/race.tex")); race.contents.set(race.folder.path + "/race.tex", "Another creator"); });
  const m = new NewTexFileModal(race.plugin, race.folder); m.open(); submit(m, "race"); await pause(); assert.equal(race.contents.get(race.folder.path + "/race.tex"), "Another creator"); assert.equal(race.opened.length, 0); assert.equal((m as unknown as import("./support/obsidian").Modal).isOpen, true); m.close();
});
test("opening failure retains the created file and retries opening without creating again", async () => {
  const h = host(); h.failOpen(true); const modal = new NewTexFileModal(h.plugin, h.folder); modal.open(); submit(modal, "saved"); await pause();
  assert.equal(h.created.length, 1); assert.equal((modal as unknown as import("./support/obsidian").Modal).isOpen, true); assert.match(elements(modal).status.textContent!, /文件已创建/); assert.equal(elements(modal).input.disabled, true);
  h.failOpen(false); submit(modal, "saved"); await pause(); assert.equal(h.created.length, 1); assert.equal(h.opened.length, 1);
});
test("closing while a create resolves keeps the file and does not navigate later", async () => {
  const h = host(); let release!: () => void; h.waitCreate(() => new Promise(done => { release = done; }));
  const modal = new NewTexFileModal(h.plugin, h.folder); modal.open(); submit(modal, "saved"); modal.close(); release(); await pause(); assert.equal(h.created.length, 1); assert.equal(h.opened.length, 0); assert.ok(notices.at(-1)?.includes("saved.tex"));
});
test("the newly created file can load into the actual TexView editor", async () => {
  const app = testApp(); const path = "课程/论文.tex"; app.vault.files.set(path, "");
  const plugin = {
    settings: { editingMode: "source", hoverRender: false, followCursor: false, cursorPreview: false, yoloTabCompletion: false, mathPreviewScale: 1 },
    histories: { restore: () => null, save: () => {} }, absolutePath: (p: string) => "/vault/" + p, rootFor: (p: string) => p,
    yolo: { extension: () => [] }, texlab: { triggerCharacters: () => [], open: () => {}, close: () => {}, change: () => {} },
    texRender: { opened: () => {}, ready: false, subscribe: () => () => {} }, diagnosticsFor: () => [],
    theoremGraphs: { invalidate: () => {}, subscribe: () => () => {} },
  } as unknown as LatexLivePlugin;
  const view = new TexView(new WorkspaceLeaf(app) as unknown as import("obsidian").WorkspaceLeaf, plugin);
  try { await (view as unknown as { loadFile(file: TFile): Promise<void> }).loadFile(new TFile(path)); assert.ok(view.editorView instanceof EditorView); assert.equal(view.getViewData(), ""); assert.equal(view.file?.path, path); }
  finally { await view.onClose(); }
});
