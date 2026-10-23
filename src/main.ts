import { startCompletion } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
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
  normalizePath,
} from "obsidian";
import { HistoryCache, syncDarkTheme } from "./editor/shared/editorKit";
import { isLive, renderStats } from "./editor/shared/livePreview";
import { YoloBridge } from "./editor/shared/yoloBridge";
import type { MathJaxLike } from "./editor/mathjaxProject";
import type { SuiteConfig } from "./editor/suiteSnippets";
import type { ClickText } from "./editor/reveal";
import { API_READY_EVENT, ExternalExtensions } from "./editor/externalExtensions";
import { TexRender } from "./editor/texRender";
import { parseTemplateProfiles, type TemplateVisualizationProfile } from "./editor/templateVisualization";
import { TemplateVisualizationModal } from "./editor/templateVisualizationModal";
import { TheoremGraphs } from "./editor/theoremGraphs";
import { Bibliographies } from "./editor/bibliographies";
import { registerBibliography } from "./editor/bibliographyView";
import { registerProseTools } from "./editor/proseTools";
import { registerProjectOutline } from "./editor/projectOutline";
import { registerProjectOperations } from "./editor/projectOperations";
import { registerNewTexFile } from "./editor/newTexFile";
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
import { lineWords } from "./preview/syncText";

const TEX_EXTENSIONS = ["tex", "sty", "cls", "ltx", "bib"];

