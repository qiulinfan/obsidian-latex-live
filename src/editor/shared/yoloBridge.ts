// Shared with obsidian-latex-live / obsidian-tinymist: keep byte-identical (canonical copy: obsidian-tinymist/src/editor/shared).
//
// Bridge to the YOLO plugin's AI tab completion for non-Markdown CodeMirror views.
// YOLO only wires its tab completion into MarkdownView editors, so this module:
//   - mounts YOLO's inline-suggestion render extension WITHOUT its Prec.highest keymap
//     (keyArbiter owns the keys and calls back into `inline` below);
//   - feeds user edits into YOLO's own trigger path (triggers, delays, cooldown,
//     enable toggle) through an Obsidian-Editor-shaped shim;
//   - keeps YOLO's controller in step with what is on screen (clears on non-user doc
//     changes, while the completion popup is visible, during IME composition);
//   - accepts the raw candidate text itself (YOLO's accept path escapes `<x>` for Markdown);
//   - tells the model the file name with its extension (patches YOLO's title dep);
//   - fails soft: any exception disables the bridge until refresh().
// Everything here is YOLO 1.6.9.7 internals; see YOLO_VERIFIED_VERSIONS and
// `npm run test:yolo` (the contract check against an installed YOLO main.js).
import { closeCompletion, completionStatus } from "@codemirror/autocomplete";
import { Compartment, EditorState, Extension, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate, keymap } from "@codemirror/view";
import type { App } from "obsidian";
import { popupVisible } from "./keyArbiter";
import type { InlineStatus, InlineSuggestions } from "./keyArbiter";

export const YOLO_VERIFIED_VERSIONS = ["1.6.9.7"];

// ---- The slice of YOLO internals this relies on ---------------------------------
interface YoloCandidate { text: string; status: string }
interface YoloTabSuggestion {
  view: EditorView;
  cursorOffset: number;
  replaceFromOffset: number | null;
  candidates: YoloCandidate[];
  selectedIndex: number;
}
interface YoloTabController {
  tabCompletionSuggestion: YoloTabSuggestion | null;
  tabCompletionPending: { editor: unknown } | null;
  deps: { getActiveFileTitle?: (...a: unknown[]) => string };
  handleEditorChange(editor: unknown): void;
  run(editor: unknown, cursorOffset: number, replaceFromOffset?: number | null): Promise<void>;
  cancelRequest(): void;
  clearTimer(): void;
  tryNavigateFromView(view: EditorView, dir: number): boolean;
}
interface YoloInlineController {
  activeInlineSuggestion: { view: EditorView } | null;
  createExtension(): Extension[];
  clearInlineSuggestion(): void;
}
interface YoloPlugin {
  manifest?: { version?: string };
  getInlineSuggestionController(): YoloInlineController;
  getTabCompletionController(): YoloTabController;
  getEditorView(editor: unknown): EditorView | null;
  handleTabCompletionEditorChange?(editor: unknown): void;
}
interface Bound {
  plugin: YoloPlugin;
  version: string;
  inline: YoloInlineController;
  tab: YoloTabController;
  render: Extension[]; // createExtension() minus its keymap
  fields: StateField<unknown>[]; // YOLO's decoration fields, to tell what is on screen
  untitle: () => void;
}

interface Pos { line: number; ch: number }

/** Obsidian-Editor lookalike over a CM view: the members YOLO's tab path calls. */
export class YoloEditorShim {
  constructor(readonly cm: EditorView) {}
  getSelection(): string {
    const { from, to } = this.cm.state.selection.main;
    return this.cm.state.sliceDoc(from, to);
  }
  somethingSelected(): boolean {
    return !this.cm.state.selection.main.empty;
  }
  getCursor(): Pos {
    return this.offsetToPos(this.cm.state.selection.main.head);
  }
  setCursor(pos: Pos): void {
    this.cm.dispatch({ selection: { anchor: this.posToOffset(pos) }, scrollIntoView: true });
  }
  offsetToPos(offset: number): Pos {
    const doc = this.cm.state.doc;
    const clamped = Math.max(0, Math.min(offset, doc.length));
    const line = doc.lineAt(clamped);
    return { line: line.number - 1, ch: clamped - line.from };
  }
  posToOffset(pos: Pos): number {
    const doc = this.cm.state.doc;
    const line = doc.line(Math.max(1, Math.min(pos.line + 1, doc.lines)));
    return Math.min(line.from + Math.max(0, pos.ch), line.to);
  }
  replaceRange(text: string, from: Pos, to?: Pos): void {
    const a = this.posToOffset(from);
    this.cm.dispatch({ changes: { from: a, to: to ? this.posToOffset(to) : a, insert: text } });
  }
}

