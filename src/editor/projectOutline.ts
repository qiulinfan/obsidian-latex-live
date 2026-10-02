import { basename } from "path";
import { ItemView, Notice, type EventRef, type WorkspaceLeaf } from "obsidian";
import type LatexLivePlugin from "../main";
import { readProjectSnapshot } from "../tex/projectIndex";
import { buildProjectOutline, type OutlineHeading, type ProjectOutline } from "../tex/outline";
import type { TexView } from "./texView";

export const VIEW_TYPE_PROJECT_OUTLINE = "latex-live-project-outline";
const EDITOR_TYPE = "latex-live-editor";
const openViews = new WeakMap<LatexLivePlugin, Set<ProjectOutlineView>>();
const preferredRoots = new WeakMap<LatexLivePlugin, string>();

/** Called from the committed edit notifier; a closed panel performs no project work. */
export function invalidateProjectOutline(plugin: LatexLivePlugin): void {
  for (const view of openViews.get(plugin) ?? []) view.schedule();
}

/** DOM-only rendering (also used by the browser smoke). Titles never become raw HTML. */
export function renderProjectOutline(container: HTMLElement, outline: ProjectOutline, open: (heading: OutlineHeading) => void, warnings: readonly string[] = []): void {
  const doc = container.ownerDocument;
  container.replaceChildren();
  const tree = doc.createElement("ul");
  tree.className = "ll-outline-tree";
  tree.setAttribute("aria-label", "Project document outline");
  const render = (headings: readonly OutlineHeading[], parent: HTMLElement) => {
    for (const heading of headings) {
      const item = doc.createElement("li");
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "ll-outline-heading";
      button.textContent = heading.title;
      button.title = `\\${heading.command}${heading.starred ? "*" : ""} — ${heading.key}:${heading.line}`;
      button.dataset.outlineId = heading.id;
      button.addEventListener("click", () => open(heading));
      item.appendChild(button);
      if (heading.children.length) {
        const children = doc.createElement("ul");
        render(heading.children, children);
        item.appendChild(children);
      }
      parent.appendChild(item);
    }
  };
  render(outline.headings, tree);
  container.appendChild(tree);
  if (!outline.count) {
    const empty = doc.createElement("p");
    empty.className = "ll-outline-empty";
    empty.textContent = "No section headings in this project's document body.";
    container.appendChild(empty);
  }
  if (outline.truncated) {
    const note = doc.createElement("p");
    note.textContent = `Showing the first ${outline.count.toLocaleString("en-US")} headings.`;
    container.appendChild(note);
  }
  if (warnings.length) {
    const details = doc.createElement("details");
    details.className = "ll-outline-warnings";
    const summary = doc.createElement("summary");
    summary.textContent = `Some inputs could not be followed (${warnings.length})`;
    details.appendChild(summary);
    for (const warning of warnings) {
      const note = doc.createElement("p");
      note.textContent = warning;
      details.appendChild(note);
    }
    container.appendChild(details);
  }
}

