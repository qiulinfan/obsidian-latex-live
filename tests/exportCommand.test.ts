// "Export to HTML" on the test stand-in for Obsidian (tests/support/obsidian.ts), with the dialog,
// the shell and (in the first test) the writer injected (design 6, S7a): when the command is
// offered, the .tex files' context menu entry, the file the dialog proposes (the exportFolder
// setting, the root's last target in the session), a cancelled dialog, a failed build; then a real
// export of a fresh copy of the article fixture (the build through a stand-in session running the
// plugin's Compiler, Obsidian's MathJax in jsdom) written through the vault adapter, the completion
// Notice's Open, Reveal and Report, and the report's located item opening its file at the line.
import "./support/dom";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { after, test } from "node:test";
import { HtmlExport, registerExport, type ExportIo } from "../src/export/command";
import { TexView } from "../src/editor/texView";
import { exportDirFor } from "../src/export/exporter";
import type { ExportReport } from "../src/export/report";
import type LatexLivePlugin from "../src/main";
import { outDirFor } from "../src/session";
import { Compiler, type CompileResult } from "../src/tex/compiler";
import { detectEngine, findRoot } from "../src/tex/project";
import { isAbortError } from "../src/tex/run";
import { fixtureCopy, removeExportTemps, texBin } from "./support/exportHost";
import { obsidianMathJax } from "./support/mathjax";
import { modals, notices, shownNotices, TFile } from "./support/obsidian";

const cleanups: (() => void)[] = [];
after(() => {
  for (const c of cleanups.splice(0)) c();
  removeExportTemps();
});

type MenuHandler = (menu: unknown, file: unknown) => void;

/** A plugin stand-in over the vault folder `vault`: what the command uses of LatexLivePlugin. */
async function fakePlugin(o: { vault: string; root: string; binDir: string | null; exportFolder?: string }) {
  const { MathJax } = await obsidianMathJax();
  const commands = new Map<string, { checkCallback(checking: boolean): boolean }>();
  const menus: MenuHandler[] = [];
  const writes: { path: string; data: string }[] = [];
  const folders: string[] = [];
  const opened: [string, number][] = [];
  const view = { active: null as { absolutePath(): string } | null };
  // The root's session: a full build with the plugin's Compiler into the root's build folder.
  let listeners: ((e: string) => void)[] = [];
  const session = {
    last: null as CompileResult | null,
    compiling: null as "full" | null,
    failure: null as string | null,
    builds: 0,
    onEvent(cb: (e: string) => void) {
      listeners.push(cb);
      return () => (listeners = listeners.filter((x) => x !== cb));
    },
    request(mode: string) {
      assert.equal(mode, "full");
      session.builds++;
      const emit = (e: string) => setTimeout(() => listeners.forEach((l) => l(e)), 0);
      const engine = detectEngine(readFileSync(o.root, "utf8"), dirname(o.root), "auto");
      const compiler = new Compiler(o.root, () => ({ binDir: o.binDir!, engine, outDir: outDirFor(o.root), preambleCache: false, shellEscape: false }), {
        onStart: () => {
          session.compiling = "full";
          listeners.forEach((l) => l("start"));
        },
        onResult: (r) => {
          compiler.dispose();
          session.compiling = null;
          session.last = r;
          emit("result");
        },
        onFailure: (e) => {
          compiler.dispose();
          session.compiling = null;
          session.failure = String(e);
          emit("failure");
        },
      });
      compiler.request("full");
    },
  };
  const plugin = {
    settings: { exportFolder: o.exportFolder ?? "", engine: "auto", shellEscape: false },
    app: {
      workspace: {
        getActiveViewOfType: () => view.active,
        getLeavesOfType: () => [],
        on: (name: string, cb: MenuHandler) => (name === "file-menu" && menus.push(cb), {}),
      },
      vault: {
        adapter: {
          write: async (path: string, data: string) => void writes.push({ path, data }),
          exists: async (path: string) => folders.includes(path),
          mkdir: async (path: string) => void folders.push(path),
        },
      },
    },
    addCommand: (c: { id: string; checkCallback(checking: boolean): boolean }) => commands.set(c.id, c),
    register: () => undefined,
    registerEvent: () => undefined,
    absolutePath: (path: string) => join(o.vault, path),
    vaultPath: (abs: string) => {
      const rel = relative(o.vault, abs);
      return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : null;
    },
    rootFor: () => o.root,
    texBinDir: () => o.binDir,
    acquireSession: () => session,
    releaseSession: () => undefined,
    sessionFor: () => null,
    texRender: { load: async () => MathJax },
    openLocation: async (abs: string, line: number) => void opened.push([abs, line]),
  };
  return { plugin: plugin as unknown as LatexLivePlugin, settings: plugin.settings, commands, menus, writes, folders, opened, view, session };
}