const fn = (o: unknown, k: string) => typeof (o as Record<string, unknown> | null)?.[k] === "function";

/** Structural check of a YOLO plugin instance; returns the bound surface or a reason. */
export function bindYolo(plugin: unknown): Omit<Bound, "untitle"> | string {
  const p = plugin as YoloPlugin;
  for (const k of ["getInlineSuggestionController", "getTabCompletionController", "getEditorView"]) {
    if (!fn(p, k)) return `missing plugin.${k}()`;
  }
  const inline = p.getInlineSuggestionController();
  const tab = p.getTabCompletionController();
  for (const k of ["createExtension", "clearInlineSuggestion"]) if (!fn(inline, k)) return `missing inline.${k}()`;
  for (const k of ["handleEditorChange", "run", "cancelRequest", "clearTimer", "tryNavigateFromView"]) {
    if (!fn(tab, k)) return `missing tab.${k}()`;
  }
  for (const k of ["tabCompletionSuggestion", "tabCompletionPending", "deps"]) {
    if (!(k in (tab as object))) return `missing tab.${k}`;
  }
  if (!("activeInlineSuggestion" in (inline as object))) return "missing inline.activeInlineSuggestion";
  const exts = inline.createExtension();
  if (!Array.isArray(exts)) return "createExtension() is not an array";
  // Throws when YOLO resolved a different @codemirror/state instance than ours.
  const withKeys = exts.filter((e) => EditorState.create({ extensions: e }).facet(keymap).length > 0);
  const render = exts.filter((e) => !withKeys.includes(e));
  const fields = render.filter((e): e is StateField<unknown> => e instanceof StateField);
  if (withKeys.length !== 1 || fields.length === 0) {
    return `unexpected createExtension() shape (${withKeys.length} keymaps, ${fields.length} fields)`;
  }
  const version = p.manifest?.version ?? "unknown";
  return { plugin: p, version, inline, tab, render, fields };
}

// Chain-safe, reversible wrapper (the monkey-around pattern): uninstalling while
// someone else wrapped on top leaves a pass-through instead of breaking their wrapper.
function patchTitle(tab: YoloTabController, title: (editor: unknown) => string | null): () => void {
  const deps = tab.deps;
  const orig = deps?.getActiveFileTitle;
  if (!deps || typeof orig !== "function") return () => {};
  let on = true;
  const wrapper = function (this: unknown, ...args: unknown[]): string {
    if (on) {
      try {
        const t = title(forcedEditor ?? tab.tabCompletionPending?.editor);
        if (t) return t;
      } catch {
        /* fall through to YOLO's own title */
      }
    }
    return orig.apply(this, args);
  };
  deps.getActiveFileTitle = wrapper;
  return () => {
    on = false;
    if (deps.getActiveFileTitle === wrapper) deps.getActiveFileTitle = orig;
  };
}
let forcedEditor: unknown = null; // set only during the synchronous prefix of run()

interface ViewEntry {
  view: EditorView;
  compartment: Compartment;
  mounted: YoloPlugin | null;
  armDeferred: boolean;
  popupWas: boolean;
  destroyed: boolean;
}

export interface YoloBridgeOptions {
  /** Log prefix, e.g. "tinymist". */
  name: string;
  /** The owning plugin's "YOLO tab completion" setting. */
  enabled: () => boolean;
}

export class YoloBridge {
  private bound: Bound | null = null;
  private broken: string | null = null;
  private rejected: unknown = null; // a YOLO instance that failed bindYolo()
  private disposed = false;
  private warned = new Set<string>();
  private entries = new Set<ViewEntry>();
  private shims = new WeakMap<EditorView, YoloEditorShim>();
  private titles = new WeakMap<object, () => string | null>();

  constructor(private app: App, private opts: YoloBridgeOptions) {}

  /** Per-EditorState extension. `title` returns the file name with extension. */
  extension(title: () => string | null): Extension {
    const compartment = new Compartment();
    const b = this.current();
    const mounted = b?.plugin ?? null;
    return [
      compartment.of(b ? b.render : []),
      ViewPlugin.define((view) => {
        const entry: ViewEntry = { view, compartment, mounted, armDeferred: false, popupWas: false, destroyed: false };
        this.entries.add(entry);
        this.titles.set(this.shim(view), title);
        return {
          update: (u: ViewUpdate) => this.guard(undefined, () => this.onUpdate(entry, u)),
          destroy: () => {
            entry.destroyed = true;
            this.entries.delete(entry);
            // setState/destroy: never dispatch inside. Also disarm YOLO's pending trigger,
            // or it still runs for the closed file (or shows a ghost in the next one).
            this.later(() => this.dismiss(view, true));
          },
        };
      }),
      EditorView.domEventHandlers({
        compositionstart: (_e, view) => {
          this.later(() => this.dismiss(view, true));
          return false;
        },
        compositionend: (_e, view) => {
          setTimeout(() => this.guard(undefined, () => {
            if (!view.composing && !popupVisible(view.state)) this.arm(view);
          }), 0);
          return false;
        },
      }),
    ];
  }

