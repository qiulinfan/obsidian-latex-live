import { readFile, mkdtemp, writeFile, realpath } from "fs/promises";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { basename, isAbsolute, join, relative, sep } from "path";
import { App, Modal, Notice, TFile } from "obsidian";
import type LatexLivePlugin from "../main";
import { applyProjectEdits, indexProjectLabels, matchAt, previewEnvironmentRename, previewLabelRename, previewReplace, searchProject, undoProjectEdits, type EditReceipt, type EditState, type LabelOccurrence, type ProjectEditHost, type ProjectEditPlan, type ProjectMatch } from "../tex/projectEdits";
import { normalizedText, readProjectSnapshot, type ProjectSnapshot } from "../tex/projectIndex";
import { TexView } from "./texView";

export interface ProjectOperationsUiHost {
  app: App;
  editHost: ProjectEditHost;
  snapshot(root: string): Promise<ProjectSnapshot>;
  navigate(match: ProjectMatch): Promise<void>;
  applied?(receipt: EditReceipt, backup: string): void;
  undone?(receipt: EditReceipt): void;
}

/** The vault and every open pane form one compare-and-swap boundary. */
export function projectEditHost(plugin: LatexLivePlugin): ProjectEditHost {
  let transactionActive = false;
  const physical = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  const views = (path: string) => {
    const targetPath = physical(path);
    return plugin.texViews().filter(view => { const abs = view.absolutePath(); return !!abs && physical(abs) === targetPath && view.editorView; });
  };
  const target = (path: string) => {
    const rel = plugin.vaultPath(path);
    const file = rel && plugin.app.vault.getAbstractFileByPath(rel);
    return file instanceof TFile ? file : null;
  };
  const writable = async (path: string) => {
    const base = plugin.vaultBase();
    if (!base || !target(path)) return false;
    try {
      const [physicalBase, physicalPath] = await Promise.all([realpath(base), realpath(path)]);
      const rel = relative(physicalBase, physicalPath);
      return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    } catch { return false; }
  };
  const read = async (path: string): Promise<EditState> => {
    const panes = views(path);
    const texts = panes.map(view => view.getCommittedText());
    const diskText = await readFile(path, "utf8");
    return { text: texts[0] ?? normalizedText(diskText), diskText, composing: panes.some(view => view.editorView!.compositionStarted), conflicting: new Set(texts).size > 1 || panes.some(view => !view.editorView!.compositionStarted && view.editorView!.state.doc.toString() !== view.getCommittedText()), writable: await writable(path) };
  };
  const check = (path: string, expected: EditState, data: string) => {
    const panes = views(path);
    if (data !== expected.diskText || panes.some(view => view.editorView!.compositionStarted || view.getCommittedText() !== normalizedText(expected.text) || view.editorView!.state.doc.toString() !== normalizedText(expected.text))) throw new Error(`The preview is stale or a composition is active: ${path}`);
  };
  return {
    begin() { if (transactionActive) throw new Error("Another project operation is running. Wait for it to finish."); transactionActive = true; },
    end() { transactionActive = false; },
    read,
    async write(path, expected, text, lineEnding) {
      if (!(await writable(path))) throw new Error("Project edits may only write files physically inside the vault.");
      const file = target(path);
      if (!file) throw new Error("This project file was removed or moved.");
      const physical = lineEnding === "\r\n" ? normalizedText(text).replace(/\n/g, "\r\n") : normalizedText(text);
      // Vault.process serializes disk updates and rechecks the disk in its callback. Check
      // the panes there too, after asynchronous filesystem validation has completed.
      await plugin.app.vault.process(file, data => { check(path, expected, data); return physical; });
      const panes = views(path);
      if (panes.some(view => view.editorView!.compositionStarted || ![normalizedText(expected.text), text].includes(view.editorView!.state.doc.toString()))) {
        // A new keystroke while the async write landed owns its buffer. Restore only the disk
        // we wrote, never that newer buffer; the original snapshot is also in the backup.
        await plugin.app.vault.process(file, data => { if (data !== physical) throw new Error("A newer disk edit prevents rollback."); return expected.diskText; });
        throw new Error("An editor changed while applying the preview. Refresh and try again.");
      }
      for (const view of panes) view.acceptProjectData(physical);
      // Use the existing external-change path after the checked write. Calling flush here
      // would add a second disk mutation without CAS; acceptProjectData cancels pending
      // plugin saves and updates committed text without a new save, preserving CM/CRLF.
      const after = await read(path);
      if (normalizedText(after.text) !== text || after.diskText !== physical || views(path).some(view => view.editorView!.compositionStarted || view.editorView!.state.doc.toString() !== text)) throw new Error("An editor changed during the project operation; its original text is retained in the backup.");
      return after;
    },
  };
}

