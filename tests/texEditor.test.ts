// The LaTeX editor's real extension stack (texEditorExtensions) with a fake YOLO and the
// built-in completion layer (no texlab): key arbitration end to end, real DOM key events.
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { completionStatus, currentCompletions, selectedCompletionIndex } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { forEachDiagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, HoverTooltipSource, activateHover, closeHoverTooltips } from "@codemirror/view";
import type { App } from "obsidian";
import { latexCompletionSource } from "../src/editor/latexCompletion";
import { latexLiveLanguage } from "../src/editor/latexLive";
import { DEFAULT_REF_NAMES } from "../src/editor/latexRefs";
import { LatexMath } from "../src/editor/latexScan";
import { ProjectMath } from "../src/editor/mathjaxProject";
import { FragmentRenderer, livePreview } from "../src/editor/shared/livePreview";
import { hoverError } from "../src/editor/shared/renderHover";
import { YoloBridge } from "../src/editor/shared/yoloBridge";
import { TexEditorOptions, TexHoverOptions, showTexDiagnostics, texEditorExtensions } from "../src/editor/texExtensions";
import type { TexDiagnostic } from "../src/tex/logParser";
import { projectDefinitions } from "../src/tex/macros";
import { FakeYolo, fakeYolo } from "./support/fakeYolo";
import { Ctx, diff, ghost, press, quietSettings, sleep, snap, typeText, waitFor } from "./support/keyMatrix";
import { obsidianMathJax } from "./support/mathjax";

interface TexCtx extends Ctx {
  yolo: FakeYolo;
}

/** A LaTeX editor as TexView builds it; `|` marks the cursor. */
function make(text: string, edits: string[] = [], more: Partial<TexEditorOptions> = {}): TexCtx {
  const cursor = text.indexOf("|");
  const doc = text.replace("|", "");
  const yolo = fakeYolo({ settings: quietSettings() });
  const app = { plugins: { plugins: { yolo: yolo.plugin } } };
  const flags = { enabled: true };
  const bridge = new YoloBridge(app as unknown as App, { name: "test", enabled: () => flags.enabled });
  const freshState = () =>
    EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: texEditorExtensions({
        text: doc,
        inline: () => bridge.inline,
        yolo: bridge.extension(() => "notes.tex"),
        completion: latexCompletionSource(null),
        onEdit: (view) => edits.push(view.state.doc.toString()),
        ...more,
      }),
    });
  const view = new EditorView({ state: freshState(), parent: document.body });
  view.focus();
  return { view, bridge, yolo, app, flags, freshState };
}

/** Wait for the completion query and the popup's interactionDelay. */
async function settle(view: EditorView) {
  await sleep(130);
  for (let i = 0; i < 100 && completionStatus(view.state) === "pending"; i++) await sleep(10);
  await sleep(90);
}

function done(c: TexCtx) {
  assert.deepEqual(c.yolo.hijacked, [], "YOLO's own keymap must never be mounted");
  c.view.destroy();
  c.bridge.destroy();
}

/** Type through the input handlers (closeBrackets, mathInput), one key at a time. */
function typeKeys(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection.main;
    const insert = () => view.state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    if (!view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, insert))) view.dispatch(insert());
  }
}

const line = (view: EditorView) => {
  const head = view.state.selection.main.head;
  const l = view.state.doc.lineAt(head);
  return l.text.slice(0, head - l.from) + "|" + l.text.slice(head - l.from);
};

test("popup: Tab accepts \\frac with fields; the ghost never competes", async () => {
  const c = make("x |");
  typeText(c.view, "\\fra");
  await settle(c.view);
  assert.equal(currentCompletions(c.view.state)[0]?.label, "frac");
  // YOLO's timer fires while the popup is open: the bridge hides the ghost at once.
  await ghost(c, "c{1}{2}", { timer: true });
  await sleep(0);
  assert.equal(snap(c).ghost, null);
  const r = press(c.view, "Tab");
  assert.equal(r.handled, true);
  assert.equal(line(c.view), "x \\frac{|}{}");
  done(c);
});

test("ghost: Tab accepts the raw AI text in one undo step; YOLO sees the .tex title", async () => {
  const c = make("We have $x |");
  await ghost(c, "< y$ for all <x>.");
  assert.equal(c.yolo.runCalls[0]?.title, "notes.tex");
  assert.equal(snap(c).ghost !== null, true);
  press(c.view, "Tab");
  assert.equal(c.view.state.doc.toString(), "We have $x < y$ for all <x>.", "no Markdown escaping");
  undo(c.view);
  assert.equal(c.view.state.doc.toString(), "We have $x ");
  done(c);
});

