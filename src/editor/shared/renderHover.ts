// Shared with obsidian-latex-live / obsidian-tinymist: keep byte-identical (canonical copy: obsidian-tinymist/src/editor/shared).
//
// Render hover: the rendering of the formula or block under the pointer, as a section of
// CodeMirror's one hover tooltip. The language supplies `target` (the construct at a
// position, visible source only) and `render` (MathJax, a Typst SVG, a PDF crop, or a
// failure built with `hoverError`).
//   Order    CodeMirror orders hover sections by extension precedence. The render hover is
//            Prec.high, so its section sits above texlab's, tinymist's and the lint
//            hover's wherever the view mounts it.
//   Widgets  no section over a position a live widget renders (livePreview's `replacedAt`,
//            plus the config's own `replacedAt`, if any).
//   Anchor   the section anchors at the start of the pointer's line within the target and
//            stays open while the pointer is over the target from there. CodeMirror hides a
//            tooltip whose anchor is scrolled out and places the merged hover at its lowest
//            section anchor, so the formula's first line would hide every section of a long
//            display scrolled past its start.
//   Async    a promised render shows its section when it resolves. One still pending
//            `spinnerTime` ms after the pointer came to rest shows a spinner section that
//            the result replaces (null or a rejection removes it; rejections are logged).
//            CodeMirror restarts a pending hover on every view update (another hover
//            section arriving is one), so a hover asked again for the same target and
//            document while its render is pending waits for that render instead of
//            starting another. A settled render is never reused: macros, compiles and
//            renderers change outside the document. A render still pending when the
//            pointer leaves the editor shows nothing (CodeMirror would still show it).
//   Closing  hideOnChange: an edit or a selection change closes the tooltip.
// Cursor preview (`cursorPreview`, setting-gated): the rendering of the construct around the
// main cursor, floating below it (below its last row, or, flipped for want of room, above its
// first: a formula that soft-wraps or a display being typed stays visible; its left edge at
// the start of the construct's last line) while the focused editor's cursor is in it. It
// renders again after every edit in the same tooltip view (a render pending keeps the last one
// shown; a failure after a rendering keeps that rendering, marked), hides while the completion
// list is open (both would sit below the line), and goes when the cursor leaves the construct
// or the editor loses focus. It binds no keys and takes no clicks.
// Only type imports from "obsidian" are allowed here: tests bundle this without Obsidian.
import { completionStatus } from "@codemirror/autocomplete";
import { EditorState, Extension, Prec, StateEffect, StateField, Text } from "@codemirror/state";
import {
  EditorView,
  Rect,
  Tooltip,
  TooltipView,
  ViewPlugin,
  closeHoverTooltip,
  hoverTooltip,
  logException,
  showTooltip,
} from "@codemirror/view";
import { replacedAt } from "./livePreview";

/** A span of visible source that renders as one piece: a formula, an environment, a call. */
export interface HoverTarget {
  readonly from: number;
  readonly to: number;
}

export interface RenderHoverConfig<T extends HoverTarget> {
  /** Read on every hover (the `hoverRender` setting). */
  enabled(): boolean;
  /** The renderable construct around `pos` whose source is visible, or null. */
  target(state: EditorState, pos: number): T | null;
  /**
   * The rendering of `target` in `view.state`, a failure (`hoverError`), or null for no
   * section. Called once per hover.
   */
  render(target: T, view: EditorView): HTMLElement | null | Promise<HTMLElement | null>;
  /**
   * More positions to skip, on top of those a live-preview widget renders (livePreview's
   * `replacedAt`, always checked). Over a widget, CodeMirror hovers one of its ends.
   */
  replacedAt?(state: EditorState, pos: number): boolean;
  /** Rest time before the hover fires, in ms (300, as the texlab and tinymist hovers). */
  hoverTime?: number;
  /** Rest time after which a render still pending shows a spinner, in ms (400). */
  spinnerTime?: number;
}

/** A promised render, shared by the hovers asked for its target while it is pending. */
interface Job {
  doc: Text;
  from: number;
  to: number;
  /** The rendering, or null (also after a rejection, which is logged once here). */
  result: Promise<HTMLElement | null>;
  /** Date.now() at which a hover still waiting shows the spinner. */
  spinAt: number;
}