export class ProjectOutlineView extends ItemView {
  root: string | null = null;
  private opened = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;
  private refs: { source: "workspace" | "vault"; ref: EventRef }[] = [];
  private status!: HTMLElement;
  private tree!: HTMLElement;
  private shown: ProjectOutline | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: LatexLivePlugin) {
    super(leaf);
    this.root = preferredRoots.get(plugin) ?? null;
  }
  getViewType(): string { return VIEW_TYPE_PROJECT_OUTLINE; }
  getDisplayText(): string { return "LaTeX project outline"; }
  getIcon(): string { return "list-tree"; }

  async onOpen(): Promise<void> {
    this.opened = true;
    const views = openViews.get(this.plugin) ?? new Set();
    views.add(this);
    openViews.set(this.plugin, views);
    this.contentEl.replaceChildren();
    this.contentEl.classList.add("ll-project-outline");
    const doc = this.contentEl.ownerDocument;
    const bar = doc.createElement("div");
    bar.className = "ll-outline-toolbar";
    this.status = doc.createElement("span");
    this.status.setAttribute("aria-live", "polite");
    const refresh = doc.createElement("button");
    refresh.type = "button";
    refresh.textContent = "Refresh";
    refresh.addEventListener("click", () => this.schedule(0));
    bar.append(this.status, refresh);
    this.tree = doc.createElement("nav");
    this.contentEl.append(bar, this.tree);
    this.refs.push({ source: "workspace", ref: this.app.workspace.on("active-leaf-change", () => this.trackRoot()) });
    this.refs.push({ source: "vault", ref: this.app.vault.on("modify", () => this.schedule()) });
    this.refs.push({ source: "vault", ref: this.app.vault.on("create", () => this.schedule()) });
    this.refs.push({ source: "vault", ref: this.app.vault.on("delete", () => this.schedule()) });
    this.refs.push({ source: "vault", ref: this.app.vault.on("rename", () => this.schedule()) });
    this.trackRoot();
    this.schedule(0);
  }

  async onClose(): Promise<void> {
    this.opened = false;
    this.revision++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const { source, ref } of this.refs) this.app[source].offref(ref);
    this.refs = [];
    openViews.get(this.plugin)?.delete(this);
    this.shown = null;
  }

  /** A side pane becoming active keeps the last LaTeX root; another TeX project changes it. */
  private trackRoot(): void {
    const active = this.app.workspace.activeLeaf?.view;
    if (active?.getViewType() === EDITOR_TYPE) {
      const abs = (active as TexView).absolutePath();
      if (abs && abs.endsWith(".tex")) {
        const root = this.plugin.rootFor(abs);
        preferredRoots.set(this.plugin, root);
        if (root !== this.root) { this.root = root; this.shown = null; this.schedule(0); }
      }
    }
    if (!this.root) {
      for (const view of this.plugin.texViews()) {
        const abs = view.absolutePath();
        if (abs?.endsWith(".tex")) { this.root = this.plugin.rootFor(abs); break; }
      }
    }
  }

  schedule(delay = 800): void {
    if (!this.opened) return;
    // An old asynchronous snapshot may never publish after a newer committed edit.
    this.revision++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, delay);
  }

  private async refresh(): Promise<void> {
    if (!this.opened) return;
    const root = this.root, revision = this.revision;
    if (!root) { this.status.textContent = "Open a LaTeX document to see its outline."; return; }
    if (this.plugin.texViews().some((v) => v.editorView?.compositionStarted)) { this.schedule(); return; }
    this.status.textContent = `${basename(root)} — updating…`;
    try {
      const snapshot = await readProjectSnapshot(root, this.plugin.editorBuffers(true));
      if (!this.opened || revision !== this.revision || root !== this.root) return;
      const outline = buildProjectOutline(snapshot.plan);
      this.shown = outline;
      this.status.textContent = `${basename(root)} — ${outline.count} headings`;
      renderProjectOutline(this.tree, outline, (heading) => {
        if (this.shown === outline) void this.plugin.openLocation(heading.file, heading.line, heading.column);
      }, snapshot.warnings);
    } catch (error) {
      if (!this.opened || revision !== this.revision) return;
      this.status.textContent = `Could not read project: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

export function registerProjectOutline(plugin: LatexLivePlugin): void {
  plugin.registerView(VIEW_TYPE_PROJECT_OUTLINE, (leaf) => new ProjectOutlineView(leaf, plugin));
  plugin.addCommand({
    id: "open-project-outline", name: "Open project outline",
    callback: () => {
      void (async () => {
        const workspace = plugin.app.workspace;
        // setViewState can focus the side pane before onOpen, so retain the source project's
        // root before that focus change (the first open editor may belong to another project).
        const active = workspace.activeLeaf?.view;
        if (active?.getViewType() === EDITOR_TYPE) {
          const abs = (active as TexView).absolutePath();
          if (abs?.endsWith(".tex")) preferredRoots.set(plugin, plugin.rootFor(abs));
        }
        let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_PROJECT_OUTLINE)[0] ?? null;
        if (!leaf) {
          leaf = workspace.getRightLeaf(false);
          if (!leaf) { new Notice("LaTeX Live: could not open the outline side pane."); return; }
          await leaf.setViewState({ type: VIEW_TYPE_PROJECT_OUTLINE, active: true });
        }
        if (leaf.view instanceof ProjectOutlineView) {
          const root = preferredRoots.get(plugin);
          if (root && leaf.view.root !== root) { leaf.view.root = root; leaf.view.schedule(0); }
        }
        await workspace.revealLeaf(leaf);
      })();
    },
  });
}