function button(parent: HTMLElement, label: string, run: () => void, cls = ""): HTMLButtonElement {
  const el = parent.ownerDocument.createElement("button");
  el.textContent = label;
  el.className = cls;
  el.type = "button";
  el.addEventListener("click", run);
  parent.append(el);
  return el;
}
function input(parent: HTMLElement, label: string, value = ""): HTMLInputElement {
  const row = parent.ownerDocument.createElement("label");
  row.textContent = label;
  const el = parent.ownerDocument.createElement("input");
  el.type = "text";
  el.value = value;
  el.setAttribute("aria-label", label);
  row.append(el);
  parent.append(row);
  return el;
}
function errorText(el: HTMLElement, error: unknown): void { el.textContent = error instanceof Error ? error.message : String(error); }

/** A bounded DOM, with explicit pagination; the full result list remains searchable. */
export function renderProjectMatches(parent: HTMLElement, snapshot: ProjectSnapshot, matches: readonly ProjectMatch[], navigate: ProjectOperationsUiHost["navigate"], limit = 200): void {
  parent.replaceChildren();
  const doc = parent.ownerDocument;
  const summary = doc.createElement("p");
  summary.textContent = `${matches.length} matches in ${new Set(matches.map(match => match.path)).size} files`;
  parent.append(summary);
  let group: HTMLElement | null = null;
  let previous = "";
  for (const match of matches.slice(0, limit)) {
    if (match.path !== previous) {
      group = doc.createElement("section"); group.className = "ll-project-group";
      const heading = doc.createElement("h4"); heading.textContent = relative(snapshot.plan.rootDir, match.path);
      group.append(heading); parent.append(group); previous = match.path;
    }
    const el = button(group!, `${match.line}:${match.column + 1}  ${match.context}`, () => void navigate(match), "ll-project-match");
    el.title = match.path;
  }
  if (limit < matches.length) button(parent, "Show 200 more results", () => renderProjectMatches(parent, snapshot, matches, navigate, limit + 200));
}

export class ProjectEditPreviewModal extends Modal {
  private receipt: EditReceipt | null = null;
  private busy = false;
  private backup = "";
  constructor(private readonly host: ProjectOperationsUiHost, readonly plan: ProjectEditPlan) { super(host.app); }
  onOpen(): void {
    this.titleEl.textContent = this.plan.title;
    this.contentEl.className = "ll-project-tools ll-project-preview";
    const summary = this.contentEl.ownerDocument.createElement("p");
    summary.textContent = `${this.plan.count} changes in ${this.plan.files.length} files. Apply checks the current editor and disk copies again. A recovery backup and project Undo are kept.`;
    this.contentEl.append(summary);
    const status = this.contentEl.ownerDocument.createElement("p"); status.className = "ll-project-status";
    const controls = this.contentEl.ownerDocument.createElement("div"); controls.className = "ll-project-toolbar";
    const apply = button(controls, "Apply changes", () => {
      if (this.busy || this.receipt) return;
      this.busy = true; apply.disabled = true;
      void (async () => {
        try {
          const dir = await mkdtemp(join(tmpdir(), "latex-live-project-edit-"));
          const backup = join(dir, "recovery.json");
          this.backup = backup;
          await writeFile(backup, JSON.stringify({ created: new Date().toISOString(), plan: this.plan }, null, 2), { encoding: "utf8", mode: 0o600 });
          status.textContent = `Recovery backup: ${backup}`;
          this.receipt = await applyProjectEdits(this.plan, this.host.editHost);
          this.host.applied?.(this.receipt, backup);
          status.textContent = `Applied ${this.plan.count} changes. Recovery backup: ${backup}`;
          undo.disabled = false;
        } catch (error) { errorText(status, error); if (this.backup) status.textContent += ` Recovery backup: ${this.backup}`; apply.disabled = false; }
        finally { this.busy = false; }
      })();
    }, "mod-cta");
    apply.disabled = !this.plan.files.length;
    const undo = button(controls, "Undo this operation", () => {
      if (this.busy || !this.receipt) return;
      this.busy = true; undo.disabled = true;
      const receipt = this.receipt;
      void undoProjectEdits(receipt, this.host.editHost).then(() => { this.host.undone?.(receipt); status.textContent = "Operation undone."; this.receipt = null; }, error => { errorText(status, error); undo.disabled = false; }).finally(() => { this.busy = false; });
    });
    undo.disabled = true;
    button(controls, "Close", () => this.close());
    this.contentEl.append(controls, status);
    const results = this.contentEl.ownerDocument.createElement("div"); results.className = "ll-project-results";
    this.contentEl.append(results);
    for (const file of this.plan.files) {
      const group = this.contentEl.ownerDocument.createElement("details"); group.className = "ll-project-group"; group.open = true;
      const head = this.contentEl.ownerDocument.createElement("summary"); head.textContent = `${file.path} · ${file.edits.length} changes`;
      group.append(head); results.append(group);
      let shown = 0;
      const draw = () => {
        for (const edit of file.edits.slice(shown, shown + 100)) {
          const row = this.contentEl.ownerDocument.createElement("pre"); row.className = "ll-project-edit";
          const where = matchAt(file.path, file.before, edit.from, edit.to);
          row.textContent = `Line ${where.line}:${where.column + 1}\n− ${file.before.slice(edit.from, edit.to)}\n+ ${edit.insert}`;
          group.append(row);
        }
        shown += 100;
      };
      draw();
      if (shown < file.edits.length) {
        const more = button(group, "Show more changes", () => { more.remove(); draw(); if (shown < file.edits.length) group.append(more); });
      }
    }
  }
}

