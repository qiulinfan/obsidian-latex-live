// Key-arbitration harness shared by tests/keyArbiter.test.ts (fake YOLO) and
// tests/yoloContract.ts (real YOLO slices): a view wired like our editors, real DOM key
// events, and the golden state x key matrix. Import "./dom" before this module.
import {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionStatus,
  hasNextSnippetField,
  hasPrevSnippetField,
  selectedCompletionIndex,
  snippet,
  startCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { EditorState, Extension } from "@codemirror/state";
import { Command, EditorView, keymap } from "@codemirror/view";
import type { App } from "obsidian";
import { keyArbiter } from "../../src/editor/shared/keyArbiter";
import { YoloBridge, YoloEditorShim } from "../../src/editor/shared/yoloBridge";
import type { YoloDouble, YoloSettings } from "./fakeYolo";
import golden from "../fixtures/keyArbiter-matrix.json";

export type YoloFactory = (opts: { settings: YoloSettings }) => YoloDouble;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeout) throw new Error("waitFor timeout");
    await sleep(5);
  }
}

// ---- fixtures ------------------------------------------------------------------------
export const OPTIONS: Completion[] = [
  { label: "\\frac", type: "function", apply: snippet("\\frac{${1}}{${2}}") },
  { label: "\\frown", type: "keyword" },
  { label: "\\alpha", type: "keyword" },
];
export function source(ctx: CompletionContext, options = OPTIONS): CompletionResult | null {
  const w = ctx.matchBefore(/\\[A-Za-z]*/);
  if (!w) return ctx.explicit ? { from: ctx.pos, options } : null;
  return { from: w.from, options, validFor: /^\\[A-Za-z]*$/ };
}
const delayed = (ms: number) => (ctx: CompletionContext) =>
  new Promise<CompletionResult | null>((r) => setTimeout(() => r(source(ctx)), ms));
/**
 * texlab-like: after `ms`, the fixture options matching the word as an incomplete list (no
 * validFor, so CM re-queries on every key and disables the popup meanwhile); null when
 * nothing matches.
 */
export const incompleteSource = (ms: number) => async (ctx: CompletionContext): Promise<CompletionResult | null> => {
  await sleep(ms);
  const w = ctx.matchBefore(/\\[A-Za-z]*/);
  const options = w ? OPTIONS.filter((o) => o.label.startsWith(w.text)) : [];
  return w && options.length ? { from: w.from, options } : null;
};

/** YOLO armed by nothing (no triggers, no idle trigger): ghosts only come from triggerNow. */
export const quietSettings = (): YoloSettings => ({
  continuationOptions: {
    enableTabCompletion: true,
    tabCompletionOptions: { idleTriggerEnabled: false, triggerDelayMs: 30 },
    tabCompletionTriggers: [],
  },
});
/** YOLO's default triggers with short delays. */
export const triggerSettings = (extra: Record<string, unknown> = {}): YoloSettings => ({
  continuationOptions: {
    enableTabCompletion: true,
    tabCompletionOptions: {
      idleTriggerEnabled: true, triggerDelayMs: 30, autoTriggerDelayMs: 60, autoTriggerCooldownMs: 0, ...extra,
    },
  },
});

export interface Ctx {
  view: EditorView;
  bridge: YoloBridge;
  yolo: YoloDouble | null;
  app: { plugins: { plugins: Record<string, unknown> } };
  flags: { enabled: boolean };
  freshState(): EditorState;
}

export interface SetupOptions {
  settings?: YoloSettings;
  doc?: string;
  /** Answer completions after this many ms (an LSP-like async source). */
  sourceDelay?: number;
  options?: Completion[];
  /** Replaces the fixture completion source. */
  source?: CompletionSource;
  enter?: Command | Command[];
  tabFallback?: Command;
  completesWord?: (state: EditorState) => boolean;
  title?: string;
  /** After the rest of the stack (e.g. live preview): keyArbiter stays first. */
  extensions?: Extension[];
}