/** A menu that records its items. */
function menu() {
  const items: { title: string; icon: string; click: () => void }[] = [];
  return {
    items,
    addItem(cb: (item: unknown) => void) {
      const item = { title: "", icon: "", click: () => undefined as void };
      const api = {
        setTitle: (t: string) => ((item.title = t), api),
        setIcon: (i: string) => ((item.icon = i), api),
        onClick: (f: () => void) => ((item.click = f), api),
      };
      cb(api);
      items.push(item);
      return this;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

const quietIo: ExportIo = {
  saveDialog: async () => null,
  write: async () => undefined,
  openPath: async () => undefined,
  showItemInFolder: () => undefined,
};

/** Drive the session events explicitly: no timer stands in for a build generation. */
function controlledBuild(older: "fast" | "full" | null) {
  const listeners = new Set<(event: string) => void>();
  let acquired = 0, released = 0, requested = 0;
  let onRequest = () => undefined as void;
  const session = {
    compiling: older,
    last: null as CompileResult | null,
    failure: null as string | null,
    onEvent(cb: (event: string) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    request(mode: string) {
      assert.equal(mode, "full");
      requested++;
      onRequest();
    },
  };
  const plugin = {
    acquireSession: () => (acquired++, session),
    releaseSession: () => released++,
  } as unknown as LatexLivePlugin;
  const exporter = new HtmlExport(plugin, quietIo);
  const build = (exporter as unknown as { build(root: string, signal: AbortSignal): Promise<CompileResult> }).build.bind(exporter);
  return {
    session, build,
    emit: (event: string) => [...listeners].forEach((cb) => cb(event)),
    counts: () => ({ acquired, released, requested, listeners: listeners.size }),
    request: (cb: () => void) => (onRequest = cb),
  };
}

test("a queued export waits for its full start, rather than the already-running full result", async () => {
  const f = controlledBuild("full");
  let settled = false;
  const pending = f.build("/book/main.tex", new AbortController().signal).then((r) => (settled = true, r));
  const older = { mode: "full" } as CompileResult;
  f.session.last = older;
  f.session.compiling = null;
  f.emit("result");
  await Promise.resolve();
  assert.equal(settled, false, "the request is queued; this result was compiled before it");
  assert.equal(f.counts().released, 0);
  f.session.compiling = "full";
  f.emit("start");
  const current = { mode: "full" } as CompileResult;
  f.session.last = current;
  f.session.compiling = null;
  f.emit("result");
  assert.equal(await pending, current);
  assert.deepEqual(f.counts(), { acquired: 1, released: 1, requested: 1, listeners: 0 });
});

test("an older failure does not satisfy a queued build; the new full failure does", async () => {
  const f = controlledBuild("fast");
  let settled = false;
  const pending = f.build("/book/main.tex", new AbortController().signal);
  void pending.then(() => settled = true, () => settled = true);
  const rejected = assert.rejects(pending, /new full failed/);
  f.session.compiling = null;
  f.session.failure = "older fast failed";
  f.emit("failure");
  await Promise.resolve();
  assert.equal(settled, false);
  f.session.compiling = "full";
  f.emit("start");
  f.session.compiling = null;
  f.session.failure = "new full failed";
  f.emit("failure");
  await rejected;
  assert.deepEqual(f.counts(), { acquired: 1, released: 1, requested: 1, listeners: 0 });
});

test("a synchronous request failure and cancellation release the held session exactly once", async () => {
  for (const older of [null, "full"] as const) {
    const f = controlledBuild(older);
    f.request(() => { f.session.failure = "TeX no longer available"; f.emit("failure"); });
    await assert.rejects(f.build("/book/main.tex", new AbortController().signal), /TeX no longer available/);
    assert.deepEqual(f.counts(), { acquired: 1, released: 1, requested: 1, listeners: 0 });
  }
  const f = controlledBuild("full");
  const controller = new AbortController();
  const pending = f.build("/book/main.tex", controller.signal);
  const rejected = assert.rejects(pending, isAbortError);
  controller.abort();
  f.emit("result");
  await rejected;
  assert.deepEqual(f.counts(), { acquired: 1, released: 1, requested: 1, listeners: 0 });
  const aborted = controlledBuild(null);
  await assert.rejects(aborted.build("/book/main.tex", controller.signal), isAbortError);
  assert.deepEqual(aborted.counts(), { acquired: 0, released: 0, requested: 0, listeners: 0 });
});

test("flush follows current project inputs, bibliography and recorded dependencies outside its folder", async () => {
  const vault = mkdtempSync(join(tmpdir(), "latex-live-export-flush-"));
  cleanups.push(() => rmSync(vault, { recursive: true, force: true }));
  const root = join(vault, "book", "main.tex");
  mkdirSync(dirname(root));
  mkdirSync(join(vault, "shared"));
  const paths = {
    chapter: join(vault, "book", "chapter.tex"),
    added: join(vault, "shared", "added.tex"),
    bib: join(vault, "shared", "refs.bib"),
    recorded: join(vault, "shared", "recorded.sty"),
    sameRoot: join(vault, "shared", "same-root.tex"),
    unrelated: join(vault, "book", "unrelated.tex"),
  };
  const oldRoot = "\\documentclass{article}\n\\begin{document}\n\\input{chapter}\n\\end{document}\n";
  writeFileSync(root, oldRoot);
  const currentRoot = oldRoot.replace("\\input{chapter}", "\\input{chapter}\n\\input{../shared/added}\n\\addbibresource{../shared/refs.bib}");
  const texts = new Map([
    [root, currentRoot], [paths.chapter, "Edited chapter."], [paths.added, "Newly referenced input."],
    [paths.bib, "@book{x,title={Edited bibliography}}"], [paths.recorded, "% Edited recorded dependency."],
    [paths.sameRoot, "% !TeX root = ../book/main.tex\nEdited chapter of this root."],
    [paths.unrelated, "\\documentclass{article}\n\\begin{document}Unrelated unsaved text.\\end{document}"],
  ]);
  for (const [path] of texts) if (path !== root) writeFileSync(path, path === paths.sameRoot ? texts.get(path)! : "Old disk text.");
  writeFileSync(paths.unrelated, "\\documentclass{article}\n\\begin{document}Unrelated disk text.\\end{document}");
  const saved: string[] = [];
  const leaves = [...texts].map(([abs, text]) => ({ view: Object.assign(Object.create(TexView.prototype) as TexView, {
    absolutePath: () => abs,
    getViewData: () => text,
    flush: async () => { saved.push(abs); writeFileSync(abs, text); },
  }) }));
  const plugin = {
    rootFor: (abs: string) => findRoot(abs, vault),
    texBinDir: () => "/dummy/tex/bin",
    settings: { exportFolder: "" },
    sessionFor: () => ({ compiler: { deps: new Set([paths.recorded]) } }),
    app: { workspace: { getLeavesOfType: () => leaves } },
  } as unknown as LatexLivePlugin;
  await new HtmlExport(plugin, quietIo).run(root);
  assert.deepEqual(saved, [root, paths.chapter, paths.added, paths.bib, paths.recorded, paths.sameRoot]);
  assert.equal(readFileSync(paths.added, "utf8"), texts.get(paths.added));
  assert.match(readFileSync(paths.unrelated, "utf8"), /Unrelated disk text/);
});

test("one job per root, and disposal during flush prevents opening a dialog or starting new jobs", async () => {
  let finishSave!: () => void;
  let saving!: () => void;
  const started = new Promise<void>((resolve) => saving = resolve);
  const saved = new Promise<void>((resolve) => finishSave = resolve);
  const root = "/book/main.tex";
  const view = Object.assign(Object.create(TexView.prototype) as TexView, {
    absolutePath: () => root, getViewData: () => "\\documentclass{article}",
    flush: async () => { saving(); await saved; },
  });
  let dialogs = 0;
  const plugin = {
    rootFor: () => root, texBinDir: () => "/dummy/tex/bin", settings: { exportFolder: "" },
    sessionFor: () => null,
    app: { workspace: { getLeavesOfType: () => [{ view }] } },
  } as unknown as LatexLivePlugin;
  const exporter = new HtmlExport(plugin, { ...quietIo, saveDialog: async () => (dialogs++, null) });
  const pending = exporter.run(root);
  await started;
  await exporter.run(root);
  assert.match(notices.at(-1)!, /already exporting main\.tex/);
  exporter.dispose();
  finishSave();
  await pending;
  await exporter.run(root);
  assert.equal(dialogs, 0);
});

test("external HTML replacement preserves the old target on partial writes and cancellation", async () => {
  const vault = mkdtempSync(join(tmpdir(), "latex-live-export-writer-vault-"));
  const outside = mkdtempSync(join(tmpdir(), "latex-live-export-writer-outside-"));
  cleanups.push(() => { rmSync(vault, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const f = await fakePlugin({ vault, root: join(vault, "main.tex"), binDir: null });
  const exporter = registerExport(f.plugin);
  const write = (exporter as unknown as { io: ExportIo }).io.write;
  const target = join(outside, "page.html");
  writeFileSync(target, "old HTML");
  const realWrite = fsp.writeFile;
  try {
    fsp.writeFile = (async (...args: Parameters<typeof fsp.writeFile>) => {
      assert.equal(dirname(String(args[0])), outside, "the temporary file is beside the target");
      await realWrite(args[0], "partially written HTML", args[2]);
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }) as typeof fsp.writeFile;
    await assert.rejects(write(target, "new HTML"), /disk full/);
    assert.equal(readFileSync(target, "utf8"), "old HTML");
    assert.deepEqual(readdirSync(outside), ["page.html"]);
    const controller = new AbortController();
    fsp.writeFile = (async (...args: Parameters<typeof fsp.writeFile>) => {
      await realWrite(...args);
      controller.abort();
    }) as typeof fsp.writeFile;
    await assert.rejects(write(target, "cancelled HTML", controller.signal), isAbortError);
    assert.equal(readFileSync(target, "utf8"), "old HTML");
    assert.deepEqual(readdirSync(outside), ["page.html"]);
  } finally { fsp.writeFile = realWrite; }
  await write(target, "new HTML");
  assert.equal(readFileSync(target, "utf8"), "new HTML");
  assert.deepEqual(readdirSync(outside), ["page.html"]);
});

test("the command and the context menu; the dialog's proposal: exportFolder, the last target; cancel; a failed build", async () => {
  const vault = mkdtempSync(join(tmpdir(), "latex-live-export-cmd-"));
  const root = join(vault, "notes", "main.tex");
  cleanups.push(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outDirFor(root), { recursive: true, force: true });
    rmSync(exportDirFor(outDirFor(root)), { recursive: true, force: true });
  });
  mkdirSync(dirname(root));
  writeFileSync(root, "\\documentclass{article}\n\\begin{document}\nText.\n\\end{document}\n");
  const f = await fakePlugin({ vault, root, binDir: "/no/tex/bin" });
  const dialogs: string[] = [];
  let answer: string | null | undefined = null;
  const writes: string[] = [];
  const exporter = registerExport(f.plugin, {
    saveDialog: async (proposed) => (dialogs.push(proposed), answer),
    write: async (abs) => void writes.push(abs),
    openPath: async () => undefined,
    showItemInFolder: () => undefined,
  });
  // Offered in a LaTeX editor of a .tex file only.
  const cmd = f.commands.get("export-html")!;
  assert.equal(cmd.checkCallback(true), false);
  f.view.active = { absolutePath: () => join(vault, "notes", "macros.sty") };
  assert.equal(cmd.checkCallback(true), false);
  f.view.active = { absolutePath: () => root };
  assert.equal(cmd.checkCallback(true), true);
  // The context menu of a .tex file (not of other files) exports its document.
  const other = menu();
  f.menus[0](other, new TFile("notes/refs.bib"));
  assert.deepEqual(other.items, []);
  const tex = menu();
  f.menus[0](tex, new TFile("notes/chapter.tex"));
  assert.deepEqual(tex.items.map((i) => `${i.title}|${i.icon}`), ["Export to HTML|file-output"]);
  // Cancelled: nothing is written, no progress.
  const shown = notices.length;
  tex.items[0].click();
  for (let i = 0; i < 50 && dialogs.length < 1; i++) await tick();
  await tick();
  assert.deepEqual(dialogs, [join(vault, "notes", "main.html")]);
  assert.deepEqual(notices.slice(shown), []);
  // The exportFolder setting (vault-relative); an answered dialog's file is proposed again in this session.
  f.settings.exportFolder = "/exports/html/";
  assert.equal(exporter.proposed(root), join(vault, "exports", "html", "main.html"));
  answer = join(vault, "out", "book.html");
  await exporter.run(root);
  assert.equal(exporter.proposed(root), answer);
  assert.match(notices.at(-1)!, /^LaTeX Live: HTML export failed: .*\/no\/tex\/bin\/latexmk ENOENT/);
  assert.deepEqual(writes, []);
  // No dialog (no Electron `remote`): the proposed file, with a Notice.
  answer = undefined;
  await exporter.run(root);
  assert.equal(dialogs.at(-1), join(vault, "out", "book.html"));
  assert.ok(notices.includes(`LaTeX Live: no save dialog here; exporting to ${join(vault, "out", "book.html")}.`));
  // Without TeX: the Notice the preview gives, no dialog.
  const none = await fakePlugin({ vault, root, binDir: null });
  let asked = false;
  await registerExport(none.plugin, { saveDialog: async () => ((asked = true), null) }).run(root);
  assert.equal(asked, false);
  assert.match(notices.at(-1)!, /no TeX installation found/);
});

test(
  "a real export through the command: written through the vault adapter, Open, Reveal, the report and its located item",
  { skip: texBin ? false : "no TeX installation found", timeout: 180_000 },
  async () => {
    const { dir, root } = fixtureCopy("export-article");
    const build = outDirFor(root);
    cleanups.push(() => {
      rmSync(build, { recursive: true, force: true });
      rmSync(exportDirFor(build), { recursive: true, force: true });
    });
    // A reference the .aux lacks: a warning with its place.
    const intro = join(dir, "sections", "intro.tex");
    writeFileSync(intro, readFileSync(intro, "utf8").replace(/\n$/, "") + "\nSee \\ref{no:such}.\n");
    const line = readFileSync(intro, "utf8").split("\n").findIndex((l) => l.includes("no:such")) + 1;
    // MathJax's fonts, from its font URL (Obsidian's fetch of app://obsidian.md/...): node_modules here.
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      fetched.push(String(url).replace(/^.*\//, ""));
      return new Response(readFileSync(join(process.cwd(), "node_modules", "mathjax", "es5", "output", "chtml", "fonts", "woff-v2", String(url).replace(/^.*\//, ""))));
    }) as typeof fetch;
    cleanups.push(() => (globalThis.fetch = realFetch));
    const f = await fakePlugin({ vault: dir, root, binDir: texBin!, exportFolder: "exports" });
    const opens: string[] = [];
    const reveals: string[] = [];
    const exporter = registerExport(f.plugin, {
      saveDialog: async (proposed) => proposed,
      openPath: async (abs) => void opens.push(abs),
      showItemInFolder: (abs) => void reveals.push(abs),
    });
    await exporter.run(root);
    const done = shownNotices.at(-1)!;
    assert.match(done.noticeEl.textContent!, /^LaTeX Live: Exported main\.html \(\d+ KB, [\d.]+ s\): 3 TeX fragments, 1 warning\./);
    assert.equal(f.session.builds, 1, "a stale build folder: one full build through the root's session");
    // Written through the vault adapter into the exportFolder, which was made.
    assert.deepEqual(f.folders, ["exports"]);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].path, "exports/main.html");
    assert.match(f.writes[0].data, /^<!doctype html>\n<html lang="en">/);
    assert.match(f.writes[0].data, /<b>Notation\.<\/b>/, "the custom text environment is selectable HTML");
    assert.ok(fetched.length > 0 && fetched.every((n) => n.endsWith(".woff")), "MathJax's fonts fetched from its font URL");
    const report = JSON.parse(readFileSync(join(exportDirFor(build), "report.json"), "utf8")) as ExportReport;
    assert.equal(report.output, join(dir, "exports", "main.html"));
    const buttons = [...done.noticeEl.querySelectorAll("button")];
    assert.deepEqual(buttons.map((b) => b.textContent), ["Open", "Reveal", "Report"]);
    buttons[0].click();
    buttons[1].click();
    assert.deepEqual([opens, reveals], [[report.output], [report.output]]);
    // The report: by severity; the located warning opens its file at the line.
    buttons[2].click();
    const modal = modals.at(-1)!;
    assert.ok(modal.isOpen);
    assert.equal(modal.titleEl.textContent, "HTML export: main.html");
    const text = modal.contentEl.textContent!;
    assert.match(text, /Warnings \(1\)sections\/intro\.tex:\d+\[ref\] \\ref\{no:such\}: not in the \.aux/);
    assert.match(text, /Notes \(\d+\)/);
    const row = modal.contentEl.querySelector<HTMLElement>(".ll-problem.is-warning.is-clickable")!;
    row.click();
    await tick();
    assert.deepEqual(f.opened, [[intro, line]]);
    assert.equal(modal.isOpen, false);
    assert.ok(existsSync(join(exportDirFor(build), "report.json")));
  },
);
