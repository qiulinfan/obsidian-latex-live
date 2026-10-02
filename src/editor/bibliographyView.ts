import { basename } from "path";
import { Modal, Notice } from "obsidian";
import type LatexLivePlugin from "../main";
import { TexView } from "./texView";
import { latexContext } from "./latexCompletion";
import { searchCitations, type IndexedCitation } from "./bibliographies";

/** Results are paged; every indexed entry remains searchable and inspectable. */
export class BibliographyModal extends Modal {
  private entries: readonly IndexedCitation[] = [];
  private query = "";
  private page = 0;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private list!: HTMLElement;
  private detail!: HTMLElement;
  private count!: HTMLElement;
  constructor(private plugin: LatexLivePlugin, private view: TexView, private root: string) { super(plugin.app); }
  onOpen(): void {
    this.titleEl.setText("Project bibliography");
    this.contentEl.classList.add("ll-project-tools", "ll-bibliography");
    const input = this.contentEl.createEl("input", { attr: { type: "search", placeholder: "Author, title, year or citation key", "aria-label": "Search bibliography" } });
    input.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.query = input.value; this.page = 0; this.render(); }, 80);
    });
    this.count = this.contentEl.createDiv();
    this.list = this.contentEl.createDiv({ cls: "ll-bib-results" });
    this.detail = this.contentEl.createDiv({ cls: "ll-bib-detail" });
    const generation = ++this.generation;
    this.count.setText("Indexing project bibliography…");
    void this.plugin.bibliographies.load(this.root).then(entries => {
      if (generation !== this.generation) return;
      this.entries = entries; this.render();
    }).catch(error => { if (generation === this.generation) this.count.setText(`Cannot index bibliography: ${String(error)}`); });
    input.focus();
  }
  onClose(): void { this.generation++; clearTimeout(this.timer); }
  private render(): void {
    const entries = searchCitations(this.entries, this.query), start = this.page * 100;
    this.count.setText(`${entries.length} results · ${this.entries.length} entries in project`);
    this.list.empty();
    for (const citation of entries.slice(start, start + 100)) {
      const e = citation.entry;
      const row = this.list.createEl("button", { text: `${e.key} · ${e.year} · ${e.title}`, cls: "ll-bib-result" });
      row.title = `${e.fields?.author ?? e.names.join(", ")} — ${basename(citation.file)}`;
      row.addEventListener("click", () => this.show(citation));
    }
    const nav = this.list.createDiv();
    for (const [label, delta, disabled] of [["Previous", -1, this.page === 0], ["Next", 1, start + 100 >= entries.length]] as const) {
      const button = nav.createEl("button", { text: label }); button.disabled = disabled;
      button.addEventListener("click", () => { this.page += delta; this.render(); });
    }
  }
  private show(citation: IndexedCitation): void {
    this.detail.empty();
    this.detail.createEl("h3", { text: citation.entry.title || citation.entry.key });
    this.detail.createEl("p", { text: `${citation.entry.type} · ${citation.file}` });
    const fields = this.detail.createEl("dl");
    for (const [key, value] of Object.entries(citation.entry.fields ?? {})) {
      fields.createEl("dt", { text: key }); fields.createEl("dd", { text: value });
    }
    this.detail.createEl("pre", { text: citation.entry.source ?? "" });
    const insert = this.detail.createEl("button", { text: "Insert citation" });
    insert.addEventListener("click", () => {
      const editor = this.view.editorView;
      if (!editor || editor.compositionStarted) { new Notice("Finish composing before inserting a citation."); return; }
      const c = latexContext(editor.state, editor.state.selection.main.head);
      const selection = editor.state.selection.main;
      const from = c?.kind === "argument" && c.arg === "cite" ? c.from : selection.from;
      const to = c?.kind === "argument" && c.arg === "cite" ? c.to : selection.to;
      const text = c?.kind === "argument" && c.arg === "cite" ? citation.entry.key : `\\cite{${citation.entry.key}}`;
      editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input" });
      this.close(); editor.focus();
    });
    const open = this.detail.createEl("button", { text: "Open bibliography source" });
    open.addEventListener("click", () => { void this.plugin.openLocation(citation.file, 1); this.close(); });
  }
}
export function registerBibliography(plugin: LatexLivePlugin): void {
  plugin.addCommand({ id: "search-project-bibliography", name: "Search project bibliography", checkCallback: checking => {
    const view = plugin.app.workspace.getActiveViewOfType(TexView), file = view?.absolutePath();
    if (!view || !file) return false;
    if (!checking) new BibliographyModal(plugin, view, plugin.rootFor(file)).open();
    return true;
  } });
}