test("Enter after \\begin{itemize} closes it and dismisses a visible ghost", async () => {
  const c = make("\\begin{itemize}|");
  await ghost(c, "\\item first");
  const b = snap(c);
  press(c.view, "Enter");
  await sleep(0);
  assert.equal(diff(b, snap(c)), 'doc="\\\\begin{itemize}\\n    \\\\item \\n\\\\end{itemize}" sel=26 ai:"\\\\item first"->null');
  done(c);
});

test("smart Enter: an exact match makes a newline, Enter never accepts AI", async () => {
  const c = make("$|$");
  typeText(c.view, "\\alpha");
  await settle(c.view);
  assert.equal(currentCompletions(c.view.state)[0]?.label, "alpha");
  press(c.view, "Enter");
  assert.equal(c.view.state.doc.toString(), "$\\alpha\n$");
  done(c);

  const g = make("text|");
  await ghost(g, " more");
  press(g.view, "Enter");
  assert.equal(g.view.state.doc.toString(), "text\n");
  done(g);
});

test("Tab with nothing to accept inserts spaces mid-word, indents in leading space", () => {
  const c = make("    \\item te|xt");
  press(c.view, "Tab");
  // Spaces to the next indent stop (4-space unit), the line itself does not move.
  assert.equal(c.view.state.doc.toString(), "    \\item te    xt");
  c.view.dispatch({ selection: { anchor: 0 } });
  press(c.view, "Tab");
  assert.equal(c.view.state.doc.toString(), "        \\item te    xt");
  done(c);
});

test("Tab right after a letter still inserts spaces when no completion comes", async () => {
  // CM reports completions as loading for 100 ms after every typed letter, even when the
  // source then answers nothing; Tab-ahead used to swallow that Tab.
  const c = make("a & word|");
  typeText(c.view, "s");
  assert.equal(press(c.view, "Tab").handled, true);
  await sleep(300);
  assert.equal(line(c.view), "a & words   |");
  done(c);
});

test("Escape with nothing to close is swallowed but still reaches the document", () => {
  const c = make("a|");
  const r = press(c.view, "Escape");
  assert.deepEqual(r, { handled: true, propagated: true });
  done(c);
});

test("$ pairs, wraps a selection, and $|$ + $ becomes display math; \\[ gets its \\]", () => {
  const c = make("see |");
  const input = (text: string) => {
    const { from, to } = c.view.state.selection.main;
    const handled = c.view.state.facet(EditorView.inputHandler).some((h) => h(c.view, from, to, text, () => c.view.state.update({ changes: { from, to, insert: text } })));
    if (!handled) c.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  };
  input("$");
  assert.equal(line(c.view), "see $|$");
  input("$");
  assert.equal(line(c.view), "see $$|$$");
  c.view.dispatch({ changes: { from: 0, to: c.view.state.doc.length, insert: "area x^2 here" }, selection: { anchor: 5, head: 8 } });
  input("$");
  assert.equal(c.view.state.doc.toString(), "area $x^2$ here");
  c.view.dispatch({ changes: { from: 0, to: c.view.state.doc.length, insert: "a \\" }, selection: { anchor: 3 } });
  input("[");
  assert.equal(line(c.view), "a \\[|\\]");
  c.view.dispatch({ changes: { from: 0, to: c.view.state.doc.length, insert: "$$" }, selection: { anchor: 1 } });
  press(c.view, "Backspace");
  assert.equal(c.view.state.doc.toString(), "", "Backspace deletes an empty $|$ pair");
  input("\\");
  input("(");
  assert.equal(line(c.view), "\\(|\\)");
  press(c.view, "Backspace");
  assert.equal(c.view.state.doc.toString(), "", "Backspace deletes an empty \\(|\\) pair");
  for (const ch of "costs \\$5 and \\{x\\}") input(ch);
  assert.equal(line(c.view), "costs \\$5 and \\{x\\}|", "escaped $ { } are never paired");
  done(c);
});

test("edits are reported once committed; an IME composition waits for compositionend", async () => {
  const edits: string[] = [];
  const c = make("|", edits);
  typeText(c.view, "a");
  assert.equal(edits.length, 1);
  c.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  typeText(c.view, "ni");
  assert.equal(edits.length, 1, "nothing saved or synced mid-composition");
  c.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await sleep(10);
  assert.equal(edits.at(-1), "ani");
  done(c);
});

