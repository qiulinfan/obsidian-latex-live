import { promises as fsp, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { basename, dirname, extname, join, relative, resolve } from "path";
import { App, Modal, Notice, TFile, loadPrism } from "obsidian";
import { TexView, VIEW_TYPE_TEX } from "../editor/texView";
import type LatexLivePlugin from "../main";
import { pdfPagePngs } from "../preview/pdfRenderer";
import { outDirFor } from "../session";
import type { CompileResult } from "../tex/compiler";
import { bibFiles } from "../tex/bib";
import { projectDefinitions } from "../tex/macros";
import { detectEngine } from "../tex/project";
import { abortError, isAbortError } from "../tex/run";
import { exportDirFor, exportHtml, type ExportHost, type ExportProgress } from "./exporter";
import type { MathEnv } from "./math";
import { prismTokenizer } from "./listings";
import { formatBytes, reportSummary, type ExportReport, type ReportItem } from "./report";

// "Export to HTML" (design 6): the Obsidian side of the export, from the command palette or a
// .tex file's context menu. Saves the project's open editors, asks where to write (Electron's save
// dialog through `remote`, proposing the last target of the root in this session, else
// `<exportFolder or the root's folder>/<root>.html`), runs exportHtml with a progress Notice that
// can cancel it, builds through the root's session when the build folder is stale, and writes the
// page (through the vault adapter inside the vault, else the file system; missing folders made).
// The completion Notice opens the page (Electron's shell), reveals it in the file manager, or shows
// the report: its items by severity, a location opening the file at the line. One export per root
// at a time; unloading the plugin cancels them all.

/** Electron's `remote` as Obsidian exposes it (only what the export uses). */
interface ElectronRemote {
  dialog: {
    showSaveDialog(
      window: unknown,
      options: { defaultPath: string; filters: { name: string; extensions: string[] }[]; properties: string[] },
    ): Promise<{ canceled: boolean; filePath?: string }>;
  };
  getCurrentWindow(): unknown;
}

/** Where the command meets the desktop: a wrapper tests replace. */
export interface ExportIo {
  /**
   * The file to write, `defaultPath` proposed; null when cancelled; `undefined` when there is no
   * dialog (the default path is used, with a Notice).
   */
  saveDialog(defaultPath: string): Promise<string | null | undefined>;
  /** Write the page (the plugin's writer: the vault adapter inside the vault, else fs). */
  write(abs: string, data: string, signal?: AbortSignal): Promise<void>;
  /** Open a file with its application (the page in the browser): Electron's shell.openPath. */
  openPath(abs: string): Promise<void>;
  /** Show a file in the system's file manager: Electron's shell.showItemInFolder. */
  showItemInFolder(abs: string): void;
}

/** Electron's `shell` as Obsidian exposes it (only what the export uses). */
interface ElectronShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

function electronShell(): ElectronShell | null {
  try {
    return (require("electron") as { shell?: ElectronShell }).shell ?? null;
  } catch {
    return null;
  }
}

/** The desktop's save dialog, through Obsidian's Electron `remote`. */
export function electronSaveDialog(defaultPath: string): Promise<string | null | undefined> {
  let remote: ElectronRemote | undefined;
  try {
    remote = (require("electron") as { remote?: ElectronRemote }).remote;
  } catch {
    remote = undefined;
  }
  if (!remote?.dialog) return Promise.resolve(undefined);
  return remote.dialog
    .showSaveDialog(remote.getCurrentWindow(), {
      defaultPath,
      filters: [{ name: "HTML", extensions: ["html"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    })
    .then((r) => (r.canceled || !r.filePath ? null : r.filePath));
}

/** The plugin's writer: a vault file through the adapter (Obsidian sees it), anything else through fs; missing folders made. */
function vaultWriter(plugin: LatexLivePlugin): ExportIo["write"] {
  return async (abs, data, signal) => {
    const check = () => {
      if (signal?.aborted) throw abortError("The export was cancelled.");
    };
    check();
    const rel = plugin.vaultPath(abs);
    if (rel === null) {
      await fsp.mkdir(dirname(abs), { recursive: true });
      const temporary = join(dirname(abs), `.${basename(abs)}.${randomUUID()}.tmp`);
      try {
        await fsp.writeFile(temporary, data, { encoding: "utf8", flag: "wx", signal });
        check();
        // A failed or cancelled write leaves an existing target intact. The rename is the
        // commit point, on the same filesystem as the target.
        await fsp.rename(temporary, abs);
      } finally {
        await fsp.rm(temporary, { force: true }).catch(() => undefined);
      }
      return;
    }
    const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const { adapter } = plugin.app.vault;
    if (folder && !(await adapter.exists(folder))) await adapter.mkdir(folder);
    check();
    await adapter.write(rel, data);
  };
}

/** The desktop's defaults: the save dialog, the plugin's writer, Electron's shell (a Notice without one). */
function desktopIo(plugin: LatexLivePlugin): ExportIo {
  return {
    saveDialog: electronSaveDialog,
    write: vaultWriter(plugin),
    openPath: async (abs) => {
      const error = await (electronShell()?.openPath(abs) ?? Promise.resolve("Electron's shell is not available"));
      if (error) new Notice(`LaTeX Live: could not open ${basename(abs)}: ${error}`);
    },
    showItemInFolder: (abs) => electronShell()?.showItemInFolder(abs),
  };
}

/** Register the command and the .tex files' context menu entry; `io` replaces the dialog, writer and shell (tests). */
export function registerExport(plugin: LatexLivePlugin, io?: Partial<ExportIo>): HtmlExport {
  const exporter = new HtmlExport(plugin, { ...desktopIo(plugin), ...io });
  plugin.addCommand({
    id: "export-html",
    name: "Export to HTML",
    checkCallback: (checking) => {
      const view = plugin.app.workspace.getActiveViewOfType(TexView);
      const abs = view?.absolutePath();
      if (!view || !abs || extname(abs) !== ".tex") return false;
      if (!checking) void exporter.run(abs);
      return true;
    },
  });
  plugin.registerEvent(
    plugin.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "tex") return;
      menu.addItem((item) =>
        item
          .setTitle("Export to HTML")
          .setIcon("file-output")
          .onClick(() => void exporter.run(plugin.absolutePath(file.path))),
      );
    }),
  );
  plugin.register(() => exporter.dispose());
  return exporter;
}

export class HtmlExport {
  /** The running export of each root. */
  private jobs = new Map<string, AbortController>();
  /** The file each root was last exported to in this session (the dialog proposes it again). */
  private targets = new Map<string, string>();
  private disposed = false;

  constructor(
    private plugin: LatexLivePlugin,
    private io: ExportIo,
  ) {}

  /** Export the document `file` belongs to. */
  async run(file: string): Promise<void> {
    if (this.disposed) return;
    const plugin = this.plugin;
    const root = plugin.rootFor(file);
    if (this.jobs.has(root)) {
      new Notice(`LaTeX Live: already exporting ${basename(root)}.`);
      return;
    }
    const binDir = plugin.texBinDir();
    if (!binDir) {
      new Notice("LaTeX Live: no TeX installation found. Install MacTeX/TeX Live or set the TeX binary directory in settings.", 10000);
      return;
    }
    const controller = new AbortController();
    this.jobs.set(root, controller);
    let progress: Notice | null = null;
    try {
      await this.flush(root);
      if (controller.signal.aborted) return;
      const proposed = this.proposed(root);
      let target = await this.io.saveDialog(proposed);
      if (target === null) return;
      if (target === undefined) {
        target = proposed;
        new Notice(`LaTeX Live: no save dialog here; exporting to ${proposed}.`);
      }
      this.targets.set(root, target);
      if (controller.signal.aborted) return;
      progress = this.progressNotice(controller);
      const show = (p: ExportProgress) => this.setProgress(progress!, `Export to HTML: ${p.message}…`, controller);
      const buildDir = outDirFor(root);
      const host: ExportHost = {
        binDir,
        engine: detectEngine(readFileSync(root, "utf8"), dirname(root), plugin.settings.engine),
        shellEscape: plugin.settings.shellEscape,
        buildDir,
        workDir: exportDirFor(buildDir),
        build: (signal) => this.build(root, signal),
        math: () => this.math(),
        code: async () => prismTokenizer(await loadPrism()),
        // PDF images and \includepdf pages through Obsidian's pdf.js, at 2x.
        pdfImages: async (abs, want, signal) => pdfPagePngs(new Uint8Array(await fsp.readFile(abs, { signal })), want, 2, signal),
        idle: () => new Promise((r) => window.setTimeout(r, 0)),
      };
      const { html, report } = await exportHtml(root, host, show, controller.signal);
      if (controller.signal.aborted) throw abortError("The export was cancelled.");
      const writing = Date.now();
      await this.io.write(target, html, controller.signal);
      report.timings.write = Date.now() - writing;
      report.output = target;
      await fsp.writeFile(join(host.workDir, "report.json"), JSON.stringify(report, null, 1)).catch(() => undefined);
      progress.hide();
      this.done(report);
    } catch (err) {
      progress?.hide();
      if (isAbortError(err) || controller.signal.aborted) new Notice("LaTeX Live: HTML export cancelled.");
      else new Notice(`LaTeX Live: HTML export failed: ${err instanceof Error ? err.message : String(err)}`, 10000);
    } finally {
      this.jobs.delete(root);
    }
  }

  /**
   * The file the dialog proposes: the root's last target in this session, else `<root>.html` in the
   * exportFolder setting's vault folder, else next to the root.
   */
  proposed(root: string): string {
    const last = this.targets.get(root);
    if (last) return last;
    const name = `${basename(root, extname(root))}.html`;
    const folder = this.plugin.settings.exportFolder.trim().replace(/^\/+|\/+$/g, "");
    return folder ? join(this.plugin.absolutePath(folder), name) : join(dirname(root), name);
  }

  /** The completion Notice: the summary, Open (the page in the browser), Reveal (in the file manager), Report. */
  private done(report: ExportReport): void {
    const frag = document.createDocumentFragment();
    frag.createSpan({ text: `LaTeX Live: ${reportSummary(report, basename(report.output))}.` });
    const buttons = frag.createDiv({ cls: "ll-export-actions" });
    const button = (text: string, act: () => void) =>
      buttons.createEl("button", { text }).addEventListener("click", (e) => {
        e.stopPropagation();
        act();
      });
    button("Open", () => void this.io.openPath(report.output));
    button("Reveal", () => this.io.showItemInFolder(report.output));
    button("Report", () => new ExportReportModal(this.plugin.app, report, this.plugin, this.io).open());
    new Notice(frag, 15000);
  }

  /** Cancel every running export (plugin unload). */
  dispose(): void {
    this.disposed = true;
    for (const c of this.jobs.values()) c.abort();
    this.jobs.clear();
  }

  /** Save the project's open editors: the export reads the files. */
  private async flush(root: string): Promise<void> {
    const views: { view: TexView; abs: string }[] = [];
    const buffers = new Map<string, string>();
    for (const { view } of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TEX)) {
      const abs = view instanceof TexView ? view.absolutePath() : null;
      if (view instanceof TexView && abs) {
        views.push({ view, abs });
        buffers.set(abs, view.getViewData());
      }
    }
    // Follow the current buffers too: a newly typed \input or bibliography can point outside
    // the root's folder, and a sibling project in that folder must not be saved incidentally.
    const files = projectDefinitions(root, buffers).files;
    const dependencies = new Set(files.map((file) => resolve(file)));
    const sources = files.map((file) => {
      try { return buffers.get(file) ?? readFileSync(file, "utf8"); } catch { return ""; }
    });
    for (const file of bibFiles(sources, dirname(root))) dependencies.add(resolve(file));
    for (const file of this.plugin.sessionFor(root)?.compiler.deps ?? []) dependencies.add(resolve(file));
    for (const { view, abs } of views) {
      if (dependencies.has(resolve(abs)) || resolve(this.plugin.rootFor(abs)) === resolve(root)) await view.flush();
    }
  }

  /**
   * A full build through the root's session (latexmk with a working biber, as "Full build"), which
   * the export holds meanwhile: the result of a full build that starts after the request. A session
   * only the export held is disposed on release, which kills its processes when cancelled.
   */
  private build(root: string, signal: AbortSignal): Promise<CompileResult> {
    if (signal.aborted) return Promise.reject(abortError("The export was cancelled."));
    const session = this.plugin.acquireSession(root);
    return new Promise<CompileResult>((resolve, reject) => {
      let done = false;
      let fullStarted = false;
      let requesting = false;
      const olderRun = session.compiling !== null;
      const finish = (settle: () => void) => {
        if (done) return;
        done = true;
        off();
        signal.removeEventListener("abort", onAbort);
        this.plugin.releaseSession(session);
        settle();
      };
      const off = session.onEvent((e) => {
        if (e === "start" && session.compiling === "full") fullStarted = true;
        // An already running full build can finish after request() queued our full build.
        // Its result (or failure) belongs to older sources; wait for the next full start.
        else if (e === "result" && fullStarted && session.last?.mode === "full" && !session.compiling) finish(() => resolve(session.last!));
        else if (e === "failure" && (fullStarted || requesting || !olderRun)) finish(() => reject(new Error(session.failure ?? "The build failed.")));
      });
      const onAbort = () => finish(() => reject(abortError("The export was cancelled.")));
      signal.addEventListener("abort", onAbort);
      requesting = true;
      try { session.request("full"); }
      catch (err) { finish(() => reject(err)); }
      finally { requesting = false; }
    });
  }

  /** Obsidian's MathJax (loaded once through TexRender) and its woff files from MathJax's own fontURL. */
  private async math(): Promise<MathEnv> {
    const mj = await this.plugin.texRender.load();
    if (!mj) throw new Error("MathJax could not be loaded.");
    const url = (mj.startup?.output as { font?: { options?: { fontURL?: string } } } | undefined)?.font?.options?.fontURL;
    // The DOM document MathJax started on (Obsidian's main window): its handler takes no other.
    const own = (mj.startup as { document?: { document?: Document } } | undefined)?.document?.document;
    return {
      mj,
      document: own ?? document,
      font: async (file, signal) => {
        const res = await fetch(`${url}/${file}`, { signal });
        if (!res.ok) throw new Error(`${file}: ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      },
    };
  }

  private progressNotice(controller: AbortController): Notice {
    const notice = new Notice("Export to HTML…", 0);
    this.setProgress(notice, "Export to HTML: starting…", controller);
    return notice;
  }

  /** The progress message with a Cancel button. */
  private setProgress(notice: Notice, message: string, controller: AbortController): void {
    const frag = document.createDocumentFragment();
    frag.createSpan({ text: message });
    const cancel = frag.createEl("button", { text: "Cancel", cls: "ll-export-cancel" });
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      controller.abort();
      notice.setMessage("Export to HTML: cancelling…");
    });
    notice.setMessage(frag);
  }
}

const SEVERITIES: readonly { key: ReportItem["severity"]; title: string }[] = [
  { key: "error", title: "Errors" },
  { key: "warning", title: "Warnings" },
  { key: "info", title: "Notes" },
];

/**
 * The export's report (design 6): the file, its size and timings, then every item by severity; an
 * item with a place in the vault opens that file at its line (plugin.openLocation).
 */
export class ExportReportModal extends Modal {
  constructor(
    app: App,
    private report: ExportReport,
    private plugin: Pick<LatexLivePlugin, "openLocation" | "vaultPath">,
    private io: Pick<ExportIo, "openPath" | "showItemInFolder">,
  ) {
    super(app);
  }

  onOpen(): void {
    const r = this.report;
    this.titleEl.setText(`HTML export: ${basename(r.output)}`);
    this.modalEl.addClass("ll-export-report");
    const { contentEl } = this;
    contentEl.empty();
    const total = Object.values(r.timings).reduce((a, b) => a + b, 0);
    const stages = Object.entries(r.timings).filter(([, ms]) => ms > 0).map(([stage, ms]) => `${stage} ${ms} ms`);
    const c = r.counts;
    contentEl.createEl("p", { cls: "ll-export-summary", text: `${r.output} · ${formatBytes(r.bytes)} · ${r.engine}, profile ${r.profile} · ${(total / 1000).toFixed(1)} s (${stages.join(", ")})` });
    contentEl.createEl("p", {
      cls: "ll-export-summary",
      text: `${c.headings ?? 0} headings, ${c.math ?? 0} formulas, ${c.theorems ?? 0} theorems, ${c.fragments ?? 0} TeX fragments, ${c.images ?? 0} images, ${c.bibitems ?? 0} bibliography entries`,
    });
    const actions = contentEl.createDiv({ cls: "ll-export-actions" });
    actions.createEl("button", { text: "Open" }).addEventListener("click", () => void this.io.openPath(r.output));
    actions.createEl("button", { text: "Reveal" }).addEventListener("click", () => this.io.showItemInFolder(r.output));
    if (!r.items.length) contentEl.createEl("p", { text: "Nothing fell back: every construct is on the page as TeX numbered it." });
    for (const { key, title } of SEVERITIES) {
      const items = r.items.filter((i) => i.severity === key);
      if (!items.length) continue;
      contentEl.createEl("h4", { text: `${title} (${items.length})` });
      const list = contentEl.createDiv({ cls: "ll-problem-list" });
      for (const item of items) {
        const row = list.createDiv({ cls: `ll-problem is-${key}` });
        const rel = item.file ? this.plugin.vaultPath(item.file) : null;
        const where = item.file ? `${rel ?? relative(dirname(r.output), item.file)}${item.line ? `:${item.line}` : ""}` : item.kind;
        row.createSpan({ cls: "ll-problem-where", text: where });
        row.createSpan({ cls: "ll-problem-msg", text: `${item.file ? `[${item.kind}] ` : ""}${item.message}${item.count && item.count > 1 ? ` (×${item.count})` : ""}` });
        if (item.file && rel !== null) {
          row.addClass("is-clickable");
          row.addEventListener("click", () => {
            this.close();
            void this.plugin.openLocation(item.file!, item.line ?? 1);
          });
        }
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