  /** The provider keyArbiter consults. */
  readonly inline: InlineSuggestions = {
    status: (view) => this.guard<InlineStatus>("none", () => this.statusOf(view)),
    accept: (view) => this.guard(false, () => this.accept(view)),
    dismiss: (view) => this.guard(undefined, () => this.dismiss(view)),
    cycle: (view, dir) => this.guard(false, () => {
      const b = this.bound;
      const s = b?.tab.tabCompletionSuggestion;
      if (!b || !s || s.view !== view || s.candidates.filter((c) => c.text).length < 2) return false;
      return b.tab.tryNavigateFromView(view, dir);
    }),
  };

  /**
   * Plugin command "Trigger AI completion (YOLO)": bypasses YOLO's trigger patterns and
   * delay (YOLO's own enable toggle and minimum context still apply). Closes an open
   * completion popup first, since the popup would otherwise hide the ghost at once.
   */
  triggerNow(view: EditorView): boolean {
    return this.guard(false, () => {
      const b = this.current();
      if (!b || !view.state.selection.main.empty) return false;
      if (completionStatus(view.state) !== null) {
        for (const e of this.entries) if (e.view === view) e.armDeferred = false;
        closeCompletion(view);
      }
      const shim = this.shim(view);
      forcedEditor = shim;
      try {
        void b.tab.run(shim, view.state.selection.main.head);
      } finally {
        forcedEditor = null;
      }
      return true;
    });
  }

  /** Call after the enable setting changes: rebinds YOLO and remounts every view. */
  refresh(): void {
    this.broken = null;
    this.rejected = null;
    this.unbind();
    this.current();
    for (const e of this.entries) this.remount(e);
  }

  /** Plugin unload. */
  destroy(): void {
    for (const e of this.entries) this.dismiss(e.view);
    this.disposed = true;
    this.unbind();
    this.entries.clear();
  }

  /** One line for the setting description. */
  describe(): string {
    if (this.broken) return `disabled after an error: ${this.broken}`;
    const b = this.current();
    return b ? `YOLO ${b.version}` : "YOLO not available";
  }

  // ---- internals --------------------------------------------------------------------

  private current(): Bound | null {
    const plugin = this.pluginNow();
    if (this.bound && this.bound.plugin === plugin) return this.bound;
    this.unbind();
    if (!plugin) return null;
    const r = bindYolo(plugin);
    if (typeof r === "string") {
      this.rejected = plugin;
      this.warnOnce(`YOLO bridge off: ${r}`);
      return null;
    }
    if (!YOLO_VERIFIED_VERSIONS.includes(r.version)) {
      this.warnOnce(`YOLO ${r.version} is untested (verified: ${YOLO_VERIFIED_VERSIONS.join(", ")})`);
    }
    const untitle = patchTitle(r.tab, (ed) => (ed && typeof ed === "object" ? this.titles.get(ed)?.() ?? null : null));
    this.bound = { ...r, untitle };
    return this.bound;
  }

  private unbind(): void {
    const b = this.bound;
    if (!b) return;
    this.bound = null;
    try {
      for (const e of this.entries) this.dismissWith(b, e.view, true);
    } catch {
      /* the old instance may already be unloaded */
    }
    b.untitle();
  }

  // Runs inside the view update: no dispatch here, side effects go through later().
  private onUpdate(entry: ViewEntry, u: ViewUpdate): void {
    const target = this.pluginNow();
    if (target !== entry.mounted || target !== (this.bound?.plugin ?? null)) {
      this.later(() => this.remount(entry)); // YOLO enabled, disabled, reloaded or updated
      return;
    }
    const b = this.bound;
    if (!b) return;
    const view = u.view;
    // The popup is on screen when visible, or when it was and completion has not been idle
    // since: CM keeps it on screen, disabled, while an incomplete list re-queries.
    const popup = popupVisible(view.state) || (entry.popupWas && completionStatus(view.state) !== null);
    if (u.selectionSet && !u.docChanged) entry.armDeferred = false;
    if (u.docChanged) {
      const userEdit = u.transactions.some(
        (tr) => tr.docChanged && (tr.isUserEvent("input") || tr.isUserEvent("delete")),
      );
      if (userEdit && !view.composing && !popup) {
        entry.armDeferred = false;
        this.later(() => this.arm(view)); // YOLO's handleEditorChange clears, then re-arms
      } else {
        entry.armDeferred = userEdit && !view.composing; // popup visible: arm once it closes
        this.later(() => this.dismiss(view, true));
      }
    } else if (popup) {
      if (this.owns(b, view)) {
        entry.armDeferred = true;
        this.later(() => this.dismiss(view, true)); // popup wins over the ghost
      }
    } else if (entry.popupWas && entry.armDeferred) {
      entry.armDeferred = false;
      this.later(() => this.arm(view)); // popup closed without an edit
    }
    entry.popupWas = popup;
  }

