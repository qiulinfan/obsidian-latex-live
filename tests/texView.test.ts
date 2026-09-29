// TexView's editing modes (design 6) on the test stand-in for Obsidian's TextFileView
// (tests/support/obsidian.ts): the header action, the command's toggle, the view state, the
// line limit, HistoryCache and the refs read at view open, with TexRender over Obsidian's MathJax
// on a temporary copy of the synthetic elegantbook fixture.
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { HistoryCache } from "../src/editor/shared/editorKit";
import { TextWidget, isLive } from "../src/editor/shared/livePreview";
import { YoloBridge } from "../src/editor/shared/yoloBridge";
import { TexRender } from "../src/editor/texRender";
import { TexView } from "../src/editor/texView";
import type LatexLivePlugin from "../src/main";
import type { EditingMode } from "../src/settings";
import { waitFor } from "./support/keyMatrix";
import { obsidianMathJax } from "./support/mathjax";
import { WorkspaceLeaf, notices, testApp } from "./support/obsidian";

/** A TexView over a copy of the fixture book (vault paths are relative to the book). */
async function texView(editingMode: EditingMode = "source") {
  const { window: mw, MathJax } = await obsidianMathJax();
  const dir = mkdtempSync(join(tmpdir(), "ll-view-"));
  const book = join(dir, "book");
  cpSync(resolve("tests/fixtures/elegantbook"), book, { recursive: true });
  const app = testApp();
  for (const f of ["chapters/ch1.tex", "chapters/ch2.tex", "booknotes.sty", "refs.bib"]) app.vault.files.set(f, readFileSync(join(book, f), "utf8"));
  app.vault.files.set("long.tex", "$x$\n".repeat(10_000));
  const texRender = new TexRender({
    outDirFor: () => join(dir, "out"),
    buffers: () => new Map(),
    mathJax: {
      load: async () => {},
      global: () => MathJax,
      finish: async () => {
        const sheet = MathJax.chtmlStylesheet();
        if (!sheet.isConnected) mw.document.head.appendChild(sheet);
      },
      document: mw.document,
    },
  });
  const yolo = new YoloBridge(app as never, { name: "test", enabled: () => false });
  const plugin = {
    app,
    settings: { editingMode, hoverRender: true, debounceMs: 100000, followCursor: false },
    texRender,
    yolo,
    histories: new HistoryCache(),
    texlab: {
      status: "stopped",
      triggerCharacters: () => [],
      completion: async () => null,
      resolve: async (item: unknown) => item,
      open: () => {},
      close: () => {},
      change: () => {},
    },
    absolutePath: (path: string) => join(book, path),
    rootFor: () => join(book, "main.tex"),
    diagnosticsFor: () => [],
    togglePreview: () => {},
    openPreview: async () => {},
    syncPreviewToCursor: async () => {},
  };
  const view = new TexView(new WorkspaceLeaf(app) as never, plugin as unknown as LatexLivePlugin);
  const cm = () => view.editorView!;
  const action = () => view.containerEl.querySelector<HTMLElement>(".view-action:is([data-icon=book-open], [data-icon=code])")!;
  const widgets = () => cm().contentDOM.querySelectorAll(".lsp-lp-render").length;
  const done = async () => {
    await view.onClose();
    yolo.destroy();
    texRender.dispose();
    rmSync(dir, { recursive: true, force: true });
  };
  return { view, app, plugin, cm, action, widgets, out: join(dir, "out"), done };
}

const open = (v: TexView, file: string, mode?: EditingMode) => v.setState(mode ? { file, mode } : { file }, {} as never);
const live = (cm: EditorView) => isLive(cm.state);

