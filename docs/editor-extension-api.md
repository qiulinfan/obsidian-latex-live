# Editor extension API for other plugins

LaTeX Live's `.tex` editor (view type `latex-live-editor`) builds its own CodeMirror 6
`EditorView`, so Obsidian's `Plugin.registerEditorExtension` never reaches it. Another plugin
adds CodeMirror extensions to it through the plugin instance:

```ts
registerTexEditorExtension(extension: Extension): () => void
```

- The extension joins every open LaTeX Live editor at once and every editor opened later
  (including a new file opened in an existing pane and a reopened file whose undo history is
  restored). Text, selection and undo history stay.
- It comes after LaTeX Live's own extensions, so LaTeX Live's keymaps (Tab, Enter, Escape,
  arrows, F12, ...) keep precedence unless the caller wraps it in `Prec`.
- The returned function removes it from every editor. It is idempotent and does nothing once
  LaTeX Live has unloaded; it never throws after LaTeX Live reloaded.
- When LaTeX Live unloads, every extension other plugins registered leaves the open editors.

At the end of each load (also after a disable/enable or an update), LaTeX Live triggers the
workspace event `"latex-live:api-ready"` with the plugin instance. A plugin that loaded earlier
listens for it and registers again; one that loads later calls the method directly:

```ts
import type { Extension } from "@codemirror/state";
import type { Events } from "obsidian";

type LatexLiveApi = { registerTexEditorExtension(extension: Extension): () => void };

// In the consumer's onload(). app.plugins is not in Obsidian's public typings. Keep one
// registration: the event may follow a direct call, and a reload makes the old disposer a no-op.
let detach = () => {};
this.register(() => detach());
const attach = (api: unknown) => {
  const fn = (api as Partial<LatexLiveApi> | null)?.registerTexEditorExtension;
  if (typeof fn !== "function") return;
  detach();
  detach = fn.call(api, myExtension);
};
attach((this.app as unknown as { plugins: { getPlugin(id: string): unknown } }).plugins.getPlugin("latex-live"));
this.registerEvent((this.app.workspace as Events).on("latex-live:api-ready", attach));
```

The caller must mark `@codemirror/*` as esbuild externals, as LaTeX Live does, so both plugins
use Obsidian's CodeMirror instances; an extension built against a bundled copy is rejected by
LaTeX Live's `EditorState`.
