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
// Only type imports from "obsidian" are allowed here: tests bundle this without Obsidian.
import { EditorState, Extension, Prec, Text } from "@codemirror/state";
import { EditorView, Tooltip, closeHoverTooltip, hoverTooltip, logException } from "@codemirror/view";
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
