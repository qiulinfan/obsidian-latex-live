import type { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { existsSync, readFileSync } from "fs";
import { basename, dirname, extname, join } from "path";
import { CropKind, CropLocation, NOTE_CHANGED } from "../preview/blockCrop";
import { AuxCheckpoint, AuxLabel, readAuxCheckpoints, readAuxLabels } from "../tex/auxData";
import { BibEntry, bibFiles, readBib } from "../tex/bib";
import { DeckFrames, DeckTitle, FramePages, deckFrames, deckTitle, readNavPages } from "../tex/beamer";
import { DetectedRules, EMPTY_USER_RULES, EnvRules, UserEnvRules, detectEnvRules, frameStarts, mergeEnvRules, rulesKey } from "../tex/envRules";
import { IMAGE_FORMATS, findGraphics, graphicsPaths } from "../tex/graphics";
import { projectDefinitions, type Definitions } from "../tex/macros";
import { includeName, stripComments } from "../tex/project";
import { sameTheorems, theoremMap } from "../tex/theorems";
import { boxNumber, cropKindOf } from "./latexLive";
import { LatexRefs, formulaRefs, refNames, sameRefNames } from "./latexRefs";
import { LatexBlock, LatexEnv, LatexMath, blockAt, formulas, mathAt, scanLatex } from "./latexScan";
import { MathError, MathJaxLike, ProjectMath, ProjectMathInput, inputEpoch, numberedEnv, tagLabels } from "./mathjaxProject";
import type { FragmentRenderer, RenderRequest, RenderResult } from "./shared/livePreview";
import { hoverError } from "./shared/renderHover";
import { applyTemplateVisualization, parseTemplateProfiles, type TemplateVisualization, type TemplateVisualizationProfile } from "./templateVisualization";

// Rendering for LaTeX editors (design 4.1, 4.8): one ProjectMath per root document over
// Obsidian's MathJax, PDF crops (the host's `crops`, blockCrop.ts), the render hover's chain and
// live preview's renderer (`rendererFor`). Obsidian's MathJax functions come in through the
// host, so tests run this on the same MathJax bundle.
//   Hover     `hoverTarget`: the formula at the pointer, else the innermost block that crops
//             (latexLive's cropKindOf: a TikZ picture, a table, a theorem-like box, a figure or
//             table float). A display formula owning its lines shows its crop from the last
//             compile when its text is the one compiled, else MathJax (a formula inside a
//             tcolorbox never crops; a compile running does not wait); inline math is MathJax.
//             A formula MathJax rejects goes to a fragment compile (the host's `fragments`,
//             fragments.ts: the root's own engine and preamble, `fragmentBody`), unless the
//             setting `texFragmentFallback` is off or MathJax found an unbalanced brace (TeX
//             stops there too); when TeX fails as well, MathJax's message shows. A block shows
//             its crop (waiting for the session's first compile), else its fragment compile (TeX's
//             message when that fails), else the note NOTE_CHANGED when it changed since; with
//             neither, nothing. A fragment takes 0.3 s (pdfLaTeX with the preamble format) to
//             1.5 s (XeLaTeX): the hover's spinner shows meanwhile.
//   Cursor    `preview`: the cursor preview's rendering of a formula, MathJax alone (it renders
//             at every keystroke; its failures keep the last rendering).
//   Rebuilds  a saved project file (300 ms) or an edit touching a definition line (500 ms)
//             re-reads the definitions, and a new instance is built only when the statements,
//             physics or unsupported macros changed (every TeX input costs memory, see
//             mathjaxProject's Lifetime). A compile result re-reads only the .aux labels,
//             which are a render argument: it never builds an instance.
//   Refs      what a root's documents refer to (`refsOf`, no MathJax needed): the last
//             compile's .aux labels (numbers, pages, titles, anchors, cleveref types) and
//             \include checkpoints (counter totals and chapter numbers per included file), the
//             entries of the .bib files its sources name, the theorem map of its sources
//             (theorems.ts: the boxes' names, colours and label prefixes) and the reference
//             names (latexRefs' refNames: cleveref's options, \crefname, \newtheorem titles,
//             \<type>autorefname, the theorem map's `\<env>name`s). Read on first use; the
//             labels again after every compile result, everything again when a view opens a
//             file of the root (a compile run elsewhere), when a project file or a .bib file is
//             saved (300 ms), and when an edit changes a .bib buffer or a bibliography,
//             \documentclass, naming, theorem or \graphicspath line (500 ms).
//   Images    `imageOf(root, path)`: the file an \includegraphics reads (graphics.ts: the root's
//             folder, the sources' \graphicspath, graphicx's extensions; not TEXINPUTS: a bare
//             name found nowhere, or a path with a macro in it, stays source unmarked, since TeX
//             may find it), remembered per root
//             until a vault file is saved under that path (its mtime is in the request, so
//             the image renders anew), or any file is created, deleted or renamed
//             (`filesChanged`); the views rebuild then. Live requests of kind "image" render
//             an <img> of the host's resource URL, or of a PDF's first page (`pdfPage`, async).
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
//             runs before the first live mount (design 3.7). Requests of kind "crop" (#4,
//             #14; `cropOf` gives their source) render through the crops (async until drawn); the views
//             rebuild when a compile ends or the preview closes (`cropsChanged`).

/** An edit touching such a line may change the bibliography, the reference names, the theorem map or a deck's title page. */
const REFS_LINE =
  /\\(?:addbibresource|(?:title|subtitle|author|institute|date)\s*[[{]|addglobalbib|addsectionbib|(?:no)?bibliography\s*\{|documentclass|ProvidesClass|LoadClass|PassOptionsToClass|RequirePackage|[cC]refname|(?:elegant)?newtheorem|graphicspath|usepackage)|autorefname|cleveref/;
/** An edit touching such a line may change what the project defines. */
const DEFINITION_LINE =
  /\\(?:(?:re|provide)?newcommand|[egx]?def|let|Declare|(?:New|Renew|Provide)DocumentCommand|(?:re)?newenvironment|input|include|usepackage|RequirePackage)/;
const FILE_DEBOUNCE_MS = 300;
/** Live image widgets are at most this high (CSS pixels, the shared `.lsp-lp-image img` rule). */
const IMAGE_MAX_HEIGHT = 320;
const EDIT_DEBOUNCE_MS = 500;
const CACHE_SIZE = 200;
/** A MathJax failure TeX would stop at too: no fragment compile for it. */
const BRACE_ERROR = /^(?:Missing|Extra) (?:open|close) brace/;

export interface TexRenderHost {
  /** Explicit editor visualization selected for this root; never used by native TeX or refs. */
  visualization?(root: string): TemplateVisualizationProfile | null;
  /** The user's live editor rules (settings.envRules; a new object when they change). */
  envRules?(): UserEnvRules;
  /** `root`'s rules (rulesOf) may have changed: the views under it reconfigure. */
  rulesChanged?(root: string): void;
  /** The build folder of a root document (its .aux files hold the label numbers). */
  outDirFor(root: string): string;
  /** Text of the open LaTeX editors by absolute path (unsaved edits count). */
  buffers(): ReadonlyMap<string, string>;
  /** Documents of the windows LaTeX editors are open in (popouts get MathJax's glyph CSS). */
  documents?(): Iterable<Document>;
  /** Obsidian's MathJax. */
  mathJax: ObsidianMath;
  /** Images for live preview (none: \includegraphics stays source). */
  images?: TexImages;
  /** PDF crops from the last compile (none: no crops). */
  crops?: TexCrops;
  /** Fragment compiles with the document's own engine (none: the hover has no fragment step). */
  fragments?: TexFragments;
  /** The `texFragmentFallback` setting, read on every hover (default on). */
  fragmentFallback?(): boolean;
}

/** Fragment compiles for the hover (fragments.ts's FragmentService). */
export interface TexFragments {
  /**
   * `body` (TeX for a preview environment) typeset with the engine and preamble of `root`: a
   * paper card, TeX's message, or null (no TeX; a newer request of the root replaced it).
   */
  render(root: string, body: string, inline: boolean): Promise<HTMLElement | { error: string } | null>;
}

/** PDF crops of blocks (blockCrop.ts's CropService). */
export interface TexCrops {
  /** Where the block `text` (starting on `line` now) of `file` is in the root's last compile. */
  locate(root: string, file: string, text: string, line: number, kind: CropKind): CropLocation;
  /** A crop request's card (async until drawn), or a quiet failure. */
  render(root: string, src: string): RenderResult | Promise<RenderResult>;
  /** The hover's crop, or why there is none; `wait`: for the session's first compile. */
  hover(root: string, file: string, text: string, line: number, kind: CropKind, wait: boolean): Promise<HTMLElement | { note: string }>;
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

/** An image file for the live preview: the host serves it, or draws a PDF's first page. */
export interface TexImages {
  /** A URL the editor's window loads the file from (Obsidian's resource path), or null outside the vault. */
  url(abs: string): string | null;
  /** The first page of a PDF file as an image URL, at most `maxHeight` CSS pixels high. */
  pdfPage(abs: string, maxHeight: number): Promise<{ url: string; width: number }>;
}

/** Live preview's renderer for one root; `changed` tells the views using it to rebuild. */
class LiveRenderer implements FragmentRenderer {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly source: {
      epoch(): number;
      render(req: RenderRequest): RenderResult | Promise<RenderResult>;
      flush(): void;
    },
  ) {}

  get epoch(): number {
    return this.source.epoch();
  }

  render(req: RenderRequest): RenderResult | Promise<RenderResult> {
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
  /** The sources' \graphicspath prefixes (see Images). */
  graphics: string[];
  /** The rules the sources imply (envRules' detectEnvRules), and the macros' arities. */
  detected: DetectedRules;
  macros: Definitions["macros"];
  timer: number | null;
  /** The pending re-read covers the sources, not only the labels. */
  full: boolean;
  /** A beamer root's frames, pages and title page (readDeck), else null. */
  deck: Deck | null;
}

/** A beamer deck as live preview shows it (src/tex/beamer.ts). */
interface Deck {
  pages: FramePages[];
  frames: DeckFrames;
  title: DeckTitle | null;
  /** Equal exactly when two decks are. */
  key: string;
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
  /** Per root: \includegraphics paths -> what they show (see Images), and the file it read. */
  private images = new Map<string, Map<string, { found: { src: string } | { error: string } | null; file: string | null }>>();

  /** frameStarts per document text (framePageOf), with the banners it counted. */
  private frameStarts = new WeakMap<Text, { banners: DetectedRules["banners"]; starts: number[] }>();

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
    return this.rootRefs(root).refs;
  }

  private visualizations = new Map<string, { native: LatexRefs["theorems"]; profile: TemplateVisualizationProfile | null; value: TemplateVisualization }>();

  visualizationOf(root: string): TemplateVisualization {
    const native = this.refsOf(root).theorems, profile = this.host.visualization?.(root) ?? null;
    const cached = this.visualizations.get(root);
    if (cached && cached.native === native && cached.profile === profile) return cached.value;
    let value: TemplateVisualization;
    try { value = applyTemplateVisualization(native, profile); }
    catch { value = applyTemplateVisualization(native, null); }
    this.visualizations.set(root, { native, profile, value });
    return value;
  }

  refreshVisualizations(): void {
    this.visualizations.clear();
    for (const renderer of this.renderers.values()) renderer.changed();
  }

  private rules = new Map<string, { user: UserEnvRules; detected: DetectedRules; profile: TemplateVisualizationProfile | null; value: EnvRules; key: string }>();

  /**
   * The live editor's rules for documents under `root` (src/tex/envRules.ts): the user's over the
   * detected over the defaults, without the environments the root's template profile names. The
   * same object while nothing changed (the live language and the highlighter rebuild on a new one).
   */
  rulesOf(root: string): EnvRules {
    const r = this.rootRefs(root);
    const user = this.host.envRules?.() ?? EMPTY_USER_RULES;
    const profile = this.host.visualization?.(root) ?? null;
    const cached = this.rules.get(root);
    if (cached && cached.user === user && cached.detected === r.detected && cached.profile === profile) return cached.value;
    let profiled: string[] = [];
    try { profiled = profile ? parseTemplateProfiles([profile])[0].environments.map((e) => e.environment) : []; }
    catch { profiled = []; }
    const merged = mergeEnvRules(user, r.detected, (name) => r.macros.get(name), profiled);
    const key = rulesKey(merged);
    const value = cached && cached.key === key ? cached.value : merged;
    this.rules.set(root, { user, detected: r.detected, profile, value, key });
    return value;
  }

  /** Where `\label{key}` is in `root`'s project sources (unsaved edits count), or null. */
  labelLocation(root: string, key: string): { file: string; line: number; column: number } | null {
    const buffers = this.host.buffers();
    for (const file of this.rootRefs(root).files) {
      const at = labelLine(buffers.get(file) ?? readText(file), key);
      if (at) return { file, ...at };
    }
    return null;
  }

  private rootRefs(root: string): RootRefs {
    let r = this.refs.get(root);
    if (!r) {
      r = { ...this.readRefs(root), timer: null, full: false };
      this.refs.set(root, r);
    }
    return r;
  }

  /** A live editor in `doc`'s window: a popout gets a copy of MathJax's glyph CSS. */
  stylesFor(doc: Document): void {
    if (this.sheet) this.copyStyles(this.sheet, doc);
  }

  /** What the render hover shows at `pos` of a document under `root` (see Hover). */
  hoverTarget(doc: Text, pos: number, root: string): LatexMath | LatexBlock | null {
    const rules = this.rulesOf(root);
    const math = mathAt(doc, pos, rules);
    if (math) return math;
    const { theorems } = this.refsOf(root);
    return blockAt(doc, pos, (b) => cropKindOf(doc, b, b.env, theorems) !== null, rules);
  }

  /**
   * The render hover's section for a formula or block of `file` (a document under `root`; null:
   * no crops), see Hover.
   */
  hover(target: LatexMath | LatexBlock, view: EditorView, root: string, file: string | null = null): HTMLElement | null | Promise<HTMLElement | null> {
    const text = view.state.doc;
    const crops = this.host.crops;
    const kind = crops && file && (target.kind === "block" || (target.display && target.block))
      ? cropKindOf(text, target, target.kind === "block" ? target.env : null, this.refsOf(root).theorems)
      : null;
    if (target.kind === "block") {
      if (!kind || !crops || !file) return this.fragmentOf(target, text, view.dom.ownerDocument, root, file);
      const note = (message: string) => {
        const el = view.dom.ownerDocument.createElement("div");
        el.className = "ll-render-note";
        el.textContent = message;
        return el;
      };
      return crops
        .hover(root, file, view.state.sliceDoc(target.from, target.to), text.lineAt(target.from).number, kind, true)
        .then(async (r) => {
          if (!("note" in r)) return r;
          // The text as hovered: the crop may have waited for a compile.
          return (await this.fragmentOf(target, text, view.dom.ownerDocument, root, file)) ?? (r.note === NOTE_CHANGED ? note(r.note) : null);
        });
    }
    if (!kind || !crops || !file) return this.hoverMath(target, view, root, true);
    return crops
      .hover(root, file, view.state.sliceDoc(target.from, target.to), text.lineAt(target.from).number, kind, false)
      .then((r) => ("note" in r ? this.hoverMath(target, view, root, true) : r));
  }

  /** The cursor preview's rendering of a formula (see Cursor). */
  preview(math: LatexMath, view: EditorView, root: string): HTMLElement | Promise<HTMLElement> {
    return this.hoverMath(math, view, root, false);
  }

  /**
   * The formula's MathJax rendering; when MathJax fails, its fragment compile (`fragments`), else
   * MathJax's message (see Hover).
   */
  private hoverMath(math: LatexMath, view: EditorView, root: string, fragments: boolean): HTMLElement | Promise<HTMLElement> {
    const text = view.state.doc;
    const source = text.sliceString(math.from, math.to);
    const doc = view.dom.ownerDocument;
    const shown = (mj: MathJaxLike | null): HTMLElement | Promise<HTMLElement> => {
      const r = mj ? this.renderMath(mj, math, root, doc) : "MathJax is not available.";
      if (typeof r !== "string") return r;
      const failed = hoverError(r, source, doc);
      const fragment = fragments && !BRACE_ERROR.test(r) ? this.fragmentOf(math, text, doc, root, null) : null;
      return fragment ? fragment.then((el) => (el && !el.classList.contains("lsp-render-hover-error") ? el : failed)) : failed;
    };
    const mj = this.mathJax();
    return mj ? shown(mj) : this.load().then(shown);
  }

  /**
   * The hover's fragment step (see Hover): the target typeset by the root's own engine, as a card
   * or TeX's message; null without fragments, with the setting off, or for a request a newer one
   * of the root replaced. `file`: the document's path (its boxes' counted numbers), when known.
   */
  private fragmentOf(target: LatexMath | LatexBlock, text: Text, doc: Document, root: string, file: string | null): Promise<HTMLElement | null> | null {
    const fragments = this.host.fragments;
    if (!fragments || this.host.fragmentFallback?.() === false) return null;
    const body = fragmentBody(text, target, this.refsOf(root), file === null ? undefined : includeName(root, file));
    const source = text.sliceString(target.from, target.to);
    return fragments
      .render(root, body, target.kind === "math" && !target.display)
      .then((r) => (r && "error" in r ? hoverError(r.error, source, doc) : r));
  }

  /**
   * The crop request source of the block [from, to] of `file` (a document under `root`) when the
   * last compile saw its text, and the source that drew it before (latexLive's `crop`).
   */
  cropOf(root: string, file: string, doc: Text, from: number, to: number, kind: CropKind): { src: string; previous: string | null } | null {
    const where = this.host.crops?.locate(root, file, doc.sliceString(from, to), doc.lineAt(from).number, kind);
    return where && "src" in where ? where : null;
  }

  /** A compile of `root` ended or its preview closed (every root: the theme changed): crops again. */
  cropsChanged(root?: string): void {
    for (const [r, renderer] of this.renderers) if (root === undefined || r === root) renderer.changed();
  }

  /**
   * What `\includegraphics{path}` in a document under `root` shows (see Images): a live
   * request's source, or why it cannot show; null when the plugin cannot know (a path built from
   * a macro, a bare name TeX may find in its own tree: mwe's `example-image-a`), which stays
   * source without an error mark.
   */
  imageOf(root: string, path: string): { src: string } | { error: string } | null {
    let cache = this.images.get(root);
    if (!cache) this.images.set(root, (cache = new Map()));
    let hit = cache.get(path);
    if (!hit) {
      const file = path.includes("\\") ? null : findGraphics(path, dirname(root), this.rootRefs(root).graphics);
      const ext = file ? extname(file.path).slice(1).toLowerCase() : "";
      let found: { src: string } | { error: string } | null;
      if (!file) found = path.includes("\\") || !/[\\/]/.test(path) ? null : { error: `Image not found: ${path}` };
      else if (!IMAGE_FORMATS.has(ext)) found = { error: `Live preview does not show .${ext} images: ${path}` };
      else if (!this.host.images) found = { error: "Images are not available here." };
      else if (ext !== "pdf" && this.host.images.url(file.path) === null) found = { error: `Outside the vault: ${file.path}` };
      else found = { src: `${file.mtime}|${file.path}` };
      cache.set(path, (hit = { found, file: file?.path ?? null }));
    }
    return hit.found;
  }

  /** A vault file was saved: rebuild the projects that read it, re-read the refs that use it, show an image anew. */
  fileModified(abs: string): void {
    for (const [root, r] of this.roots) if (r.files.has(abs)) this.schedule(root, FILE_DEBOUNCE_MS);
    for (const [root, r] of this.refs) if (r.files.has(abs) || r.bibs.has(abs)) this.reloadRefs(root, FILE_DEBOUNCE_MS, true);
    for (const [root, cache] of this.images) {
      const stale = [...cache].filter(([, hit]) => hit.file === abs);
      for (const [path] of stale) cache.delete(path);
      if (stale.length) this.renderers.get(root)?.changed();
    }
  }

  /** A vault file was created, deleted or renamed: images resolve again (see Images). */
  filesChanged(): void {
    for (const [root, cache] of this.images) {
      if (!cache.size) continue;
      cache.clear();
      this.renderers.get(root)?.changed();
    }
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
    this.visualizations.clear();
    for (const r of [...this.roots.values(), ...this.refs.values()]) if (r.timer !== null) window.clearTimeout(r.timer);
    this.roots.clear();
    this.refs.clear();
    this.renderers.clear();
    this.images.clear();
  }

  /** A source card's formula, using its committed project snapshot and private MathJax. */
  sourceMath(root: string, src: string, display: boolean, doc: Document, defs: Definitions, refs: LatexRefs): HTMLElement {
    const mj = this.mathJax();
    if (!mj) throw new MathError("MathJax is not available.");
    const input = { statements: defs.statements, physics: defs.packages.has("physics"), unsupported: defs.unsupported };
    let r = this.roots.get(root);
    if (!r) {
      r = { math: ProjectMath.create(mj, this.host.mathJax.document, input), files: new Set(defs.files), cache: new Map(), timer: null };
      this.roots.set(root, r);
    } else if (r.math.epoch !== inputEpoch(input)) {
      r.math = ProjectMath.create(mj, this.host.mathJax.document, input);
      r.files = new Set(defs.files);
      r.cache.clear();
      this.renderers.get(root)?.changed();
    }
    // A card may have newer labels than a debounced editor refresh; don't mix cache entries.
    const node = r.math.render(src, display, new Map(), formulaRefs(refs));
    this.installStyles(mj);
    if (this.sheet) this.copyStyles(this.sheet, doc);
    return doc.importNode(node, true) as HTMLElement;
  }

  /** A live request (see Live): its source has its numbers already. Images: see Images. */
  private renderLive(root: string, req: RenderRequest): RenderResult | Promise<RenderResult> {
    if (req.kind === "image") return this.renderImage(req.src);
    if (req.kind === "crop") return this.host.crops?.render(root, req.src) ?? { ok: false, message: "No crops here.", quiet: true };
    const mj = this.mathJax();
    if (!mj) return { ok: false, message: "MathJax is not available." };
    try {
      return { ok: true, node: this.rootMath(mj, root).math.render(req.src, req.display) };
    } catch (e) {
      if (!(e instanceof MathError)) throw e;
      return { ok: false, message: e.message };
    }
  }

  /** An image request's source (`mtime|path`, imageOf) as an <img>. */
  private renderImage(src: string): RenderResult | Promise<RenderResult> {
    const path = src.slice(src.indexOf("|") + 1);
    const images = this.host.images;
    if (!images) return { ok: false, message: "Images are not available here." };
    const img = (url: string, width?: number): RenderResult => {
      const el = this.host.mathJax.document.createElement("img");
      el.src = url;
      el.alt = path;
      if (width) el.width = Math.round(width);
      return { ok: true, node: el };
    };
    if (extname(path).toLowerCase() === ".pdf") return images.pdfPage(path, IMAGE_MAX_HEIGHT).then((p) => img(p.url, p.width));
    const url = images.url(path);
    return url === null ? { ok: false, message: `Outside the vault: ${path}` } : img(url);
  }

  /** After a batch of live renders: the Styles step for every window with a LaTeX editor. */
  private flushLive(): void {
    const mj = this.mathJax();
    if (!mj) return;
    this.installStyles(mj);
    const sheet = this.sheet;
    if (sheet) for (const doc of this.host.documents?.() ?? []) this.copyStyles(sheet, doc);
  }

  /** The formula's rendering (a clone of the cached one), or MathJax's message. */
  private renderMath(mj: MathJaxLike, math: LatexMath, root: string, doc: Document): HTMLElement | string {
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
    if (typeof hit === "string") return hit;
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
      let images = false;
      let deck: Deck | null;
      if (r.full) {
        const read = this.readRefs(root, was);
        images = read.graphics.join("\n") !== r.graphics.join("\n");
        ({ files: r.files, bibs: r.bibs, graphics: r.graphics, macros: r.macros } = read);
        if (rulesKey(read.detected as EnvRules) !== rulesKey(r.detected as EnvRules)) {
          r.detected = read.detected;
          this.host.rulesChanged?.(root);
        }
        next = read.refs;
        deck = read.deck;
      } else {
        next = { ...was, ...this.readLabels(root, was) };
        deck = r.detected.beamer ? this.readDeck(root, r.detected, [...r.files]) : null;
      }
      const deckChanged = deck?.key !== r.deck?.key;
      r.deck = deck;
      r.full = false;
      if (images) this.images.get(root)?.clear();
      const same =
        next.labels === was.labels &&
        next.cites === was.cites &&
        next.names === was.names &&
        next.theorems === was.theorems &&
        next.checkpoints === was.checkpoints;
      if (!same) {
        r.refs = next;
        this.roots.get(root)?.cache.clear(); // the hover's renders read the refs
      }
      if (!same || images || deckChanged) this.renderers.get(root)?.changed();
    }, ms);
  }

  /** The refs of `root` (see Refs); the maps of `was` are kept where nothing changed. */
  private readRefs(root: string, was?: LatexRefs): { refs: LatexRefs; files: Set<string>; bibs: Set<string>; graphics: string[]; detected: DetectedRules; macros: Definitions["macros"]; deck: Deck | null } {
    const buffers = this.host.buffers();
    const defs = projectDefinitions(root, buffers);
    const files = defs.files;
    const texts = files.map((f) => buffers.get(f) ?? readText(f));
    const bibs = bibFiles(texts, dirname(root));
    const cites = new Map<string, BibEntry>();
    for (const bib of bibs) for (const [key, e] of readBib(bib, buffers.get(bib))) if (!cites.has(key)) cites.set(key, e);
    const sources = texts.map(stripComments);
    const theorems = theoremMap(sources);
    const names = refNames(sources, theorems);
    const refs: LatexRefs = {
      ...this.readLabels(root, was),
      cites: was && sameMap(cites, was.cites, (a, b) => a === b) ? was.cites : cites,
      names: was && sameRefNames(names, was.names) ? was.names : names,
      theorems: was && sameTheorems(theorems, was.theorems) ? was.theorems : theorems,
    };
    const detected = detectEnvRules(sources);
    return { refs, files: new Set(files), bibs: new Set(bibs), graphics: graphicsPaths(sources), detected, macros: defs.macros, deck: this.readDeck(root, detected, files) };
  }

  /**
   * A beamer root's deck: the last compile's .nav pages, the frames of the files its body reads
   * (open editors' text counts) and the preamble's title page; null for a paper.
   */
  private readDeck(root: string, detected: DetectedRules, files: readonly string[]): Deck | null {
    if (!detected.beamer) return null;
    const buffers = this.host.buffers();
    const text = (f: string) => buffers.get(f) ?? (existsSync(f) ? readText(f) : null);
    const job = basename(root, extname(root));
    const pages = readNavPages(join(this.host.outDirFor(root), `${job}.nav`));
    const frames = deckFrames(root, detected.banners, text);
    const title = deckTitle(files, text);
    return { pages, frames, title, key: JSON.stringify([pages, [...frames.files], title]) };
  }

  /**
   * The PDF pages of the frame at `pos` of `doc` (the file `file` under the beamer root `root`),
   * or null: no .nav, or the .nav and the sources disagree on the frames (an edit since the
   * compile that added or removed one in this file, or a deck the count misreads).
   */
  framePageOf(root: string, file: string, doc: Text, pos: number): FramePages | null {
    const r = this.rootRefs(root);
    const deck = r.deck;
    const at = deck?.frames.files.get(file);
    if (!deck || !at || deck.frames.total !== deck.pages.length) return null;
    let local = this.frameStarts.get(doc);
    if (!local || local.banners !== r.detected.banners) {
      local = { banners: r.detected.banners, starts: frameStarts(doc.toString(), r.detected.banners, file === root) };
      this.frameStarts.set(doc, local);
    }
    if (local.starts.length !== at.count) return null;
    const k = local.starts.indexOf(pos);
    return k < 0 ? null : deck.pages[at.offset + k];
  }

  /** A beamer root's title page: its fields and the \title line (file, 0-based line), or null. */
  titlePageOf(root: string): DeckTitle | null {
    return this.rootRefs(root).deck?.title ?? null;
  }

  /**
   * The labels of `root`'s build folder, their numbers and the \include checkpoints (those of `was`
   * when unchanged).
   */
  private readLabels(root: string, was?: LatexRefs): Pick<LatexRefs, "labels" | "numbers" | "checkpoints"> {
    const outDir = this.host.outDirFor(root);
    const labels = readAuxLabels(outDir);
    const read = readAuxCheckpoints(outDir);
    const checkpoints = was && sameMap(read, was.checkpoints, sameCheckpoint) ? was.checkpoints : read;
    if (was && sameMap(labels, was.labels, sameLabel)) return { labels: was.labels, numbers: was.numbers, checkpoints };
    const numbers = new Map<string, string>();
    for (const [key, l] of labels) numbers.set(key, l.number);
    return { labels, numbers: was && sameMap(numbers, was.numbers, (a, b) => a === b) ? was.numbers : numbers, checkpoints };
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

/** amsmath's numbered environments whose starred forms take \tag (fragmentBody). */
const STARRED = new Set(["equation", "align", "alignat", "flalign", "gather", "multline"]);

/**
 * The TeX a fragment compile typesets for a hover target (design 4.7): its source, numbered as
 * the PDF numbers it. A numbered display environment (also inside a block) becomes its starred
 * form with `\tag{n}` on the rows whose label the last compile numbered (tagLabels; rows without
 * one show no number, as in the MathJax hover), `eqnarray` staying as it is. A theorem box prints
 * its head's number (latexLive's boxNumber: its label's .aux entry, else its place counted in the
 * \include'd `file`): `\the<counter>` is set to it (`thm:x` at `tcb@cnt@theorem.3.1` prints 3.1);
 * a float the number of its label's entry. A float becomes a minipage whose captions are its
 * type's (a float cannot go into the preview's box).
 */
export function fragmentBody(doc: Text, target: LatexMath | LatexBlock, refs: LatexRefs, file?: string): string {
  const numbered = (src: string): string => {
    const env = numberedEnv(src);
    if (!env || !STARRED.has(env)) return src;
    // A \label alone on its line leaves a blank line, a paragraph break TeX refuses in math.
    return tagLabels(src, refs.numbers)
      .replace(/\n[ \t]*(?=\n)/g, "")
      .replace(/^(\s*\\begin\s*\{)([a-z]+)\}/, "$1$2*}")
      .replace(/(\\end\s*\{)([a-z]+)\}(\s*)$/, "$1$2*}$3");
  };
  if (target.kind === "math") return numbered(doc.sliceString(target.from, target.to));
  let text = doc.sliceString(target.from, target.to);
  const inside = formulas(doc).filter((f) => f.display && f.from >= target.from && f.to <= target.to);
  for (const f of inside.reverse()) {
    text = text.slice(0, f.from - target.from) + numbered(doc.sliceString(f.from, f.to)) + text.slice(f.to - target.from);
  }
  let number: { counter: string; value: string } | null = null;
  const def = refs.theorems.get(target.env);
  if (def?.numbered) {
    const env = scanLatex(doc).find((c): c is LatexEnv => c.kind === "env" && c.from === target.from);
    const n = env ? boxNumber(doc, env, def, refs, file) : null;
    if (n?.counter) number = { counter: n.counter, value: n.number };
  }
  const float = /^(figure|table)\*?$/.exec(target.env)?.[1];
  if (float) {
    for (const m of text.matchAll(/\\label\s*\{([^{}]*)\}/g)) {
      const aux = refs.labels.get(m[1].trim());
      if (aux?.kind === float) {
        number = { counter: float, value: aux.number };
        break;
      }
    }
    text = text
      .replace(/^\\begin\s*\{(?:figure|table)\*?\}(?:\s*\[[^\]]*\])?/, `\\begin{minipage}{\\linewidth}\\expandafter\\def\\csname @captype\\endcsname{${float}}`)
      .replace(/\\end\s*\{(?:figure|table)\*?\}\s*$/, "\\end{minipage}");
  }
  return number ? `\\expandafter\\def\\csname the${number.counter}\\endcsname{${number.value}}${text}` : text;
}

function sameMap<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>, same: (x: V, y: V) => boolean): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w === undefined || !same(v, w)) return false;
  }
  return true;
}

const sameCheckpoint = (a: AuxCheckpoint, b: AuxCheckpoint): boolean =>
  a.chapter === b.chapter && sameMap(a.counters, b.counters, (x, y) => x === y);

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

/** The (0-based) line and column of `\label{key}` in `text` outside comments, or null. */
function labelLine(text: string, key: string): { line: number; column: number } | null {
  const needle = `\\label{${key}}`;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const column = stripComments(lines[i]).indexOf(needle);
    if (column >= 0) return { line: i, column };
  }
  return null;
}
