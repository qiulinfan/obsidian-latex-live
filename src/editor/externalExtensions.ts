import { Compartment, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * Workspace event latex-live triggers (with the plugin instance) once
 * `registerTexEditorExtension` is usable, after every load and reload. A consumer that loaded
 * earlier (re)registers its extensions on it; one that loads later calls the method directly.
 */
export const API_READY_EVENT = "latex-live:api-ready";

/**
 * CodeMirror extensions other plugins add to latex-live's own `.tex` editors (Obsidian's
 * `registerEditorExtension` reaches only its Markdown editor). One compartment, placed after
 * latex-live's own extensions, holds them in every editor: new editor states include it through
 * `extension()`, and each change reconfigures it in the open editors. Kept free of the
 * `obsidian` module so tests drive it with plain EditorViews.
 */
export class ExternalExtensions {
  private readonly compartment = new Compartment();
  private readonly entries: { extension: Extension }[] = [];
  private disposed = false;

  constructor(private readonly views: () => Iterable<EditorView>) {}

  /** The compartment with the extensions registered now, for a new editor state. */
  extension(): Extension {
    return this.compartment.of(this.content());
  }

  /**
   * Add `extension` to every open editor and every later one. The returned disposer removes it
   * again; it is idempotent, and a no-op once latex-live has unloaded.
   */
  register(extension: Extension): () => void {
    if (this.disposed) return () => {};
    const entry = { extension };
    this.entries.push(entry);
    this.reconfigure();
    return () => {
      const i = this.entries.indexOf(entry);
      if (i < 0) return;
      this.entries.splice(i, 1);
      this.reconfigure();
    };
  }

  /** latex-live unloads: every registered extension leaves the open editors, later calls do nothing. */
  dispose(): void {
    if (this.disposed) return;
    this.entries.length = 0;
    this.reconfigure();
    this.disposed = true;
  }

  private content(): Extension[] {
    return this.entries.map((e) => e.extension);
  }

  private reconfigure(): void {
    const effects = this.compartment.reconfigure(this.content());
    for (const view of this.views()) {
      if (this.compartment.get(view.state) !== undefined) view.dispatch({ effects });
    }
  }
}
