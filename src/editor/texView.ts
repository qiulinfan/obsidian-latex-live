import { Diagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, Tooltip, hoverTooltip } from "@codemirror/view";
import { Component, MarkdownRenderer, Scope, TFile, TextFileView, WorkspaceLeaf } from "obsidian";
import type LatexLivePlugin from "../main";
import type { TexDiagnostic } from "../tex/logParser";
import { Definitions, emptyDefinitions, projectDefinitions } from "../tex/macros";
import { latexCompletionSource } from "./latexCompletion";
import {
  EditorEphemeralState,
  applyEphemeralState,
  getEphemeralState,
  registerEditorScope,
  setDocText,
  showSearch,
} from "./shared/editorKit";
import { LspCompletionBackend, LspRange, lspPosToOffset, offsetToLspPos } from "./shared/lspCompletion";
import { texEditorExtensions } from "./texExtensions";

export const VIEW_TYPE_TEX = "latex-live-editor";

const PROJECT_TTL_MS = 5000;

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
  /** The file uses CRLF line breaks (CodeMirror keeps LF); saves write them back. */
  private crlf = false;
  private project: { abs: string; at: number; defs: Definitions } | null = null;

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

  getViewData(): string {
    if (!this.editor) return this.data;
    const text = this.editor.state.doc.toString();
    return this.crlf ? text.replace(/\n/g, "\r\n") : text;
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    // CodeMirror joins lines with LF; keep a CRLF file CRLF (its first line break decides),
    // so opening and switching away never rewrites it.
    this.crlf = /^[^\n]*\r\n/.test(data);
    if (!this.editor) {
      this.contentEl.addClass("ll-editor-content", "lsp-cm-view");
      this.editor = new EditorView({ state: this.stateFor(data), parent: this.contentEl });
      this.openOnServer();
      if (this.pendingEState) applyEphemeralState(this.editor, this.pendingEState);
      this.pendingEState = null;
    } else if (clear) {
      this.editor.setState(this.stateFor(data));
      this.openOnServer();
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
  revealLine(line: number): void {
    if (!this.editor) return;
    const doc = this.editor.state.doc;
    const pos = doc.line(Math.min(Math.max(line, 1), doc.lines)).from;
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

  refreshDiagnostics(): void {
    const path = this.absolutePath();
    if (!path || !this.editor) return;
    const diags = this.plugin.diagnosticsFor(path);
    this.editor.dispatch(
      setDiagnostics(this.editor.state, toCmDiagnostics(this.editor.state, diags)),
    );
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
      }),
      onEdit: (view, changes, startDoc) => {
        const abs = this.absolutePath();
        if (abs) plugin.texlab.change(abs, view.state.doc, changes, startDoc);
        if (!this.applyingExternal) this.onEdited();
      },
      onCursor: () => this.onCursorMoved(),
      extensions: [
        lintGutter(),
        this.hover(),
        EditorView.domEventHandlers({
          compositionend: () => {
            if (this.saveAfterComposition) this.scheduleSave();
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

  /** Macros, colors and environments defined across the project (re-read every few seconds). */
  private definitions(): Definitions {
    const abs = this.absolutePath();
    if (!abs) return emptyDefinitions();
    const now = Date.now();
    if (!this.project || this.project.abs !== abs || now - this.project.at > PROJECT_TTL_MS) {
      this.project = { abs, at: now, defs: projectDefinitions(this.plugin.rootFor(abs)) };
    }
    return this.project.defs;
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
  private hover() {
    return hoverTooltip(
      async (view, pos): Promise<Tooltip | null> => {
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
      },
      { hoverTime: 300 },
    );
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

function toCmDiagnostics(state: EditorState, diags: TexDiagnostic[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of diags) {
    if (d.line === null || d.line < 1 || d.line > state.doc.lines) continue;
    const line = state.doc.line(d.line);
    const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
    const from = line.from + Math.min(indent, line.length);
    out.push({
      from,
      to: Math.max(from, line.to),
      severity: d.severity,
      message: d.message,
      source: "LaTeX",
    });
  }
  return out;
}