/** A view wired like our editors: arbiter first, then the bridge, then the rest. */
export function setup(makeYolo: YoloFactory | null, o: SetupOptions = {}): Ctx {
  const yolo = makeYolo ? makeYolo({ settings: o.settings ?? quietSettings() }) : null;
  const app = { plugins: { plugins: yolo ? { yolo: yolo.plugin as unknown } : {} } };
  const flags = { enabled: true };
  const bridge = new YoloBridge(app as unknown as App, { name: "test", enabled: () => flags.enabled });
  const src = o.source ?? (o.sourceDelay ? delayed(o.sourceDelay) : (ctx: CompletionContext) => source(ctx, o.options));
  const freshState = () => EditorState.create({
    doc: o.doc ?? "",
    extensions: [
      keyArbiter({ inline: () => bridge.inline, enter: o.enter, tabFallback: o.tabFallback, completesWord: o.completesWord }),
      bridge.extension(() => o.title ?? "notes.typ"),
      history(),
      closeBrackets(),
      autocompletion({ override: [src] }),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
      o.extensions ?? [],
    ],
  });
  const view = new EditorView({ state: freshState(), parent: document.body });
  view.focus();
  return { view, bridge, yolo, app, flags, freshState };
}

export function typeText(view: EditorView, text: string): void {
  const { head } = view.state.selection.main;
  view.dispatch({ changes: { from: head, insert: text }, selection: { anchor: head + text.length }, userEvent: "input.type" });
}
export async function settle(view: EditorView): Promise<void> {
  await waitFor(() => completionStatus(view.state) === null, 1500);
  await sleep(0);
}
export async function openPopup(view: EditorView, { settleMs = 90 } = {}): Promise<void> {
  startCompletion(view);
  await waitFor(() => selectedCompletionIndex(view.state) !== null);
  if (settleMs) await sleep(settleMs);
}
/**
 * Show an AI suggestion: the bridge's triggerNow, or with `timer` YOLO's own run() as its
 * trigger timer calls it (which does not close a completion popup first); then deliver
 * `text` (optionally a second candidate).
 */
export async function ghost(
  c: Ctx,
  text: string,
  { pending = false, second = null as string | null, timer = false } = {},
): Promise<void> {
  if (timer) void c.yolo!.tab.run(new YoloEditorShim(c.view), c.view.state.selection.main.head);
  else c.bridge.triggerNow(c.view);
  if (!pending) c.yolo!.respond(second ? `${text}<yolo_next_suggestion/>${second}` : text);
  await sleep(0);
}
export function applySnippet(view: EditorView, template: string): void {
  const { head } = view.state.selection.main;
  snippet(template)(view, null as unknown as Completion, head, head);
}

// ---- keys ----------------------------------------------------------------------------
const KEYCODES: Record<string, number> = { Tab: 9, Enter: 13, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38 };
// jsdom has no elementFromPoint; @codemirror/view 6.38 calls it for vertical cursor motion.
if (!document.elementFromPoint) document.elementFromPoint = () => null;
let docEvents: string[] = [];
document.addEventListener("keydown", (e) => docEvents.push(e.key));