test("a new view opens in the editingMode setting; the header action toggles, keeping text, selection and history", async () => {
  const t = await texView("source");
  try {
    await open(t.view, "chapters/ch1.tex");
    assert.deepEqual(t.view.getState(), { file: "chapters/ch1.tex", mode: "source" });
    assert.equal(live(t.cm()), false);
    assert.deepEqual([t.action().dataset.icon, t.action().getAttribute("aria-label")], ["book-open", "Switch to live preview"]);
    assert.deepEqual([...t.action().parentElement!.children].map((a) => (a as HTMLElement).dataset.icon), ["eye", "book-open"], "right of the preview's eye");
    t.cm().dispatch({ changes: { from: 0, insert: "% edit\n" }, selection: { anchor: 3 }, userEvent: "input.type" });
    const before = [t.cm().state.doc.toString(), t.cm().state.selection.main.head, undoDepth(t.cm().state)];

    t.action().click();
    assert.equal(live(t.cm()), false, "MathJax is preloaded before the first live mount");
    await waitFor(() => live(t.cm()));
    await waitFor(() => t.widgets() > 0);
    assert.deepEqual([t.action().dataset.icon, t.action().getAttribute("aria-label")], ["code", "Switch to source mode"]);
    assert.ok(t.view.contentEl.classList.contains("is-live-preview"));
    assert.deepEqual([t.cm().state.doc.toString(), t.cm().state.selection.main.head, undoDepth(t.cm().state)], before);
    assert.equal(t.view.getState().mode, "live");
    assert.equal(t.app.workspace.layoutSaves, 1, "the layout (and the mode) is saved");

    t.view.toggleMode(); // the command
    assert.equal(live(t.cm()), false, "back to source at once");
    assert.equal(t.widgets(), 0);
    assert.ok(!t.view.contentEl.classList.contains("is-live-preview"));
    assert.equal(t.action().dataset.icon, "book-open");
    assert.deepEqual([t.cm().state.doc.toString(), t.cm().state.selection.main.head, undoDepth(t.cm().state)], before);
    assert.deepEqual([t.view.getState().mode, t.app.workspace.layoutSaves], ["source", 2]);
  } finally {
    await t.done();
  }
});

test("the mode comes back from the view state; a file opened in the view keeps the view's mode", async () => {
  const t = await texView("source");
  try {
    await open(t.view, "chapters/ch1.tex", "live"); // a restart: workspace.json holds the mode
    await waitFor(() => live(t.cm()));
    assert.equal(t.view.getState().mode, "live");
    await open(t.view, "chapters/ch2.tex");
    assert.equal(live(t.cm()), true, "mounted live at once (MathJax is ready)");
    await waitFor(() => t.widgets() > 0);
    await open(t.view, "chapters/ch2.tex", "source"); // the same file: the open editor switches
    assert.equal(live(t.cm()), false);
    assert.deepEqual(t.view.getState(), { file: "chapters/ch2.tex", mode: "source" });
    await open(t.view, "booknotes.sty", "live");
    assert.equal(live(t.cm()), true);
    assert.equal(t.widgets(), 0, "package files have no constructs");
  } finally {
    await t.done();
  }
});

test("editingMode live: new views open live; over 10,000 lines a view stays in source and the toggle refuses", async () => {
  const t = await texView("live");
  try {
    assert.equal(t.view.getState().mode, "live");
    await open(t.view, "long.tex");
    assert.deepEqual(t.view.getState(), { file: "long.tex", mode: "source" }, "10,001 lines");
    assert.equal(live(t.cm()), false);
    const shown = notices.length;
    t.view.toggleMode();
    assert.deepEqual(notices.slice(shown), ["LaTeX Live: live preview is off for documents over 10,000 lines."]);
    assert.equal(live(t.cm()), false);
    assert.equal(t.app.workspace.layoutSaves, 0);
  } finally {
    await t.done();
  }
  const u = await texView("live");
  try {
    await open(u.view, "chapters/ch1.tex");
    await waitFor(() => live(u.cm()));
    assert.ok(u.view.contentEl.classList.contains("is-live-preview"));
  } finally {
    await u.done();
  }
});

test("a file reopened in a live view gets its undo history back in live mode (HistoryCache)", async () => {
  const t = await texView("live");
  try {
    await open(t.view, "chapters/ch1.tex");
    await waitFor(() => live(t.cm()));
    t.cm().dispatch({ changes: { from: 0, insert: "% one\n" }, userEvent: "input.type" });
    t.cm().dispatch({ changes: { from: 0, insert: "% two\n" }, userEvent: "input.type" });
    const depth = undoDepth(t.cm().state);
    assert.ok(depth >= 1);
    await open(t.view, "chapters/ch2.tex"); // unloading ch1 saves it and caches its history
    await open(t.view, "chapters/ch1.tex");
    assert.ok(t.cm().state.doc.toString().startsWith("% two\n% one\n"));
    assert.equal(undoDepth(t.cm().state), depth, "restored from HistoryCache");
    assert.equal(live(t.cm()), true, "with the compartment's live content");
    await waitFor(() => t.widgets() > 0);
  } finally {
    await t.done();
  }
});

