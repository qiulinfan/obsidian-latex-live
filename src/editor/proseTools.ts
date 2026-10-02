import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { Modal, Notice } from "obsidian";
import type LatexLivePlugin from "../main";
import { countProse, parseDelimitedTable, proseWords, tableLatex, type ProseWord } from "../tex/prose";
import { readProjectSnapshot } from "../tex/projectIndex";
import { visitNodes } from "../export/plan";
import { TexView } from "./texView";

export interface SpellDictionary { isWordMisspelled(word: string): boolean; getWordSuggestions(word: string): string[]; }
export function nativeSpellDictionary(): SpellDictionary | null {
  try {
    const frame = (require("electron") as { webFrame?: SpellDictionary }).webFrame;
    return frame && typeof frame.isWordMisspelled === "function" && typeof frame.getWordSuggestions === "function" ? frame : null;
  } catch { return null; }
}
export const showSpelling = StateEffect.define<readonly ProseWord[]>();
/** Only explicit spelling checks produce decorations. Edits clear stale results, without parsing. */
export const proseSpelling = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged) value = Decoration.none;
    for (const effect of tr.effects) if (effect.is(showSpelling)) value = Decoration.set(effect.value.map(word =>
      Decoration.mark({ class: "ll-spelling-error", attributes: { title: `Spelling: ${word.text}` } }).range(word.from, word.to)), true);
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});
export async function checkProseSpelling(words: readonly ProseWord[], dictionary: SpellDictionary, cancelled: () => boolean): Promise<ProseWord[]> {
  const cache = new Map<string, boolean>(), out: ProseWord[] = [];
  for (let i = 0; i < words.length; i++) {
    if (i % 100 === 0) { await new Promise<void>(done => setTimeout(done, 0)); if (cancelled()) return []; }
    const word = words[i];
    if (/\p{Script=Han}/u.test(word.text)) continue;
    let misspelled = cache.get(word.text);
    if (misspelled === undefined) { misspelled = dictionary.isWordMisspelled(word.text); cache.set(word.text, misspelled); }
    if (misspelled) out.push(word);
  }
  return out;
}
export class SpellingModal extends Modal {
  private closed = false;
  constructor(private plugin: LatexLivePlugin, private view: TexView, private dictionary: SpellDictionary) { super(plugin.app); }
  onClose(): void { this.closed = true; }
  onOpen(): void {
    this.titleEl.setText("Check prose spelling"); this.contentEl.classList.add("ll-project-tools");
    const editor = this.view.editorView;
    if (!editor || editor.compositionStarted) { this.contentEl.setText("Finish composing before checking spelling."); return; }
    const doc = editor.state.doc;
    const status = this.contentEl.createDiv({ text: "Checking prose with Obsidian's system dictionary…" });
    const results = this.contentEl.createDiv({ cls: "ll-project-results" });
    void (async () => {
      const path = this.view.absolutePath();
      const snapshot = path ? await readProjectSnapshot(this.plugin.rootFor(path), this.plugin.editorBuffers(true)) : null;
      if (this.closed || editor.state.doc !== doc || editor.compositionStarted) return [];
      const words = proseWords(doc.toString(), snapshot?.plan.sig);
      return checkProseSpelling(words, this.dictionary, () => this.closed || editor.state.doc !== doc || editor.compositionStarted);
    })().then(mistakes => {
      if (this.closed) return;
      if (editor.state.doc !== doc || editor.compositionStarted) { status.setText("Text changed. Run the spelling check again."); return; }
      if (!this.dictionary.isWordMisspelled("qzxqzxqzx")) { status.setText("No active dictionary detected. Enable spellcheck in Obsidian's Editor settings, then try again."); return; }
      status.setText(`${mistakes.length} possible spelling errors. Math, commands, references and code were excluded.`);
      editor.dispatch({ effects: showSpelling.of(mistakes) });
      const render = (start: number) => {
        results.empty();
        for (const word of mistakes.slice(start, start + 100)) {
          const row = results.createDiv({ cls: "ll-project-match" });
          const jump = row.createEl("button", { text: `${doc.lineAt(word.from).number}: ${word.text}` });
          jump.addEventListener("click", () => {
            if (editor.state.doc !== doc || editor.compositionStarted) { status.setText("Text changed. Run the spelling check again."); return; }
            editor.dispatch({ selection: { anchor: word.from, head: word.to }, effects: EditorView.scrollIntoView(word.from, { y: "center" }) });
          });
          for (const suggestion of this.dictionary.getWordSuggestions(word.text).slice(0, 5)) {
            const button = row.createEl("button", { text: suggestion });
            button.addEventListener("click", () => {
              if (editor.compositionStarted || editor.state.doc !== doc) { status.setText("Text changed. Run the spelling check again."); return; }
              editor.dispatch({ changes: { from: word.from, to: word.to, insert: suggestion }, userEvent: "input" });
              this.close(); editor.focus();
            });
          }
        }
        if (start) { const previous = results.createEl("button", { text: "Previous" }); previous.onclick = () => render(start - 100); }
        if (start + 100 < mistakes.length) { const next = results.createEl("button", { text: "Next" }); next.onclick = () => render(start + 100); }
      };
      render(0);
    }).catch(e => status.setText(`Spelling check failed: ${String(e)}`));
  }
}
/** HTML clipboard tables use textContent only; reject merged cells instead of losing topology. */
export function clipboardTable(text: string, html: string, document: Document): string[][] | null {
  if (html) {
    if (html.length > 1_000_000) throw new Error("Table is too large (maximum 1 MB).");
    const template = document.createElement("template"); template.innerHTML = html;
    const table = template.content.querySelector("table");
    if (table) {
      if (table.querySelector('td[colspan]:not([colspan="1"]),th[colspan]:not([colspan="1"]),td[rowspan]:not([rowspan="1"]),th[rowspan]:not([rowspan="1"])')) throw new Error("Merged cells are not supported; paste a rectangular table.");
      const rows = [...table.rows].map(row => [...row.cells].map(cell => cell.textContent ?? ""));
      if (rows.length * (rows[0]?.length ?? 0) > 2000) throw new Error("Table is too large (maximum 2,000 cells).");
      if (rows.length && rows[0].length && rows.every(row => row.length === rows[0].length)) return rows;
      return null;
    }
  }
  return parseDelimitedTable(text);
}
function systemTableClipboard(): { text: string; html: string } {
  try {
    const clipboard = (require("electron") as { clipboard: { readText(): string; readHTML(): string } }).clipboard;
    return { text: clipboard.readText(), html: clipboard.readHTML() };
  } catch { throw new Error("The desktop clipboard is unavailable in this window."); }
}
export class TablePasteModal extends Modal {
  constructor(plugin: LatexLivePlugin, private view: TexView, private readClipboard = systemTableClipboard) { super(plugin.app); }
  onOpen(): void {
    this.titleEl.setText("Paste as LaTeX table"); this.contentEl.classList.add("ll-project-tools");
    const status = this.contentEl.createDiv({ text: "Reading clipboard…" });
    const text = this.contentEl.createEl("textarea", { attr: { "aria-label": "LaTeX table preview", rows: "12", spellcheck: "false" } });
    const mode = this.contentEl.createEl("select", { attr: { "aria-label": "Table style" } });
    mode.createEl("option", { text: "tabular", attr: { value: "plain" } }); mode.createEl("option", { text: "booktabs", attr: { value: "booktabs" } });
    const insert = this.contentEl.createEl("button", { text: "Insert table" }); insert.disabled = true;
    let rows: string[][] | null = null;
    try {
      const clipboard = this.readClipboard();
      rows = clipboardTable(clipboard.text, clipboard.html, this.contentEl.ownerDocument);
      if (!rows) { status.setText("Copy a rectangular spreadsheet table, then run this command again."); return; }
      status.setText(`${rows.length} rows × ${rows[0].length} columns. booktabs needs \\usepackage{booktabs} in the preamble.`);
      const render = () => { text.value = tableLatex(rows!, mode.value === "booktabs"); }; render(); mode.onchange = render; insert.disabled = false;
    } catch (e) { status.setText(`Cannot read table: ${String(e)}`); }
    insert.onclick = () => {
      const editor = this.view.editorView;
      if (!editor || editor.compositionStarted) { new Notice("Finish composing before inserting a table."); return; }
      editor.dispatch(editor.state.replaceSelection(text.value)); this.close(); editor.focus();
    };
  }
}
export function registerProseTools(plugin: LatexLivePlugin): void {
  const editorCommand = (id: string, name: string, run: (view: TexView) => unknown) => plugin.addCommand({ id, name, checkCallback: checking => {
    const view = plugin.app.workspace.getActiveViewOfType(TexView);
    if (!view?.editorView) return false;
    if (!checking) run(view); return true;
  } });
  editorCommand("count-prose-words", "Count prose words in project", view => {
    const file = view.absolutePath(); if (!file) return;
    void readProjectSnapshot(plugin.rootFor(file), plugin.editorBuffers(true)).then(snapshot => {
      const rows = snapshot.plan.visits.map((visit, index) => {
        const file = snapshot.plan.files.get(visit.key)!;
        return { file: file.abs, count: countProse(proseWords(file.src, snapshot.plan.sig, visitNodes(snapshot.plan, index))) };
      });
      const modal = new Modal(plugin.app); modal.titleEl.setText("Project prose count"); modal.contentEl.classList.add("ll-project-tools");
      const words = rows.reduce((n, row) => n + row.count.words, 0), han = rows.reduce((n, row) => n + row.count.hanCharacters, 0);
      modal.contentEl.createEl("p", { text: `${words} words · ${han} Chinese characters. Source prose excluding math, commands and code; repeated inputs count per visit.` });
      for (const row of rows) modal.contentEl.createDiv({ text: `${row.file}: ${row.count.words} words · ${row.count.hanCharacters} Chinese characters` });
      modal.open();
    }).catch(e => new Notice(`Cannot count project prose: ${String(e)}`));
  });
  editorCommand("check-prose-spelling", "Check prose spelling in current file", view => {
    const dictionary = nativeSpellDictionary();
    if (dictionary) new SpellingModal(plugin, view, dictionary).open();
    else new Notice("The system spellchecker is unavailable in this window.");
  });
  editorCommand("paste-latex-table", "Paste clipboard as LaTeX table", view => new TablePasteModal(plugin, view).open());
}
