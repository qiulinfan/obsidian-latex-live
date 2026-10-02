import { Compartment, EditorState, Extension } from "@codemirror/state";
import { EditorView, Tooltip } from "@codemirror/view";
import { statSync } from "fs";
import { dirname, resolve } from "path";
import {
  Component,
  MarkdownRenderer,
  Notice,
  Scope,
  TFile,
  TextFileView,
  ViewStateResult,
  WorkspaceLeaf,
  setIcon,
  setTooltip,
} from "obsidian";
import type LatexLivePlugin from "../main";
import type { EditingMode } from "../settings";
import { Definitions, emptyDefinitions, projectDefinitions } from "../tex/macros";
import { includeName, preambleFiles } from "../tex/project";
import { latexCompletionSource } from "./latexCompletion";
import { applyEditorAppearance } from "./editorAppearance";
import { latexFolding } from "./latexFolding";
import { proseSpelling } from "./proseTools";
import { invalidateProjectOutline } from "./projectOutline";
import { latexLiveLanguage } from "./latexLive";
import { latexTooltipPortal, refreshLatexTooltipAppearance, theoremGraphHover } from "./theoremGraphView";
import {
  EditorEphemeralState,
  applyEphemeralState,
  getEphemeralState,
  registerEditorScope,
  setDocText,
  showSearch,
} from "./shared/editorKit";
import { LIVE_MAX_LINES, LiveLanguage, isLive, livePreview, livePreviewCompartment } from "./shared/livePreview";
import { LspCompletionBackend, LspRange, lspPosToOffset, offsetToLspPos } from "./shared/lspCompletion";
import { showTexDiagnostics, texEditorExtensions } from "./texExtensions";

export const VIEW_TYPE_TEX = "latex-live-editor";

const PROJECT_TTL_MS = 5000;
const PACKAGE_EXTENSIONS = new Set(["sty", "cls"]);

/** The header action in each mode: the icon and title of the switch to the other mode. */
const MODE_ACTION: Record<EditingMode, [icon: string, title: string]> = {
  source: ["book-open", "Switch to live preview"],
  live: ["code", "Switch to source mode"],
};

/**
 * Package, class and bibliography files are code and data, and so are the files the root reads
 * before \begin{document} (preambleFiles): live preview finds no constructs there.
 */
const NO_CONSTRUCTS: LiveLanguage = { scan: () => [], decorate: () => {} };
const DATA_EXTENSIONS = new Set([...PACKAGE_EXTENSIONS, "bib"]);
// A theme change tells CM to discard cached font metrics even when a short document's
// min-height hides the resize. Reuse two empty themes instead of accumulating new styles.
const APPEARANCE_THEMES = [EditorView.theme({}), EditorView.theme({})];

