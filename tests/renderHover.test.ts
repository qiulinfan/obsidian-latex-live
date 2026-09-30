import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { autocompletion, closeCompletion, completionStatus, startCompletion } from "@codemirror/autocomplete";
import { EditorState, Extension } from "@codemirror/state";
import { EditorView, activateHover, closeHoverTooltips, getTooltip, hoverTooltip, keymap, showTooltip } from "@codemirror/view";
import { CursorPreviewConfig, HoverTarget, cursorPreview, hoverError, renderHover } from "../src/editor/shared/renderHover";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Span extends HoverTarget {
  src: string;
}

/** `$...$` spans: the stand-in for a language scanner. */
function spanAt(state: EditorState, pos: number): Span | null {
  for (const m of state.doc.toString().matchAll(/\$[^$\n]*\$/g)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    if (from <= pos && pos <= to) return { from, to, src: m[0] };
  }
  return null;
}

function rendered(src: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "fake-math";
  el.textContent = src;
  return el;
}

/** A language server's text hover (texlab, tinymist) at any position. */
function langHover(hoverTime = 10): Extension {
  return hoverTooltip(
    (_view, pos) => ({
      pos,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "lang-hover";
        dom.textContent = "signature";
        return { dom };
      },
    }),
    { hoverTime },
  );
}

function makeView(doc: string, extensions: Extension[], errors: unknown[] = []) {
  const sink = EditorView.exceptionSink.of((e) => errors.push(e));
  return new EditorView({ state: EditorState.create({ doc, extensions: [extensions, sink] }), parent: document.body });
}

/** Hover sections top to bottom: "render", "spinner" (a pending render) or "lang". */
function sections(view: EditorView): string[] {
  const host = view.dom.querySelector(".cm-tooltip-hover");
  if (!host) return [];
  return [...host.children].map((s) =>
    s.classList.contains("lsp-render-hover")
      ? s.classList.contains("is-pending") ? "spinner" : "render"
      : s.classList.contains("lang-hover") ? "lang" : s.className,
  );
}

/**
 * The pointer comes to rest over `pos`, through CodeMirror's own mousemove path. jsdom has
 * no layout, so the view's coordinate mapping is pinned to `pos`; CodeMirror's restart of a
 * pending hover then finds the same position again, as a resting pointer does.
 */
function pointAt(view: EditorView, pos: number) {
  Object.assign(view, {
    posAtCoords: () => pos,
    coordsAtPos: () => ({ left: 10, right: 12, top: 0, bottom: 10 }),
  });
  const line = view.contentDOM.querySelector(".cm-line")!;
  line.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 11, clientY: 5 }));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("renderHover: the render section comes first, above a language hover mounted before it", () => {
  const calls: [Span, EditorView][] = [];
  const view = makeView("a $x^2$ b", [
    langHover(),
    renderHover({
      enabled: () => true,
      target: spanAt,
      render: (t, v) => {
        calls.push([t, v]);
        return rendered(t.src);
      },
    }),
  ]);
  activateHover(view, 4, 1);
  assert.deepEqual(sections(view), ["render", "lang"]);
  const section = view.dom.querySelector(".lsp-render-hover")!;
  assert.ok(section.classList.contains("cm-tooltip-section"));
  assert.equal(section.querySelector(".fake-math")?.textContent, "$x^2$");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], { from: 2, to: 7, src: "$x^2$" }, "render gets the target's own object");
  assert.equal(calls[0][1], view);
  view.destroy();
});

test("renderHover: no section when off, outside a target, beside it, or over a rendered widget", () => {
  let on = true;
  let renders = 0;
  // "$x$" is 2..5; "$y$" (8..11) is rendered by a live widget.
  const view = makeView("a $x$ b $y$", [
    renderHover({
      enabled: () => on,
      target: spanAt,
      render: (t) => (renders++, rendered(t.src)),
      replacedAt: (_state, pos) => pos >= 8 && pos <= 11,
    }),
    langHover(),
  ]);
  const at = (pos: number, side: -1 | 1) => {
    view.dispatch({ effects: closeHoverTooltips });
    activateHover(view, pos, side);
    return sections(view);
  };
  assert.deepEqual(at(3, 1), ["render", "lang"]);
  assert.deepEqual(at(2, 1), ["render", "lang"], "pointer on the opening $");
  assert.deepEqual(at(5, -1), ["render", "lang"], "pointer on the closing $");
  assert.deepEqual(at(2, -1), ["lang"], "pointer on the space before");
  assert.deepEqual(at(5, 1), ["lang"], "pointer on the space after");
  assert.deepEqual(at(0, 1), ["lang"], "no target");
  assert.deepEqual(at(8, 1), ["lang"], "over the widget (its start)");
  on = false;
  assert.deepEqual(at(3, 1), ["lang"], "setting off");
  assert.equal(renders, 3);
  view.destroy();
});