// KY-2 / LL-ENTER-PENDING-BEGIN: Enter typed right after `\begin{ali` (closeBrackets' `}`
// after the cursor) while the name's completion is still loading completes the name.
for (const [typed, want] of [
  ["\\begin{ali", "\\begin{align}\n    \n\\end{align}"],
  ["\\begin{itemi", "\\begin{itemize}\n    \\item \n\\end{itemize}"],
  ["\\begin{proof", "\\begin{proof}\n    \n\\end{proof}"],
  ["\\begin{myenv", "\\begin{myenv}\n    \n\\end{myenv}"],
] as const) {
  test(`fast Enter after ${typed} waits for the name's completion`, async () => {
    const c = make("|");
    typeKeys(c.view, typed);
    assert.equal(line(c.view), typed + "|}");
    assert.equal(completionStatus(c.view.state), "pending");
    assert.equal(press(c.view, "Enter").handled, true);
    await sleep(600);
    assert.equal(c.view.state.doc.toString(), want);
    done(c);
  });
}

test("Enter inside the popup's interactionDelay after \\begin{ali accepts once it ends", async () => {
  const c = make("|");
  typeKeys(c.view, "\\begin{ali");
  await waitFor(() => selectedCompletionIndex(c.view.state) !== null);
  press(c.view, "Enter");
  await sleep(300);
  assert.equal(c.view.state.doc.toString(), "\\begin{align}\n    \n\\end{align}");
  done(c);
});

test("fast Enter after \\begin{ali is dropped when typing goes on", async () => {
  const c = make("|");
  typeKeys(c.view, "\\begin{ali");
  press(c.view, "Enter");
  typeKeys(c.view, "g");
  await sleep(600);
  assert.equal(line(c.view), "\\begin{alig|}");
  done(c);
});

test("$, { and \\( \\[ pair after Chinese text and before Chinese punctuation", () => {
  for (const punct of "，。：；）") {
    const c = make(`设|${punct}则`);
    typeKeys(c.view, "$");
    assert.equal(line(c.view), `设$|$${punct}则`);
    typeKeys(c.view, "x$");
    assert.equal(line(c.view), `设$x$|${punct}则`, "the closing $ steps over");
    done(c);
  }
  const c = make("设|，则");
  typeKeys(c.view, "$$");
  assert.equal(line(c.view), "设$$|$$，则", "$$ still opens display math");
  c.view.dispatch({ changes: { from: 0, to: c.view.state.doc.length, insert: "𠀀，" }, selection: { anchor: 2 } });
  typeKeys(c.view, "$x$");
  assert.equal(line(c.view), "𠀀$x$|，", "a Han character outside the BMP counts too");
  c.view.dispatch({ changes: { from: 0, to: c.view.state.doc.length, insert: "见\\ref，" }, selection: { anchor: 5 } });
  typeKeys(c.view, "{");
  assert.equal(line(c.view), "见\\ref{|}，");
  c.view.dispatch({ changes: { from: 0, to: c.view.state.doc.length, insert: "$x+y" }, selection: { anchor: 4 } });
  typeKeys(c.view, "$");
  assert.equal(line(c.view), "$x+y$|", "after a Latin letter $ closes math, as before");
  for (const [open, close] of [["\\(", "\\)"], ["\\[", "\\]"]]) {
    c.view.dispatch({ changes: { from: 0, to: c.view.state.doc.length, insert: "见，" }, selection: { anchor: 1 } });
    typeKeys(c.view, open);
    assert.equal(line(c.view), `见${open}|${close}，`, `${open} pairs before Chinese punctuation`);
  }
  done(c);
});

test("no completion popup in % comments or verbatim; Enter stays a newline", async () => {
  for (const text of ["x % note: |", "\\begin{verbatim}\n|\n\\end{verbatim}"]) {
    const c = make(text);
    typeKeys(c.view, "\\fr");
    await settle(c.view);
    assert.deepEqual(currentCompletions(c.view.state), [], text);
    press(c.view, "Enter");
    assert.equal(line(c.view), "|", text);
    done(c);
  }
  // Outside the comment the same keys complete.
  const c = make("x |% note");
  typeKeys(c.view, "\\fr");
  await settle(c.view);
  assert.equal(currentCompletions(c.view.state)[0]?.label, "frac");
  done(c);
});