export class TexView extends TextFileView {
  private editor: EditorView | null = null;
  private saveTimer: number | null = null;
  private cursorTimer: number | null = null;
  /** Ephemeral state that arrived before the editor existed. */
  private pendingEState: EditorEphemeralState | null = null;
  /** The path this view has open on texlab. */
  private lspPath: string | null = null;
  /** Set while an external file change is applied (it needs no save). */
  private applyingExternal = false;
  /** A save was skipped because an IME composition was open; compositionend reschedules it. */
  private saveAfterComposition = false;
  /** Last committed text: theorem cards never read a pending IME composition. */
  private committedData = "";
  /** The file uses CRLF line breaks (CodeMirror keeps LF); saves write them back. */
  private crlf = false;
  private project: { abs: string; at: number; root: string; defs: Definitions } | null = null;
  /**
   * Source or live preview. Kept in the view state (a restart restores it); a new view starts
   * in the `editingMode` setting, and a file opened in this view keeps it.
   */
  private mode: EditingMode;
  private readonly modeAction: HTMLElement;
  /** Waiting for MathJax before live preview mounts (texRender.preload). */
  private preloading = false;
  private appearanceAfterComposition = false;
  private readonly appearanceCompartment = new Compartment();
  private appearanceTheme = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: LatexLivePlugin,
  ) {
    super(leaf);
    // Obsidian's global hotkeys would otherwise eat these keys (Markdown-only commands).
    this.scope = new Scope(this.app.scope);
    registerEditorScope(this.scope, () => this.editor, {
      bold: ["\\textbf{", "}"],
      italic: ["\\emph{", "}"],
      togglePreview: () => this.plugin.togglePreview(this),
    });
    this.mode = plugin.settings.editingMode;
    // Actions are prepended: the mode switch ends up right of the preview's eye.
    this.modeAction = this.addAction(...MODE_ACTION[this.mode], () => this.toggleMode());
    this.addAction("eye", "Open LaTeX preview", () => {
      void this.plugin.openPreview(this);
    });
  }

  getViewType(): string {
    return VIEW_TYPE_TEX;
  }

  getDisplayText(): string {
    return this.file?.name ?? "LaTeX";
  }

  getIcon(): string {
    return "sigma";
  }

  /** The CodeMirror view (commands, YOLO). */
  get editorView(): EditorView | null {
    return this.editor;
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), mode: this.mode };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const mode = (state as { mode?: unknown } | null)?.mode;
    // Before the file loads, so its editor mounts in the mode; an open editor switches below.
    if (mode === "source" || mode === "live") this.mode = mode;
    await super.setState(state, result);
    this.applyMode();
  }

  /**
   * The header action and the "Toggle live preview" command. Documents over LIVE_MAX_LINES
   * lines stay in source mode. Only livePreviewCompartment is reconfigured: the text, the
   * selection, the scroll position and the undo history stay.
   */
  toggleMode(): void {
    if (this.mode === "source" && this.editor && this.editor.state.doc.lines > LIVE_MAX_LINES) {
      new Notice(`LaTeX Live: live preview is off for documents over ${LIVE_MAX_LINES.toLocaleString("en-US")} lines.`);
      return;
    }
    this.mode = this.mode === "live" ? "source" : "live";
    this.applyMode();
    this.app.workspace.requestSaveLayout();
  }

  getViewData(): string {
    if (!this.editor) return this.data;
    const text = this.editor.state.doc.toString();
    return this.crlf ? text.replace(/\n/g, "\r\n") : text;
  }

  getCommittedText(): string {
    return this.committedData;
  }

  /** A project transaction already saved this text through Vault.process's CAS boundary. */
  acceptProjectData(data: string): void {
    if (this.editor?.compositionStarted) throw new Error("Finish composing before applying a project edit.");
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saveAfterComposition = false;
    this.setViewData(data, false);
  }

  /** Typography changes are local styles, preserving selection, history and unsaved text. */
  applyAppearance(): void {
    if (this.editor?.compositionStarted) { this.appearanceAfterComposition = true; return; }
    this.appearanceAfterComposition = false;
    const before = this.contentEl.style.cssText;
    applyEditorAppearance(this.contentEl, this.plugin.settings);
    if (this.editor) {
      if (before !== this.contentEl.style.cssText) {
        this.appearanceTheme = 1 - this.appearanceTheme;
        this.editor.dispatch({ effects: this.appearanceCompartment.reconfigure(APPEARANCE_THEMES[this.appearanceTheme]) });
      }
      refreshLatexTooltipAppearance(this.editor);
      this.editor.requestMeasure();
    }
  }

  setViewData(data: string, clear: boolean): void {
    this.applyAppearance();
    this.data = data;
    if (!this.editor || clear) this.committedData = data.replace(/\r\n?/g, "\n");
    this.plugin.theoremGraphs?.invalidate();
    // CodeMirror joins lines with LF; keep a CRLF file CRLF (its first line break decides),
    // so opening and switching away never rewrites it.
    this.crlf = /^[^\n]*\r\n/.test(data);
    if (!this.editor) {
      this.contentEl.addClass("ll-editor-content", "lsp-cm-view");
      this.editor = new EditorView({ state: this.stateFor(data), parent: this.contentEl });
      if (this.plugin.settings.hoverRender) void this.plugin.texRender.load();
      this.openOnServer();
      if (this.pendingEState) applyEphemeralState(this.editor, this.pendingEState);
      this.pendingEState = null;
      this.applyMode();
      this.rereadRefs();
    } else if (clear) {
      this.editor.setState(this.stateFor(data));
      this.openOnServer();
      this.applyMode();
      this.rereadRefs();
    } else {
      // External change (another editor, git, an agent): a minimal diff keeps the cursor,
      // the scroll position and the undo history (F4).
      this.applyingExternal = true;
      try {
        setDocText(this.editor, data);
      } finally {
        this.applyingExternal = false;
      }
    }
    this.refreshDiagnostics();
  }

  clear(): void {
    this.flushTimers();
  }

  async onUnloadFile(file: TFile): Promise<void> {
    if (this.editor) this.plugin.histories.save(file.path, this.editor.state);
    this.closeOnServer();
    await super.onUnloadFile(file);
  }

  async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    this.closeOnServer();
    this.openOnServer();
    // The root (or the kind of file) may have changed with the path.
    const editor = this.editor;
    const live = editor && isLive(editor.state) ? this.liveExtension() : null;
    if (editor && live) editor.dispatch({ effects: livePreviewCompartment.reconfigure(live) });
  }

  async onClose(): Promise<void> {
    this.flushTimers();
    if (this.editor && this.file) this.plugin.histories.save(this.file.path, this.editor.state);
    this.closeOnServer();
    this.editor?.destroy();
    this.editor = null;
    await super.onClose();
  }

  getEphemeralState(): Record<string, unknown> {
    const st = super.getEphemeralState();
    return this.editor ? { ...st, ...getEphemeralState(this.editor) } : st;
  }

  setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    const st = state as EditorEphemeralState | null;
    if (this.editor) applyEphemeralState(this.editor, st);
    else this.pendingEState = st;
  }

  /** Obsidian's "Search current file" (Mod-F) calls this. */
  showSearch(replace = false): void {
    if (this.editor) showSearch(this.editor, replace);
  }

  /** Absolute filesystem path of the open file, or null. */
  absolutePath(): string | null {
    return this.file ? this.plugin.absolutePath(this.file.path) : null;
  }

  /** 1-based line and 0-based column of the main cursor. */
  cursor(): { line: number; column: number } | null {
    if (!this.editor) return null;
    const head = this.editor.state.selection.main.head;
    const line = this.editor.state.doc.lineAt(head);
    return { line: line.number, column: head - line.from };
  }

  /** Move the cursor to a 1-based line, scroll it into view, and focus. */
  revealLine(line: number, column = 0): void {
    if (!this.editor) return;
    const doc = this.editor.state.doc;
    const target = doc.line(Math.min(Math.max(line, 1), doc.lines));
    const pos = target.from + Math.min(Math.max(column, 0), target.length);
    this.editor.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    this.editor.focus();
  }

  /**
   * Never writes uncommitted IME text (Pinyin before a candidate is picked): the vault
   * modify event would compile it (F8/F11). Obsidian's own debounced save comes here too.
   */
  async save(clear?: boolean): Promise<void> {
    if (!clear && this.editor?.compositionStarted) {
      this.saveAfterComposition = true;
      return;
    }
    this.saveAfterComposition = false;
    await super.save(clear);
  }

  /** Save now, skipping the debounce (compile-now command). */
  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
  }

  /** The last compile's diagnostics for this file into the editor (the full set, every time). */
  refreshDiagnostics(): void {
    const path = this.absolutePath();
    if (!path || !this.editor) return;
    showTexDiagnostics(this.editor, this.plugin.diagnosticsFor(path));
  }

  /**
   * Bring the editor and the header action to `this.mode`. Live preview mounts once MathJax is
   * preloaded (the editor shows source until then) and never over LIVE_MAX_LINES lines (the
   * mode falls back to source).
   */
  private applyMode(): void {
    const editor = this.editor;
    if (editor && this.mode === "live" && editor.state.doc.lines > LIVE_MAX_LINES) this.mode = "source";
    const [icon, title] = MODE_ACTION[this.mode];
    setIcon(this.modeAction, icon);
    setTooltip(this.modeAction, title);
    if (!editor) return;
    const live = this.mode === "live";
    if (live !== isLive(editor.state)) {
      const ext = live ? this.liveExtension() : [];
      if (ext) editor.dispatch({ effects: livePreviewCompartment.reconfigure(ext) });
      else this.preload();
    }
    const shown = isLive(editor.state);
    this.contentEl.toggleClass("is-live-preview", shown);
    if (shown) this.plugin.texRender.stylesFor(editor.dom.ownerDocument);
  }

  /** Live preview for this file's root, or null until MathJax is preloaded. */
  private liveExtension(): Extension | null {
    const project = this.projectInfo();
    const render = this.plugin.texRender;
    if (!project || !render.ready) return null;
    const { root, abs } = project;
    const code = DATA_EXTENSIONS.has(this.file?.extension ?? "") || preambleFiles(root).has(resolve(abs));
    const language = code
      ? NO_CONSTRUCTS
      : latexLiveLanguage({
          refs: () => render.refsOf(root),
          file: includeName(root, abs),
          image: (path) => render.imageOf(root, path),
          crop: (doc, from, to, kind) => render.cropOf(root, abs, doc, from, to, kind),
        });
    return livePreview({ language, renderer: render.rendererFor(root) });
  }

  /**
   * A document opened here: its root's labels and bibliography are read again (a compile may
   * have run elsewhere since), so chips work without the preview open (design 4.5).
   */
  private rereadRefs(): void {
    const root = this.projectInfo()?.root;
    if (root && !DATA_EXTENSIONS.has(this.file?.extension ?? "")) this.plugin.texRender.opened(root);
  }

  /** Load and warm up MathJax, then mount live preview (design 3.7). */
  private preload(): void {
    const root = this.projectInfo()?.root;
    if (!root || this.preloading) return;
    this.preloading = true;
    void this.plugin.texRender.preload(root).then((ok) => {
      this.preloading = false;
      if (!ok && this.mode === "live") {
        new Notice("LaTeX Live: MathJax is not available, so live preview stays off.");
        this.mode = "source";
      }
      this.applyMode();
    });
  }

  /** The editor state for `data`: the cached one (with undo history) if the text matches. */
  private stateFor(data: string): EditorState {
    const extensions = this.extensions(data);
    const key = this.file?.path;
    return (
      (key && this.plugin.histories.restore(key, data, { extensions })) ||
      EditorState.create({ doc: data, extensions })
    );
  }

  private extensions(data: string) {
    const plugin = this.plugin;
    const backend: LspCompletionBackend = {
      triggerCharacters: () => plugin.texlab.triggerCharacters(),
      request: (pos, context, state) => {
        const abs = this.absolutePath();
        return abs ? plugin.texlab.completion(abs, state.doc, pos, context) : Promise.resolve(null);
      },
      resolve: (item) => plugin.texlab.resolve(item),
    };
    return texEditorExtensions({
      text: data,
      inline: () => plugin.yolo.inline,
      yolo: plugin.yolo.extension(() => this.file?.name ?? null),
      completion: latexCompletionSource(backend, {
        definitions: () => this.definitions(),
        renderInfo: (doc) => this.renderMarkdown(doc.value, doc.kind === "plaintext"),
        bib: this.file?.extension === "bib",
        isFolder: (path) => this.isFolder(path),
        citations: () => {
          const root = this.projectInfo()?.root;
          return root && plugin.bibliographies ? plugin.bibliographies.load(root) : Promise.resolve([]);
        },
      }),
      onEdit: (view, changes, startDoc) => {
        this.committedData = view.state.doc.toString();
        plugin.theoremGraphs.invalidate();
        const abs = this.absolutePath();
        if (abs) {
          plugin.texlab.change(abs, view.state.doc, changes, startDoc);
          plugin.texRender.edited(abs, changes, startDoc, view.state.doc);
          plugin.bibliographies?.edited(abs, changes, startDoc, view.state.doc);
        }
        invalidateProjectOutline(plugin);
        if (!this.applyingExternal) this.onEdited();
      },
      onCursor: () => this.onCursorMoved(),
      diagnostics: true,
      // The mode's content of livePreviewCompartment, also for HistoryCache.restore.
      live: this.mode === "live" ? (this.liveExtension() ?? []) : [],
      hover: {
        // Documents only: package and class files are code, their `$` rarely pair as math.
        enabled: () => plugin.settings.hoverRender && !PACKAGE_EXTENSIONS.has(this.file?.extension ?? ""),
        target: (state, pos) => {
          const root = this.projectInfo()?.root;
          return root ? plugin.texRender.hoverTarget(state.doc, pos, root) : null;
        },
        render: (target, view) => {
          const project = this.projectInfo();
          return project ? plugin.texRender.hover(target, view, project.root, project.abs) : null;
        },
        lsp: (view, pos) => this.lspHover(view, pos),
        // The formula being typed, rendered below it (setting-gated; MathJax alone).
        cursor: {
          enabled: () => plugin.settings.cursorPreview && !PACKAGE_EXTENSIONS.has(this.file?.extension ?? ""),
          render: (math, view) => {
            const root = this.projectInfo()?.root;
            return root ? plugin.texRender.preview(math, view, root) : null;
          },
        },
      },
      extensions: [
        DATA_EXTENSIONS.has(this.file?.extension ?? "") ? [] : latexFolding,
        proseSpelling,
        this.appearanceCompartment.of(APPEARANCE_THEMES[this.appearanceTheme]),
        latexTooltipPortal(),
        theoremGraphHover({
          load: (view, key, signal) => {
            const project = this.projectInfo();
            return project && !DATA_EXTENSIONS.has(this.file?.extension ?? "")
              ? plugin.theoremGraphs.load(project.root, key, signal)
              : Promise.resolve(null);
          },
          renderContent: (view, node, signal) => plugin.theoremGraphs.content(node, view.dom.ownerDocument, signal),
          openSource: (source) => void plugin.openLocation(source.file, source.line),
          subscribe: (_view, onChange) => plugin.theoremGraphs.subscribe(onChange),
        }),
        EditorView.domEventHandlers({
          compositionend: () => {
            if (this.saveAfterComposition) this.scheduleSave();
            if (this.appearanceAfterComposition) queueMicrotask(() => this.applyAppearance());
            return false;
          },
        }),
      ],
      keys: [{ key: "F12", run: () => (void this.goToDefinition(), true) }],
    });
  }

  private onEdited(): void {
    // requestSave marks the view dirty, so Obsidian merges external changes instead of
    // dropping unsaved text. The short debounce saves for the compile: the vault modify
    // event drives recompilation of every previewed document that depends on this file.
    this.requestSave();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, this.plugin.settings.debounceMs);
  }

  private onCursorMoved(): void {
    if (!this.plugin.settings.followCursor) return;
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null;
      void this.plugin.syncPreviewToCursor(this, true);
    }, 250);
  }

  private flushTimers(): void {
    if (this.cursorTimer !== null) {
      window.clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
    }
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.save();
    }
  }

  private openOnServer(): void {
    const abs = this.absolutePath();
    if (!this.editor || !abs || abs === this.lspPath) return;
    this.closeOnServer();
    this.lspPath = abs;
    this.plugin.texlab.open(abs, this.editor.state.doc);
  }

  private closeOnServer(): void {
    if (this.lspPath) this.plugin.texlab.close(this.lspPath);
    this.lspPath = null;
  }

  /** The root document and the project's definitions (re-read every few seconds). */
  private projectInfo(): { abs: string; root: string; defs: Definitions } | null {
    const abs = this.absolutePath();
    if (!abs) return null;
    const now = Date.now();
    if (!this.project || this.project.abs !== abs || now - this.project.at > PROJECT_TTL_MS) {
      const root = this.plugin.rootFor(abs);
      this.project = { abs, at: now, root, defs: projectDefinitions(root) };
    }
    return this.project;
  }

  /** Macros, colors and environments defined across the project. */
  private definitions(): Definitions {
    return this.projectInfo()?.defs ?? emptyDefinitions();
  }

  /**
   * Whether a file argument's path names a folder. texlab lists paths from the root
   * document's folder; this file's own folder is checked too.
   */
  private isFolder(path: string): boolean {
    const p = this.projectInfo();
    if (!p) return false;
    return [p.root, p.abs].some((file) => {
      try {
        return statSync(resolve(dirname(file), path)).isDirectory();
      } catch {
        return false;
      }
    });
  }

  /** Completion docs and hovers through Obsidian's Markdown renderer. */
  private renderMarkdown(text: string, plain = false): { dom: HTMLElement; destroy?: () => void } {
    const dom = document.createElement("div");
    dom.className = "ll-lsp-doc markdown-rendered";
    if (plain) {
      dom.textContent = text;
      dom.classList.add("lsp-completion-info");
      return { dom };
    }
    const component = new Component();
    component.load();
    void MarkdownRenderer.render(this.app, text, dom, this.file?.path ?? "", component);
    return { dom, destroy: () => component.unload() };
  }

  /** texlab hover: symbols (as glyphs), packages, citations, labels. */
  private async lspHover(view: EditorView, pos: number): Promise<Tooltip | null> {
    const abs = this.absolutePath();
    if (!abs || this.plugin.texlab.status !== "running") return null;
    let hv: LspHover | null;
    try {
      hv = (await this.plugin.texlab.hover(abs, view.state.doc, offsetToLspPos(view.state.doc, pos))) as LspHover | null;
    } catch {
      return null;
    }
    const md = hoverText(hv?.contents);
    if (!md) return null;
    const from = hv?.range ? lspPosToOffset(view.state.doc, hv.range.start) : pos;
    const to = hv?.range ? lspPosToOffset(view.state.doc, hv.range.end) : pos;
    return {
      pos: from,
      end: to,
      above: true,
      create: () => this.renderMarkdown(md.value, md.plain),
    };
  }

  /** F12: open the definition of the command, label or citation under the cursor. */
  private async goToDefinition(): Promise<void> {
    const abs = this.absolutePath();
    const view = this.editor;
    if (!abs || !view) return;
    const doc = view.state.doc;
    const locs = await this.plugin.texlab.definition(abs, doc, offsetToLspPos(doc, view.state.selection.main.head));
    const loc = locs[0];
    if (loc) await this.plugin.openLocation(loc.path, loc.line + 1);
  }
}

interface LspHover {
  contents?: unknown;
  range?: LspRange;
}

/** LSP hover contents as markdown (or plain text). */
function hoverText(contents: unknown): { value: string; plain: boolean } | null {
  const one = (c: unknown): string =>
    typeof c === "string" ? c : c && typeof c === "object" && "value" in c ? String((c as { value: unknown }).value) : "";
  const value = (Array.isArray(contents) ? contents.map(one).join("\n\n") : one(contents)).trim();
  if (!value) return null;
  const plain = !!contents && typeof contents === "object" && (contents as { kind?: string }).kind === "plaintext";
  return { value, plain };
}