export default class LatexLivePlugin extends Plugin {
  settings: LatexLiveSettings = DEFAULT_SETTINGS;
  /** Undo history of recently closed files (restored on reopen). */
  readonly histories = new HistoryCache();
  /** Extensions other plugins added to the `.tex` editors (registerTexEditorExtension). */
  readonly externalEditorExtensions = new ExternalExtensions(() =>
    this.texViews().flatMap((v) => (v.editorView ? [v.editorView] : [])),
  );
  yolo!: YoloBridge;
  texlab!: TexlabServer;
  /** Project math for hover rendering (one private MathJax instance per root). */
  texRender!: TexRender;
  /** Source-backed proof references and lazy statement/proof cards for each open project. */
  theoremGraphs!: TheoremGraphs;
  bibliographies!: Bibliographies;
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
  private templateModals = new Set<TemplateVisualizationModal>();
  private visualizationKey = "";
  private unloading = false;
  private templateSaving = false;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.visualizationKey = this.visualizationSettingsKey();
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
      visualization: root => this.visualizationProfile(root),
    });
    this.theoremGraphs = new TheoremGraphs({
      buffers: () => this.editorBuffers(true),
      outDirFor,
      prepareMath: () => this.texRender.load(),
      math: (root, src, display, doc, defs, refs) => this.texRender.sourceMath(root, src, display, doc, defs, refs).outerHTML,
      pdfImages: async (abs, want, signal) => pdfPagePngs(new Uint8Array(await readFile(abs, { signal })), want, 2, signal),
    });
    this.bibliographies = new Bibliographies(() => this.editorBuffers(true));

    this.registerView(VIEW_TYPE_TEX, (leaf) => new TexView(leaf, this));
    this.registerView(VIEW_TYPE_PREVIEW, (leaf) => new LatexPreviewView(leaf, this));
    this.registerExtensions(TEX_EXTENSIONS, VIEW_TYPE_TEX);

    this.addCommand({ id: "template-visualization", name: "Choose / edit template visualization", callback: () => this.openTemplateVisualizations() });

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
    registerBibliography(this);
    registerProseTools(this);
    registerProjectOutline(this);
    registerProjectOperations(this);
    registerNewTexFile(this);

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
        this.bibliographies.invalidate();
      }),
    );
    // Live preview's images resolve again (a figure saved, deleted or moved). After the layout
    // is ready: the vault's initial scan creates every file.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", () => { this.texRender.filesChanged(); this.theoremGraphs.invalidate(); this.bibliographies.invalidate(); }));
      this.registerEvent(this.app.vault.on("delete", () => { this.texRender.filesChanged(); this.theoremGraphs.invalidate(); this.bibliographies.invalidate(); }));
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
    this.app.workspace.trigger(API_READY_EVENT, this);
  }

  /**
   * Public API: add a CodeMirror 6 extension to every open and later latex-live `.tex` editor
   * (view type `latex-live-editor`, its own EditorView, which Obsidian's registerEditorExtension
   * never reaches). It comes after latex-live's own extensions, so their keymaps keep precedence
   * unless the caller wraps it in `Prec`. The returned disposer removes it from every editor; it
   * is idempotent and a no-op after latex-live unloads, which removes every registered extension.
   * After each load and reload, latex-live triggers the workspace event `"latex-live:api-ready"`
   * (API_READY_EVENT) with this plugin, so a plugin that loaded earlier can register again.
   * See docs/editor-extension-api.md.
   */
  registerTexEditorExtension(extension: Extension): () => void {
    return this.externalEditorExtensions.register(extension);
  }

  onunload(): void {
    this.unloading = true;
    this.externalEditorExtensions.dispose();
    for (const modal of this.templateModals) modal.close();
    this.templateModals.clear();
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    this.yolo.destroy();
    this.crops.dispose();
    this.fragments.dispose();
    this.texRender.dispose();
    this.theoremGraphs.dispose();
    this.bibliographies.invalidate();
    window.clearTimeout(this.restartTimer);
    void this.texlab.dispose();
  }

  async saveSettings(): Promise<void> {
    this.binDir = undefined;
    for (const view of this.texViews()) view.applyAppearance();
    await this.saveData(this.settings);
    const visualizationKey = this.visualizationSettingsKey();
    if (visualizationKey !== this.visualizationKey) {
      this.visualizationKey = visualizationKey;
      this.texRender.refreshVisualizations();
    }
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

  private visualizationSettingsKey(): string {
    return JSON.stringify([this.settings.templateVisualizations, this.settings.templateAssignments]);
  }

  private visualizationProfile(root: string): TemplateVisualizationProfile | null {
    const key = this.vaultPath(root);
    const id = key ? this.settings.templateAssignments?.[key] : null;
    return id && Array.isArray(this.settings.templateVisualizations)
      ? this.settings.templateVisualizations.find(p => p?.id === id) ?? null : null;
  }

  openTemplateVisualizations(): void {
    if (this.unloading) return;
    const active = this.app.workspace.activeLeaf?.view;
    const abs = active instanceof TexView && active.file?.extension === "tex" ? active.absolutePath() : null;
    const root = abs ? this.rootFor(abs) : active instanceof LatexPreviewView ? active.root : null;
    const key = root ? this.vaultPath(root) : null;
    const expected = this.visualizationSettingsKey();
    let profiles: TemplateVisualizationProfile[];
    try { profiles = parseTemplateProfiles(this.settings.templateVisualizations); }
    catch (error) { new Notice(`Template visualization: ${error instanceof Error ? error.message : String(error)}`); return; }
    const modal = new TemplateVisualizationModal({
      app: this.app, profiles, selected: key ? this.settings.templateAssignments?.[key] ?? "auto" : "auto", project: key,
      save: async (profiles, selected) => {
        if (this.unloading) throw new Error("LaTeX Live was unloaded. Reopen the dialog after loading the plugin.");
        if (this.templateSaving) throw new Error("Template settings are being saved. Try again after the current save finishes.");
        if (this.visualizationSettingsKey() !== expected) throw new Error("Template settings changed while this dialog was open. Reopen it to preserve the newer settings.");
        const valid = parseTemplateProfiles(profiles), ids = new Set(valid.map(p => p.id));
        if (selected !== "auto" && !ids.has(selected)) throw new Error("Choose a saved profile or Automatic.");
        const assignments = Object.fromEntries(Object.entries(this.settings.templateAssignments ?? {}).filter(([, id]) => ids.has(id)));
        if (key) { if (selected === "auto") delete assignments[key]; else assignments[key] = selected; }
        // Save before changing the live configuration, so a failed write retains the old view.
        this.templateSaving = true;
        try {
          await this.saveData({ ...this.settings, templateVisualizations: valid, templateAssignments: assignments });
          this.settings.templateVisualizations = valid;
          this.settings.templateAssignments = assignments;
          this.visualizationKey = this.visualizationSettingsKey();
          if (!this.unloading) this.texRender.refreshVisualizations();
        } finally { this.templateSaving = false; }
      },
      closed: () => this.templateModals.delete(modal),
    });
    this.templateModals.add(modal); modal.open();
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
    // SyncTeX preserves the filesystem spelling; Obsidian indexes NFC paths. Normalize
    // only at this vault boundary, including a decomposed spelling of the vault itself.
    const rel = relative(base.normalize("NFC"), abs.normalize("NFC"));
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      return null;
    }
    const normalized = normalizePath(rel.split(sep).join("/"));
    // Host normalization also treats backslashes as separators. Keep that from turning
    // a POSIX filename into a path that escapes the vault.
    return !normalized || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)
      ? null : normalized;
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
  editorBuffers(committed = false): Map<string, string> {
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
    // The line's words correct SyncTeX's box in the PDF's text (syncText.ts).
    const words = lineWords(cur.text, cur.column);
    for (const leaf of this.previewLeaves()) {
      const pv = leaf.view as LatexPreviewView;
      if (pv.root === root) pv.reveal(box, onlyIfHidden, words);
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

  /**
   * LaTeX Suite's snippets and their settings, from its `CMSettings` (rebuilt by LaTeX Suite when
   * its settings or snippet files change), or null when the setting is off or the plugin is not
   * enabled. Read at every key.
   */
  suiteSnippetConfig(): SuiteConfig | null {
    if (!this.settings.latexSuiteSnippets) return null;
    const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
    const cm = (plugins?.["obsidian-latex-suite"] as { CMSettings?: Record<string, any> } | undefined)?.CMSettings;
    if (!cm || !cm.snippetsEnabled || !Array.isArray(cm.snippets?.all)) return null;
    return {
      snippets: cm.snippets.all,
      trigger: String(cm.snippetsTrigger ?? "Tab"),
      wordDelimiters: String(cm.wordDelimiters ?? ""),
      removeWhitespace: !!cm.removeSnippetWhitespace,
      suppressOnIME: cm.suppressSnippetTriggerOnIME !== false,
      recursion: Number(cm.snippetRecursion) || 0,
      textMacros: Array.isArray(cm.mathlessMacros?.all) ? cm.mathlessMacros.all : [],
    };
  }

  /**
   * Open a vault file in the LaTeX editor at a 1-based line. `click`, the word double-clicked in
   * the PDF, places the cursor on it near that line (TexView.revealLine).
   */
  async openLocation(abs: string, line: number, column = 0, click?: ClickText): Promise<void> {
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
    if (leaf.view instanceof TexView) leaf.view.revealLine(line, column, click);
  }

  private editorLeaf(): WorkspaceLeaf {
    const tex = this.app.workspace.getLeavesOfType(VIEW_TYPE_TEX)[0];
    if (tex) return tex;
    const recent = this.app.workspace.getMostRecentLeaf();
    return recent && !(recent.view instanceof LatexPreviewView)
      ? recent
      : this.app.workspace.getLeaf("tab");
  }

  texViews(): TexView[] {
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
    void this.bibliographies.fileModified(abs);
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