  /** The YOLO instance that should be mounted now (cheap; no binding). */
  private pluginNow(): unknown {
    if (this.disposed || this.broken || !this.opts.enabled()) return null;
    const p = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } })
      .plugins?.plugins?.["yolo"] ?? null;
    return p === this.rejected ? null : p;
  }

  private arm(view: EditorView): void {
    const b = this.current();
    if (!b || !view.state.selection.main.empty) return;
    const shim = this.shim(view);
    if (b.plugin.getEditorView(shim) !== view) {
      throw new Error("YOLO cannot resolve the shim's view (CodeMirror instance mismatch)");
    }
    if (typeof b.plugin.handleTabCompletionEditorChange === "function") b.plugin.handleTabCompletionEditorChange(shim);
    else b.tab.handleEditorChange(shim);
  }

  private owns(b: Bound, view: EditorView): boolean {
    const shim = this.shims.get(view);
    return (
      (!!shim && b.tab.tabCompletionPending?.editor === shim) ||
      b.tab.tabCompletionSuggestion?.view === view ||
      b.inline.activeInlineSuggestion?.view === view
    );
  }

  private dismiss(view: EditorView, disarm = false): void {
    if (this.bound) this.dismissWith(this.bound, view, disarm);
  }

  private dismissWith(b: Bound, view: EditorView, disarm: boolean): void {
    const shim = this.shims.get(view);
    if (disarm && shim && b.tab.tabCompletionPending?.editor === shim) b.tab.clearTimer();
    if (b.tab.tabCompletionSuggestion?.view === view) {
      b.tab.cancelRequest();
      b.inline.clearInlineSuggestion();
    } else if (b.inline.activeInlineSuggestion?.view === view) {
      b.inline.clearInlineSuggestion();
    }
  }

  private statusOf(view: EditorView): InlineStatus {
    const b = this.bound;
    const s = b?.tab.tabCompletionSuggestion;
    if (!b || !s || s.view !== view) return "none";
    const sel = view.state.selection.main;
    const text = s.candidates[s.selectedIndex]?.text;
    const onScreen = b.fields.some((f) => {
      const v = view.state.field(f, false) as { size?: number } | undefined;
      return typeof v?.size === "number" && v.size > 0;
    });
    return text && sel.empty && sel.head === s.cursorOffset && onScreen ? "visible" : "pending";
  }

  private accept(view: EditorView): boolean {
    const b = this.bound;
    const s = b?.tab.tabCompletionSuggestion;
    if (!b || !s || this.statusOf(view) !== "visible") return false;
    const text = s.candidates[s.selectedIndex].text;
    const to = s.cursorOffset;
    const from = s.replaceFromOffset ?? to;
    if (from > to) return false;
    b.tab.cancelRequest();
    b.inline.clearInlineSuggestion();
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      scrollIntoView: true,
      userEvent: "input.complete.ai",
    });
    return true;
  }

  private remount(entry: ViewEntry): void {
    const b = this.current(); // binds or unbinds as needed
    entry.mounted = b?.plugin ?? null;
    this.later(() => {
      if (!entry.destroyed) entry.view.dispatch({ effects: entry.compartment.reconfigure(b ? b.render : []) });
    });
  }

  private shim(view: EditorView): YoloEditorShim {
    let s = this.shims.get(view);
    if (!s) this.shims.set(view, (s = new YoloEditorShim(view)));
    return s;
  }

  private later(f: () => void): void {
    queueMicrotask(() => this.guard(undefined, f));
  }

  private guard<T>(fallback: T, f: () => T): T {
    if (this.broken) return fallback;
    try {
      return f();
    } catch (err) {
      this.broken = err instanceof Error ? err.message : String(err);
      console.error(`[${this.opts.name}] YOLO bridge disabled:`, err);
      const b = this.bound;
      this.bound = null;
      b?.untitle();
      for (const e of this.entries) {
        e.mounted = null;
        queueMicrotask(() => {
          if (!e.destroyed) e.view.dispatch({ effects: e.compartment.reconfigure([]) });
        });
      }
      return fallback;
    }
  }

  private warnOnce(msg: string): void {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    console.warn(`[${this.opts.name}] ${msg}`);
  }
}
