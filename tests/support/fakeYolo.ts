// Test double for the YOLO plugin (1.6.9.7): exactly the surface yoloBridge binds to
// (plugin getters, getEditorView, handleTabCompletionEditorChange, the tab controller's
// fields and methods, the inline controller's createExtension), with the controller
// semantics ported from YOLO's main.js (o0e / w0e). The provider call is replaced by
// `respond()`, which delivers model text the way run()'s stream loop does.
//
// createExtension() also returns a Prec.highest keymap that hijacks the six keys YOLO
// binds (ArrowUp, ArrowDown, Tab, Shift-Tab, Escape, Backspace) unconditionally and
// records them in `hijacked`: if the bridge ever mounted it, every key test would fail.
import { Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType, keymap } from "@codemirror/view";

export interface YoloTrigger { type: "string" | "regex"; pattern: string; enabled: boolean; acceptMode: "insert" | "replace" }
export interface YoloSettings {
  continuationOptions: {
    enableTabCompletion?: boolean;
    tabCompletionOptions?: {
      idleTriggerEnabled?: boolean;
      triggerDelayMs?: number;
      autoTriggerDelayMs?: number;
      autoTriggerCooldownMs?: number;
    };
    tabCompletionTriggers?: YoloTrigger[];
  };
}
export interface RunCall { title: string; head: number; replaceFromOffset: number | null }

/** What tests need from a YOLO instance, fake or real (see realYolo.ts). */
export interface YoloDouble {
  /** The object that goes into app.plugins.plugins.yolo. */
  plugin: Record<string, unknown>;
  tab: {
    tabCompletionSuggestion: { candidates: { text: string }[]; selectedIndex: number; replaceFromOffset: number | null } | null;
    tabCompletionPending: unknown;
    deps: { getActiveFileTitle(): string };
    run(editor: unknown, head: number, replaceFromOffset?: number | null): Promise<void>;
  };
  inline: { createExtension(): unknown[] };
  settings: YoloSettings;
  runCalls: RunCall[];
  activeAbortControllers: Set<AbortController>;
  isContinuationInProgress: boolean;
  /** Deliver model output for the current suggestion; false when there is none. */
  respond(raw: string, opts?: { finish?: boolean }): boolean;
}

export interface FakeYolo extends YoloDouble {
  /** Keys YOLO's own keymap handled; stays empty while the bridge filters the keymap. */
  hijacked: string[];
}

const SEPARATOR = "<yolo_next_suggestion/>";
const CANDIDATES = 3;
/** YOLO's default tabCompletionTriggers. */
export const DEFAULT_TRIGGERS: YoloTrigger[] = [
  { type: "string", pattern: ", ", enabled: true, acceptMode: "insert" },
  { type: "string", pattern: "\uFF0C", enabled: true, acceptMode: "insert" },
  { type: "string", pattern: ": ", enabled: true, acceptMode: "insert" },
  { type: "string", pattern: "\uFF1A", enabled: true, acceptMode: "insert" },
  { type: "regex", pattern: "\\n$", enabled: true, acceptMode: "insert" },
  { type: "regex", pattern: "(?:^|\\n)[-*+]\\s$", enabled: true, acceptMode: "insert" },
];

interface Candidate { text: string; status: string }
interface Suggestion {
  editor: { cm: EditorView; getSelection(): string };
  view: EditorView;
  cursorOffset: number;
  replaceFromOffset: number | null;
  candidates: Candidate[];
  selectedIndex: number;
  hasUserNavigated: boolean;
}
interface Display { from: number; text: string; count: number }

const setDisplay = StateEffect.define<Display | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string, readonly count: number) {
    super();
  }
  eq(o: GhostWidget): boolean {
    return o.text === this.text && o.count === this.count;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "yolo-tab-completion-display";
    if (this.text) {
      const ghost = el.appendChild(document.createElement("span"));
      ghost.className = "yolo-ghost-text";
      ghost.textContent = this.text;
    }
    return el;
  }
}