/** `$$...$$` displays (across lines) and `$...$` spans. */
function mathAt(state: EditorState, pos: number): HoverTarget | null {
  for (const m of state.doc.toString().matchAll(/\$\$[^$]*\$\$|\$[^$\n]*\$/g)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    if (from <= pos && pos <= to) return { from, to };
  }
  return null;
}

test("renderHover: the section anchors on the pointer's line within the target, below the formula's start", () => {
  // Lines: 1 "x", 2 "$$", 3..42 the rows, 43 "$$", 44 "y $z$ ...".
  const rows = Array.from({ length: 40 }, (_, i) => `a_${i} + b_${i}`).join("\n");
  const view = makeView(`x\n$$\n${rows}\n$$\ny $z$ and more`, [
    langHover(),
    renderHover({ enabled: () => true, target: mathAt, render: () => rendered("R") }),
  ]);
  const { doc } = view.state;
  const line = (n: number) => doc.line(n);
  // The hover host merges its sections from their lowest anchor (the language hover's is
  // `pos`) to their highest end, and stays open while the pointer is over that range.
  const hostAt = (pos: number) => {
    view.dispatch({ effects: closeHoverTooltips });
    activateHover(view, pos, 1);
    assert.deepEqual(sections(view), ["render", "lang"]);
    const host = view.state.facet(showTooltip).find((t) => t)!;
    return [host.pos, host.end];
  };
  assert.deepEqual(hostAt(line(32).from + 2), [line(32).from, line(43).to], "row 30 of the display");
  assert.deepEqual(hostAt(line(2).from + 1), [line(2).from, line(43).to], "the opening line");
  assert.deepEqual(hostAt(line(44).from + 3), [line(44).from + 2, line(44).from + 5], "inline: the formula");
  view.destroy();
});

test("renderHover: a promised render that resolves in time shows directly, without a spinner", async () => {
  const d = deferred<HTMLElement | null>();
  const view = makeView("$x$", [
    renderHover({ enabled: () => true, target: spanAt, render: () => d.promise, hoverTime: 10, spinnerTime: 110 }),
  ]);
  activateHover(view, 1, 1);
  await sleep(20);
  assert.deepEqual(sections(view), []);
  d.resolve(rendered("$x$"));
  await sleep(0);
  assert.deepEqual(sections(view), ["render"]);
  await sleep(120);
  assert.deepEqual(sections(view), ["render"], "no spinner afterwards");
  view.destroy();
});

test("renderHover: a slow render shows a spinner at spinnerTime, then its result in place", async () => {
  const d = deferred<HTMLElement | null>();
  const view = makeView("$x$", [
    renderHover({ enabled: () => true, target: spanAt, render: () => d.promise, hoverTime: 10, spinnerTime: 60 }),
  ]);
  activateHover(view, 1, 1); // the pointer has rested 10 ms: the spinner is due 50 ms from now
  await sleep(25);
  assert.deepEqual(sections(view), []);
  await sleep(60);
  assert.deepEqual(sections(view), ["spinner"]);
  const section = view.dom.querySelector(".lsp-render-hover")!;
  assert.equal(section.getAttribute("aria-busy"), "true");
  assert.ok(section.querySelector(".lsp-render-hover-spinner"));
  d.resolve(rendered("$x$"));
  await sleep(5);
  assert.deepEqual(sections(view), ["render"]);
  assert.equal(view.dom.querySelector(".lsp-render-hover"), section, "filled in place");
  assert.equal(section.getAttribute("aria-busy"), null);
  assert.equal(section.textContent, "$x$");
  view.destroy();
});

test("renderHover: a hover restarted while its render is pending waits for that render", async () => {
  let targets = 0;
  const pending: ReturnType<typeof deferred<HTMLElement | null>>[] = [];
  const view = makeView("$x$ and more", [
    renderHover({
      enabled: () => true,
      target: (state, pos) => (targets++, spanAt(state, pos)),
      render: () => {
        pending.push(deferred<HTMLElement | null>());
        return pending[pending.length - 1].promise;
      },
      hoverTime: 10,
      spinnerTime: 1000,
    }),
    langHover(30),
  ]);
  // 10 ms: the render starts. 30 ms: the language section arrives, an update that makes
  // CodeMirror restart the pending render hover (20 ms later), which asks again.
  pointAt(view, 1);
  await sleep(80);
  assert.equal(targets, 2, "the hover was asked twice");
  assert.equal(pending.length, 1, "one render");
  assert.deepEqual(sections(view), ["lang"]);
  pending[0].resolve(rendered("$x$"));
  await sleep(0);
  assert.deepEqual(sections(view), ["render", "lang"], "first, although it arrived last");
  // The same formula hovered again renders again (macros or a compile may have changed it).
  view.dispatch({ effects: closeHoverTooltips });
  pointAt(view, 1);
  await sleep(20);
  assert.equal(pending.length, 2);
  view.destroy();
});

