import type { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { readFileSync } from "fs";
import { dirname } from "path";
import { AuxLabel, readAuxLabels } from "../tex/aux";
import { BibEntry, bibFiles, readBib } from "../tex/bib";
import { projectDefinitions } from "../tex/macros";
import { stripComments } from "../tex/project";
import { LatexRefs, formulaRefs, refNames, sameRefNames } from "./latexRefs";
import type { LatexMath } from "./latexScan";
import { MathError, MathJaxLike, ProjectMath, ProjectMathInput, inputEpoch } from "./mathjaxProject";
import type { FragmentRenderer, RenderRequest, RenderResult } from "./shared/livePreview";
import { hoverError } from "./shared/renderHover";

// Rendering for LaTeX editors (design 4.1, 4.8): one ProjectMath per root document over
// Obsidian's MathJax, the render hover's chain (P1: MathJax only) and live preview's renderer
// (`rendererFor`). Obsidian's MathJax functions come in through the host, so tests run this on
// the same MathJax bundle.
//   Rebuilds  a saved project file (300 ms) or an edit touching a definition line (500 ms)
//             re-reads the definitions, and a new instance is built only when the statements,
//             physics or unsupported macros changed (every TeX input costs memory, see
//             mathjaxProject's Lifetime). A compile result re-reads only the .aux labels,
//             which are a render argument: it never builds an instance.
//   Refs      what a root's documents refer to (`refsOf`, no MathJax needed): the last
//             compile's .aux labels (numbers, pages, titles, anchors, cleveref types), the
//             entries of the .bib files its sources name, and the reference names its sources
//             set (latexRefs' refNames: cleveref's options, \crefname, \newtheorem titles,
//             \<type>autorefname). Read on first use; the labels again after every compile
//             result, everything again when a view opens a file of the root (a compile run
//             elsewhere), when a project file or a .bib file is saved (300 ms), and when an
//             edit changes a .bib buffer or a bibliography, \documentclass or naming line (500 ms).
//   Cache     rendered formulas per root (display + source -> node or MathJax's message,
//             CACHE_SIZE, least recently used out), handed out as clones; dropped when the
//             instance or the labels change. A hover repeated over a formula costs a clone.
//   Styles    after a new render MathJax's stylesheet is updated at once (its glyph rules are
//             added only when chtmlStylesheet() runs) and put into the main window's head if
//             Obsidian has not yet, so the first hover never draws without glyph CSS; a
//             popout window gets a copy of its rules. finishRenderMath() still runs for
//             Obsidian's own bookkeeping.
//   Live      `rendererFor(root)` is the root's FragmentRenderer (one object per root, so views
//             of one project share their renders): synchronous, its epoch is the definitions'
//             hash (ProjectMath.epoch), and requests carry the formula prepared by latexLive
//             (labels already turned into tags), so it renders them without labels. Its
//             subscribers hear of a new instance and of new refs (the views rebuild: chips
//             change, and only the formulas whose prepared text changed re-render). `flush` (after a
//             batch) is the Styles step, for every window with a LaTeX editor. `preload`
//             runs before the first live mount (design 3.7).

/** An edit touching such a line may change the bibliography or the reference names. */
const REFS_LINE = /\\(?:addbibresource|addglobalbib|addsectionbib|(?:no)?bibliography\s*\{|documentclass|[cC]refname|newtheorem)|autorefname|cleveref/;
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
  /** Documents of the windows LaTeX editors are open in (popouts get MathJax's glyph CSS). */
  documents?(): Iterable<Document>;
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

/** Live preview's renderer for one root; `changed` tells the views using it to rebuild. */
class LiveRenderer implements FragmentRenderer {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly source: {
      epoch(): number;
      render(req: RenderRequest): RenderResult;
      flush(): void;
    },
  ) {}

  get epoch(): number {
    return this.source.epoch();
  }

  render(req: RenderRequest): RenderResult {
    return this.source.render(req);
  }

  flush(): void {
    this.source.flush();
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => void this.listeners.delete(onChange);
  }

  /** A new instance (epoch) or new refs. */
  changed(): void {
    for (const f of [...this.listeners]) f();
  }
}

interface RootMath {
  math: ProjectMath;
  /** The project files the definitions came from. */
  files: Set<string>;
  /** Display flag + formula source -> its rendering or MathJax's message (see Cache). */
  cache: Map<string, Element | string>;
  timer: number | null;
}

/** A root's refs (see Refs) and what they were read from. */
interface RootRefs {
  refs: LatexRefs;
  /** The project's source files and its .bib files. */
  files: Set<string>;
  bibs: Set<string>;
  timer: number | null;
  /** The pending re-read covers the sources, not only the labels. */
  full: boolean;
}

export class TexRender {
  private roots = new Map<string, RootMath>();
  private refs = new Map<string, RootRefs>();
  /** Live preview's renderer per root (see Live). */
  private renderers = new Map<string, LiveRenderer>();
  private loading: Promise<MathJaxLike | null> | null = null;
  private preloading: Promise<boolean> | null = null;
  private preloaded = false;
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

  /** Live preview can mount at once: `preload` has finished. */
  get ready(): boolean {
    return this.preloaded;
  }

  /**
   * Before the first live mount (design 3.7): MathJax loaded, one warm-up render through
   * `root`'s instance with its glyph CSS in place, finishRenderMath, and the fonts ready, so
   * the first widgets draw at their final size. False when MathJax is not available.
   */
  preload(root: string): Promise<boolean> {
    this.preloading ??= this.load().then(async (mj) => {
      if (!mj) return false;
      try {
        this.rootMath(mj, root).math.render("x", false);
      } catch (e) {
        if (!(e instanceof MathError)) throw e;
      }
      this.installStyles(mj);
      await this.host.mathJax.finish();
      await this.host.mathJax.document.fonts?.ready;
      this.preloaded = true;
      return true;
    });
    return this.preloading;
  }

  /** Live preview's renderer for documents under `root` (see Live). */
  rendererFor(root: string): FragmentRenderer {
    let r = this.renderers.get(root);
    if (!r) {
      r = new LiveRenderer({
        epoch: () => {
          const mj = this.mathJax();
          return mj ? this.rootMath(mj, root).math.epoch : 0;
        },
        render: (req) => this.renderLive(root, req),
        flush: () => this.flushLive(),
      });
      this.renderers.set(root, r);
    }
    return r;
  }

  /** Label numbers of `root`'s last compile (prepareMath's tags). */
  labelsOf(root: string): ReadonlyMap<string, string> {
    return this.refsOf(root).numbers;
  }

  /** What documents under `root` refer to (see Refs), read on first use. */
  refsOf(root: string): LatexRefs {
    let r = this.refs.get(root);
    if (!r) {
      r = { ...this.readRefs(root), timer: null, full: false };
      this.refs.set(root, r);
    }
    return r.refs;
  }

  /** A live editor in `doc`'s window: a popout gets a copy of MathJax's glyph CSS. */
  stylesFor(doc: Document): void {
    if (this.sheet) this.copyStyles(this.sheet, doc);
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

  /** A vault file was saved: rebuild the projects that read it, re-read the refs that use it. */
  fileModified(abs: string): void {
    for (const [root, r] of this.roots) if (r.files.has(abs)) this.schedule(root, FILE_DEBOUNCE_MS);
    for (const [root, r] of this.refs) if (r.files.has(abs) || r.bibs.has(abs)) this.reloadRefs(root, FILE_DEBOUNCE_MS, true);
  }

  /**
   * An editor changed `abs`: rebuild its projects when a definition line was touched; re-read
   * the refs of a changed .bib buffer, or when a bibliography or \documentclass line was touched.
   */
  edited(abs: string, changes: ChangeSet, startDoc: Text, doc: Text): void {
    const touched = (re: RegExp) => {
      let hit = false;
      changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        hit ||= re.test(lines(startDoc, fromA, toA)) || re.test(lines(doc, fromB, toB));
      });
      return hit;
    };
    const roots = [...this.roots].filter(([, r]) => r.files.has(abs)).map(([root]) => root);
    if (roots.length && touched(DEFINITION_LINE)) for (const root of roots) this.schedule(root, EDIT_DEBOUNCE_MS);
    for (const [root, r] of this.refs) {
      if (r.bibs.has(abs) || (r.files.has(abs) && touched(REFS_LINE))) this.reloadRefs(root, EDIT_DEBOUNCE_MS, true);
    }
  }

  /** A compile of `root` finished: its labels may have changed (never a rebuild of MathJax). */
  compiled(root: string): void {
    this.reloadRefs(root, 0, false);
  }

  /** A view opened a document of `root`: the refs again (a compile may have run elsewhere). */
  opened(root: string): void {
    this.reloadRefs(root, 0, true);
  }

  dispose(): void {
    for (const r of [...this.roots.values(), ...this.refs.values()]) if (r.timer !== null) window.clearTimeout(r.timer);
    this.roots.clear();
    this.refs.clear();
    this.renderers.clear();
  }

  /** A live request (see Live): its source has its numbers already. */
  private renderLive(root: string, req: RenderRequest): RenderResult {
    const mj = this.mathJax();
    if (!mj) return { ok: false, message: "MathJax is not available." };
    try {
      return { ok: true, node: this.rootMath(mj, root).math.render(req.src, req.display) };
    } catch (e) {
      if (!(e instanceof MathError)) throw e;
      return { ok: false, message: e.message };
    }
  }

  /** After a batch of live renders: the Styles step for every window with a LaTeX editor. */
  private flushLive(): void {
    const mj = this.mathJax();
    if (!mj) return;
    this.installStyles(mj);
    const sheet = this.sheet;
    if (sheet) for (const doc of this.host.documents?.() ?? []) this.copyStyles(sheet, doc);
  }

  private renderMath(mj: MathJaxLike, math: LatexMath, source: string, root: string, doc: Document): HTMLElement {
    const r = this.rootMath(mj, root);
    const key = (math.display ? "D" : "I") + math.src;
    let hit = r.cache.get(key);
    if (hit !== undefined) {
      r.cache.delete(key);
    } else {
      try {
        const refs = this.refsOf(root);
        hit = r.math.render(math.src, math.display, refs.numbers, formulaRefs(refs));
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
      r = { math, files, cache: new Map(), timer: null };
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

  /**
   * Re-read `root`'s refs after `ms` (`full`: the sources too, else only the labels) when they
   * were read before (else they are read on first use); the views hear of a change.
   */
  private reloadRefs(root: string, ms: number, full: boolean): void {
    const r = this.refs.get(root);
    if (!r) return;
    r.full ||= full;
    if (r.timer !== null) window.clearTimeout(r.timer);
    r.timer = window.setTimeout(() => {
      r.timer = null;
      if (this.refs.get(root) !== r) return;
      const was = r.refs;
      let next: LatexRefs;
      if (r.full) {
        const read = this.readRefs(root, was);
        ({ files: r.files, bibs: r.bibs } = read);
        next = read.refs;
      } else next = { ...was, ...this.readLabels(root, was) };
      r.full = false;
      if (next.labels === was.labels && next.cites === was.cites && next.names === was.names) return;
      r.refs = next;
      this.roots.get(root)?.cache.clear(); // the hover's renders read the refs
      this.renderers.get(root)?.changed();
    }, ms);
  }

  /** The refs of `root` (see Refs); the maps of `was` are kept where nothing changed. */
  private readRefs(root: string, was?: LatexRefs): { refs: LatexRefs; files: Set<string>; bibs: Set<string> } {
    const buffers = this.host.buffers();
    const files = projectDefinitions(root, buffers).files;
    const texts = files.map((f) => buffers.get(f) ?? readText(f));
    const bibs = bibFiles(texts, dirname(root));
    const cites = new Map<string, BibEntry>();
    for (const bib of bibs) for (const [key, e] of readBib(bib, buffers.get(bib))) if (!cites.has(key)) cites.set(key, e);
    const names = refNames(texts.map(stripComments));
    const refs: LatexRefs = {
      ...this.readLabels(root, was),
      cites: was && sameMap(cites, was.cites, (a, b) => a === b) ? was.cites : cites,
      names: was && sameRefNames(names, was.names) ? was.names : names,
    };
    return { refs, files: new Set(files), bibs: new Set(bibs) };
  }

  /** The labels of `root`'s build folder, and their numbers (those of `was` when unchanged). */
  private readLabels(root: string, was?: LatexRefs): Pick<LatexRefs, "labels" | "numbers"> {
    const labels = readAuxLabels(this.host.outDirFor(root));
    if (was && sameMap(labels, was.labels, sameLabel)) return { labels: was.labels, numbers: was.numbers };
    const numbers = new Map<string, string>();
    for (const [key, l] of labels) numbers.set(key, l.number);
    return { labels, numbers: was && sameMap(numbers, was.numbers, (a, b) => a === b) ? was.numbers : numbers };
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
      this.renderers.get(root)?.changed();
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

function sameMap<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>, same: (x: V, y: V) => boolean): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w === undefined || !same(v, w)) return false;
  }
  return true;
}

const sameLabel = (a: AuxLabel, b: AuxLabel): boolean =>
  a.number === b.number &&
  a.page === b.page &&
  a.title === b.title &&
  a.anchor === b.anchor &&
  a.kind === b.kind &&
  a.order?.join() === b.order?.join();

/** A source file's text ("" when it cannot be read). */
function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The whole lines of `doc` that [from, to] touches. */
function lines(doc: Text, from: number, to: number): string {
  return doc.sliceString(doc.lineAt(from).from, doc.lineAt(to).to);
}