test("compile diagnostics: a new error on the line being typed waits for a pause or for the cursor to leave", async () => {
  const c = make("\\documentclass{article}\n\\begin{document}\n  See |\n\\end{document}", [], { diagnostics: true });
  const view = c.view;
  /** What the lint layer shows, as "line:message" (and the underline's start column). */
  const shown = () => {
    const out: string[] = [];
    forEachDiagnostic(view.state, (d, from) => {
      const l = view.state.doc.lineAt(from);
      out.push(`${l.number}:${from - l.from}:${d.message}`);
    });
    return out.sort();
  };
  const diag = (line: number, message: string, severity: TexDiagnostic["severity"] = "error"): TexDiagnostic => ({ severity, file: null, line, message });
  const warning = diag(1, "Font shape undefined.", "warning");
  const undefinedCs = diag(3, "Undefined control sequence.");

  // A compile after the save debounce reports the half-typed `\fr` on the line being typed.
  typeKeys(view, "\\fr");
  press(view, "Escape");
  showTexDiagnostics(view, [undefinedCs, warning]);
  assert.deepEqual(shown(), ["1:0:Font shape undefined."], "held on the typing line; other lines show at once");
  await sleep(1000);
  assert.deepEqual(shown(), ["1:0:Font shape undefined."], "still inside the pause");
  await sleep(700);
  assert.deepEqual(shown(), ["1:0:Font shape undefined.", "3:2:Undefined control sequence."], "shown after a 1.5 s pause");

  // Typing on: the error the next compile still reports stays; once fixed it goes at once.
  typeKeys(view, "a");
  showTexDiagnostics(view, [undefinedCs, warning]);
  assert.deepEqual(shown(), ["1:0:Font shape undefined.", "3:2:Undefined control sequence."]);
  showTexDiagnostics(view, [warning]);
  assert.deepEqual(shown(), ["1:0:Font shape undefined."], "a fixed error disappears immediately");

  // A new error while typing waits; leaving the line shows it.
  typeKeys(view, "c");
  showTexDiagnostics(view, [diag(3, "Missing $ inserted."), warning]);
  assert.deepEqual(shown(), ["1:0:Font shape undefined."]);
  view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
  await sleep(0);
  assert.deepEqual(shown(), ["1:0:Font shape undefined.", "3:2:Missing $ inserted."], "the cursor left the line");
  done(c);
});

// ---- T-L4: render hover and texlab's hover -----------------------------------------------------

/** Hover sections top to bottom: "render", "texlab", "lint" (a diagnostic), "error" (hoverError). */
function hoverSections(view: EditorView): string[] {
  const host = view.dom.querySelector(".cm-tooltip-hover");
  return host
    ? [...host.children].map((s) =>
        s.classList.contains("lsp-render-hover")
          ? s.querySelector(".lsp-render-hover-error") ? "error" : "render"
          : s.querySelector(".texlab-hover") || s.classList.contains("texlab-hover") ? "texlab" : s.querySelector(".cm-diagnostic") ? "lint" : s.className,
      )
    : [];
}

function hoverAt(view: EditorView, pos: number, side: -1 | 1 = 1): string[] {
  view.dispatch({ effects: closeHoverTooltips });
  activateHover(view, pos, side);
  return hoverSections(view);
}

/** A texlab stand-in: a text hover at any position, recording where it was asked. */
function fakeTexlab(calls: number[]): HoverTooltipSource {
  return (_view, pos) => {
    calls.push(pos);
    return {
      pos,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "texlab-hover";
        dom.textContent = "texlab";
        return { dom };
      },
    };
  };
}

const fakeRender = (rendered: LatexMath[]): TexHoverOptions["render"] => (m) => {
  rendered.push(m);
  const el = document.createElement("span");
  el.className = "fake-math";
  el.textContent = m.src;
  return el;
};

test("render hover: a formula's section, texlab quiet inside math, texlab elsewhere", () => {
  const lsp: number[] = [];
  const rendered: LatexMath[] = [];
  let on = true;
  // "$\alpha + x$" is 4..16; "\[y\]" is 21..27.
  const c = make("see $\\alpha + x$ and \\[y\\] \\ref{a}|", [], {
    hover: { enabled: () => on, render: fakeRender(rendered), lsp: fakeTexlab(lsp) },
  });
  const view = c.view;
  assert.deepEqual(hoverAt(view, 6), ["render"], "on \\alpha: texlab would only repeat the glyph");
  assert.deepEqual(lsp, []);
  assert.equal(view.dom.querySelector(".fake-math")?.textContent, "\\alpha + x");
  assert.deepEqual(hoverAt(view, 24), ["render"]);
  assert.deepEqual([rendered[1].display, rendered[1].src], [true, "y"]);
  assert.deepEqual(hoverAt(view, 30), ["texlab"], "outside math: texlab alone");
  assert.deepEqual(hoverAt(view, 4, -1), ["texlab"], "the character before the formula");
  on = false;
  assert.deepEqual(hoverAt(view, 6), ["texlab"], "rendering off: texlab's hover inside math too");
  assert.equal(rendered.length, 2);
  done(c);
});

