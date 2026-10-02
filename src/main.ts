import { startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { readFile } from "fs/promises";
import { isAbsolute, join, relative, sep } from "path";
import {
  FileSystemAdapter,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
  finishRenderMath,
  loadMathJax,
} from "obsidian";
import { HistoryCache, syncDarkTheme } from "./editor/shared/editorKit";
import { isLive, renderStats } from "./editor/shared/livePreview";
import { YoloBridge } from "./editor/shared/yoloBridge";
import type { MathJaxLike } from "./editor/mathjaxProject";
import { TexRender } from "./editor/texRender";
import { TheoremGraphs } from "./editor/theoremGraphs";
import { TexView, VIEW_TYPE_TEX } from "./editor/texView";
import { registerExport } from "./export/command";
import { TexlabServer, resolveTexlab, texlabSettings } from "./lsp/texlab";
import { CropService } from "./preview/blockCrop";
import { FragmentService } from "./preview/fragments";
import { openPdf, pdfPageImage, pdfPagePngs } from "./preview/pdfRenderer";
import { LatexPreviewView, VIEW_TYPE_PREVIEW } from "./preview/previewView";
import { LatexSession, SessionEvent, outDirFor } from "./session";
import {
  DEFAULT_SETTINGS,
  LatexLiveSettings,
  LatexLiveSettingTab,
} from "./settings";
import { resolveTexBinDir, texEnv } from "./tex/binaries";
import { TexDiagnostic } from "./tex/logParser";
import { findRoot } from "./tex/project";
import { forwardSearch, inverseSearch, SourceLocation } from "./tex/synctex";

const TEX_EXTENSIONS = ["tex", "sty", "cls", "ltx", "bib"];

export default class LatexLivePlugin extends Plugin {
  settings: LatexLiveSettings = DEFAULT_SETTINGS;
  /** Undo history of recently closed files (restored on reopen). */
  readonly histories = new HistoryCache();
  yolo!: YoloBridge;
  texlab!: TexlabServer;
  /** Project math for hover rendering (one private MathJax instance per root). */
  texRender!: TexRender;
  /** Source-backed proof references and lazy statement/proof cards for each open project. */
  theoremGraphs!: TheoremGraphs;
  /** PDF crops of blocks from the previewed sessions' last compiles (hover and live preview). */
  crops!: CropService;
  /** Fragment compiles for the hover: what MathJax and the crops cannot show (design 4.7). */
  fragments!: FragmentService;
  private sessions = new Map<string, LatexSession>();
  private binDir: string | null | undefined;
  private texlabBin: string | null | undefined;
  /** The settings texlab was started with; a change restarts it. */
  private texlabKey = "";
  private restartTimer: number | undefined;
  /** Root document of the active editor; texlab reads its .aux from that output folder. */
  private activeRoot: string | null = null;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.yolo = new YoloBridge(this.app, {
      name: "latex-live",
      enabled: () => this.settings.yoloTabCompletion,
    });
    this.texlabKey = this.texlabSettingsKey();
    this.texlab = new TexlabServer({
      binary: () => this.texlabPath(),
      root: this.vaultBase() ?? process.cwd(),
      env: () => {
        // Obsidian's PATH has no TeX: put the compiler's distribution first (CR-11).
        const bin = this.texBinDir();
        return bin ? texEnv(bin) : process.env;
      },
      settings: () => texlabSettings(this.activeRoot ? outDirFor(this.activeRoot) : null),
    });

    this.crops = new CropService({
      session: (root) => this.sessionFor(root),
      binDir: () => this.texBinDir(),
      openPdf,
      inverted: () => this.invertsPaper(),
      document,
    });
    this.fragments = new FragmentService({
      binDir: () => this.texBinDir(),
      engineSetting: () => this.settings.engine,
      preambleCache: () => this.settings.preambleCache,
      outDirFor,
      buffers: () => this.editorBuffers(),
      openPdf,
      inverted: () => this.invertsPaper(),
      document,
    });
    this.texRender = new TexRender({
      outDirFor,
      buffers: () => this.editorBuffers(),
      documents: () => new Set(this.texViews().map((v) => v.containerEl.ownerDocument)),
      mathJax: {
        load: loadMathJax,
        global: () => (window as unknown as { MathJax?: MathJaxLike }).MathJax,
        finish: finishRenderMath,
        document,
      },
      images: {
        url: (abs) => {
          const rel = this.vaultPath(abs);
          return rel === null ? null : this.app.vault.adapter.getResourcePath(rel);
        },
        // pdf.js refuses a Buffer: a Uint8Array copy.
        pdfPage: async (abs, maxHeight) => pdfPageImage(new Uint8Array(await readFile(abs)), maxHeight, window.devicePixelRatio || 1),
      },
      crops: this.crops,
      fragments: this.fragments,
      fragmentFallback: () => this.settings.texFragmentFallback,
    });
    this.theoremGraphs = new TheoremGraphs({
      buffers: () => this.editorBuffers(true),
      outDirFor,
      prepareMath: () => this.texRender.load(),
      math: (root, src, display, doc, defs, refs) => this.texRender.sourceMath(root, src, display, doc, defs, refs).outerHTML,
      pdfImages: async (abs, want, signal) => pdfPagePngs(new Uint8Array(await readFile(abs, { signal })), want, 2, signal),
    });

    this.registerView(VIEW_TYPE_TEX, (leaf) => new TexView(leaf, this));
    this.registerView(VIEW_TYPE_PREVIEW, (leaf) => new LatexPreviewView(leaf, this));
    this.registerExtensions(TEX_EXTENSIONS, VIEW_TYPE_TEX);

    this.addCommand({
      id: "open-preview",
      name: "Open preview",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TexView);
        if (!view?.file) return false;
        if (!checking) void this.openPreview(view);
        return true;
      },
    });
    this.addCommand({
      id: "compile",
      name: "Compile now",
      checkCallback: (checking) => this.withSession(checking, "fast"),
    });
    this.addCommand({
      id: "full-build",
      name: "Full build with latexmk (BibTeX/Biber, all passes)",
      checkCallback: (checking) => this.withSession(checking, "full"),
    });
    this.addCommand({
      id: "show-in-preview",
      name: "Show cursor position in preview",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TexView);
        if (!view?.file) return false;
        if (!checking) void this.syncPreviewToCursor(view, false);
        return true;
      },
    });

    this.addCommand({
      id: "toggle-live-preview",
      name: "Toggle live preview",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TexView);
        if (!view?.file) return false;
        if (!checking) view.toggleMode();
        return true;
      },
    });
    // For measurements (design 3.8): only offered in a live editor.
    this.addCommand({
      id: "show-render-statistics",
      name: "Show render statistics",
      checkCallback: (checking) => {
        const editor = this.app.workspace.getActiveViewOfType(TexView)?.editorView;
        if (!editor || !isLive(editor.state)) return false;
        if (!checking) {
          const s = renderStats(editor);
          new Notice(
            `LaTeX Live render statistics: ${s.renders} renders (p50 ${s.p50} ms, p95 ${s.p95} ms), ` +
              `${s.hits} cache hits, ${s.misses} misses, ${s.pending} pending; ` +
              `${s.builds} decoration builds (p50 ${s.buildP50} ms, p95 ${s.buildP95} ms).`,
            15000,
          );
        }
        return true;
      },
    });

    registerExport(this);

    this.addCommand({
      id: "trigger-completion",
      name: "Trigger completion",
      checkCallback: (checking) => this.withEditor(checking, (v) => startCompletion(v)),
    });
    this.addCommand({
      id: "trigger-ai-completion",
      name: "Trigger AI completion (YOLO)",
      checkCallback: (checking) => {
        if (!this.settings.yoloTabCompletion) return false;
        return this.withEditor(checking, (v) => {
          if (!this.yolo.triggerNow(v)) new Notice(`LaTeX Live: no AI completion here (${this.yolo.describe()}).`);
        });
      },
    });
    this.addCommand({
      id: "restart-texlab",
      name: "Restart texlab",
      callback: () => void this.restartTexlab(),
    });

    this.addSettingTab(new LatexLiveSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("modify", (f) => this.onModified(f)));
    this.registerEvent(
      this.app.vault.on("rename", (f, old) => {
        this.histories.rename(old, f.path);
        this.texRender.filesChanged();
        this.theoremGraphs.invalidate();
      }),
    );
    // Live preview's images resolve again (a figure saved, deleted or moved). After the layout
    // is ready: the vault's initial scan creates every file.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", () => { this.texRender.filesChanged(); this.theoremGraphs.invalidate(); }));
      this.registerEvent(this.app.vault.on("delete", () => { this.texRender.filesChanged(); this.theoremGraphs.invalidate(); }));
    });
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => this.onActiveLeaf(leaf)),
    );
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        this.refreshPreviews();
        this.theoremGraphs.invalidate();
        for (const v of this.texViews()) if (v.editorView) syncDarkTheme(v.editorView);
      }),
    );
  }

  onunload(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    this.yolo.destroy();
    this.crops.dispose();
    this.fragments.dispose();
    this.texRender.dispose();
    this.theoremGraphs.dispose();
    window.clearTimeout(this.restartTimer);
    void this.texlab.dispose();
  }

  async saveSettings(): Promise<void> {
    this.binDir = undefined;
    for (const view of this.texViews()) view.applyAppearance();
    await this.saveData(this.settings);
    const key = this.texlabSettingsKey();
    if (key !== this.texlabKey) {
      // The binary or its TeX PATH changed: restart once typing in the field pauses.
      this.texlabKey = key;
      this.texlabBin = undefined;
      window.clearTimeout(this.restartTimer);
      this.restartTimer = window.setTimeout(() => void this.texlab.restart(), 1000);
    }
  }

  private texlabSettingsKey(): string {
    return `${this.settings.texlabPath}|${this.settings.texBinDir}`;
  }

  /** The texlab binary (configured or auto-detected), cached until settings change. */
  texlabPath(): string | null {
    if (this.texlabBin === undefined) this.texlabBin = resolveTexlab(this.settings.texlabPath);
    return this.texlabBin;
  }

  async restartTexlab(): Promise<void> {
    this.texlabBin = undefined;
    const ok = (await this.texlab.restart()) && this.texlabPath() !== null;
    new Notice(
      ok
        ? `LaTeX Live: texlab restarted (${this.texlabPath()}).`
        : "LaTeX Live: texlab is not available. Install it (brew install texlab) or set its path in settings.",
    );
  }

  texBinDir(): string | null {
    if (this.binDir === undefined) {
      this.binDir = resolveTexBinDir(this.settings.texBinDir);
    }
    return this.binDir;
  }

  vaultBase(): string | null {
    const a = this.app.vault.adapter;
    return a instanceof FileSystemAdapter ? a.getBasePath() : null;
  }

  absolutePath(vaultPath: string): string {
    return join(this.vaultBase() ?? "", vaultPath);
  }

  /** Vault-relative path for an absolute path inside the vault, else null. */
  vaultPath(abs: string): string | null {
    const base = this.vaultBase();
    if (!base) return null;
    const rel = relative(base, abs);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      return null;
    }
    return rel.split(sep).join("/");
  }

  rootFor(abs: string): string {
    return findRoot(abs, this.vaultBase() ?? abs);
  }

  acquireSession(root: string): LatexSession {
    let s = this.sessions.get(root);
    if (!s) {
      s = new LatexSession(this, root);
      this.sessions.set(root, s);
    }
    s.refs++;
    return s;
  }

  releaseSession(s: LatexSession): void {
    if (--s.refs > 0) return;
    s.dispose();
    this.sessions.delete(s.root);
    this.crops.release(s.root);
    this.fragments.release(s.root);
    this.texRender.cropsChanged(s.root);
    this.refreshDiagnostics();
  }

  /** The session previewing `root`, if a preview holds one (PDF crops need it). */
  sessionFor(root: string): LatexSession | null {
    return this.sessions.get(root) ?? null;
  }

  /** The text of the open LaTeX editors by absolute path (unsaved edits included). */
  private editorBuffers(committed = false): Map<string, string> {
    const out = new Map<string, string>();
    for (const v of this.texViews()) {
      const abs = v.absolutePath();
      if (abs && v.editorView) out.set(abs, committed ? v.getCommittedText() : v.editorView.state.doc.toString());
    }
    return out;
  }

  /** The files open in LaTeX editors (a compile's crop sources). */
  openTexFiles(): string[] {
    const out: string[] = [];
    for (const v of this.texViews()) {
      const abs = v.absolutePath();
      if (abs) out.push(abs);
    }
    return out;
  }

  /** Called by sessions after every event: update editor diagnostics, label numbers and crops. */
  sessionChanged(s: LatexSession, e: SessionEvent): void {
    if (s.last) this.refreshDiagnostics();
    if (e === "result") { this.texRender.compiled(s.root); this.theoremGraphs.invalidate(); }
    // A compile that ended: live crops of its new PDF, or those held back while it ran.
    if (e !== "start") this.texRender.cropsChanged(s.root);
  }

  diagnosticsFor(file: string): TexDiagnostic[] {
    const out: TexDiagnostic[] = [];
    for (const s of this.sessions.values()) out.push(...s.diagnosticsFor(file));
    return out;
  }

  refreshPreviews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PREVIEW)) {
      if (leaf.view instanceof LatexPreviewView) leaf.view.applyTheme();
    }
    // Crops are paper cards: they follow the preview's inversion.
    this.texRender.cropsChanged();
  }

  /** The preview inverts its colours (and crops their paper): the setting, in a dark theme. */
  invertsPaper(): boolean {
    return this.settings.invertPreview === "dark-theme" && document.body.hasClass("theme-dark");
  }

  /** Mod-E in the editor: close the preview if one is open, else open it. */
  togglePreview(view: TexView): void {
    const leaves = this.previewLeaves();
    if (leaves.length) for (const l of leaves) l.detach();
    else void this.openPreview(view);
  }

  async openPreview(view: TexView): Promise<void> {
    const abs = view.absolutePath();
    if (!abs) return;
    if (!this.texBinDir()) {
      new Notice(
        "LaTeX Live: no TeX installation found. Install MacTeX/TeX Live or " +
          "set the TeX binary directory in settings.",
        10000,
      );
    }
    let leaf = this.previewLeaves()[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: VIEW_TYPE_PREVIEW, active: false });
    }
    if (leaf.view instanceof LatexPreviewView) leaf.view.setRoot(this.rootFor(abs));
    void this.app.workspace.revealLeaf(leaf);
  }

  /** Forward SyncTeX: scroll the preview to the editor's cursor. */
  async syncPreviewToCursor(view: TexView, onlyIfHidden: boolean): Promise<void> {
    const abs = view.absolutePath();
    const cur = view.cursor();
    const bin = this.texBinDir();
    if (!abs || !cur || !bin) return;
    const root = this.rootFor(abs);
    const session = this.sessions.get(root);
    if (!session?.last) return;
    const box = await forwardSearch(
      bin,
      session.compiler.pdfPath(),
      abs,
      cur.line,
      cur.column,
    );
    if (!box) return;
    for (const leaf of this.previewLeaves()) {
      const pv = leaf.view as LatexPreviewView;
      if (pv.root === root) pv.reveal(box, onlyIfHidden);
    }
  }

  inverseSearch(
    s: LatexSession,
    page: number,
    x: number,
    y: number,
  ): Promise<SourceLocation | null> {
    const bin = this.texBinDir();
    if (!bin) return Promise.resolve(null);
    return inverseSearch(
      bin,
      s.compiler.pdfPath(),
      page,
      x,
      y,
      s.compiler.rootDir,
      s.compiler.toLogical,
    );
  }

  /** Open a vault file in the LaTeX editor at a 1-based line. */
  async openLocation(abs: string, line: number): Promise<void> {
    const rel = this.vaultPath(abs);
    const file = rel ? this.app.vault.getAbstractFileByPath(rel) : null;
    if (!(file instanceof TFile)) return;
    let leaf =
      this.app.workspace
        .getLeavesOfType(VIEW_TYPE_TEX)
        .find((l) => l.view instanceof TexView && l.view.file?.path === rel) ?? null;
    if (leaf) {
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    } else {
      // Never replace the preview pane itself.
      leaf = this.editorLeaf();
      await leaf.openFile(file);
    }
    if (leaf.view instanceof TexView) leaf.view.revealLine(line);
  }

  private editorLeaf(): WorkspaceLeaf {
    const tex = this.app.workspace.getLeavesOfType(VIEW_TYPE_TEX)[0];
    if (tex) return tex;
    const recent = this.app.workspace.getMostRecentLeaf();
    return recent && !(recent.view instanceof LatexPreviewView)
      ? recent
      : this.app.workspace.getLeaf("tab");
  }

  private texViews(): TexView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_TEX)
      .map((l) => l.view)
      .filter((v): v is TexView => v instanceof TexView);
  }

  /** checkCallback for commands that act on the active LaTeX editor. */
  private withEditor(checking: boolean, run: (view: EditorView) => unknown): boolean {
    const editor = this.app.workspace.getActiveViewOfType(TexView)?.editorView;
    if (!editor) return false;
    if (!checking) run(editor);
    return true;
  }

  private previewLeaves(): WorkspaceLeaf[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_PREVIEW)
      .filter((l) => l.view instanceof LatexPreviewView);
  }

  private withSession(checking: boolean, mode: "fast" | "full"): boolean {
    const view = this.app.workspace.getActiveViewOfType(TexView);
    const abs = view?.absolutePath();
    if (!view || !abs) return false;
    if (checking) return true;
    void (async () => {
      await view.flush();
      const root = this.rootFor(abs);
      const s = this.sessions.get(root);
      if (s) s.request(mode);
      else await this.openPreview(view);
    })();
    return true;
  }

  /** Recompile every previewed document that read the modified file. */
  private onModified(f: TAbstractFile): void {
    if (!(f instanceof TFile)) return;
    const abs = this.absolutePath(f.path);
    this.texRender.fileModified(abs);
    this.theoremGraphs.invalidate();
    for (const s of this.sessions.values()) {
      const deps = s.compiler.deps;
      const fresh = deps.size === 0 && abs.startsWith(s.compiler.rootDir + sep);
      if (abs === s.root || deps.has(abs) || fresh) {
        // Only a full build reruns BibTeX/Biber on a changed bibliography.
        s.request(f.extension === "bib" ? "full" : "fast");
      }
    }
  }

  /** Previews and texlab's output folder follow the document of the active LaTeX editor. */
  private onActiveLeaf(leaf: WorkspaceLeaf | null): void {
    if (!(leaf?.view instanceof TexView)) return;
    const abs = leaf.view.absolutePath();
    if (!abs || !abs.endsWith(".tex")) return;
    const root = this.rootFor(abs);
    if (root !== this.activeRoot) {
      this.activeRoot = root;
      this.texlab.configurationChanged();
    }
    for (const p of this.previewLeaves()) (p.view as LatexPreviewView).setRoot(root);
  }

  private refreshDiagnostics(): void {
    for (const v of this.texViews()) v.refreshDiagnostics();
  }
}