test("renderHover: a slow render that resolves to null or fails removes only its own section", async () => {
  const errors: unknown[] = [];
  const pending: ReturnType<typeof deferred<HTMLElement | null>>[] = [];
  const view = makeView(
    "$x$ and more",
    [
      renderHover({
        enabled: () => true,
        target: spanAt,
        render: () => {
          pending.push(deferred<HTMLElement | null>());
          return pending[pending.length - 1].promise;
        },
        hoverTime: 10,
        spinnerTime: 60,
      }),
      langHover(30),
    ],
    errors,
  );
  pointAt(view, 1);
  await sleep(100);
  assert.deepEqual(sections(view), ["spinner", "lang"]);
  pending[0].resolve(null);
  await sleep(5);
  assert.deepEqual(sections(view), ["lang"]);

  view.dispatch({ effects: closeHoverTooltips });
  pointAt(view, 1);
  await sleep(100);
  assert.deepEqual(sections(view), ["spinner", "lang"]);
  pending[1].reject(new Error("renderer died"));
  await sleep(5);
  assert.deepEqual(sections(view), ["lang"]);
  assert.equal(pending.length, 2, "one render per hover despite the restarts");
  assert.equal(errors.length, 1, "logged once");
  assert.match(String(errors[0]), /renderer died/);
  view.destroy();
});

test("renderHover: a render still pending when the pointer leaves the editor shows nothing", async () => {
  const pending: ReturnType<typeof deferred<HTMLElement | null>>[] = [];
  const view = makeView("$x$", [
    renderHover({
      enabled: () => true,
      target: spanAt,
      render: () => {
        pending.push(deferred<HTMLElement | null>());
        return pending[pending.length - 1].promise;
      },
      hoverTime: 10,
      spinnerTime: 60,
    }),
  ]);
  const leave = () => view.dom.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: document.body }));
  pointAt(view, 1);
  await sleep(30);
  leave();
  await sleep(60);
  assert.deepEqual(sections(view), [], "no spinner");
  pending[0].resolve(rendered("$x$"));
  await sleep(5);
  assert.deepEqual(sections(view), [], "no render");

  // Back over the formula it renders again; leaving closes the spinner, and the render
  // arriving afterwards does not reopen it.
  pointAt(view, 1);
  await sleep(80);
  assert.deepEqual(sections(view), ["spinner"]);
  leave();
  assert.deepEqual(sections(view), []);
  pending[1].resolve(rendered("$x$"));
  await sleep(5);
  assert.deepEqual(sections(view), []);
  assert.equal(pending.length, 2);
  view.destroy();
});

test("renderHover: a render that throws is logged and shows no section", () => {
  const errors: unknown[] = [];
  const view = makeView(
    "$x$",
    [
      renderHover({
        enabled: () => true,
        target: spanAt,
        render: () => {
          throw new Error("bug");
        },
      }),
      langHover(),
    ],
    errors,
  );
  activateHover(view, 1, 1);
  assert.deepEqual(sections(view), ["lang"]);
  assert.equal(errors.length, 1);
  view.destroy();
});

test("renderHover: an edit or a selection change closes the tooltip", () => {
  const view = makeView("$x$ and $y$", [
    renderHover({ enabled: () => true, target: spanAt, render: (t) => rendered(t.src) }),
  ]);
  activateHover(view, 1, 1);
  assert.deepEqual(sections(view), ["render"]);
  view.dispatch({ selection: { anchor: 5 } });
  assert.deepEqual(sections(view), []);
  activateHover(view, 9, 1);
  assert.equal(view.dom.querySelector(".fake-math")?.textContent, "$y$");
  view.dispatch({ changes: { from: 4, insert: "z" } });
  assert.deepEqual(sections(view), []);
  view.destroy();
});

