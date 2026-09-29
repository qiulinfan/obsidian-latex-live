import type { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { readAuxLabels } from "../tex/aux";
import { projectDefinitions } from "../tex/macros";
import type { LatexMath } from "./latexScan";
import { MathError, MathJaxLike, ProjectMath, ProjectMathInput, inputEpoch } from "./mathjaxProject";
import { hoverError } from "./shared/renderHover";

// Rendering for LaTeX editors (design 4.1, 4.8): one ProjectMath per root document over
// Obsidian's MathJax, and the render hover's chain (P1: MathJax only). Obsidian's MathJax
// functions come in through the host, so tests run this on the same MathJax bundle.
//   Rebuilds  a saved project file (300 ms) or an edit touching a definition line (500 ms)
//             re-reads the definitions, and a new instance is built only when the statements,
//             physics or unsupported macros changed (every TeX input costs memory, see
//             mathjaxProject's Lifetime). A compile result re-reads only the .aux labels,
//             which are a render argument: it never builds an instance.
//   Cache     rendered formulas per root (display + source -> node or MathJax's message,
//             CACHE_SIZE, least recently used out), handed out as clones; dropped when the
//             instance or the labels change. A hover repeated over a formula costs a clone.
//   Styles    after a new render MathJax's stylesheet is updated at once (its glyph rules are
//             added only when chtmlStylesheet() runs) and put into the main window's head if
//             Obsidian has not yet, so the first hover never draws without glyph CSS; a
//             popout window gets a copy of its rules. finishRenderMath() still runs for
//             Obsidian's own bookkeeping.

/** An edit touching such a line may change what the project defines. */
const DEFINITION_LINE =
  /\\(?:(?:re|provide)?newcommand|[egx]?def|let|Declare|(?:New|Renew|Provide)DocumentCommand|(?:re)?newenvironment|input|include|usepackage|RequirePackage)/;
const FILE_DEBOUNCE_MS = 300;
const EDIT_DEBOUNCE_MS = 500;
const CACHE_SIZE = 200;

export interface TexRenderHost {
  /** The build folder of a root document (its .aux files hold the label numbers). */
  outDirFor(root: string): string;
  /** Text of the open LaTeX editors by absolute path (unsaved edits count). */
  buffers(): ReadonlyMap<string, string>;
  /** Obsidian's MathJax. */
  mathJax: ObsidianMath;
}

/** Obsidian's MathJax as main.ts passes it (loadMathJax, window.MathJax, finishRenderMath). */
export interface ObsidianMath {
  /** Load the script (loadMathJax). */
  load(): Promise<void>;
  /** `window.MathJax`, whatever state it is in. */
  global(): MathJaxLike | undefined;
  /** finishRenderMath: puts the CHTML stylesheet into the main window (debounced). */
  finish(): Promise<void>;
  /** The main window's document, where MathJax creates its nodes. */
  document: Document;
}

interface RootMath {
  math: ProjectMath;
  /** Label key -> number text from the build folder's .aux files. */
  labels: ReadonlyMap<string, string>;
  /** The project files the definitions came from. */
  files: Set<string>;
  /** Display flag + formula source -> its rendering or MathJax's message (see Cache). */
  cache: Map<string, Element | string>;
  timer: number | null;
  labelTimer: number | null;
}

export class TexRender {
  private roots = new Map<string, RootMath>();
  private loading: Promise<MathJaxLike | null> | null = null;
  /** MathJax's stylesheet as of the last new render. */
  private sheet: HTMLStyleElement | null = null;
  /** Each popout window's copy of MathJax's stylesheet, with the number of rules copied. */
  private popoutSheets = new WeakMap<Document, { el: HTMLStyleElement; rules: number }>();

  constructor(private host: TexRenderHost) {}

  /** Obsidian's MathJax once its script ran, else null. */
  private mathJax(): MathJaxLike | null {
    const mj = this.host.mathJax.global();
    return typeof mj?.tex2chtml === "function" && mj.startup?.output ? mj : null;
  }

  /** Load Obsidian's MathJax (once), so the first hover need not wait for it. */
  load(): Promise<MathJaxLike | null> {
    this.loading ??= this.host.mathJax
      .load()
      .then(async () => {
        await this.host.mathJax.global()?.startup?.promise;
        return this.mathJax();
      })
      .catch((e: unknown) => {
        console.error("LaTeX Live: MathJax failed to load", e);
        return null;
      });
    return this.loading;
  }

  /** The render hover's section for a formula of a document under `root`. */
  hover(math: LatexMath, view: EditorView, root: string): HTMLElement | Promise<HTMLElement> {
    const source = view.state.sliceDoc(math.from, math.to);
    const doc = view.dom.ownerDocument;
    const mj = this.mathJax();
    if (mj) return this.renderMath(mj, math, source, root, doc);
    return this.load().then((loaded) =>
      loaded ? this.renderMath(loaded, math, source, root, doc) : hoverError("MathJax is not available.", source, doc),
    );
  }

  /** A vault file was saved: rebuild the projects that read it. */
  fileModified(abs: string): void {
    for (const [root, r] of this.roots) if (r.files.has(abs)) this.schedule(root, FILE_DEBOUNCE_MS);
  }

  /** An editor changed `abs`: rebuild its projects when a definition line was touched. */
  edited(abs: string, changes: ChangeSet, startDoc: Text, doc: Text): void {
    const roots = [...this.roots].filter(([, r]) => r.files.has(abs)).map(([root]) => root);
    if (!roots.length) return;
    let touched = false;
    changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      touched ||= DEFINITION_LINE.test(lines(startDoc, fromA, toA)) || DEFINITION_LINE.test(lines(doc, fromB, toB));
    });
    if (touched) for (const root of roots) this.schedule(root, EDIT_DEBOUNCE_MS);
  }

  /** A compile of `root` finished: its label numbers may have changed (never a rebuild). */
  compiled(root: string): void {
    const r = this.roots.get(root);
    if (!r) return; // read fresh on first use
    if (r.labelTimer !== null) window.clearTimeout(r.labelTimer);
    r.labelTimer = window.setTimeout(() => {
      r.labelTimer = null;
      if (this.roots.get(root) !== r) return;
      const labels = this.labels(root);
      if (sameLabels(labels, r.labels)) return;
      r.labels = labels;
      r.cache.clear();
    }, 0);
  }

  dispose(): void {
    for (const r of this.roots.values()) {
      if (r.timer !== null) window.clearTimeout(r.timer);
      if (r.labelTimer !== null) window.clearTimeout(r.labelTimer);
    }
    this.roots.clear();
  }

  private renderMath(mj: MathJaxLike, math: LatexMath, source: string, root: string, doc: Document): HTMLElement {
    const r = this.rootMath(mj, root);
    const key = (math.display ? "D" : "I") + math.src;
    let hit = r.cache.get(key);
    if (hit !== undefined) {
      r.cache.delete(key);
    } else {
      try {
        hit = r.math.render(math.src, math.display, r.labels);
        this.installStyles(mj);
      } catch (e) {
        if (!(e instanceof MathError)) throw e;
        hit = e.message;
      }
    }
    r.cache.set(key, hit);
    if (r.cache.size > CACHE_SIZE) r.cache.delete(r.cache.keys().next().value!);
    if (typeof hit === "string") return hoverError(hit, source, doc);
    if (this.sheet) this.copyStyles(this.sheet, doc);
    return hit.cloneNode(true) as HTMLElement;
  }

  /** The root's renderer and labels, built on first use. */
  private rootMath(mj: MathJaxLike, root: string): RootMath {
    let r = this.roots.get(root);
    if (!r) {
      const { input, files } = this.definitions(root);
      const math = ProjectMath.create(mj, this.host.mathJax.document, input);
      r = { math, labels: this.labels(root), files, cache: new Map(), timer: null, labelTimer: null };
      this.roots.set(root, r);
    }
    return r;
  }

  private definitions(root: string): { input: ProjectMathInput; files: Set<string> } {
    const defs = projectDefinitions(root, this.host.buffers());
    return {
      input: { statements: defs.statements, physics: defs.packages.has("physics"), unsupported: defs.unsupported },
      files: new Set(defs.files),
    };
  }

  private labels(root: string): Map<string, string> {
    const labels = new Map<string, string>();
    for (const [key, l] of readAuxLabels(this.host.outDirFor(root))) labels.set(key, l.number);
    return labels;
  }

  /** Re-read a built root's definitions after `ms`; a new renderer only when they changed. */
  private schedule(root: string, ms: number): void {
    const r = this.roots.get(root);
    if (!r) return; // built fresh on first use
    if (r.timer !== null) window.clearTimeout(r.timer);
    r.timer = window.setTimeout(() => {
      r.timer = null;
      const mj = this.mathJax();
      if (!mj || this.roots.get(root) !== r) return;
      const { input, files } = this.definitions(root);
      r.files = files;
      if (inputEpoch(input) === r.math.epoch) return;
      r.math = ProjectMath.create(mj, this.host.mathJax.document, input);
      r.cache.clear();
    }, ms);
  }

  /**
   * Glyph CSS for a new render, before the hover shows it (see Styles). Obsidian's
   * finishRenderMath() adopts a stylesheet already in the head (it appends the same element).
   */
  private installStyles(mj: MathJaxLike): void {
    const sheet = mj.chtmlStylesheet?.() ?? null;
    if (sheet && !sheet.isConnected) this.host.mathJax.document.head.appendChild(sheet);
    this.sheet = sheet;
    void this.host.mathJax.finish();
  }

  /**
   * A popout window's copy of MathJax's stylesheet, refreshed when rules were added. MathJax
   * adds the rules of new glyphs with insertRule, so the copy is made from its CSS rules (a
   * clone of the element only has the text of its first version).
   */
  private copyStyles(sheet: HTMLStyleElement, doc: Document): void {
    if (doc === this.host.mathJax.document || !doc.defaultView) return;
    const rules = sheet.sheet?.cssRules;
    const old = this.popoutSheets.get(doc);
    if (old?.el.isConnected && rules && old.rules === rules.length) return;
    const copy = doc.createElement("style");
    copy.textContent = rules ? Array.from(rules, (r) => r.cssText).join("\n") : sheet.textContent;
    if (old?.el.isConnected) old.el.replaceWith(copy);
    else doc.head.appendChild(copy);
    this.popoutSheets.set(doc, { el: copy, rules: rules?.length ?? -1 });
  }
}

function sameLabels(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
}

/** The whole lines of `doc` that [from, to] touches. */
function lines(doc: Text, from: number, to: number): string {
  return doc.sliceString(doc.lineAt(from).from, doc.lineAt(to).to);
}