/** Dispatch a real keydown on the content DOM ("Tab", "Shift-Tab", ...). */
export function press(view: EditorView, spec: string): { handled: boolean; propagated: boolean } {
  const shift = spec.startsWith("Shift-");
  const key = shift ? spec.slice(6) : spec;
  const ev = new KeyboardEvent("keydown", { key, code: key, shiftKey: shift, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "keyCode", { get: () => KEYCODES[key] });
  Object.defineProperty(ev, "which", { get: () => KEYCODES[key] });
  docEvents = [];
  view.contentDOM.dispatchEvent(ev);
  return { handled: ev.defaultPrevented, propagated: docEvents.includes(key) };
}

export interface Snap {
  doc: string;
  sel: number | [number, number];
  cmp: string | null;
  pick: number | null;
  snip: "off" | "f0" | "f>0";
  ghost: string | null;
  ai: string | null;
  armed: boolean;
}
export function snap(c: Ctx): Snap {
  const st = c.view.state;
  const m = st.selection.main;
  const tab = c.yolo?.tab;
  const s = tab?.tabCompletionSuggestion;
  return {
    doc: st.doc.toString(),
    sel: m.empty ? m.head : [m.anchor, m.head],
    cmp: completionStatus(st),
    pick: selectedCompletionIndex(st),
    snip: hasNextSnippetField(st) || hasPrevSnippetField(st) ? (hasPrevSnippetField(st) ? "f>0" : "f0") : "off",
    ghost: c.view.contentDOM.querySelector(".yolo-ghost-text")?.textContent ?? null,
    ai: s ? s.candidates[s.selectedIndex].text || "(generating)" : null,
    armed: !!tab?.tabCompletionPending,
  };
}
/** What changed between two snapshots, in the golden matrix's notation. */
export function diff(b: Snap, a: Snap): string {
  const out: string[] = [];
  if (a.doc !== b.doc) out.push(`doc=${JSON.stringify(a.doc)}`);
  if (JSON.stringify(a.sel) !== JSON.stringify(b.sel)) out.push(`sel=${JSON.stringify(a.sel)}`);
  if (a.cmp !== b.cmp) out.push(`popup:${b.cmp}->${a.cmp}`);
  else if (a.pick !== b.pick) out.push(`pick:${b.pick}->${a.pick}`);
  if (a.snip !== b.snip) out.push(`snippet:${b.snip}->${a.snip}`);
  if (a.ghost !== b.ghost || a.ai !== b.ai) out.push(`ai:${JSON.stringify(b.ai)}->${JSON.stringify(a.ai)}`);
  return out.join(" ") || "no-op";
}

// ---- the golden matrix -----------------------------------------------------------------
const FRAC = "\\frac{${1}}{${2}}";
export const STATES: Record<string, (c: Ctx) => Promise<void>> = {
  none: async (c) => { typeText(c.view, "x = 1"); await settle(c.view); },
  popup: async (c) => { typeText(c.view, "a \\fr"); await openPopup(c.view); },
  snippet: async (c) => { typeText(c.view, "a "); await settle(c.view); applySnippet(c.view, FRAC); await sleep(0); },
  ghost: async (c) => { typeText(c.view, "x = 1"); await settle(c.view); await ghost(c, " + 2"); },
  ghost2: async (c) => { typeText(c.view, "x = 1"); await settle(c.view); await ghost(c, " + 2", { second: " - 3" }); },
  ghost_pending: async (c) => { typeText(c.view, "x = 1"); await settle(c.view); await ghost(c, "", { pending: true }); },
  "popup+ghost": async (c) => { typeText(c.view, "a \\fr"); await openPopup(c.view); await ghost(c, "ac{1}{2}", { timer: true }); },
  "snippet+ghost": async (c) => {
    typeText(c.view, "a "); await settle(c.view); applySnippet(c.view, FRAC); await sleep(0); await ghost(c, "n+1");
  },
  "snippet+popup": async (c) => {
    typeText(c.view, "a "); await settle(c.view); applySnippet(c.view, FRAC); typeText(c.view, "\\al"); await openPopup(c.view);
  },
  "snippet+popup+ghost": async (c) => {
    typeText(c.view, "a "); await settle(c.view); applySnippet(c.view, FRAC); typeText(c.view, "\\al"); await openPopup(c.view);
    await ghost(c, "pha", { timer: true });
  },
};
export const KEYS = ["Tab", "Shift-Tab", "Enter", "Escape", "Backspace", "ArrowDown", "ArrowUp"];

export interface Cell { handled: boolean; toDocument: boolean; outcome: string }
export const GOLDEN = golden.expected as Record<string, Record<string, Cell>>;

/** Press every key in `state` (a fresh view each) and report the cells. */
export async function matrixRow(
  makeYolo: YoloFactory,
  state: string,
  check?: (c: Ctx) => void,
  opts: SetupOptions = {},
): Promise<Record<string, Cell>> {
  const row: Record<string, Cell> = {};
  for (const key of KEYS) {
    const c = setup(makeYolo, opts);
    try {
      await STATES[state](c);
      const before = snap(c);
      const r = press(c.view, key);
      await sleep(0);
      row[key] = { handled: r.handled, toDocument: r.propagated, outcome: diff(before, snap(c)) };
      check?.(c);
    } finally {
      c.view.destroy();
      c.bridge.destroy();
    }
  }
  return row;
}