const NO_REFS = { numbers: new Map(), labels: new Map(), cites: new Map(), names: DEFAULT_REF_NAMES };

test("render hover: above the lint hover of a compile error; neither hover over a live widget", async () => {
  const rendered: LatexMath[] = [];
  const texlab: number[] = [];
  let on = true;
  const renderer: FragmentRenderer = {
    epoch: 0,
    render: (req) => ({ ok: true, node: Object.assign(document.createElement("span"), { textContent: req.src }) }),
  };
  // Live preview: "$y$" (22..25) is rendered in place; "$x$" (18..21) holds the cursor, and the
  // display formula (line 1) has a compile error, so both show their source.
  const c = make("\\[ \\frac{a}{b} \\]\n$x|$ $y$\n", [], {
    diagnostics: true,
    hover: { enabled: () => on, render: fakeRender(rendered), lsp: fakeTexlab(texlab) },
    live: livePreview({ language: latexLiveLanguage({ refs: () => NO_REFS }), renderer }),
  });
  const view = c.view;
  showTexDiagnostics(view, [{ severity: "error", file: null, line: 1, message: "Missing $ inserted." }]);
  await sleep(50);
  assert.deepEqual(
    [...view.contentDOM.querySelectorAll(".lsp-lp-render")].map((w) => w.textContent),
    ["y"],
    "only $y$ is a widget",
  );
  assert.deepEqual(hoverAt(view, 5), ["render", "lint"]);
  assert.deepEqual(hoverAt(view, 19), ["render"]);
  assert.deepEqual(hoverAt(view, 22), [], "over the widget (its start)");
  assert.deepEqual(hoverAt(view, 24), []);
  assert.deepEqual(rendered.map((m) => m.src), [" \\frac{a}{b} ", "x"]);
  assert.deepEqual(texlab, [], "texlab: inside math, or over the widget");
  on = false;
  assert.deepEqual(hoverAt(view, 19), ["texlab"], "rendering off: texlab's hover in the revealed source");
  assert.deepEqual(hoverAt(view, 23), [], "never over the widget");
  assert.deepEqual(texlab, [19]);
  done(c);
});

test("render hover: the project's MathJax end to end, with MathJax's message on failure", async () => {
  const { window, MathJax } = await obsidianMathJax();
  const math = ProjectMath.create(MathJax, window.document, {
    statements: projectDefinitions(`${process.cwd()}/tests/fixtures/elegantbook/main.tex`).statements,
    physics: false,
  });
  const labels = new Map([["eq:var-def", "1.2"]]);
  const render: TexHoverOptions["render"] = (m, view) => {
    try {
      return math.render(m.src, m.display, labels) as HTMLElement;
    } catch (e) {
      return hoverError((e as Error).message, view.state.sliceDoc(m.from, m.to));
    }
  };
  const c = make("$\\E[Q]{X}$ and $\\frac{a}{$\n\\begin{align}\n  a &= b \\label{eq:var-def}\n\\end{align}\n|", [], {
    hover: { enabled: () => true, render, lsp: fakeTexlab([]) },
  });
  const view = c.view;
  assert.deepEqual(hoverAt(view, 3), ["render"]);
  assert.ok(view.dom.querySelector(".lsp-render-hover mjx-container"));
  assert.deepEqual(hoverAt(view, 18), ["error"]);
  assert.equal(view.dom.querySelector(".lsp-render-hover-message")?.textContent, "Missing close brace");
  assert.equal(view.dom.querySelector(".lsp-render-hover-source")?.textContent, "$\\frac{a}{$");
  assert.deepEqual(hoverAt(view, 35), ["render"], "inside the align");
  const tag = [...view.dom.querySelectorAll(".lsp-render-hover mjx-mtd mjx-c")].map((g) => g.className.split(" ")[0]);
  assert.ok(tag.join(",").includes("mjx-c28,mjx-c31,mjx-c2E,mjx-c32,mjx-c29"), "\\label -> \\tag{1.2}");
  done(c);
});