// YOLO's multi-candidate display field: maps through changes, replaced by its effect,
// cleared by any doc change.
const displayField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setDisplay)) continue;
      const v = e.value;
      next = v ? Decoration.set([Decoration.widget({ widget: new GhostWidget(v.text, v.count), side: 1 }).range(v.from)]) : Decoration.none;
    }
    return tr.docChanged ? Decoration.none : next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function fakeYolo(opts: { settings?: YoloSettings; version?: string; title?: string } = {}): FakeYolo {
  const hijacked: string[] = [];
  const runCalls: RunCall[] = [];
  const activeAbortControllers = new Set<AbortController>();
  const double = {} as FakeYolo;

  const getEditorView = (e: unknown): EditorView | null => {
    const cm = (e as { cm?: unknown } | null)?.cm;
    return cm instanceof EditorView ? cm : null;
  };

  const tab = {
    deps: { getActiveFileTitle: (): string => opts.title ?? "yolo-basename" },
    tabCompletionTimer: null as ReturnType<typeof setTimeout> | null,
    tabCompletionAbortController: null as AbortController | null,
    tabCompletionSuggestion: null as Suggestion | null,
    tabCompletionPending: null as { editor: Suggestion["editor"]; replaceFromOffset: number | null } | null,
    lastAutoTriggerAt: 0,

    options() {
      return {
        idleTriggerEnabled: false,
        triggerDelayMs: 3000,
        autoTriggerDelayMs: 3000,
        autoTriggerCooldownMs: 15000,
        ...double.settings.continuationOptions.tabCompletionOptions,
      };
    },
    triggerMatch(view: EditorView, head: number): { replaceFromOffset: number | null } | null {
      const before = view.state.sliceDoc(Math.max(0, head - 2000), head);
      const trimmed = before.replace(/\s+$/, "");
      for (const t of double.settings.continuationOptions.tabCompletionTriggers ?? DEFAULT_TRIGGERS) {
        if (!t.enabled || !t.pattern) continue;
        if (t.type === "string") {
          if (before.endsWith(t.pattern)) return { replaceFromOffset: t.acceptMode === "replace" ? head - t.pattern.length : null };
          if (t.acceptMode !== "replace" && trimmed.endsWith(t.pattern)) return { replaceFromOffset: null };
        } else {
          const re = new RegExp(t.pattern); // replace-mode regex offsets are not modelled
          if (re.test(before) || (t.acceptMode !== "replace" && re.test(trimmed))) return { replaceFromOffset: null };
        }
      }
      return null;
    },
    clearTimer() {
      if (this.tabCompletionTimer) clearTimeout(this.tabCompletionTimer);
      this.tabCompletionTimer = null;
      this.tabCompletionPending = null;
    },
    cancelRequest() {
      const c = this.tabCompletionAbortController;
      if (!c) return;
      c.abort();
      activeAbortControllers.delete(c);
      this.tabCompletionAbortController = null;
    },
    clearSuggestion() {
      const s = this.tabCompletionSuggestion;
      if (!s) return;
      s.view.dispatch({ effects: setDisplay.of(null) });
      this.tabCompletionSuggestion = null;
    },
    handleEditorChange(editor: Suggestion["editor"]) {
      this.clearTimer();
      this.cancelRequest();
      inline.clearInlineSuggestion();
      if (!double.settings.continuationOptions.enableTabCompletion || double.isContinuationInProgress) return;
      const view = getEditorView(editor);
      if (!view || editor.getSelection()) return;
      const head = view.state.selection.main.head;
      const o = this.options();
      const match = this.triggerMatch(view, head);
      if (!match && !o.idleTriggerEnabled) return;
      const idle = !match;
      if (idle && o.autoTriggerCooldownMs > 0 && Date.now() - this.lastAutoTriggerAt < o.autoTriggerCooldownMs) return;
      this.tabCompletionPending = { editor, replaceFromOffset: match?.replaceFromOffset ?? null };
      this.tabCompletionTimer = setTimeout(() => {
        if (this.tabCompletionPending?.editor !== editor) return;
        if (getEditorView(editor)?.state.selection.main.head !== head || editor.getSelection()) return;
        if (idle) this.lastAutoTriggerAt = Date.now();
        void this.run(editor, head, this.tabCompletionPending.replaceFromOffset);
      }, idle ? o.autoTriggerDelayMs : o.triggerDelayMs);
    },
    // The synchronous prefix of YOLO's run(), minus the provider call.
    run(editor: Suggestion["editor"], head: number, replaceFromOffset?: number | null): Promise<void> {
      if (!double.settings.continuationOptions.enableTabCompletion) return Promise.resolve();
      const view = getEditorView(editor);
      if (!view || view.state.selection.main.head !== head || editor.getSelection()) return Promise.resolve();
      const title = this.deps.getActiveFileTitle();
      const from = replaceFromOffset === undefined ? this.triggerMatch(view, head)?.replaceFromOffset ?? null : replaceFromOffset;
      runCalls.push({ title, head, replaceFromOffset: from });
      this.cancelRequest();
      inline.clearInlineSuggestion();
      this.tabCompletionPending = null;
      const s: Suggestion = {
        editor, view, cursorOffset: head, replaceFromOffset: from, selectedIndex: 0, hasUserNavigated: false,
        candidates: Array.from({ length: CANDIDATES }, (_, i) => ({ text: "", status: i ? "pending" : "generating" })),
      };
      this.tabCompletionSuggestion = s;
      this.render(s);
      const abort = new AbortController();
      this.tabCompletionAbortController = abort;
      activeAbortControllers.add(abort);
      return Promise.resolve();
    },
    render(s: Suggestion) {
      if (this.tabCompletionSuggestion !== s) return;
      const c = s.candidates[s.selectedIndex];
      const count = s.candidates.filter((x) => x.text).length;
      s.view.dispatch({ effects: setDisplay.of({ from: s.cursorOffset, text: c?.text ?? "", count }) });
      inline.activeInlineSuggestion = c?.text ? { source: "tab", view: s.view, fromOffset: s.cursorOffset } : null;
    },
    cleanCandidateText(t: string): string {
      const n = t.replace(/\r\n/g, "\n").replace(/\s+$/, "");
      return n.trim() ? n.replace(/^\s+/, "") : "";
    },
    updateCandidatesFromRawText(s: Suggestion, raw: string) {
      const parts = raw.split(SEPARATOR).slice(0, s.candidates.length);
      s.candidates.forEach((c, i) => {
        if (parts[i] === undefined) {
          c.text = "";
          c.status = "pending";
          return;
        }
        c.text = this.cleanCandidateText(parts[i]);
        c.status = i < parts.length - 1 ? "complete" : "generating";
      });
      this.render(s);
    },
    finishCandidateGeneration(s: Suggestion) {
      if (this.tabCompletionSuggestion !== s) return;
      for (const c of s.candidates) c.status = c.text ? "complete" : "interrupted";
      this.render(s);
    },
    tryNavigateFromView(view: EditorView, dir: number): boolean {
      const s = this.tabCompletionSuggestion;
      if (!s || s.view !== view) return false;
      const withText = s.candidates.flatMap((c, i) => (c.text ? [i] : []));
      if (withText.length <= 1) return true;
      const at = Math.max(0, withText.indexOf(s.selectedIndex));
      s.selectedIndex = withText[(at + dir + withText.length) % withText.length];
      s.hasUserNavigated = true;
      this.render(s);
      return true;
    },
    handleSelectionChange(view: EditorView) {
      const s = this.tabCompletionSuggestion;
      if (s && s.view === view && view.state.selection.main.head !== s.cursorOffset) {
        this.cancelRequest();
        inline.clearInlineSuggestion();
      }
    },
  };

  const inline = {
    activeInlineSuggestion: null as { source: string; view: EditorView; fromOffset: number } | null,
    clearInlineSuggestion() {
      tab.clearSuggestion();
      this.activeInlineSuggestion = null;
    },
    createExtension(): unknown[] {
      const hijack = (key: string) => ({ key, run: () => (hijacked.push(key), true) });
      return [
        displayField,
        EditorView.updateListener.of((u) => {
          if (u.focusChanged && !u.view.hasFocus) {
            tab.clearTimer();
            tab.cancelRequest();
            this.clearInlineSuggestion();
            return;
          }
          if (u.selectionSet) {
            tab.handleSelectionChange(u.view);
            const a = this.activeInlineSuggestion;
            if (a && a.view === u.view && u.view.state.selection.main.head !== a.fromOffset) this.clearInlineSuggestion();
          }
        }),
        Prec.highest(keymap.of(["ArrowUp", "ArrowDown", "Tab", "Shift-Tab", "Escape", "Backspace"].map(hijack))),
      ];
    },
  };

  Object.assign(double, {
    hijacked,
    runCalls,
    activeAbortControllers,
    isContinuationInProgress: false,
    settings: opts.settings ?? { continuationOptions: { enableTabCompletion: true } },
    tab,
    inline,
    respond(raw: string, { finish = true } = {}) {
      const s = tab.tabCompletionSuggestion;
      if (!s) return false;
      tab.updateCandidatesFromRawText(s, raw);
      if (finish) tab.finishCandidateGeneration(s);
      return true;
    },
    plugin: {
      manifest: { id: "yolo", version: opts.version ?? "1.6.9.7" },
      getInlineSuggestionController: () => inline,
      getTabCompletionController: () => tab,
      getEditorView,
      handleTabCompletionEditorChange: (e: Suggestion["editor"]) => tab.handleEditorChange(e),
    },
  });
  return double;
}