export function renderHover<T extends HoverTarget>(cfg: RenderHoverConfig<T>): Extension {
  const hoverTime = cfg.hoverTime ?? 300;
  const spinnerDelay = Math.max(0, (cfg.spinnerTime ?? 400) - hoverTime);
  const jobs = new WeakMap<EditorView, Job>();

  const source = (view: EditorView, pos: number, side: -1 | 1): Tooltip | null | Promise<Tooltip | null> => {
    const { state } = view;
    if (!cfg.enabled() || replacedAt(state, pos) || cfg.replacedAt?.(state, pos)) return null;
    const t = cfg.target(state, pos);
    // At `from` with side -1 (or `to` with side 1) the pointer is on the character outside.
    if (!t || (side < 0 && pos <= t.from) || (side > 0 && pos >= t.to)) return null;
    const at = Math.min(Math.max(state.doc.lineAt(pos).from, t.from), t.to);
    let job = jobs.get(view);
    if (!job || job.doc !== state.doc || job.from !== t.from || job.to !== t.to) {
      let out: HTMLElement | null | Promise<HTMLElement | null>;
      try {
        out = cfg.render(t, view);
      } catch (e) {
        logException(state, e, "render hover");
        return null;
      }
      if (!out || !("then" in out)) {
        const el = out;
        return el && tooltip(t, at, () => section(view, el));
      }
      const result = out.then(
        (el) => el,
        (e) => {
          logException(view.state, e, "render hover");
          return null;
        },
      );
      const started: Job = { doc: state.doc, from: t.from, to: t.to, result, spinAt: Date.now() + spinnerDelay };
      jobs.set(view, (job = started));
      void result.then(() => {
        if (jobs.get(view) === started) jobs.delete(view);
      });
    }
    return waitFor(view, t, at, job);
  };

  const waitFor = (view: EditorView, t: T, at: number, job: Job) =>
    new Promise<Tooltip | null>((resolve) => {
      let spun = false;
      let shown: HTMLElement | null = null;
      const settle = (tip: Tooltip | null) => {
        clearTimeout(timer);
        view.dom.removeEventListener("mouseleave", left);
        resolve(tip);
      };
      // CodeMirror would still show a hover that resolves after the pointer left the editor.
      const left = () => settle(null);
      view.dom.addEventListener("mouseleave", left);
      const timer = setTimeout(
        () => {
          spun = true;
          settle(tooltip(t, at, () => (shown = section(view, null))));
        },
        Math.max(0, job.spinAt - Date.now()),
      );
      void job.result.then((el) => {
        if (!spun) {
          settle(el && tooltip(t, at, () => section(view, el)));
          return;
        }
        // CodeMirror creates the spinner's section in the transaction that shows it, which
        // may still be queued behind this callback.
        setTimeout(() => {
          if (!shown?.isConnected) return; // never shown, or closed since
          if (el) fill(shown, el);
          else view.dispatch({ effects: closeHoverTooltip(hover) });
        });
      });
    });

  const hover = hoverTooltip(source, { hoverTime, hideOnChange: true });
  return Prec.high(hover);
}

function tooltip(t: HoverTarget, at: number, create: () => HTMLElement): Tooltip {
  return { pos: at, end: t.to, above: true, create: () => ({ dom: create() }) };
}

/** The hover section: `content`, or a spinner while it is pending (null). */
function section(view: EditorView, content: HTMLElement | null): HTMLElement {
  const doc = view.dom.ownerDocument;
  const dom = doc.createElement("div");
  dom.className = "lsp-render-hover";
  if (content) {
    dom.append(content);
    return dom;
  }
  dom.classList.add("is-pending");
  dom.setAttribute("aria-busy", "true");
  dom.appendChild(doc.createElement("span")).className = "lsp-render-hover-spinner";
  dom.append("Rendering…");
  return dom;
}

function fill(dom: HTMLElement, content: HTMLElement): void {
  dom.classList.remove("is-pending");
  dom.removeAttribute("aria-busy");
  dom.replaceChildren(content);
}

// ---- Cursor preview ---------------------------------------------------------------------

export interface CursorPreviewConfig<T extends HoverTarget> {
  /** Read at every selection or document change (the `cursorPreview` setting). */
  enabled(): boolean;
  /** The renderable construct around the main cursor whose source is visible, or null. */
  target(state: EditorState): T | null;
  /**
   * As renderHover's `render`, called again after every edit while the cursor stays in the
   * construct. A failure (`hoverError`) after a rendering of the construct keeps that
   * rendering (marked `is-error`); null shows nothing.
   */
  render(target: T, view: EditorView): HTMLElement | null | Promise<HTMLElement | null>;
}

interface Preview<T extends HoverTarget> {
  readonly focused: boolean;
  readonly target: T | null;
  readonly tooltip: Tooltip | null;
}

const previewFocus = StateEffect.define<boolean>();

/**
 * A floating render below the construct around the main cursor while the editor has focus
 * (see the header). The language's `target` decides which constructs get one.
 */