export class ProjectSearchModal extends Modal {
  private snapshot: ProjectSnapshot;
  constructor(private readonly host: ProjectOperationsUiHost, snapshot: ProjectSnapshot) { super(host.app); this.snapshot = snapshot; }
  onOpen(): void {
    this.titleEl.textContent = `Search LaTeX project · ${basename(this.snapshot.root)}`;
    this.contentEl.className = "ll-project-tools ll-project-search";
    const controls = this.contentEl.ownerDocument.createElement("div"); controls.className = "ll-project-toolbar";
    const query = input(controls, "Find");
    const replace = input(controls, "Replace with");
    const options: { caseSensitive?: boolean; wholeWord?: boolean } = {};
    for (const [key, label] of [["caseSensitive", "Match case"], ["wholeWord", "Whole word"]] as const) {
      const el = input(controls, label); el.type = "checkbox";
      el.addEventListener("change", () => { options[key] = el.checked; });
    }
    const status = this.contentEl.ownerDocument.createElement("p"); status.className = "ll-project-status";
    const results = this.contentEl.ownerDocument.createElement("div"); results.className = "ll-project-results";
    status.textContent = this.snapshot.warnings.length ? `Incomplete project snapshot: ${this.snapshot.warnings.join("; ")}` : `${this.snapshot.files.length} source files in the current root project.`;
    button(controls, "Search", () => renderProjectMatches(results, this.snapshot, searchProject(this.snapshot, query.value, options), this.host.navigate));
    button(controls, "Preview replacement", () => {
      try { new ProjectEditPreviewModal(this.host, previewReplace(this.snapshot, query.value, replace.value, options)).open(); }
      catch (error) { errorText(status, error); }
    });
    button(controls, "Refresh project", () => {
      void this.host.snapshot(this.snapshot.root).then(snapshot => { this.snapshot = snapshot; status.textContent = snapshot.warnings.length ? `Incomplete project snapshot: ${snapshot.warnings.join("; ")}` : "Project snapshot refreshed."; renderProjectMatches(results, snapshot, searchProject(snapshot, query.value, options), this.host.navigate); }, error => errorText(status, error));
    });
    query.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); renderProjectMatches(results, this.snapshot, searchProject(this.snapshot, query.value, options), this.host.navigate); } });
    this.contentEl.append(controls, status, results);
    query.focus();
  }
}

export class ProjectLabelsModal extends Modal {
  constructor(private readonly host: ProjectOperationsUiHost, private readonly snapshot: ProjectSnapshot, private readonly rename: boolean, private readonly initialKey = "") { super(host.app); }
  onOpen(): void {
    this.titleEl.textContent = this.rename ? "Rename project label" : "Find all label references";
    this.contentEl.className = "ll-project-tools ll-project-labels";
    const controls = this.contentEl.ownerDocument.createElement("div"); controls.className = "ll-project-toolbar";
    const key = input(controls, "Label", this.initialKey);
    const next = this.rename ? input(controls, "New label") : null;
    const status = this.contentEl.ownerDocument.createElement("p"); status.className = "ll-project-status";
    const results = this.contentEl.ownerDocument.createElement("div"); results.className = "ll-project-results";
    const index = indexProjectLabels(this.snapshot);
    const show = () => {
      const matches = index.occurrences.filter(item => item.key === key.value.trim()).sort((a, b) => a.path.localeCompare(b.path) || a.from - b.from);
      renderProjectMatches(results, this.snapshot, matches, this.host.navigate);
      status.textContent = index.unsafe.length ? `${index.unsafe.length} dynamic/incomplete references are excluded; safe rename requires resolving them.` : "Definitions and all literal references, including math, cleveref lists and ranges.";
    };
    button(controls, "Find references", show);
    if (next) button(controls, "Preview rename", () => {
      try { new ProjectEditPreviewModal(this.host, previewLabelRename(this.snapshot, key.value.trim(), next.value.trim())).open(); }
      catch (error) { errorText(status, error); }
    });
    this.contentEl.append(controls, status, results);
    if (key.value) show();
    key.focus();
  }
}