test("hoverError: the message and the source, as plain text", () => {
  const el = hoverError("Missing close brace <b>", "$\\frac{a}{$");
  assert.equal(el.className, "lsp-render-hover-error");
  assert.equal(el.querySelector(".lsp-render-hover-message")?.textContent, "Missing close brace <b>");
  assert.equal(el.querySelector("b"), null);
  assert.equal(el.querySelector("pre.lsp-render-hover-source")?.textContent, "$\\frac{a}{$");
  assert.equal(hoverError("unclosed delimiter").querySelector(".lsp-render-hover-source"), null);
});

// ---- T-S13 cursor preview ------------------------------------------------------------------

/** `$$...$$` (over lines) or `$...$` around the main cursor. */
function formulaAtCursor(state: EditorState): Span | null {
  const pos = state.selection.main.head;
  for (const m of state.doc.toString().matchAll(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    if (from <= pos && pos <= to) return { from, to, src: m[0] };
  }
  return null;
}

/** An editor with a cursor preview (rendering each formula's source) on `doc`. */
function previewed(doc: string, cfg: Partial<CursorPreviewConfig<Span>> = {}, more: Extension[] = []) {
  const renders: string[] = [];
  const errors: unknown[] = [];
  const extensions = [
    more,
    cursorPreview<Span>({
      enabled: () => true,
      target: formulaAtCursor,
      render: (t) => (renders.push(t.src), rendered(t.src)),
      ...cfg,
    }),
    EditorView.exceptionSink.of((e) => errors.push(e)),
  ];
  const view = new EditorView({ state: EditorState.create({ doc, extensions }), parent: document.body });
  const tip = () => view.dom.querySelector<HTMLElement>(".cm-tooltip.lsp-cursor-preview");
  /** What the preview shows (null: no preview, or an empty one). */
  const shown = () => {
    const el = tip();
    return el && !el.classList.contains("is-empty") ? el.textContent : null;
  };
  const at = (needle: string, offset = 1) => view.state.doc.toString().indexOf(needle) + offset;
  const anchor = () => view.state.facet(showTooltip).find((t) => t)?.pos;
  return { view, extensions, renders, errors, tip, shown, at, anchor };
}

test("T-S13 cursorPreview: below the formula at the cursor, updated while typing, gone when it leaves or the editor blurs", async () => {
  let on = true;
  const { view, extensions, renders, tip, shown, at, anchor } = previewed("a $x$ b $y$ c\n$$\nz\n$$\nend", { enabled: () => on });
  view.dispatch({ selection: { anchor: at("$x$") } });
  assert.equal(tip(), null, "only while the editor has focus");
  view.focus();
  await sleep(40);
  assert.equal(shown(), "$x$");
  assert.equal(anchor(), 2, "under the formula");
  const first = tip();
  assert.ok(first?.classList.contains("cm-tooltip"));
  // Typing inside: the same tooltip renders the new text.
  view.dispatch({ changes: { from: at("x$"), insert: "^2" }, selection: { anchor: at("x$") + 3 }, userEvent: "input.type" });
  assert.equal(shown(), "$x^2$");
  assert.equal(tip(), first, "not rebuilt while typing");
  // A move inside renders nothing again; leaving hides it; the next formula gets its own.
  const n = renders.length;
  view.dispatch({ selection: { anchor: at("$x^2$", 2) } });
  assert.equal(renders.length, n);
  view.dispatch({ selection: { anchor: 0 } });
  assert.equal(tip(), null);
  view.dispatch({ selection: { anchor: at("$y$", 3) } }); // right after it
  assert.equal(shown(), "$y$");
  assert.notEqual(tip(), first);
  // A display over lines: below its last line, so the lines being typed stay visible.
  view.dispatch({ selection: { anchor: at("z", 0) } });
  assert.equal(shown(), "$$\nz\n$$");
  assert.equal(anchor(), view.state.doc.line(4).from);
  // Blurred: gone; focused again: back.
  view.contentDOM.blur();
  await sleep(40);
  assert.equal(tip(), null);
  view.focus();
  await sleep(40);
  assert.equal(shown(), "$$\nz\n$$");
  // A state set on the focused editor (another file, the history cache) shows it too.
  view.setState(EditorState.create({ doc: "p $w$", selection: { anchor: 3 }, extensions }));
  await sleep(0);
  assert.equal(shown(), "$w$");
  // The setting off: gone at the next change.
  on = false;
  view.dispatch({ selection: { anchor: 4 } });
  assert.equal(tip(), null);
  view.destroy();
});

test("T-S13 cursorPreview: hangs below the construct's last row, or flipped above its first (a soft-wrapped formula), its left edge at the anchor", async () => {
  const { view, shown, at, anchor } = previewed("a $x + y + z$ b");
  view.focus();
  await sleep(40);
  view.dispatch({ selection: { anchor: at("z") } });
  assert.equal(shown(), "$x + y + z$");
  assert.equal(anchor(), 2);
  // jsdom has no layout: the formula wraps before the second "+", its second row 20 px lower.
  Object.assign(view, {
    coordsAtPos: (pos: number) => (pos < 9 ? { left: 8 * pos, right: 8 * pos + 1, top: 0, bottom: 20 } : { left: 8 * (pos - 9), right: 8 * (pos - 9) + 1, top: 20, bottom: 40 }),
  });
  const tooltip = view.state.facet(showTooltip).find((t) => t)!;
  const coords = getTooltip(view, tooltip)!.getCoords!(tooltip.pos);
  assert.deepEqual(coords, { left: 16, right: 17, top: 0, bottom: 40 }, "from the formula's first row's top to its last row's bottom, the anchor's left edge");
  view.destroy();
});

test("T-S13 cursorPreview: a pending render keeps the last one; a failure keeps it, marked; older renders never land over newer", async () => {
  const jobs: { src: string; job: ReturnType<typeof deferred<HTMLElement | null>> }[] = [];
  const { view, errors, tip, shown, at } = previewed("a $x$ b", {
    render: (t) => {
      const job = deferred<HTMLElement | null>();
      jobs.push({ src: t.src, job });
      return job.promise;
    },
  });
  view.focus();
  await sleep(40);
  view.dispatch({ selection: { anchor: at("x") } });
  assert.equal(shown(), null, "nothing rendered yet");
  jobs[0].job.resolve(rendered(jobs[0].src));
  await sleep(0);
  assert.equal(shown(), "$x$");
  const type = (text: string) => {
    const pos = at("$ b", 0);
    view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, userEvent: "input.type" });
  };
  type("1");
  type("2");
  assert.deepEqual(jobs.map((j) => j.src), ["$x$", "$x1$", "$x12$"]);
  assert.equal(shown(), "$x$", "pending: the last rendering stays");
  jobs[2].job.resolve(rendered("$x12$"));
  await sleep(0);
  assert.equal(shown(), "$x12$");
  jobs[1].job.resolve(rendered("$x1$"));
  await sleep(0);
  assert.equal(shown(), "$x12$", "an older render landing late is dropped");
  type("(");
  jobs[3].job.resolve(hoverError("unclosed delimiter", "$x12($"));
  await sleep(0);
  assert.equal(shown(), "$x12$");
  assert.ok(tip()!.classList.contains("is-error"));
  type(")");
  jobs[4].job.resolve(rendered("$x12()$"));
  await sleep(0);
  assert.equal(shown(), "$x12()$");
  assert.ok(!tip()!.classList.contains("is-error"));
  // A new formula's first render failing shows the error; null shows nothing.
  view.dispatch({ changes: { from: view.state.doc.length, insert: " $q$" }, selection: { anchor: view.state.doc.length + 3 } });
  jobs[5].job.resolve(hoverError("unknown variable: q"));
  await sleep(0);
  assert.equal(shown(), "unknown variable: q");
  view.dispatch({ changes: { from: at("q"), insert: "q" } });
  jobs[6].job.resolve(null);
  await sleep(0);
  assert.equal(shown(), null);
  assert.ok(tip()!.classList.contains("is-empty"));
  // A rejection is logged and shows nothing.
  view.dispatch({ changes: { from: at("q"), insert: "q" } });
  jobs[7].job.reject(new Error("renderer crashed"));
  await sleep(0);
  assert.equal(shown(), null);
  assert.equal(errors.length, 1);
  view.destroy();
});

test("T-S13 cursorPreview: hidden while the completion list is open, back when it closes; no keys bound", async () => {
  const { view, tip, shown, at } = previewed("a $xy$ b", {}, [
    autocompletion({ override: [(ctx) => ({ from: ctx.pos, options: [{ label: "alpha" }] })], activateOnTyping: false }),
  ]);
  view.focus();
  await sleep(40);
  view.dispatch({ selection: { anchor: at("y") } });
  assert.equal(shown(), "$xy$");
  startCompletion(view);
  for (let i = 0; i < 50 && completionStatus(view.state) !== "active"; i++) await sleep(10);
  assert.equal(completionStatus(view.state), "active");
  assert.ok(tip()!.classList.contains("is-covered"));
  closeCompletion(view);
  assert.ok(!tip()!.classList.contains("is-covered"));
  assert.equal(shown(), "$xy$");
  view.destroy();
  const state = EditorState.create({ extensions: cursorPreview({ enabled: () => true, target: () => null, render: () => null }) });
  assert.equal(state.facet(keymap).length, 0);
});
