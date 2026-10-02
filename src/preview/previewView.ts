import {
  ItemView,
  Modal,
  Notice,
  ViewStateResult,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { basename, relative } from "path";
import type LatexLivePlugin from "../main";
import type { LatexSession, SessionEvent } from "../session";
import type { TexDiagnostic } from "../tex/logParser";
import type { PdfBox } from "../tex/synctex";
import { PdfRenderer, type PdfReadingStatus } from "./pdfRenderer";
import { savePdfSnapshot } from "./pdfReading";

export const VIEW_TYPE_PREVIEW = "latex-live-preview";

const ENGINE_LABEL: Record<string, string> = {
  pdflatex: "pdfLaTeX",
  xelatex: "XeLaTeX",
  lualatex: "LuaLaTeX",
};

export class LatexPreviewView extends ItemView {
  /** Absolute path of the previewed root document. */
  root: string | null = null;
  private session: LatexSession | null = null;
  private detachSession: (() => void) | null = null;
  private renderer: PdfRenderer | null = null;
  private statusEl!: HTMLElement;
  private problemsEl!: HTMLDetailsElement;
  private pageInput!: HTMLInputElement;
  private pageCount!: HTMLElement;
  private scaleEl!: HTMLElement;
  private saveButton!: HTMLButtonElement;
  private pageButtons: HTMLButtonElement[] = [];
  private saving = false;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: LatexLivePlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PREVIEW;
  }

  getDisplayText(): string {
    return this.root ? `${basename(this.root)} (preview)` : "LaTeX preview";
  }

  getIcon(): string {
    return "eye";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ll-preview");

    const dock = root.createDiv({ cls: "ll-preview-dock" });
    const bar = dock.createDiv({ cls: "ll-toolbar" });
    this.statusEl = bar.createDiv({ cls: "ll-status" });
    const actions = bar.createDiv({ cls: "ll-actions" });
    const button = (icon: string, label: string, run: () => void) => {
      const b = actions.createEl("button", {
        cls: "clickable-icon ll-button",
        attr: { "aria-label": label },
      });
      setIcon(b, icon);
      b.addEventListener("click", run);
      return b;
    };
    button("refresh-cw", "Recompile", () => this.session?.request("fast"));
    button("hammer", "Full build (latexmk, runs BibTeX/Biber)", () =>
      this.session?.request("full"),
    );
    button("zoom-out", "Zoom out", () => this.renderer?.zoomOut());
    button("zoom-in", "Zoom in", () => this.renderer?.zoomIn());
    button("move-horizontal", "Fit width", () => this.renderer?.fitWidth());
    button("scroll-text", "Show log", () => this.showLog());
    this.saveButton = button("download", "Save the last successful build as PDF", () => { void this.savePdf(); });

    const navigation = dock.createDiv({ cls: "ll-pdf-navigation" });
    this.pageButtons = [];
    const pageButton = (icon: string, label: string, offset: number) => {
      const b = navigation.createEl("button", { cls: "clickable-icon ll-button", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.addEventListener("click", () => this.renderer?.goToPage(this.renderer.status.page + offset));
      this.pageButtons.push(b);
    };
    pageButton("chevron-left", "Previous page", -1);
    this.pageInput = navigation.createEl("input", { attr: { type: "number", min: "1", step: "1", "aria-label": "Go to PDF page" } });
    this.pageInput.addEventListener("change", () => { this.renderer?.goToPage(Number(this.pageInput.value)); this.updateReading(this.renderer?.status); });
    this.pageInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault(); event.stopPropagation();
      this.renderer?.goToPage(Number(this.pageInput.value));
      this.pageInput.blur(); this.updateReading(this.renderer?.status);
    });
    this.pageCount = navigation.createSpan({ cls: "ll-pdf-count", text: "/ 0" });
    pageButton("chevron-right", "Next page", 1);
    this.scaleEl = navigation.createSpan({ cls: "ll-pdf-scale" });

    this.problemsEl = dock.createEl("details", { cls: "ll-problems" });
    this.renderer = new PdfRenderer(root, { onStatus: (status) => this.updateReading(status) });
    this.renderer.scrollEl.addEventListener("dblclick", (ev) => {
      void this.inverseSearch(ev);
    });
    this.applyTheme();
    this.render();
    if (this.session?.lastPdf) void this.renderer.load(this.session.lastPdf.slice());
  }

  async onClose(): Promise<void> {
    this.attach(null);
    this.renderer?.destroy();
    this.renderer = null;
  }

  getState(): Record<string, unknown> {
    const file = this.root ? this.plugin.vaultPath(this.root) : null;
    return { ...super.getState(), file };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const file = (state as { file?: unknown } | null)?.file;
    if (typeof file === "string") {
      this.setRoot(this.plugin.absolutePath(file));
    }
    await super.setState(state, result);
  }

  /** Show the given root document, attaching to (or creating) its session. */
  setRoot(root: string | null): void {
    if (root === this.root) return;
    this.root = root;
    if (this.problemsEl) this.problemsEl.open = false;
    this.attach(root ? this.plugin.acquireSession(root) : null);
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    this.render();
    const s = this.session;
    this.renderer?.clear(s ? "Compiling…" : "No PDF yet.");
    if (!s) return;
    if (s.lastPdf) void this.renderer?.load(s.lastPdf.slice());
    else if (!s.compiling) s.request("fast");
  }

  reveal(box: PdfBox, onlyIfHidden: boolean): void {
    this.renderer?.reveal(box, onlyIfHidden);
  }

  applyTheme(): void {
    this.renderer?.setInverted(this.plugin.invertsPaper());
  }

  private attach(session: LatexSession | null): void {
    this.detachSession?.();
    this.detachSession = null;
    if (this.session) this.plugin.releaseSession(this.session);
    this.session = session;
    if (session) {
      this.detachSession = session.onEvent((e) => this.onSessionEvent(e));
    }
  }

  private onSessionEvent(e: SessionEvent): void {
    const s = this.session;
    if (e === "result" && s?.last?.pdfData) {
      // pdf.js takes ownership of the buffer; keep the session's copy intact.
      void this.renderer?.load(s.last.pdfData.slice());
    }
    this.render();
  }

  private render(): void {
    if (!this.statusEl) return;
    const s = this.session;
    this.saveButton.disabled = !s?.lastPdf || this.saving;
    this.statusEl.empty();
    this.statusEl.removeClass("is-error", "is-ok", "is-busy");
    if (!s) {
      this.statusEl.setText("Open a .tex file to preview it.");
      this.renderProblems([]);
      return;
    }
    const engine = ENGINE_LABEL[s.engine] ?? s.engine;
    if (s.compiling) {
      this.statusEl.addClass("is-busy");
      this.statusEl.setText(
        s.compiling === "full" ? `Building with latexmk…` : `Compiling (${engine})…`,
      );
    } else if (s.failure) {
      this.statusEl.addClass("is-error");
      this.statusEl.setText(s.failure);
    } else if (s.last) {
      const r = s.last;
      const errors = r.log.diagnostics.filter((d) => d.severity === "error").length;
      const secs = (r.durationMs / 1000).toFixed(2);
      const parts = [
        errors
          ? `${errors} error${errors > 1 ? "s" : ""}`
          : r.pdfWritten
            ? r.pdfReused ? "Up to date" : "Compiled"
            : "No output",
        `${secs}s`,
        r.mode === "full" ? "latexmk" : ENGINE_LABEL[r.engine],
      ];
      if (r.usedPreambleCache) parts.push("cached preamble");
      if (r.log.needsBibliography && r.mode === "fast") {
        parts.push("citations need a full build");
      }
      this.statusEl.addClass(errors || !r.pdfWritten ? "is-error" : "is-ok");
      this.statusEl.setText(parts.join(" · "));
    }
    if (!s.lastPdf && this.renderer && !this.renderer.hasDocument) {
      this.renderer.setEmpty(
        s.compiling ? "Compiling…" : s.last ? "No PDF was produced." : "No PDF yet.",
      );
    }
    this.renderProblems(s.last?.log.diagnostics ?? []);
  }

  private renderProblems(diags: TexDiagnostic[]): void {
    const el = this.problemsEl;
    const wasOpen = el.open;
    el.empty();
    const shown = diags.filter((d) => d.severity !== "info");
    el.toggleClass("is-hidden", shown.length === 0);
    const errors = shown.filter((d) => d.severity === "error").length;
    el.createEl("summary", {
      text: `${errors} error${errors === 1 ? "" : "s"}, ${
        shown.length - errors
      } warning${shown.length - errors === 1 ? "" : "s"}`,
    });
    const list = el.createDiv({ cls: "ll-problem-list" });
    for (const d of shown) {
      const item = list.createDiv({ cls: `ll-problem is-${d.severity}` });
      const where = d.file
        ? `${relative(this.plugin.vaultBase() ?? "", d.file)}${d.line ? `:${d.line}` : ""}`
        : "";
      item.createSpan({ cls: "ll-problem-where", text: where });
      item.createSpan({ cls: "ll-problem-msg", text: d.message });
      if (d.file) {
        item.addClass("is-clickable");
        item.addEventListener("click", () => {
          void this.plugin.openLocation(d.file!, d.line ?? 1);
        });
      }
    }
    // Diagnostics never open the dock; an explicit choice lasts until cleared or switched.
    el.open = wasOpen && shown.length > 0;
  }

  private async inverseSearch(ev: MouseEvent): Promise<void> {
    const pt = this.renderer?.pointFromEvent(ev);
    const s = this.session;
    if (!pt || !s) return;
    ev.preventDefault();
    const loc = await this.plugin.inverseSearch(s, pt.page, pt.x, pt.y);
    if (loc) await this.plugin.openLocation(loc.file, loc.line);
  }

  private updateReading(status?: PdfReadingStatus): void {
    if (!this.pageInput) return;
    const current = status ?? { page: 0, pages: 0, scale: 1, fit: true };
    if (this.pageInput.ownerDocument.activeElement !== this.pageInput) this.pageInput.value = current.page ? String(current.page) : "";
    this.pageInput.max = String(current.pages);
    this.pageInput.disabled = current.pages === 0;
    this.pageCount.setText(`/ ${current.pages}`);
    this.scaleEl.setText(`${Math.round(current.scale * 100)}%${current.fit ? " · Fit width" : ""}`);
    this.pageButtons[0].disabled = current.page <= 1;
    this.pageButtons[1].disabled = current.page >= current.pages;
  }

  private async savePdf(): Promise<void> {
    const root = this.root, session = this.session, data = session?.lastPdf;
    if (!root || !data || this.saving) return;
    this.saving = true;
    this.render();
    try {
      const path = await savePdfSnapshot(root, data);
      if (path) new Notice(`LaTeX Live: saved ${basename(path)} (last successful build).`);
    } catch (error) { new Notice(`LaTeX Live: could not save PDF: ${String(error)}`); }
    finally { this.saving = false; this.render(); }
  }

  private showLog(): void {
    const log = this.session?.last?.rawLog;
    const modal = new Modal(this.app);
    modal.titleEl.setText(this.root ? `${basename(this.root)} — TeX log` : "TeX log");
    modal.modalEl.addClass("ll-log-modal");
    modal.contentEl.createEl("pre", { cls: "ll-log", text: log || "No log yet." });
    modal.open();
  }
}