test("a document opened in a view reads its root's refs again (a compile that ran elsewhere); .bib files have no constructs", async () => {
  const t = await texView("live");
  try {
    cpSync(resolve("tests/fixtures/aux/book"), t.out, { recursive: true }); // an earlier compile
    // From the decorations: jsdom draws a viewport that depends on its (absent) layout.
    const chips = () => {
      const out: string[] = [];
      for (const source of t.cm().state.facet(EditorView.decorations)) {
        const set = typeof source === "function" ? source(t.cm()) : source;
        set.between(0, t.cm().state.doc.length, (_f, _t, d) => {
          const w = d.spec.widget;
          if (w instanceof TextWidget && w.cls.includes("lsp-lp-chip")) out.push(w.text);
        });
      }
      return out;
    };
    await open(t.view, "chapters/ch1.tex");
    await waitFor(() => live(t.cm()) && chips().length > 0);
    assert.deepEqual(chips(), ["chap:prob", "(1.3)", "1.1", "[张三、李四 2020, 第 2 章]", "[Li et al. 2019]"]);
    const aux = join(t.out, "chapters", "ch1.aux");
    writeFileSync(aux, readFileSync(aux, "utf8").replace("{{1.1}{1}{概率与期望}{tcb@cnt@theorem.1.1}", "{{1.7}{1}{概率与期望}{tcb@cnt@theorem.1.7}"));
    await open(t.view, "chapters/ch2.tex");
    await open(t.view, "chapters/ch1.tex");
    await waitFor(() => chips()[2] === "1.7");
    await open(t.view, "refs.bib");
    assert.equal(live(t.cm()), true);
    assert.deepEqual([t.widgets(), chips().length, t.cm().contentDOM.querySelectorAll(".lsp-lp-strong, .lsp-lp-bullet").length], [0, 0, 0]);
  } finally {
    await t.done();
  }
});

test("files the root reads before \\begin{document} (a split preamble) have no constructs; chapters keep theirs", async () => {
  const t = await texView("live");
  try {
    const book = t.plugin.absolutePath("");
    const main = readFileSync(join(book, "main.tex"), "utf8");
    writeFileSync(join(book, "main.tex"), main.replace("\\input{macros}", "\\input{macros}\n\\input{setup/preamble}"));
    const preamble = [
      "\\hypersetup{colorlinks, pdftitle={My $\\alpha$ notes}}",
      "\\setlist[itemize]{label=$\\bullet$}",
      "\\newtcolorbox{keybox}{colback=red!5, title={\\textbf{Key point}}}",
      "\\input{setup/boxes}",
    ].join("\n");
    const boxes = "\\tcbset{fonttitle=\\bfseries, before upper={\\emph{Note:} }}\n\\title{$L^2$ notes}\n";
    mkdirSync(join(book, "setup"));
    writeFileSync(join(book, "setup", "preamble.tex"), preamble);
    writeFileSync(join(book, "setup", "boxes.tex"), boxes);
    t.app.vault.files.set("setup/preamble.tex", preamble);
    t.app.vault.files.set("setup/boxes.tex", boxes);
    const decorated = () => t.widgets() + t.cm().contentDOM.querySelectorAll(".lsp-lp-strong, .lsp-lp-em").length;
    await open(t.view, "setup/preamble.tex");
    await waitFor(() => live(t.cm()));
    assert.equal(decorated(), 0, "preamble.tex");
    await open(t.view, "setup/boxes.tex");
    assert.equal(live(t.cm()), true);
    assert.equal(decorated(), 0, "boxes.tex, input by preamble.tex");
    await open(t.view, "chapters/ch1.tex");
    await waitFor(() => t.widgets() > 0);
  } finally {
    await t.done();
  }
});