export function cursorPreview<T extends HoverTarget>(cfg: CursorPreviewConfig<T>): Extension {
  const field: StateField<Preview<T>> = StateField.define<Preview<T>>({
    create: () => ({ focused: false, target: null, tooltip: null }),
    update(value, tr) {
      let focused = value.focused;
      for (const e of tr.effects) if (e.is(previewFocus)) focused = e.value;
      if (focused === value.focused && !tr.docChanged && !tr.selection && !tr.reconfigured) return value;
      const target = focused && cfg.enabled() ? cfg.target(tr.state) : null;
      if (!target) return value.tooltip || focused !== value.focused ? { focused, target: null, tooltip: null } : value;
      const old = value.target;
      // The same construct (its start mapped through the edit) keeps its tooltip view, which
      // renders it again: typing never rebuilds the tooltip or blanks it.
      const same = !!old && !!value.tooltip && tr.changes.mapPos(old.from) === target.from;
      if (same && !tr.docChanged && old.to === target.to) return value;
      const { doc } = tr.state;
      const pos = Math.min(Math.max(doc.lineAt(target.to).from, target.from), target.to);
      const create = same ? value.tooltip!.create : (view: EditorView) => previewView(view, cfg, field);
      return { focused, target, tooltip: { pos, above: false, create } };
    },
    provide: (f) => showTooltip.from(f, (v) => v.tooltip),
  });
  // A state set on a focused editor (setState, HistoryCache) starts out unfocused.
  const focusSync = ViewPlugin.fromClass(
    class {
      private destroyed = false;
      constructor(view: EditorView) {
        queueMicrotask(() => {
          if (!this.destroyed && view.hasFocus !== view.state.field(field, false)?.focused) {
            view.dispatch({ effects: previewFocus.of(view.hasFocus) });
          }
        });
      }
      destroy() {
        this.destroyed = true;
      }
    },
  );
  return [field, focusSync, EditorView.focusChangeEffect.of((_state, focusing) => previewFocus.of(focusing))];
}

function previewView<T extends HoverTarget>(
  view: EditorView,
  cfg: CursorPreviewConfig<T>,
  field: StateField<Preview<T>>,
): TooltipView {
  const doc = view.dom.ownerDocument;
  const dom = doc.createElement("div");
  dom.className = "lsp-cursor-preview is-empty";
  const body = dom.appendChild(doc.createElement("div"));
  body.className = "lsp-render-hover";
  /** The construct and text last rendered. */
  let last: { doc: Text; from: number; to: number } | null = null;
  let asked = 0;
  let shown = 0;
  /** A rendering of the construct is on screen. */
  let rendered = false;

  const show = (el: HTMLElement | null) => {
    const failed = !!el?.classList.contains("lsp-render-hover-error");
    dom.classList.toggle("is-error", failed && rendered);
    if (failed && rendered) return; // the last rendering stays
    rendered = !!el && !failed;
    body.replaceChildren(...(el ? [el] : []));
    dom.classList.toggle("is-empty", !el);
  };

  const render = (state: EditorState) => {
    const t = state.field(field, false)?.target;
    if (!t || (last && last.doc === state.doc && last.from === t.from && last.to === t.to)) return;
    last = { doc: state.doc, from: t.from, to: t.to };
    const n = ++asked;
    let out: HTMLElement | null | Promise<HTMLElement | null>;
    try {
      out = cfg.render(t, view);
    } catch (e) {
      logException(state, e, "cursor preview");
      out = null;
    }
    // Renders may land out of order: an older one never replaces a newer one.
    const land = (el: HTMLElement | null) => {
      if (n <= shown) return;
      shown = n;
      show(el);
    };
    if (!out || !("then" in out)) return land(out);
    out.then(land, (e) => {
      logException(view.state, e, "cursor preview");
      land(null);
    });
  };

  // The completion list would cover it (both sit below the line): hidden while it is open.
  const cover = (state: EditorState) => dom.classList.toggle("is-covered", completionStatus(state) === "active");
  cover(view.state);
  render(view.state);
  return {
    dom,
    // The construct's rows, not its anchor's: below its last row, or, flipped for want of room
    // near the pane's bottom, above its first (a formula that soft-wraps, or a display, would
    // otherwise have the row being typed covered). The left edge stays at the anchor (the end
    // would push a wide rendering past the editor's right edge).
    getCoords(pos) {
      const t = view.state.field(field, false)?.target;
      const at = view.coordsAtPos(pos);
      const first = t && view.coordsAtPos(t.from, 1);
      const end = t && view.coordsAtPos(t.to, -1);
      return (at && end ? { left: at.left, right: at.right, top: first ? first.top : end.top, bottom: end.bottom } : at) as Rect;
    },
    update(u) {
      cover(u.state);
      render(u.state);
    },
    destroy() {
      shown = Infinity;
    },
  };
}

/**
 * A render failure for the hover section: the renderer's message and, when given, the
 * source it failed on (both as plain text).
 */
export function hoverError(message: string, source?: string, doc: Document = document): HTMLElement {
  const dom = doc.createElement("div");
  dom.className = "lsp-render-hover-error";
  const text = dom.appendChild(doc.createElement("div"));
  text.className = "lsp-render-hover-message";
  text.textContent = message;
  if (source) {
    const pre = dom.appendChild(doc.createElement("pre"));
    pre.className = "lsp-render-hover-source";
    pre.textContent = source;
  }
  return dom;
}