function keyAtCursor(index: readonly LabelOccurrence[], path: string, position: number): string {
  return index.find(item => item.path === path && item.from <= position && position <= item.to)?.key ?? "";
}

/** All services are demand-driven; no scanner is mounted in CodeMirror's update path. */
export function registerProjectOperations(plugin: LatexLivePlugin): void {
  const undoStack: { receipt: EditReceipt; backup: string }[] = [];
  const host: ProjectOperationsUiHost = {
    app: plugin.app,
    editHost: projectEditHost(plugin),
    snapshot: root => readProjectSnapshot(root, plugin.editorBuffers(true)),
    navigate: async match => {
      const state = await host.editHost.read(match.path);
      const current = matchAt(match.path, normalizedText(state.text), match.from, match.to);
      if (current.text !== match.text || current.line !== match.line || current.column !== match.column || current.context !== match.context) { new Notice("This result changed. Refresh the project search before navigating."); return; }
      await plugin.openLocation(match.path, match.line, match.column);
    },
    applied: (receipt, backup) => { undoStack.push({ receipt, backup }); if (undoStack.length > 8) undoStack.shift(); },
    undone: receipt => { const at = undoStack.findIndex(item => item.receipt === receipt); if (at >= 0) undoStack.splice(at, 1); },
  };
  const command = (id: string, name: string, run: (snapshot: ProjectSnapshot, path: string, position: number) => void) => plugin.addCommand({
    id, name,
    checkCallback: checking => {
      const view = plugin.app.workspace.getActiveViewOfType(TexView);
      const path = view?.absolutePath();
      if (!path || !view?.editorView) return false;
      if (!checking) {
        if (view.editorView.compositionStarted) { new Notice("Finish IME composition before opening project tools."); return true; }
        const position = view.editorView.state.selection.main.head;
        void host.snapshot(plugin.rootFor(path)).then(snapshot => run(snapshot, path, position), error => new Notice(error instanceof Error ? error.message : String(error)));
      }
      return true;
    },
  });
  command("search-project", "Search and replace in current LaTeX project", snapshot => new ProjectSearchModal(host, snapshot).open());
  command("find-label-references", "Find all label references in current project", (snapshot, path, position) => new ProjectLabelsModal(host, snapshot, false, keyAtCursor(indexProjectLabels(snapshot).occurrences, path, position)).open());
  command("rename-project-label", "Rename label across current project", (snapshot, path, position) => new ProjectLabelsModal(host, snapshot, true, keyAtCursor(indexProjectLabels(snapshot).occurrences, path, position)).open());
  command("rename-environment-pair", "Rename paired begin/end environment", (snapshot, path, position) => {
    const modal = new Modal(plugin.app);
    modal.titleEl.textContent = "Rename paired begin/end environment";
    modal.contentEl.className = "ll-project-tools";
    const name = input(modal.contentEl, "New environment name");
    const status = modal.contentEl.ownerDocument.createElement("p"); modal.contentEl.append(status);
    button(modal.contentEl, "Preview rename", () => { try { new ProjectEditPreviewModal(host, previewEnvironmentRename(snapshot, path, position, name.value.trim())).open(); } catch (error) { errorText(status, error); } });
    modal.open(); name.focus();
  });
  plugin.addCommand({
    id: "undo-project-edit", name: "Undo last project replacement or rename",
    checkCallback: checking => {
      if (!undoStack.length) return false;
      if (!checking) {
        const operation = undoStack.at(-1)!;
        void undoProjectEdits(operation.receipt, host.editHost).then(() => { undoStack.pop(); new Notice("Project operation undone."); }, error => new Notice(`${error instanceof Error ? error.message : String(error)} Recovery backup: ${operation.backup}`, 15000));
      }
      return true;
    },
  });
}
