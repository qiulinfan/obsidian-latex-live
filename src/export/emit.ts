import { basename, extname } from "path";
import { citeText, refText, type LatexRefs } from "../editor/latexRefs";
import { MathError } from "../editor/mathjaxProject";
import type { Definitions } from "../tex/macros";
import { abortError } from "../tex/run";
import { texText } from "../tex/texText";
import type { TheoremDef, TheoremMap } from "../tex/theorems";
import {
  citeNames,
  BBL_WRAPPERS,
  BBL_SILENT,
  BBL_TEXT,
  BBL_QUOTES,
  bblShutText,
  formatEntry,
  numericLabels,
  postnoteText,
  type BblEntry,
  type BibCite,
  type CiteNumber,
  type LabelPiece,
} from "./bibliography";
import { attr, esc, hrefId, TOC_MARK, type Footnote, type TitleBlock } from "./html";
import { drawingKey } from "./fragments";
import { collectFrontmatter, type FrontmatterPart, type PaperFrontmatter } from "./frontmatter";
import { cssLength, optionArg, type ExportImages, type Picture } from "./images";
import { highlightListing, type CodeTokenizer } from "./listings";
import { displayLayout, displayTex, type DisplayRow, type ExportMath, type Numbering } from "./math";
import { HTML_ENVS, isFileInput, lineAt, PICTURE_ENVS, visitNodes, type ExportPlan, type PlanFile, type PlanFragment } from "./plan";
import { tocEntry, StepQueue, type ProbeLog, type ProbeStep, type Span } from "./probeLog";
import {
  BASE_COLORS,
  bullet,
  censusTheorems,
  chapterLabel,
  colorId,
  fallbackName,
  parseColor,
  profileColors,
  theoremHtml,
  theoremLook,
  xcolor,
  type Profile,
  type Rgb,
} from "./profiles";
import { ReportBuilder, type ReportItem, type ShownNumber } from "./report";
import { CITES } from "./signatures";
import { tableHtml, tableLayout } from "./tables";
import { argText, given, parseTex, walkTex, type TexArg, type TexNode } from "./texTree";

// Tree -> HTML (design 4). Walks the root's body and every file it reads in the plan's visit
// order, so each construct's lines are a Span the probe's StepQueue can hand numbers to:
//   - headings: the level and the number as the class prints it (`第一章`, `1.1`, `A`), from the
//     probe's contents records; the title from the source;
//   - paragraphs: blank lines and \par end them; spaces between CJK characters (line breaks in
//     Chinese text) go, as xeCJK drops them; TeX's ligatures (`--`, `---`, quotes) over runs a
//     comment joined; `~` is a no-break space;
//   - styles (\textbf ..) and font switches (\bfseries ..) to the end of their group, across
//     paragraphs; `\textcolor`/`\color` with the probe's colours;
//   - lists with the labels TeX printed (enumerate's from the probe), description terms;
//   - theorem-like environments (the theorem map's, and the census's \newtheorems a class or package
//     defines) with their name and number, in the profile's look (profiles.ts: elegantbook's boxes
//     and heads, amsthm's styles); headings as the class prints their numbers (a chapter's
//     `Chapter 1`, `附录 A`), `\paragraph` run in; floats with their captions' names and numbers;
//     verbatim and listings as `<pre>`; `\href`/`\url` as links; colours (xcolor's expressions too)
//     as the page's colour variables, which the profile lightens in dark mode;
//   - math (S2) through ExportMath: inline formulas, displays with each numbered row tagged with the
//     number TeX printed (math.ts lays the rows out; the steps come in amsmath's order), labels as
//     anchors, `\intertext` as a paragraph between the parts; a formula MathJax rejects at emit
//     time is its source in `<pre>` (the plan made the ones it knew of fragments);
//   - references (S3) with the live chips' texts (latexRefs' refText on the build's .aux), linked
//     to their labels' anchors; citations as the class prints them (bibliography.ts): biblatex's
//     numeric labels from the probe (numeric-comp ranges, pre- and postnotes, `\textcite`), natbib's
//     and LaTeX's from the .aux's `\bibcite`, other styles live preview's labels (report item);
//     the bibliography: biblatex's .bbl entries in the order the probe saw them printed, BibTeX's
//     thebibliography items; footnotes with TeX's marks (`\footnotemark`/`\footnotetext` too);
//     a link whose target the page lacks becomes plain text (report item);
//   - TeX fragments (S5) as the SVG dvisvgm drew from the probe's DVI (fragments.ts: inline ones on
//     the baseline, blocks on their own; the steps TeX took inside one are in its drawing, so the
//     queue drops them and `numbers` records them as shown), else their source (report item);
//   - floats (S6) with their captions' names and numbers (`\caption*` none, `\captionof`,
//     subcaption's `(a)`), side by side minipages and subfigures at their widths; images as data
//     URIs (images.ts), `\includepdf`'s pages as images; tabular as an HTML table (tables.ts);
//     listings (`lstlisting`, `\lstinputlisting`) as `<pre>` with their captions and numbers;
//   - unknown macros keep their arguments' text (report item).

/** TeX's sectioning levels. */
const LEVELS: Record<string, number> = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
/** Levels whose headings run into their paragraph (LaTeX's \paragraph and \subparagraph). */
const RUN_IN = 4;
const LEVEL_NAMES = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];

/** Style commands with a text argument: the element or class they wrap it in. */
const STYLE_COMMANDS: Record<string, [string, string]> = {
  textbf: ["<b>", "</b>"],
  textit: ["<i>", "</i>"],
  textsl: ["<i>", "</i>"],
  emph: ["<em>", "</em>"],
  texttt: ["<code>", "</code>"],
  textsf: ['<span class="llx-sf">', "</span>"],
  textsc: ['<span class="llx-sc">', "</span>"],
  underline: ["<u>", "</u>"],
  uline: ["<u>", "</u>"],
  textup: ["", ""],
  textrm: ["", ""],
  textmd: ["", ""],
  textnormal: ["", ""],
  textsuperscript: ["<sup>", "</sup>"],
  textsubscript: ["<sub>", "</sub>"],
  text: ["", ""],
  mbox: ["", ""],
  hbox: ["", ""],
  fbox: ['<span class="llx-fbox">', "</span>"],
  makebox: ["", ""],
  framebox: ['<span class="llx-fbox">', "</span>"],
  ensuremath: ["", ""],
};
/** Font switches: the class the rest of their group gets. */
const SWITCHES: Record<string, string> = {
  bfseries: "llx-bf",
  bf: "llx-bf",
  cbfseries: "llx-bf",
  itshape: "llx-it",
  it: "llx-it",
  slshape: "llx-it",
  sl: "llx-it",
  em: "llx-it",
  ttfamily: "llx-tt",
  tt: "llx-tt",
  sffamily: "llx-sf",
  sf: "llx-sf",
  scshape: "llx-sc",
  sc: "llx-sc",
};
/** Commands that typeset nothing the HTML shows (layout, setup, sizes, fonts). */
const SILENT = new Set([
  "noindent", "indent", "centering", "raggedright", "raggedleft", "clearpage", "newpage", "cleardoublepage",
  "pagebreak", "nopagebreak", "vspace", "medskip", "bigskip", "smallskip", "vfill", "frontmatter", "mainmatter",
  "backmatter", "appendix", "index", "phantomsection", "protect", "relax", "listoffigures", "listoftables",
  "printindex", "bibliographystyle", "nocite", "pagestyle", "thispagestyle", "pagenumbering", "setcounter",
  "addtocounter", "stepcounter", "refstepcounter", "setlength", "addtolength", "captionsetup", "hypersetup",
  "graphicspath", "lstset", "lstdefinestyle", "tcbset", "usetikzlibrary", "newcounter", "makeatletter", "makeatother", "allowbreak",
  "nobreak", "hline", "toprule", "midrule", "bottomrule", "cline", "markboth", "markright", "normalsize", "small",
  "footnotesize", "scriptsize", "tiny", "large", "Large", "LARGE", "huge", "Huge", "selectfont", "fontsize",
  "upshape", "mdseries", "rmfamily", "normalfont", "songti", "heiti", "kaishu", "fangsong", "linespread",
  "setlist", "label", "par", "@", "/", "-", "nolinebreak", "unskip", "ignorespaces", "leavevmode",
  "null", "strut", "hyphenation", "FloatBarrier", "suppressfloats", "balance", "onecolumn", "twocolumn",
  "tableofcontents", "maketitle", "item", "bibitem", "caption", "includeonly", "addbibresource",
  "cmidrule", "specialrule", "addlinespace", "morecmidrules", "centerline",
  "shorttitle", "shortauthors",
  "titlerunning", "authorrunning",
]);
/** Control symbols and commands that typeset space. */
const SPACES: Record<string, string> = {
  ",": " ", " ": " ", ";": " ", ":": " ", "!": "", quad: " ", qquad: "  ",
  enspace: " ", thinspace: " ", hfill: " ", hspace: " ", hskip: " ", "\n": " ", "\t": " ",
};
const REF_COMMANDS: Record<string, string> = {
  ref: "ref", eqref: "eqref", pageref: "pageref", autoref: "autoref", Autoref: "autoref", cref: "cref",
  Cref: "Cref", nameref: "nameref",
};
const FLOATS: Record<string, string> = {
  figure: "figure", "figure*": "figure", table: "table", "table*": "table", algorithm: "algorithm", wrapfigure: "figure",
  wraptable: "table", sidewaysfigure: "figure", sidewaystable: "table",
};
/** Boxes whose content the page shows at the text's width (a table or picture in one is a block). */
const BOXES = new Set(["resizebox", "scalebox", "rotatebox", "adjustbox"]);
/** subcaption's sub-floats: the counter their captions step. */
const SUBFLOATS: Record<string, string> = { subfigure: "subfigure", subtable: "subtable" };
const LISTS = new Set(["itemize", "enumerate", "description", "problemset"]);
/** What only TeX draws: a census theorem holding one stays a fragment. */
const PICTURE_INSIDE = new RegExp(String.raw`\\(?:tikz\b|begin\s*\{(?:${[...PICTURE_ENVS].join("|")})\})`);
const ENUMS = ["enumi", "enumii", "enumiii", "enumiv"];
/** Accent commands (texText puts the mark on the letter). */
const ACCENTS = new Set(["'", "`", "^", '"', "~", "=", ".", "u", "v", "H", "c", "k", "r", "d", "b", "t"]);
/** Commands BibTeX styles write into a .bbl (natbib's plainnat, LaTeX's plain). */
const BBL_COMMANDS: Record<string, string> = { newblock: " ", urlprefix: "URL " };

/** The anchor id of a bibliography entry. */
const bibId = (key: string) => `llx-bib-${key}`;
/** HTML with its first letter capitalized (`\Citet`, `\Textcite`). */
const upperFirst = (html: string) => html.replace(/^((?:<[^>]*>)*)(\p{Ll})/u, (_m, tags: string, c: string) => tags + c.toUpperCase());

/** CJK characters between which a source line break typesets nothing (Han, kana, CJK punctuation). */
const CJK = "\\p{Script=Han}\\u3000-\\u303f\\u3040-\\u30ff\\uff00-\\uffef";
/** Inline tags a joined space may cross; a formula (MathJax's `mjx-` markup, text only in CSS) is no such tag. */
const TAGS = "(?:<(?!/?mjx-)[^>]+>)*";
const CJK_SPACE = new RegExp(`([${CJK}])(${TAGS})[ \\n\\u00a0]+(${TAGS})(?=[${CJK}])`, "gu");
/** Full-width punctuation: xeCJK drops the spaces next to it (`、 (3.5)` prints `、(3.5)`). */
const PUNCT = "\\u3001-\\u303f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65";
const PUNCT_SPACE = new RegExp(`([${PUNCT}])(${TAGS})[ \\n]+|[ \\n]+(${TAGS})(?=[${PUNCT}])`, "gu");

/**
 * Spaces a line break left between CJK characters (also across inline tags, never across a
 * formula) go, and so do spaces next to full-width punctuation.
 */
export function joinCjk(html: string): string {
  return html.replace(CJK_SPACE, "$1$2$3").replace(PUNCT_SPACE, (_m, p: string | undefined, a: string | undefined, b: string | undefined) => (p ?? "") + (a ?? "") + (b ?? ""));
}

/** Text as TeX typesets it: its ligatures and `~` (escaped for HTML). */
export function texLigatures(raw: string): string {
  return esc(
    raw
      .replace(/---/g, "—")
      .replace(/--/g, "–")
      .replace(/``/g, "“")
      .replace(/''/g, "”")
      .replace(/`/g, "‘")
      .replace(/'/g, "’")
      .replace(/~/g, " "),
  );
}

/** A link target the page may point to: http(s), mailto, ftp, fragments and relative paths. */
function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(?:https?:|mailto:|ftp:|#)/i.test(u)) return u;
  return /^[a-z][a-z0-9+.-]*:/i.test(u) ? null : u;
}

export interface Heading {
  /** TeX's level: -1 part, 0 chapter, 1 section, ... */
  level: number;
  /** The number as the class prints it (`第一章`), or null. */
  number: string | null;
  /** The title as HTML. */
  title: string;
  id: string;
  /** It has a contents entry (unstarred, or an \addcontentsline of its own). */
  toc: boolean;
}

/** What the build wrote about the bibliography (the exporter reads it). */
export interface EmitBib {
  /** biblatex's .bbl entries by key, in the order of its first data list (empty without biblatex). */
  entries: ReadonlyMap<string, BblEntry>;
  /** A BibTeX .bbl (its thebibliography), which `\bibliography` reads; null without one. */
  bbl: string | null;
  /** The .aux's `\bibcite` labels (natbib, LaTeX). */
  bibcites: ReadonlyMap<string, BibCite>;
}

export interface EmitInput {
  plan: ExportPlan;
  /** The probe's records; null in aux-only mode (the probe wrote none). */
  log: ProbeLog | null;
  queue: StepQueue | null;
  /** The build's labels, the .bib entries (citation fallback) and the reference names. */
  refs: LatexRefs;
  theorems: TheoremMap;
  defs: Definitions;
  /** The class's look (profiles.ts). */
  profile: Profile;
  math: Pick<ExportMath, "render">;
  bib: EmitBib;
  /** The TeX fragments dvisvgm drew (prepared SVG, fragments.ts), by plan fragment id. */
  fragments: ReadonlyMap<string, string>;
  /** The document's images, read (images.ts). */
  images: Pick<ExportImages, "graphic" | "listingAt" | "pdfPages">;
  /** The host's existing syntax tokenizer (Obsidian's Prism); no highlighter is bundled. */
  code?: CodeTokenizer;
  report: ReportBuilder;
  /** Yield to the UI (called about every 30 ms of work). */
  idle(): Promise<void>;
  /** How many formulas were rendered so far (called when yielding). */
  progress?(formulas: number): void;
  signal: AbortSignal;
}

export interface EmitOutput {
  body: string;
  headings: Heading[];
  footnotes: Footnote[];
  /** The title block (\maketitle), or null. */
  header: TitleBlock | null;
  /** The document's title as text (the page's <title>). */
  title: string;
  /** The contents' heading (`目录`), when \tableofcontents stands in the body. */
  tocTitle: string | null;
  counts: Record<string, number>;
  numbers: ShownNumber[];
  /** The colours the page uses (the profile's and those the text names), by name: its colour variables. */
  colors: Map<string, Rgb>;
}

interface Ctx {
  file: PlanFile;
  visit: number;
  /** The float whose caption numbers (`figure`), or null. */
  float: string | null;
  /** Where that float began (subcaption steps a figure's counter at its first subfigure, before the caption). */
  floatAt?: { visit: number; line: number };
  /** The span of a construct whose text is not the file's (a macro's expansion). */
  at?: Span;
  /** Macro expansions deep. */
  depth: number;
  /** Publisher .bbl wrappers are interpreted only inside a bibliography. */
  bibliography?: boolean;
  metadata?: boolean;
}

/** A font switch in force: its classes and colour. */
interface Style {
  classes: string[];
  color: string | null;
}
const NO_STYLE: Style = { classes: [], color: null };
const styled = (s: Style) => s.classes.length > 0 || s.color !== null;
const styleAttrs = (s: Style) =>
  `${s.classes.length ? ` class="${s.classes.join(" ")}"` : ""}${s.color ? ` style="color:${attr(s.color)}"` : ""}`;

/** Emit the plan's document as HTML (see the file comment). */
export async function emitHtml(input: EmitInput): Promise<EmitOutput> {
  return new Emitter(input).run();
}

export interface SourceSlice {
  key: string;
  visit: number;
  /** Original nodes from this plan file, with their original offsets and identity. */
  nodes: readonly TexNode[];
  /** Owned nested proofs omitted from the statement card; never clone their parents. */
  excluded?: readonly { key: string; visit: number; from: number; to: number }[];
}

export interface SourceSliceOutput {
  body: string;
  footnotes: Footnote[];
  colors: Map<string, Rgb>;
  items: ReportItem[];
}

const SLICE_MAX_CHARS = 64_000, SLICE_MAX_NODES = 5_000, SLICE_MAX_VISITS = 64;
const sourceNodes = new WeakMap<PlanFile, Set<TexNode>>();
let sliceSerial = 0;

function boundedSourceSlice(plan: ExportPlan, source: SourceSlice): ReadonlySet<string> {
  const excluded = new Set((source.excluded ?? []).map((r) => `${r.visit}|${r.key}|${r.from}|${r.to}`));
  const allowed = (key: string, visit: number): { file: PlanFile; nodes: Set<TexNode> } => {
    const file = plan.files.get(key);
    if (!file || plan.visits[visit]?.key !== key) throw new Error("Source slice does not match the plan visit.");
    let nodes = sourceNodes.get(file);
    if (!nodes) { nodes = new Set(); walkTex(file.nodes, (n) => { nodes!.add(n); }); sourceNodes.set(file, nodes); }
    return { file, nodes };
  };
  for (const r of source.excluded ?? []) {
    const { nodes } = allowed(r.key, r.visit);
    if (![...nodes].some((n) => n.t === "env" && n.from === r.from && n.to === r.to)) throw new Error("Source exclusion is not an original environment range.");
  }
  let count = 0, chars = 0;
  const visits = new Set<number>();
  const active = new Set<number>();
  const scan = (nodes: readonly TexNode[], key: string, visit: number, depth: number) => {
    if (depth > 64 || active.has(visit)) throw new Error("Source slice input nesting is too deep or cyclic.");
    const original = allowed(key, visit);
    visits.add(visit);
    if (visits.size > SLICE_MAX_VISITS) throw new Error("Source slice exceeds the input visit limit.");
    active.add(visit);
    const walk = (list: readonly TexNode[], nesting: number) => {
      if (nesting > 64) throw new Error("Source slice node nesting is too deep.");
      for (const n of list) {
        if (!original.nodes.has(n)) throw new Error("Source slice contains a reconstructed or foreign AST node.");
        if (n.t === "env" && n.name === "document") throw new Error("Source slice requires content nodes, not a full document.");
        if (excluded.has(`${visit}|${key}|${n.from}|${n.to}`)) continue;
        if (++count > SLICE_MAX_NODES) throw new Error("Source slice exceeds the node limit.");
        // Leaves and command headers are counted once, not once per enclosing environment.
        if (n.t === "env") {
          const args = n.args.flatMap((a) => a.body ?? []);
          chars += n.bodyFrom - n.from + n.to - n.bodyTo - args.reduce((s, c) => s + c.to - c.from, 0);
          walk(args, nesting + 1);
          walk(n.body, nesting + 1);
        } else if (n.t === "group") { chars += n.to - n.from - n.body.reduce((s, c) => s + c.to - c.from, 0); walk(n.body, nesting + 1); }
        else if (n.t === "macro" && !n.code) { const args = n.args.flatMap((a) => a.body ?? []); chars += n.to - n.from - args.reduce((s, c) => s + c.to - c.from, 0); walk(args, nesting + 1); }
        else { chars += n.to - n.from; }
        if (chars > SLICE_MAX_CHARS) throw new Error("Source slice exceeds the character limit.");
        if (n.t === "macro" && isInput(n) && !n.code) {
          const target = plan.inputTargets.get(`${visit}@${n.from}`);
          if (target !== undefined) scan(visitNodes(plan, target), plan.visits[target].key, target, depth + 1);
        }
      }
    };
    walk(nodes, 0);
    active.delete(visit);
  };
  scan(source.nodes, source.key, source.visit, 0);
  return excluded;
}

/** Validate the original bounded input closure before a caller reads any images/resources. */
export function validateSourceSlice(plan: ExportPlan, source: SourceSlice): void {
  boundedSourceSlice(plan, source);
}

/** A bounded statement/proof view: no IO, build, probe, document header or global stylesheet. */
export async function emitSourceSlice(input: EmitInput, source: SourceSlice, options: { idPrefix?: string } = {}): Promise<SourceSliceOutput> {
  if (input.signal.aborted) throw abortError("The source preview was cancelled.");
  const { plan } = input;
  const excluded = boundedSourceSlice(plan, source);
  const prefix = options.idPrefix ?? `ll-slice-${++sliceSerial}-`;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(prefix)) throw new Error("Source slice idPrefix must be a safe HTML ID prefix.");
  const report = new ReportBuilder();
  const queue = input.log ? new StepQueue(input.log, plan.visits) : null;
  return new Emitter({ ...input, queue, report }, true, excluded).runSlice(source, prefix);
}

/** Namespace only real tag attributes/CSS, never an `id="..."` written as source text. */
function namespaceSlice(body: string, footnotes: readonly Footnote[], prefix: string, labels: ReadonlySet<string>): { body: string; footnotes: Footnote[] } {
  const tags = /<(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const ids = new Map<string, string>();
  const gather = (html: string) => { for (const tag of html.matchAll(tags)) for (const m of tag[0].matchAll(/\sid="([^"]*)"/g)) ids.set(decode(m[1]), prefix + decode(m[1])); };
  gather(body);
  for (const f of footnotes) { if (f.id) ids.set(f.id, prefix + f.id); if (f.ref) ids.set(f.ref, prefix + f.ref); gather(f.html); }
  const cssUrls = (s: string) => s.replace(/url\(\s*(["']?)#([^\s)"']+)\1\s*\)/g, (all, quote: string, id: string) => ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : all);
  const rewrite = (html: string) => html.replace(tags, (tag) => {
    let label = "";
    tag = tag.replace(/\sid="([^"]*)"/g, (_all, raw: string) => { const id = decode(raw); if (labels.has(id)) label = ` data-ll-tex-label="${attr(id)}"`; return ` id="${attr(ids.get(id)!)}"`; });
    if (label) tag = tag.replace(/\s*\/?>$/, (end) => label + end);
    tag = tag.replace(/\s(href|xlink:href)="(#[^"]*)"/g, (all, name: string, raw: string) => {
      let id: string; try { id = decodeURIComponent(decode(raw).slice(1)); } catch { return all; }
      return ids.has(id) ? ` ${name}="${attr(hrefId(ids.get(id)!))}"` : all;
    });
    return cssUrls(tag);
  }).replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g, (_all, begin: string, css: string, end: string) => begin + cssUrls(css) + end);
  return { body: rewrite(body), footnotes: footnotes.map((f) => ({ ...f, id: ids.get(f.id) ?? f.id, ref: ids.get(f.ref) ?? f.ref, html: rewrite(f.html) })) };
}

class Emitter {
  private readonly frontmatter: PaperFrontmatter | null;
  private readonly className: string;
  private nextVisit = 1;
  private headings: Heading[] = [];
  private footnotes: Footnote[] = [];
  /** `\footnotemark`s waiting for their `\footnotetext`. */
  private marks: Omit<Footnote, "html">[] = [];
  private header: TitleBlock | null = null;
  private tocTitle: string | null = null;
  private ids = new Set<string>();
  private sourceLabels = new Set<string>();
  private sliceWorkNodes = 0;
  private sliceExpandedChars = 0;
  private counts: Record<string, number> = {};
  private numbers: ShownNumber[] = [];
  private enumDepth = 0;
  private itemizeDepth = 0;
  private fragments = new Map<string, PlanFragment>();
  /** The last fragment emitted: sibling nodes inside it (`\tikz`'s path up to its `;`) are its drawing. */
  private drawnSpan: { key: string; from: number; to: number } | null = null;
  private minLevel = 1;
  /** The document's font size in TeX points (`llxinfo{fontsize}`): em for lengths and images. */
  private fontPt: number;
  /** Counters whose numbers the page shows (a fragment's are recorded as drawn). */
  private shownCounters: Set<string>;
  private lastYield = Date.now();
  private unknown = new Map<string, { count: number; file: string; line: number }>();
  private notes = new Set<string>();
  /** Theorems of the census the theorem map does not know (a class's or package's \newtheorem). */
  private census: Map<string, TheoremDef>;
  /** The colours the page uses, by name (the profile's first). */
  private colors: Map<string, Rgb>;
  /** After \appendix: chapters print `附录 A`, `Appendix A`. */
  private appendix = false;

  constructor(private readonly o: EmitInput, private readonly sliceMode = false, private readonly excluded: ReadonlySet<string> = new Set()) {
    this.frontmatter = sliceMode ? null : collectFrontmatter(o.plan);
    const root = o.plan.files.get(o.plan.rootKey)!;
    const dc = root.nodes.find((n) => n.t === "macro" && n.name === "documentclass");
    this.className = this.frontmatter?.className ?? (dc?.t === "macro" ? argText(root.src, dc.args[dc.args.length - 1]).trim() : "");
    this.fontPt = Number(o.log?.info.get("fontsize")) || 10;
    this.census = o.log ? censusTheorems(o.log.envs, o.theorems, o.log.names) : new Map();
    this.colors = profileColors(o.profile, o.log?.colors ?? new Map(), o.theorems);
    this.shownCounters = new Set(["equation", "figure", "table", "footnote", "lstlisting", "algorithm", "subfigure", "subtable"]);
    for (const [env, def] of [...o.theorems, ...this.census]) if (def.numbered) this.shownCounters.add(this.theoremCounter(env, def));
    for (const f of o.plan.fragments) this.fragments.set(`${f.key}@${f.from}`, f);
    let min = Infinity;
    for (const f of sliceMode ? [] : o.plan.files.values()) {
      const scan = (nodes: readonly TexNode[]) => {
        for (const n of nodes) {
          if (n.t === "macro" && n.name in LEVELS) min = Math.min(min, LEVELS[n.name]);
          else if (n.t === "env") scan(n.body);
          else if (n.t === "group") scan(n.body);
        }
      };
      scan(f.nodes);
    }
    this.minLevel = Number.isFinite(min) ? min : 1;
  }

  async run(): Promise<EmitOutput> {
    const { plan } = this.o;
    const root = plan.files.get(plan.rootKey)!;
    const ctx: Ctx = { file: root, visit: 0, float: null, depth: 0 };
    const body = this.linked(await this.flowAsync(visitNodes(plan, 0), ctx));
    for (const f of this.footnotes) f.html = this.linked(f.html);
    for (const [name, u] of this.unknown) {
      this.o.report.add({ severity: "warning", kind: "unknown-macro", message: `\\${name}: not rendered, its arguments kept as text`, count: u.count, file: u.file, line: u.line });
    }
    for (const s of this.o.queue?.orphans ?? []) {
      this.o.report.add({ severity: "warning", kind: "numbering", message: `orphan step ${s.counter} = ${texText(s.value)} (no construct took it)`, file: this.abs(s.key), line: s.line });
    }
    const title = this.frontmatter?.title;
    return {
      body,
      headings: this.headings,
      footnotes: this.footnotes,
      header: this.header,
      title: title ? texText(title.file.src.slice(title.from, title.to).replace(/\\thanks\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "")) : "",
      tocTitle: this.tocTitle,
      counts: this.counts,
      numbers: this.numbers,
      colors: this.colors,
    };
  }

  async runSlice(source: SourceSlice, prefix: string): Promise<SourceSliceOutput> {
    const file = this.o.plan.files.get(source.key)!;
    const ctx: Ctx = { file, visit: source.visit, float: null, depth: 0, metadata: true };
    const body = await this.flowAsync(source.nodes, ctx);
    for (const [name, u] of this.unknown) this.o.report.add({ severity: "warning", kind: "unknown-macro", message: `\\${name}: not rendered, its arguments kept as text`, count: u.count, file: u.file, line: u.line });
    // No full-document linked()/orphan drain: references outside this card remain navigation
    // targets, and counters outside its bounded source were never this renderer's responsibility.
    const namespaced = namespaceSlice(body, this.footnotes, prefix, this.sourceLabels);
    return { ...namespaced, colors: this.colors, items: [...this.o.report.items] };
  }

  /** Expansions must remain bounded too, not only the authored source/input closure. */
  checkSliceWork(): void {
    if (!this.sliceMode) return;
    if (this.o.signal.aborted) throw abortError("The source preview was cancelled.");
    if (++this.sliceWorkNodes > SLICE_MAX_NODES * 4) throw new Error("Source slice exceeds the expanded node limit.");
  }

  /**
   * `html` with every link to an id the page lacks as plain text (a label inside a construct the
   * page does not show, a citation of a bibliography it does not print): one report item each.
   */
  private linked(html: string): string {
    return html.replace(/<a class="([^"]*)" href="#([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (link, cls: string, target: string, inner: string) => {
      const id = decodeURIComponent(target);
      if (this.ids.has(id)) return link;
      const what = id.startsWith("llx-bib-") ? `citation ${id.slice(8)}: no bibliography entry on the page` : `reference to ${id}: its label is not on the page`;
      this.o.report.add({ severity: "warning", kind: id.startsWith("llx-bib-") ? "cite" : "ref", message: what });
      return cls.includes("llx-ref") ? `<span class="${cls}">${inner}</span>` : inner;
    });
  }

  // ---- flow: paragraphs and blocks ------------------------------------------------------------

  private skipFrontmatter(n: TexNode, ctx: Ctx): boolean {
    if (this.sliceMode && this.excluded.has(`${ctx.visit}|${ctx.file.key}|${n.from}|${n.to}`)) return true;
    if (!this.frontmatter) return false;
    if (ctx.metadata) return false;
    if (this.frontmatter.maketitle?.node === n && !this.header && !(n.t === "macro" && n.name === "maketitle")) this.titleBlock(ctx, n, () => []);
    if (!this.frontmatter.consumed.has(n)) return false;
    if (n.t === "env" && n.name === "abstract") this.o.queue?.takeFrontmatterToc(this.span(n, ctx), false, this.name("abstract"));
    return true;
  }

  /** A file's or the document's top-level nodes, yielding to the UI between them. */
  private async flowAsync(nodes: readonly TexNode[], ctx: Ctx): Promise<string> {
    const flow = new Flow(this, ctx);
    for (let i = 0; i < nodes.length; i++) {
      if (this.o.signal.aborted) throw abortError("The export was cancelled.");
      if (Date.now() - this.lastYield > 30) {
        this.o.progress?.(this.counts.math ?? 0);
        await this.o.idle();
        this.lastYield = Date.now();
      }
      const n = nodes[i];
      if (this.skipFrontmatter(n, ctx)) continue;
      if (n.t === "macro" && isInput(n)) {
        const child = this.inputOf(n, ctx);
        if (child) flow.block(await this.flowAsync(visitNodes(this.o.plan, child.visit), child));
        else if (this.sliceMode) flow.block(this.missingInput(n, ctx));
        continue;
      }
      flow.add(n, () => nodes.slice(i + 1));
    }
    return flow.finish();
  }

  /** Nodes as block content (paragraphs and blocks). */
  flow(nodes: readonly TexNode[], ctx: Ctx, lead = ""): string {
    const flow = new Flow(this, ctx, lead);
    nodes.forEach((n, i) => { if (!this.skipFrontmatter(n, ctx)) flow.add(n, () => nodes.slice(i + 1)); });
    return flow.finish();
  }

  /** The file an `\input`-like node reads, as the next plan visit; null when the plan did not visit it. */
  inputOf(n: TexNode & { t: "macro" }, ctx: Ctx): Ctx | null {
    if (ctx.at) return null;
    const { plan } = this.o;
    const site = `${ctx.visit}@${n.from}`;
    const index = plan.inputTargets.get(site);
    if (index === undefined || (!this.sliceMode && index !== this.nextVisit)) {
      const key = plan.inputKeys.get(site);
      if (key && plan.missing.has(key)) this.note("build", `${key}: file not found or outside the project`, ctx, n);
      return null;
    }
    if (!this.sliceMode) this.nextVisit++;
    const v = plan.visits[index];
    return { file: plan.files.get(v.key)!, visit: index, float: null, depth: 0 };
  }

  private missingInput(n: TexNode, ctx: Ctx): string {
    this.note("build", "Input was not available in the cached source plan; shown as source", ctx, n);
    return `<pre class="llx-source">${esc(ctx.file.src.slice(n.from, n.to))}</pre>`;
  }

  /** Skip the visits a construct the emitter does not descend into would open (a fragment's). */
  private skipVisits(ctx: Ctx, from: number, to: number): void {
    const { visits } = this.o.plan;
    while (this.nextVisit < visits.length) {
      const v = visits[this.nextVisit];
      if (v.parent !== ctx.visit || v.parentLine < from || v.parentLine > to) return;
      const start = this.nextVisit++;
      while (this.nextVisit < visits.length && visits[this.nextVisit].parent >= start) this.nextVisit++;
    }
  }

  /** A block-level node's HTML, or null when it is inline content. */
  block(n: TexNode, ctx: Ctx, rest: () => TexNode[]): string | null {
    if (n.t === "env") {
      // An inline fragment (a picture, a table TeX draws) sits in its paragraph.
      const frag = this.fragments.get(`${ctx.file.key}@${n.from}`);
      return frag?.kind === "inline" ? null : this.environment(n, ctx);
    }
    if (n.t === "math") return n.display ? this.display(n, ctx) : null;
    if (n.t === "verb") return n.env ? this.verbatim(n, ctx) : null;
    if (n.t !== "macro") return null;
    const frag = this.fragments.get(`${ctx.file.key}@${n.from}`);
    if (frag && frag.kind === "block") return this.fragment(frag, ctx);
    if (isInput(n)) {
      const child = this.inputOf(n, ctx);
      return child ? this.flow(visitNodes(this.o.plan, child.visit), child) : this.sliceMode ? this.missingInput(n, ctx) : "";
    }
    if (n.name in LEVELS) return this.heading(n, ctx, rest);
    // A box around a table or a picture (`\resizebox{\linewidth}{!}{..}`): its content, at the text's width.
    if (BOXES.has(n.name) && n.args[n.args.length - 1]?.body?.some((x) => x.t === "env")) return this.flow(n.args[n.args.length - 1].body ?? [], ctx);
    switch (n.name) {
      case "maketitle":
        this.titleBlock(ctx, n, rest);
        return "";
      case "keywords":
        return `<p class="llx-paper-keywords"><strong>${this.o.profile.lang === "zh-CN" ? "关键词" : "Keywords"}:</strong> ${this.inline(n.args.at(-1)?.body ?? [], { ...ctx, metadata: true })}</p>`;
      case "tableofcontents":
        this.tocTitle ??= this.name("contents");
        return TOC_MARK;
      case "appendix":
        this.appendix = true;
        return "";
      case "printbibliography":
        return this.printbibliography(n, ctx);
      case "bibliography":
        return this.bibliography(n, ctx);
      case "includepdf":
        return this.includepdf(n, ctx);
      case "lstinputlisting":
        return this.inputListing(n, ctx);
      case "addcontentsline":
        this.o.queue?.take("toc", this.span(n, ctx));
        return "";
      case "par":
        return "";
    }
    return null;
  }

  // ---- inline --------------------------------------------------------------------------------

  /** Nodes as inline HTML; a font switch styles the rest of them. */
  inline(nodes: readonly TexNode[], ctx: Ctx): string {
    let out = "";
    let raw = "";
    const flushText = () => {
      if (raw) out += texLigatures(raw);
      raw = "";
    };
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (this.insideDrawn(n, ctx)) continue;
      if (n.t === "text") {
        raw += n.s;
        continue;
      }
      if (n.t === "comment") continue;
      flushText();
      if (n.t === "macro" && (n.name in SWITCHES || n.name === "color")) {
        const style = this.switchStyle(n, ctx, NO_STYLE);
        const rest = this.inline(nodes.slice(i + 1), ctx);
        return out + (styled(style) ? `<span${styleAttrs(style)}>${rest}</span>` : rest);
      }
      out += this.inlineNode(n, ctx);
    }
    flushText();
    return out;
  }

  /** The style after a switch (`\bfseries`, `\color{c}`) on top of `base`. */
  switchStyle(n: TexNode & { t: "macro" }, ctx: Ctx, base: Style): Style {
    if (n.name === "color") {
      const c = this.color(argText(ctx.file.src, n.args[1]), ctx, n);
      return c ? { ...base, color: c } : base;
    }
    const cls = SWITCHES[n.name];
    return base.classes.includes(cls) ? base : { ...base, classes: [...base.classes, cls] };
  }

  inlineNode(n: TexNode, ctx: Ctx): string {
    this.checkSliceWork();
    if ((this.sliceMode || !ctx.metadata) && this.skipFrontmatter(n, ctx)) return "";
    switch (n.t) {
      case "text":
        return texLigatures(n.s);
      case "space":
        return " ";
      case "par":
        return "<br>";
      case "comment":
        return "";
      case "group":
        return this.inline(n.body, ctx);
      case "math":
        return n.display ? this.display(n, ctx) : this.inlineMath(n, ctx);
      case "verb":
        return n.env ? this.verbatim(n, ctx) : `<code>${n.cmd === "lstinline" ? this.listingCode(ctx.file.src.slice(n.textFrom, n.textTo), ctx, n) : esc(ctx.file.src.slice(n.textFrom, n.textTo))}</code>`;
      case "env":
        return this.environment(n, ctx);
      case "macro":
        return this.macro(n, ctx);
    }
  }

  private macro(n: TexNode & { t: "macro" }, ctx: Ctx): string {
    const { src } = ctx.file;
    if (n.code) return "";
    const frag = this.fragments.get(`${ctx.file.key}@${n.from}`);
    if (frag) return this.fragment(frag, ctx);
    if (isInput(n)) {
      const child = this.inputOf(n, ctx);
      return child ? this.flow(visitNodes(this.o.plan, child.visit), child) : this.sliceMode ? this.missingInput(n, ctx) : "";
    }
    const name = n.name;
    const body = (i: number) => this.inline(n.args[i]?.body ?? [], ctx);
    const last = n.args.length - 1;
    if (STYLE_COMMANDS[name]) {
      const [open, close] = STYLE_COMMANDS[name];
      return open + body(last) + close;
    }
    if (name === "textcolor" || name === "colorbox") {
      const c = this.color(argText(src, n.args[1]), ctx, n);
      const inner = body(2);
      if (!c) return inner;
      return name === "colorbox" ? `<span class="llx-colorbox" style="background-color:${attr(c)}">${inner}</span>` : `<span style="color:${attr(c)}">${inner}</span>`;
    }
    if (name in SPACES) return SPACES[name];
    if (name === "\\" || name === "newline" || name === "linebreak") return "<br>";
    if (name === "label") return this.anchor(argText(src, n.args[0]).trim());
    if (name in REF_COMMANDS) return this.ref(n, ctx);
    if (CITES.has(name)) return this.cite(n, ctx);
    if (name === "footnote") return this.footnote(n, ctx);
    if (name === "footnotemark") return this.footnotemark(n, ctx);
    if (name === "footnotetext") {
      this.footnotetext(n, ctx);
      return "";
    }
    if (ACCENTS.has(name)) return esc(texText(src.slice(n.from, n.to)));
    if (ctx.bibliography) {
      // ACM supplies this identity wrapper only when the project has not defined it.
      // In particular a project's empty definition deliberately hides article titles.
      if (name === "showarticletitle" && this.o.defs.macros.has(name)) {
        const expanded = this.expand(n, ctx);
        if (expanded !== null) return expanded;
        this.note("unknown-macro", "\\showarticletitle: project definition could not be rendered", ctx, n);
        return body(0);
      }
      const wrapper = BBL_WRAPPERS[name];
      if (wrapper !== undefined) return body(wrapper);
      if (BBL_SILENT.has(name)) return "";
      if (name in BBL_TEXT) return esc(BBL_TEXT[name]);
      const quotes = BBL_QUOTES[name];
      if (quotes) return esc(quotes[0]) + body(0) + esc(quotes[1]);
      if (name === "BibitemShut") {
        const text = bblShutText(argText(src, n.args[0]).trim());
        if (text !== null) return esc(text);
        this.unknownMacro(name, ctx, n);
        return body(0);
      }
    }
    if (ctx.metadata) {
      if (this.className === "acmart") {
        if (["department", "institution", "streetaddress"].includes(name)) return body(last) + "<br>\n";
        if (["city", "state", "postcode"].includes(name)) return body(last) + ", ";
      }
      if (["fnm", "sur", "spfx", "sfx", "orgdiv", "orgname", "orgaddress", "street", "city", "postcode", "state", "country", "institution", "IEEEauthorblockN", "IEEEauthorblockA"].includes(name)) return body(last);
      if (name === "inst" || name === "IEEEauthorrefmark") return `<sup>${body(last)}</sup>`;
      if (name === "email") {
        const email = texText(argText(src, n.args[last])).trim();
        return `<a href="mailto:${attr(email)}">${esc(email)}</a>`;
      }
    }
    if (name in BBL_COMMANDS) return BBL_COMMANDS[name];
    if (name === "natexlab") return body(0);
    if (name === "doi") return `doi: ${this.link(`https://doi.org/${argText(src, n.args[0]).trim()}`, argText(src, n.args[0]).trim())}`;
    if (name === "url" || name === "nolinkurl") {
      const url = argText(src, n.args[0]);
      const safe = name === "url" ? safeUrl(url) : null;
      return safe ? `<a href="${attr(safe)}"><code>${esc(url)}</code></a>` : `<code>${esc(url)}</code>`;
    }
    if (name === "href") {
      const safe = safeUrl(argText(src, n.args[1]));
      const text = body(2);
      return safe ? `<a href="${attr(safe)}">${text}</a>` : text;
    }
    if (name === "includegraphics") return this.image(n, ctx);
    if (BOXES.has(name)) return body(last);
    if (name === "caption" || name === "subcaption") return this.inline(n.args[2]?.body ?? [], ctx);
    if (name === "item") return given(n.args[0]) ? body(0) + " " : "";
    if (name === "thanks") return "";
    if (name === "qed" && this.className === "llncs") {
      const expanded = this.expand(n, ctx);
      return expanded !== null ? expanded : `<span class="llx-qed">${this.o.math.render(String.raw`\sqcup\!\!\!\sqcap`, false)}</span>`;
    }
    if (name === "and") return ", ";
    if (name === "TeX" || name === "LaTeX") return name;
    if (name === "today") {
      const value = this.o.log?.info.get("today");
      // A protected redefinition may survive the probe's expansion. Avoid recursing into it:
      // a readable source definition can still render it, otherwise report the missing value.
      if (value !== undefined && !/\\today(?![A-Za-z])/.test(value)) return this.texHtml(value, ctx, this.span(n, ctx));
      const expanded = ctx.depth < 8 ? this.expand(n, ctx) : null;
      if (expanded !== null) return expanded;
      this.note("unknown-macro", "\\today: no expanded value from TeX, shown as source", ctx, n, "warning");
      return '<code class="llx-source">\\today</code>';
    }
    if (SILENT.has(name) || name in SWITCHES) return "";
    const expanded = this.expand(n, ctx);
    if (expanded !== null) return expanded;
    const typeset = n.args.length === 0 ? texText(src.slice(n.from, n.to)) : "";
    if (typeset) return esc(typeset);
    this.unknownMacro(name, ctx, n);
    return n.args.map((a) => (a.body && a.kind !== "o" ? this.inline(a.body, ctx) : "")).join("");
  }

  /** A user macro with a text body (`\newcommand{\zhen}[2]{#1（#2）}`), expanded and rendered; null when there is none. */
  private expand(n: TexNode & { t: "macro" }, ctx: Ctx): string | null {
    const m = this.o.defs.macros.get(n.name);
    if (!m || m.math || ctx.depth > 8) return null;
    const re = new RegExp(String.raw`^\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand)\{\\${n.name}\}(?:\[(\d)\])?(?:\[([^\]]*)\])?\{([\s\S]*)\}$`);
    const simpleDef = new RegExp(String.raw`^\\(?:gdef|def)\\${n.name}((?:#\d)*)\{([\s\S]*)\}$`);
    let definition: { optional?: string; body: string } | null = null;
    for (const st of this.o.defs.statements) {
      const match = re.exec(st);
      if (match) definition = { optional: match[2], body: match[3] };
      else {
        const def = simpleDef.exec(st);
        // Only ordinary consecutive arguments, not TeX's delimited parameter syntax.
        if (def && def[1] === Array.from({ length: def[1].length / 2 }, (_, i) => `#${i + 1}`).join("")) definition = { body: def[2] };
      }
    }
    if (!definition) return null;
    const { src } = ctx.file;
    const optional = definition.optional !== undefined;
    const args = n.args.map((a, i) => (i === 0 && optional && !given(a) ? definition!.optional! : argText(src, a)));
    const text = definition.body.replace(/#(\d)/g, (_m, k: string) => args[Number(k) - 1] ?? "");
    const expandedCtx = this.textCtx(text, ctx, this.span(n, ctx));
    return this.inline(parseTex(text, this.o.plan.sig), expandedCtx);
  }

  /** A context for TeX that is not the file's text (no fragment or visit lookups by offset), its numbers taken in `at`. */
  private textCtx(text: string, ctx: Ctx, at: Span): Ctx {
    if (this.sliceMode && (this.sliceExpandedChars += text.length) > SLICE_MAX_CHARS * 4) throw new Error("Source slice exceeds the expanded character limit.");
    return { ...ctx, file: { ...ctx.file, key: "", src: text, lines: [0] }, at, depth: ctx.depth + 1 };
  }

  /** TeX that is not the file's text (an `\intertext`, a .bbl field) as inline HTML. */
  private texHtml(tex: string, ctx: Ctx, at: Span): string {
    const expandedCtx = this.textCtx(tex, ctx, at);
    return joinCjk(this.inline(parseTex(tex, this.o.plan.sig), expandedCtx)).trim();
  }

  private inlineMath(n: TexNode & { t: "math" }, ctx: Ctx): string {
    this.count("math");
    const frag = this.fragments.get(`${ctx.file.key}@${n.from}`);
    if (frag) return this.fragment(frag, ctx);
    const tex = ctx.file.src.slice(n.srcFrom, n.srcTo);
    const anchors = [...tex.matchAll(/\\label\s*\{([^{}]*)\}/g)].map((m) => this.anchor(m[1].trim())).join("");
    try {
      return anchors + this.o.math.render(tex, false);
    } catch (e) {
      if (!(e instanceof MathError)) throw e;
      this.note("math", `MathJax: ${e.message}`, ctx, n);
      return `${anchors}<code class="llx-math llx-math-error" title="${attr(e.message)}">${esc(tex)}</code>`;
    }
  }

  /**
   * A display formula: anchors for its labels, each part rendered (an `\intertext` between parts is
   * a paragraph), each numbered row tagged with the number TeX printed (see math.ts for which rows
   * take a step). A part MathJax rejects makes the display its source in `<pre>`.
   */
  private display(n: TexNode & { t: "math" }, ctx: Ctx): string {
    this.count("math");
    const frag = this.fragments.get(`${ctx.file.key}@${n.from}`);
    if (frag) return this.fragment(frag, ctx, true);
    const { src } = ctx.file;
    const tex = n.env ? src.slice(n.from, n.to) : src.slice(n.srcFrom, n.srcTo);
    const layout = displayLayout(tex, n.env);
    const anchors = layout.labels.map((k) => this.anchor(k)).join("");
    const tags = this.rowTags(layout.numbering, layout.parts.flatMap((p) => (p.kind === "math" ? p.rows : [])), this.span(n, ctx), ctx, n);
    let html = "";
    try {
      for (const p of layout.parts) {
        if (p.kind === "text") {
          const text = this.texHtml(tex.slice(p.from, p.to), ctx, this.span(n, ctx));
          html += `<p class="llx-cont llx-intertext">${text}</p>`;
        } else html += `<div class="llx-display">${this.o.math.render(displayTex(tex, layout, p, (row) => tags.get(row) ?? null), true)}</div>`;
      }
    } catch (e) {
      if (!(e instanceof MathError)) throw e;
      this.note("math", `MathJax: ${e.message}`, ctx, n);
      return `${anchors}<pre class="llx-source llx-math-error" title="${attr(e.message)}">${esc(tex.trim())}</pre>`;
    }
    return anchors + html;
  }

  /**
   * The numbers of a display's rows (see math.ts): each numbered row takes the next equation step
   * in the display's lines (else its label's .aux number, else `?`); rows TeX steps for but does
   * not number take theirs too (an equation with its own \tag, eqnarray's undone last step).
   */
  private rowTags(numbering: Numbering, rows: DisplayRow[], span: Span, ctx: Ctx, at: TexNode): Map<DisplayRow, string> {
    const tags = new Map<DisplayRow, string>();
    const own = (row: DisplayRow) => {
      if (row.own === "tag" && row.tag !== null) this.numbers.push({ counter: "tag", value: texText(row.tag), shown: true, ...(row.labels[0] ? { label: row.labels[0] } : {}) });
    };
    const step = (row: DisplayRow | null) => {
      const s = this.o.queue?.take("equation", span);
      if (s) {
        const value = texText(s.value);
        this.numbers.push({ counter: "equation", value, shown: row !== null, ...(row?.labels[0] ? { label: row.labels[0] } : {}) });
        if (row) tags.set(row, value);
        return;
      }
      if (!row) return;
      const aux = row.labels[0] ? this.o.refs.labels.get(row.labels[0]) : undefined;
      tags.set(row, aux ? texText(aux.number) : "?");
      if (this.o.queue || !aux) this.note("numbering", `equation: no number from TeX${aux ? " (the .aux's used)" : ""}`, ctx, at);
    };
    if (numbering === "equation") {
      rows.forEach(own);
      step(rows[0] && !rows[0].own ? rows[0] : null);
    } else if (numbering === "multline" || numbering === "rows" || numbering === "eqnarray") {
      for (const row of rows) {
        own(row);
        if (!row.own) step(row);
      }
      if (numbering === "eqnarray") step(null);
    } else {
      rows.forEach(own);
      if (numbering === "eqnarray*") step(null);
    }
    return tags;
  }

  private verbatim(n: TexNode & { t: "verb" }, ctx: Ctx): string {
    const { src } = ctx.file;
    this.count("verbatim");
    if (n.env === "comment" || n.env?.startsWith("filecontents")) return "";
    let text = src.slice(n.textFrom, n.textTo);
    // The rest of the \begin line is no text (listings drops it), nor the \end line's indentation.
    text = text.replace(/^[^\n]*\n/, (first) => (first.trim() ? first : "")).replace(/\n[ \t]*$/, "");
    if (n.env !== "lstlisting") return `<pre><code>${esc(text)}</code></pre>`;
    return this.listing(`<pre class="llx-lst"><code>${this.listingCode(text, ctx, n)}</code></pre>`, n.args[0], ctx, n);
  }

  /** `\lstinputlisting[..]{file}` (from the root's folder, its `firstline`..`lastline`) as a listing. */
  private inputListing(n: TexNode & { t: "macro" }, ctx: Ctx): string {
    const { src } = ctx.file;
    const name = argText(src, n.args[1]).trim();
    const opts = optionArg(src, n.args[0]);
    const loaded = this.o.images.listingAt(ctx.at ? undefined : `${ctx.visit}@${n.from}`);
    if (!loaded || "error" in loaded) {
      this.note("build", loaded?.error ?? `${name}: listing was not prepared`, ctx, n);
      return `<p class="llx-cont llx-missing">[${esc(name)}]</p>`;
    }
    const text = loaded.text;
    const lines = text.replace(/\n$/, "").split("\n");
    const first = Number(opts.get("firstline")) || 1;
    const last = Number(opts.get("lastline")) || lines.length;
    this.count("verbatim");
    return this.listing(`<pre class="llx-lst"><code>${this.listingCode(lines.slice(first - 1, last).join("\n"), ctx, n)}</code></pre>`, n.args[0], ctx, n);
  }

  /** Effective listing settings are TeX's, including class defaults and local option scopes. */
  private listingCode(text: string, ctx: Ctx, at: TexNode): string {
    const settings = this.o.queue?.takeListing(this.span(at, ctx));
    if (!settings || !this.o.code) return esc(text);
    const out = highlightListing(text, settings, this.o.code, (name) => this.color(name, ctx, at));
    for (const issue of out.issues) this.note("code", issue, ctx, at);
    if (out.html !== esc(text)) this.count("highlightedListings");
    return out.html;
  }

  /** A listing's `<pre>`, anchored by its `label=`, under its `caption=` with the number TeX gave it. */
  private listing(pre: string, opts: TexArg | undefined, ctx: Ctx, at: TexNode): string {
    const key = given(opts) ? /(?:^|,)\s*label\s*=\s*\{?([^,{}]+)\}?/.exec(argText(ctx.file.src, opts))?.[1].trim() : undefined;
    const anchor = key ? this.anchor(key) : "";
    const caption = this.listingCaption(opts, ctx);
    if (caption === null) return anchor + pre;
    const step = this.o.queue?.take("lstlisting", this.span(at, ctx));
    const name = this.name("lstlisting");
    if (step) this.numbers.push({ counter: "lstlisting", value: texText(step.value), shown: true, ...(key ? { label: key } : {}) });
    const label = step ? `${name} ${texText(step.value)}` : name;
    return `${anchor}<figure class="llx-listing"><figcaption><span class="llx-caption-label">${esc(label)}</span>${caption}</figcaption>${pre}</figure>`;
  }

  /** A listing's `caption=` option as HTML, or null without one. */
  private listingCaption(arg: TexArg | undefined, ctx: Ctx): string | null {
    const opts = arg?.body;
    if (!opts || !given(arg)) return null;
    for (let i = 0; i < opts.length; i++) {
      const t = opts[i];
      if (t.t !== "text" || !/(?:^|,)\s*caption\s*=\s*$/.test(t.s)) continue;
      const next = opts[i + 1];
      if (next?.t === "group") return joinCjk(this.inline(next.body, ctx));
    }
    const m = /(?:^|,)\s*caption\s*=\s*([^,{}]+)/.exec(argText(ctx.file.src, arg));
    return m ? texLigatures(m[1].trim()) : null;
  }

  // ---- constructs ----------------------------------------------------------------------------

  /** A sectioning command's heading; `\paragraph` and below run into the next paragraph (`runIn`: its lead). */
  heading(n: TexNode & { t: "macro" }, ctx: Ctx, rest: () => TexNode[], runIn = false): string {
    const level = LEVELS[n.name];
    const starred = given(n.args[0]);
    const title = joinCjk(this.inline(n.args[2]?.body ?? [], ctx));
    // Labels right after the heading anchor it.
    const labels: string[] = [];
    for (const x of rest()) {
      if (x.t === "space" || x.t === "comment") continue;
      if (x.t === "macro" && x.name === "label") labels.push(argText(ctx.file.src, x.args[0]).trim());
      else break;
    }
    let number: string | null = null;
    let toc = false;
    if (!starred) {
      const step = this.o.queue?.take("toc", this.span(n, ctx));
      if (step) {
        number = tocEntry(step.value).number;
        toc = true;
      } else if (this.o.queue) {
        this.note("numbering", `\\${n.name} has no contents record: shown without a number`, ctx, n, "warning");
      } else if (labels[0]) {
        const l = this.o.refs.labels.get(labels[0]);
        number = l ? texText(l.number) : null;
      }
    }
    this.count("headings");
    return this.headingHtml(level, number, title, toc, labels, { runIn });
  }

  /**
   * A heading (its contents entry recorded): `h2`.. by level below the document's top one, classed
   * by level (`llx-chapter`); a chapter's number as the class prints it (profiles.ts chapterLabel).
   */
  private headingHtml(level: number, number: string | null, title: string, toc: boolean, labels: string[] = [], o: { runIn?: boolean; cls?: string } = {}): string {
    const id = this.uniqueId(labels.find((l) => !this.ids.has(l)) ?? `llx-h${this.headings.length + 1}`);
    this.headings.push({ level, number, title, id, toc });
    const anchors = labels.filter((l) => l !== id).map((l) => this.anchor(l)).join("");
    const shown = number && level === 0 ? chapterLabel(this.o.profile, number, this.appendix, (k) => this.name(k)) : number;
    const inner = `${anchors}${shown ? `<span class="llx-num">${esc(shown)}</span>` : ""}${title}`;
    const cls = `llx-${LEVEL_NAMES[level + 1] ?? "section"}${o.cls ? ` ${o.cls}` : ""}`;
    if (o.runIn) return `<b class="llx-runin ${cls}" id="${attr(id)}">${inner}</b>`;
    const h = Math.min(6, Math.max(2, 2 + level - this.minLevel));
    return `<h${h} class="${cls}" id="${attr(id)}">${inner}</h${h}>`;
  }

  private environment(n: TexNode & { t: "env" }, ctx: Ctx): string {
    const name = n.name;
    // ACM excludes these comment-style environments when anonymous. Wrapping their begin/end
    // lines as fragments would also prevent the comment package from recognizing the end line.
    if (["acks", "anonsuppress"].includes(name) && this.o.log?.info.has("title-anonymous")) {
      if (this.o.log?.info.get("title-anonymous") === "true") {
        this.skipVisits(ctx, lineAt(ctx.file, n.from), lineAt(ctx.file, n.to));
        return "";
      }
      if (name === "anonsuppress") return this.flow(n.body, ctx);
      const span = this.span(n, ctx);
      const toc = this.o.queue?.take("toc", span);
      const label = toc ? this.texHtml(tocEntry(toc.value).title, ctx, span) : this.o.defs.macros.has("acksname") ? this.texHtml("\\acksname", ctx, span) : "Acknowledgments";
      return this.headingHtml(LEVELS.section, null, label, !!toc) + this.flow(n.body, ctx);
    }
    const expanded = this.o.plan.environmentExpansions.get(`${ctx.file.key}@${n.from}`);
    if (expanded !== undefined) {
      const expandedCtx = this.textCtx(expanded, ctx, this.span(n, ctx));
      return this.flow(parseTex(expanded, this.o.plan.sig), expandedCtx);
    }
    const frag = this.fragments.get(`${ctx.file.key}@${n.from}`);
    // An environment the plan made a TeX fragment that the census calls a theorem is one (unless
    // it holds a picture, which only TeX can draw); its steps are then the head's.
    const census = frag?.kind === "block" ? this.census.get(name) : undefined;
    if (census && PICTURE_INSIDE.test(ctx.file.src.slice(n.bodyFrom, n.bodyTo))) return this.fragment(frag!, ctx);
    if (census) this.note("unknown-env", `\\begin{${name}}: a \\newtheorem of the class or a package (the probe's census), shown as a theorem`, ctx, n, "info");
    else if (frag) return this.fragment(frag, ctx);
    const def = this.o.theorems.get(name) ?? census;
    if (def) return this.theorem(n, def, ctx);
    if (LISTS.has(name)) return this.list(n, ctx);
    if (name in FLOATS) {
      const inner = this.flow(n.body, { ...ctx, float: FLOATS[name], floatAt: { visit: ctx.visit, line: lineAt(ctx.file, n.from) } });
      return `<figure class="llx-float llx-${FLOATS[name]}">${inner}</figure>`;
    }
    if (name in SUBFLOATS || name === "minipage") {
      // Side by side at the width TeX gives them (`0.45\textwidth` is 45 %), aligned on `[t]`/`[b]`.
      const { src } = ctx.file;
      const width = cssLength(argText(src, n.args[3]), this.fontPt);
      const pos = argText(src, n.args[0]).trim();
      const style = `${width ? `width:${width};` : ""}vertical-align:${pos === "t" ? "top" : pos === "b" ? "bottom" : "middle"}`;
      if (name === "minipage") return `<div class="llx-minipage" style="${style}">${this.flow(n.body, ctx)}</div>`;
      return `<figure class="llx-subfloat" style="${style}">${this.flow(n.body, { ...ctx, float: SUBFLOATS[name] })}</figure>`;
    }
    switch (name) {
      case "center":
        return `<div class="llx-center" style="text-align:center">${this.flow(n.body, ctx)}</div>`;
      case "flushleft":
      case "flushright":
        return `<div style="text-align:${name === "flushleft" ? "left" : "right"}">${this.flow(n.body, ctx)}</div>`;
      case "quote":
      case "quotation":
      case "verse":
        return `<blockquote>${this.flow(n.body, ctx)}</blockquote>`;
      case "abstract":
        return `<section class="llx-abstract"><p class="llx-cont llx-abstract-title">${esc(this.name("abstract"))}</p>${this.flow(n.body, ctx)}</section>`;
      case "tabular":
      case "tabular*":
        return this.tabular(n, ctx);
      case "thebibliography":
        return this.thebibliography(n, ctx);
      case "subequations": {
        // Its own step (the parent number, `2`; the rows show `2a`, `2b`): taken, not shown.
        const line = lineAt(ctx.file, n.from);
        const step = ctx.at ? null : this.o.queue?.take("equation", { visit: ctx.visit, from: line, to: line });
        if (step) this.numbers.push({ counter: "equation", value: texText(step.value), shown: false });
        return `<div class="llx-subequations">${this.flow(n.body, ctx)}</div>`;
      }
      default:
        // document, minipage, subequations, multicols, titlepage, size environments.
        if (!HTML_ENVS.has(name)) this.note("unknown-env", `\\begin{${name}}: its body kept as text`, ctx, n, "warning");
        return `<div class="llx-${attr(name.replace(/\*$/, ""))}">${this.flow(n.body, ctx)}</div>`;
    }
  }

  private theorem(n: TexNode & { t: "env" }, def: TheoremDef, ctx: Ctx): string {
    const { src } = ctx.file;
    let title: TexArg | undefined;
    let label: string | null = null;
    if (def.spec === "tcb" || def.spec === "tcb*") {
      // `{title}{label}` (labelled prefix:label) or `[title]\label{k}`.
      title = [n.args[0], n.args[1]].find(given);
      const key = given(n.args[3]) ? argText(src, n.args[3]).trim() : "";
      if (key) label = given(n.args[2]) ? key : def.prefix ? `${def.prefix}:${key}` : key;
    } else if (def.spec === "o" || def.spec === "m") title = n.args.find(given);
    let body = n.body;
    // A \label first in the body anchors the environment.
    const first = body.findIndex((x) => x.t !== "space" && x.t !== "comment");
    if (!label && first >= 0 && body[first].t === "macro" && (body[first] as { name: string }).name === "label") {
      label = argText(src, (body[first] as TexNode & { t: "macro" }).args[0]).trim();
      body = body.slice(first + 1);
    }
    let number: string | null = null;
    if (def.numbered) {
      const counter = this.theoremCounter(n.name, def);
      const step = this.o.queue?.take(counter, this.span(n, ctx));
      if (step) {
        number = texText(step.value);
        this.numbers.push({ counter, value: number, shown: true, ...(label ? { label } : {}) });
      } else if (label && this.o.refs.labels.get(label)) number = texText(this.o.refs.labels.get(label)!.number);
      else {
        number = "?";
        this.note("numbering", `${n.name}: no number from TeX (counter ${counter})`, ctx, n, "warning");
      }
    }
    const base = n.name.replace(/\*$/, "");
    if (label) this.sourceLabels.add(label);
    const name = this.o.log?.names.get(base) || (def.user ? def.name : fallbackName(this.o.profile, base) || def.name);
    const titleHtml = title ? joinCjk(this.inline(title.body ?? [], ctx)) : "";
    // The head: the name (a [title] in its place for amsthm's proof and elegantbook's custom), the
    // number; the note after it: `(title)`, or the title as it is (elegantbook's example).
    let head = (def.title === "replace" || def.title === "name") && titleHtml ? titleHtml : esc(name);
    if (number) head += ` ${esc(number)}`;
    const note = !titleHtml ? "" : def.title === "paren" ? `(${titleHtml})` : def.title === "after" ? titleHtml : "";
    this.count("theorems");
    const look = theoremLook(this.o.profile, n.name, def, this.o.log?.envs.get(n.name));
    return theoremHtml(look, {
      cls: n.name === "proof" ? "llx-proof" : `llx-thm llx-${attr(base)}`,
      id: label ? this.uniqueId(label) : null,
      head,
      note,
      punct: look.punct ?? def.punct,
      qed: look.qed === undefined ? def.qed : look.qed,
      flow: (lead) => this.flow(body, ctx, lead),
    });
  }

  /** The counter a numbered theorem-like environment steps (census, elegantbook, \newtheorem). */
  private theoremCounter(env: string, def: TheoremDef): string {
    const meaning = this.o.log?.envs.get(env) ?? "";
    const thm = /\\@thm\s*(?:\[[^\]]*\])?\s*\{.*\}\s*\{([^{}]*)\}\s*\{[^{}]*\}\s*$/.exec(meaning);
    if (thm?.[1]) return thm[1];
    if (def.counter) return def.counter;
    if (def.spec === "tcb") return `tcb@cnt@${env}`;
    return env;
  }

  private list(n: TexNode & { t: "env" }, ctx: Ctx): string {
    const kind = n.name === "problemset" ? "enumerate" : n.name;
    const items: { item: TexNode & { t: "macro" }; body: TexNode[] }[] = [];
    let head = "";
    if (n.name === "problemset") {
      // elegantbook's problemset: a starred section with its own contents entry, then a list.
      const step = this.o.queue?.take("toc", this.span(n, ctx));
      const text = step ? tocEntry(step.value).title : this.name("exercise");
      head = this.headingHtml(LEVELS[step?.level ?? "section"] ?? 1, null, esc(text), !!step, [], { cls: "llx-problemset" });
    }
    for (const x of n.body) {
      if (x.t === "macro" && x.name === "item") items.push({ item: x, body: [] });
      else items[items.length - 1]?.body.push(x);
    }
    if (kind === "enumerate") this.enumDepth++;
    else if (kind === "itemize") this.itemizeDepth++;
    const depth = kind === "enumerate" ? this.enumDepth : this.itemizeDepth;
    let html: string;
    if (kind === "description") {
      html = `<dl>${items.map((it) => `<dt>${joinCjk(this.inline(it.item.args[0]?.body ?? [], ctx))}</dt><dd>${this.flow(it.body, ctx)}</dd>`).join("")}</dl>`;
    } else {
      const lis = items.map((it, i) => {
        let label: string;
        if (given(it.item.args[0])) label = joinCjk(this.inline(it.item.args[0].body ?? [], ctx));
        else if (kind === "enumerate") {
          const last = it.body[it.body.length - 1];
          const span = this.span({ from: it.item.from, to: last ? last.to : it.item.to }, ctx);
          const step = this.o.queue?.take(ENUMS[Math.min(depth, 4) - 1], span);
          if (step) label = this.itemLabel(step.value, ctx, it.item);
          else {
            label = `${i + 1}.`;
            if (this.o.queue) this.note("numbering", `item ${i + 1}: no label from TeX`, ctx, it.item, "warning");
          }
        } else {
          const b = bullet(this.o.profile, depth);
          const color = b.color ? this.color(b.color, ctx, it.item) : null;
          label = `<span class="llx-bullet"${color ? ` style="color:${attr(color)}"` : ""}>${b.text}</span>`;
        }
        return `<li><span class="llx-label">${label}</span>${this.flow(it.body, ctx)}</li>`;
      });
      html = `<${kind === "enumerate" ? "ol" : "ul"} class="llx-list">${lis.join("")}</${kind === "enumerate" ? "ol" : "ul"}>`;
    }
    if (kind === "enumerate") this.enumDepth--;
    else if (kind === "itemize") this.itemizeDepth--;
    this.count("lists");
    return head + html;
  }

  /** An enumerate label as TeX printed it, in its colour (the probe keeps enumitem's `\color`: elegantbook's structurecolor `1.`). */
  private itemLabel(value: string, ctx: Ctx, at: TexNode): string {
    const m = /\\color\s*\{([^{}]*)\}/.exec(value);
    const text = esc(texText(value));
    const color = m ? this.color(m[1], ctx, at) : null;
    return color ? `<span style="color:${attr(color)}">${text}</span>` : text;
  }

  /**
   * A caption (`\caption` in a float, subcaption's `\subcaption`, `\captionof{type}` anywhere): its
   * name and number as TeX printed them; `\caption*` has neither, a sub-float's is `(a)`.
   */
  caption(n: TexNode & { t: "macro" }, ctx: Ctx, rest: () => TexNode[]): string {
    const captionof = n.name === "captionof";
    const float = captionof ? argText(ctx.file.src, n.args[1]).trim() : n.name === "subcaption" ? (ctx.float === "table" ? "subtable" : "subfigure") : ctx.float;
    const arg = n.args[captionof ? 3 : 2];
    const text = joinCjk(this.inline(arg?.body ?? [], ctx));
    if (!float) return `<p class="llx-cont">${text}</p>`;
    if (given(n.args[0])) return `<figcaption>${text}</figcaption>`;
    const span = this.span(n, ctx);
    if (!captionof && ctx.floatAt?.visit === span.visit && !ctx.at) span.from = Math.min(span.from, ctx.floatAt.line);
    const step = this.o.queue?.take(float, span);
    const sub = Object.values(SUBFLOATS).includes(float);
    const name = this.name(float) || float;
    let number = step ? texText(step.value) : "";
    if (step) {
      // Its label: inside the caption, else right after it.
      let label: string | undefined;
      walkTex(arg?.body ?? [], (x) => void (x.t === "macro" && x.name === "label" && (label ??= argText(ctx.file.src, x.args[0]).trim())));
      const next = rest().find((x) => x.t !== "space" && x.t !== "comment");
      if (!label && next?.t === "macro" && next.name === "label") label = argText(ctx.file.src, next.args[0]).trim();
      // A sub-caption shows `(a)` where \ref prints `2a` (\p@subfigure): its label names no shown number.
      this.numbers.push({ counter: float, value: number, shown: true, ...(label && !sub ? { label } : {}) });
    } else if (this.o.queue) {
      number = "?";
      this.note("numbering", `${float} caption: no number from TeX`, ctx, n, "warning");
    }
    this.count("captions");
    const label = `<span class="llx-caption-label${sub ? " is-sub" : ""}">${esc(sub ? `(${number})` : `${name} ${number}`.trim())}</span>`;
    // A \captionof outside a float is a paragraph (a figcaption belongs in a figure).
    return captionof && !ctx.float ? `<p class="llx-cont llx-caption">${label}${text}</p>` : `<figcaption>${label}${text}</figcaption>`;
  }

  /** tabular (tables.ts): its columns, rules and spanning cells. */
  private tabular(n: TexNode & { t: "env" }, ctx: Ctx): string {
    const { src } = ctx.file;
    const layout = tableLayout(src, argText(src, n.args[n.name === "tabular*" ? 2 : 1]), n.body);
    this.count("tables");
    return tableHtml(layout, (nodes) => joinCjk(this.inline(nodes, ctx)).trim(), (tex) => cssLength(tex, this.fontPt));
  }

  /** `\includegraphics[..]{name}` as the image (images.ts) at the size the document gives it. */
  private image(n: TexNode & { t: "macro" }, ctx: Ctx): string {
    const { src } = ctx.file;
    const name = argText(src, n.args[3]).trim();
    const opts = optionArg(src, n.args[1]);
    const pic = this.o.images.graphic(name, Number(opts.get("page")) || 1, ctx.at ? undefined : `${ctx.visit}@${n.from}`);
    if (typeof pic === "string") {
      this.note("image", pic, ctx, n);
      return `<span class="llx-missing">[${esc(name)}]</span>`;
    }
    this.count("images");
    return this.img(pic, opts, basename(name, extname(name)));
  }

  /**
   * An `<img>`: graphicx's `width`/`height` (a fraction of the line as a percentage, lengths in em of
   * the document's font), else its natural size times `scale`; `angle` rotates it. Never wider than the text.
   */
  private img(pic: Picture, opts: ReadonlyMap<string, string>, alt: string): string {
    const width = opts.has("width") ? cssLength(opts.get("width")!, this.fontPt) : null;
    const height = opts.has("height") ? cssLength(opts.get("height")!, this.fontPt) : null;
    const scale = Number(opts.get("scale") ?? 1) || 1;
    const style: string[] = [];
    if (width) style.push(`width:${width}`);
    if (height && !height.endsWith("%") && !(width && opts.has("keepaspectratio"))) style.push(`height:${height}`);
    if (!width && !height && pic.width) style.push(`width:${Number(((pic.width * scale * 72.27) / 72 / this.fontPt).toFixed(3))}em`);
    const angle = Number(opts.get("angle"));
    if (angle) style.push(`transform:rotate(${-angle}deg)`);
    return `<img class="llx-img" src="${attr(pic.src)}" alt="${attr(alt)}"${style.length ? ` style="${style.join(";")}"` : ""}>`;
  }

  /** pdfpages' `\includepdf[pages=..]{file}`: each page an image; `addtotoc`'s entries anchor the first. */
  private includepdf(n: TexNode & { t: "macro" }, ctx: Ctx): string {
    const { src } = ctx.file;
    const name = argText(src, n.args[1]).trim();
    const span = this.span(n, ctx);
    let anchors = "";
    for (let s = this.o.queue?.take("toc", span); s; s = this.o.queue?.take("toc", span)) {
      const entry = tocEntry(s.value);
      const id = this.uniqueId(`llx-h${this.headings.length + 1}`);
      this.headings.push({ level: LEVELS[s.level ?? ""] ?? 1, number: entry.number, title: esc(entry.title), id, toc: true });
      anchors += `<a id="${attr(id)}"></a>`;
    }
    const pages = this.o.images.pdfPages(name, optionArg(src, n.args[0]).get("pages") ?? null, ctx.at ? undefined : `${ctx.visit}@${n.from}`);
    if (typeof pages === "string") {
      this.note("image", pages, ctx, n);
      return `${anchors}<p class="llx-cont llx-missing">[${esc(name)}]</p>`;
    }
    this.count("pdfpages", pages.length);
    const alt = basename(name, extname(name));
    return `${anchors}<div class="llx-pdfpages">${pages.map((p) => this.img(p, new Map(), alt)).join("")}</div>`;
  }

  /** The bibliography's heading: its contents record (tocbibind, elegantbook's bibintoc), else the class's name. */
  private bibHeading(ctx: Ctx, at: TexNode, title: string | null): string {
    const step = this.o.queue?.take("toc", this.span(at, ctx));
    // biblatex and natbib head it with \bibname where \chapter exists, else \refname.
    const book = this.o.log ? this.o.log.names.has("chapter") : this.minLevel <= 0;
    const text = step ? tocEntry(step.value).title : (title ?? this.name(book ? "bib" : "ref"));
    return this.headingHtml(LEVELS[step?.level ?? ""] ?? this.minLevel, null, esc(text), !!step);
  }

  /** An entry's id (the first bibliography listing a key gets it). */
  private bibAnchor(key: string): string {
    if (this.ids.has(bibId(key))) return "";
    this.ids.add(bibId(key));
    return ` id="${attr(bibId(key))}"`;
  }

  /**
   * biblatex's \printbibliography: the entries the probe saw it print (`llx@bib` records in its
   * lines), in that order, with their numbers; without records the .bbl's whole data list.
   */
  private printbibliography(n: TexNode & { t: "macro" }, ctx: Ctx): string {
    const options = argText(ctx.file.src, n.args[0]);
    const title = /(?:^|,)\s*title\s*=\s*(?:\{([^{}]*)\}|([^,]*))/.exec(options);
    const heading = /(?:^|,)\s*heading\s*=\s*none\b/.test(options) ? "" : this.bibHeading(ctx, n, title ? texText(title[1] ?? title[2]) : null);
    const span = this.span(n, ctx);
    const keys: string[] = [];
    for (let s = this.o.queue?.take("llx@bib", span); s; s = this.o.queue?.take("llx@bib", span)) keys.push(s.value);
    if (!keys.length && !this.o.queue) keys.push(...this.o.bib.entries.keys());
    const items: string[] = [];
    for (const key of keys) {
      const e = this.o.bib.entries.get(key);
      if (!e) continue;
      const c = this.o.log?.cites.get(key);
      const label = c?.number ? `<span class="llx-label">[${esc(c.prefix + c.number)}]</span>` : "";
      const text = formatEntry(e, (tex) => this.texHtml(tex, ctx, span), (url, t) => this.link(url, t));
      items.push(`<li${this.bibAnchor(key)}>${label}${text}</li>`);
    }
    if (!items.length) this.note("cite", "\\printbibliography: no entries (the build's .bbl has none)", ctx, n);
    this.count("bibitems", items.length);
    return `${heading}<ol class="llx-list llx-bib">${items.join("")}</ol>`;
  }

  /** BibTeX's \bibliography: the thebibliography of the build's .bbl, read where it stands. */
  private bibliography(n: TexNode & { t: "macro" }, ctx: Ctx): string {
    const bbl = this.o.bib.bbl?.replace(/\\penalty\s*-?\d+\s*/g, "") ?? null;
    const env = bbl === null ? undefined : parseTex(bbl, this.o.plan.sig).find((x) => x.t === "env" && x.name === "thebibliography");
    if (bbl === null || env?.t !== "env") {
      this.note("cite", "\\bibliography: the build wrote no .bbl", ctx, n);
      return this.bibHeading(ctx, n, null);
    }
    return this.thebibliography(env, this.textCtx(bbl, ctx, this.span(n, ctx)));
  }

  /**
   * thebibliography's items with the labels the .aux's `\bibcite` gives them: natbib's numbers as
   * `[1]` (none in author-year mode), LaTeX's `[1]` or `[Knu84]`.
   */
  private thebibliography(n: TexNode & { t: "env" }, ctx: Ctx): string {
    ctx = { ...ctx, bibliography: true };
    const heading = this.bibHeading(ctx, n, null);
    const natbib = this.natbib();
    const items: string[] = [];
    let current: { key: string; label: string; body: TexNode[] } | null = null;
    const flush = () => {
      if (!current) return;
      const label = current.label ? `<span class="llx-label">[${esc(current.label)}]</span>` : "";
      items.push(`<li${this.bibAnchor(current.key)}>${label}${this.flow(current.body, ctx)}</li>`);
    };
    for (const x of n.body) {
      if (x.t === "macro" && x.name === "bibitem") {
        flush();
        const key = argText(ctx.file.src, x.args[1]).trim();
        const cite = this.o.bib.bibcites.get(key);
        const own = given(x.args[0]) ? texText(argText(ctx.file.src, x.args[0])) : null;
        const number = String(items.length + 1);
        const label = natbib ? (natbib.numbers ? texText(cite?.label ?? number) : "") : cite ? texText(cite.label) : (own ?? number);
        current = { key, label, body: [] };
      } else current?.body.push(x);
    }
    flush();
    this.count("bibitems", items.length);
    return `${heading}<ol class="llx-list llx-bib${natbib && !natbib.numbers ? " llx-bib-ay" : ""}">${items.join("")}</ol>`;
  }

  /** natbib's mode and punctuation as the probe saw them at the end of the document; null without natbib. */
  private natbib(): { numbers: boolean; super: boolean; sort: boolean; compress: boolean; open: string; close: string; sep: string; aysep: string; cmt: string; defaultCite: string } | null {
    const info = this.o.log?.info;
    const flags = info?.get("natbib")?.split(",");
    if (!info || !flags) return null;
    // An empty aysep/notesep is meaningful (ACM's author-year form has no comma).
    const punct = (name: string, fallback: string) => texText(info.get(`natbib-${name}`) ?? fallback);
    return {
      numbers: flags.includes("numbers"),
      super: flags.includes("super"),
      sort: flags.includes("sort"),
      compress: flags.includes("compress"),
      open: punct("open", "["),
      close: punct("close", "]"),
      sep: punct("sep", ","),
      aysep: punct("aysep", ","),
      cmt: punct("cmt", ","),
      defaultCite: info.get("natbib-default-cite") ?? "auto",
    };
  }

  /**
   * A TeX fragment: the SVG dvisvgm drew of its page (a block on its own, centred when it is a
   * display), anchored by its labels; else its source (report item). The steps TeX took inside it
   * are in the drawing: the queue drops them and the counters the page shows are recorded.
   */
  private fragment(f: PlanFragment, ctx: Ctx, display = false): string {
    this.count("fragments");
    const from = lineAt(ctx.file, f.from);
    const to = lineAt(ctx.file, Math.max(f.from, f.to - 1));
    const text = ctx.file.src.slice(f.from, f.to);
    const labels = [...text.matchAll(/\\label\s*\{([^{}]*)\}/g)].map((m) => m[1].trim());
    const key = this.o.queue ? this.o.queue.fragmentKey(f.id, ctx.visit) : drawingKey(ctx.visit, f.id);
    const svg = key === null ? undefined : this.o.fragments.get(key);
    this.drawn(this.o.queue?.drop(f.id, ctx.visit) ?? [], labels, !!svg);
    this.skipVisits(ctx, from, to);
    if (!ctx.at) this.drawnSpan = { key: ctx.file.key, from: f.from, to: f.to };
    const anchors = labels.map((k) => this.anchor(k)).join("");
    if (svg) return f.kind === "inline" ? anchors + svg : `${anchors}<div class="llx-frag-block${display ? " is-display" : ""}">${svg}</div>`;
    this.note("fragment", `${f.what}: TeX drew no picture of it (see the probe's errors), shown as source`, ctx, f);
    return f.kind === "inline" ? `${anchors}<code class="llx-source">${esc(text)}</code>` : `${anchors}<pre class="llx-source">${esc(text)}</pre>`;
  }

  /** A node that lies inside the fragment just emitted (a later sibling of the node it started at). */
  insideDrawn(n: TexNode, ctx: Ctx): boolean {
    const d = this.drawnSpan;
    return !!d && !ctx.at && d.key === ctx.file.key && n.from > d.from && n.to <= d.to;
  }

  /** Steps inside a fragment: the numbers of counters the page shows, as shown (a lone label names a lone step). */
  private drawn(steps: readonly ProbeStep[], labels: readonly string[], rendered: boolean): void {
    const shown = steps.filter((s) => this.shownCounters.has(s.counter) || s.counter.startsWith("tcb@cnt@"));
    shown.forEach((s) => this.numbers.push({ counter: s.counter, value: texText(s.value), shown: rendered, ...(labels.length === 1 && shown.length === 1 ? { label: labels[0] } : {}) }));
  }

  private ref(n: TexNode & { t: "macro" }, ctx: Ctx): string {
    const keys = argText(ctx.file.src, n.args[n.args.length - 1]).split(",").map((k) => k.trim()).filter(Boolean);
    const { text, missing } = refText(REF_COMMANDS[n.name], keys, this.o.refs);
    if (missing) this.note("ref", `\\${n.name}{${keys.join(",")}}: not in the .aux`, ctx, n, "warning");
    this.count("refs");
    const cls = missing ? "llx-ref is-missing" : "llx-ref";
    const starred = n.args[0]?.kind === "s" && given(n.args[0]);
    const target = keys.find((k) => this.o.refs.labels.has(k));
    if (this.sliceMode && keys.length) {
      const key = target ?? keys[0];
      const data = ` data-ll-tex-ref="${attr(key)}" data-ll-tex-refs="${attr(JSON.stringify(keys))}"`;
      return starred ? `<span class="${cls}"${data}>${esc(text)}</span>` : `<a class="${cls}" href="${attr(hrefId(key))}"${data}>${esc(text)}</a>`;
    }
    return starred || !target ? `<span class="${cls}">${esc(text)}</span>` : `<a class="${cls}" href="${attr(hrefId(target))}">${esc(text)}</a>`;
  }

  /** A citation's labels, each linked to its bibliography entry. */
  private labelHtml(pieces: readonly LabelPiece[]): string {
    return pieces.map((p) => ("sep" in p ? esc(p.sep) : `<a class="llx-cite-link" href="${attr(hrefId(bibId(p.key)))}">${esc(p.text)}</a>`)).join("");
  }

  /**
   * A citation as the document's bibliography package prints it (see the file comment): biblatex's
   * numeric styles, natbib, LaTeX's \cite; anything else live preview's labels (report item).
   */
  private cite(n: TexNode & { t: "macro" }, ctx: Ctx): string {
    const { src } = ctx.file;
    const name = n.name;
    const keys = argText(src, n.args[3]).split(",").map((k) => k.trim()).filter(Boolean);
    if (!keys.length) return "";
    const [a, b] = [n.args[1], n.args[2]];
    const preArg = given(a) && given(b) ? a : undefined;
    const postArg = given(b) ? b : given(a) ? a : undefined;
    const pre = preArg ? joinCjk(this.inline(preArg.body ?? [], ctx)).trim() : "";
    const post = postArg ? joinCjk(this.inline(postArg.body ?? [], ctx)).trim() : "";
    this.count("citations");
    const style = this.o.log?.info.get("citestyle") ?? (this.o.bib.entries.size ? "numeric" : null);
    if (style !== null) {
      const numbers: CiteNumber[] = keys.map((key) => ({ key, number: "", prefix: "", ...this.o.log?.cites.get(key) }));
      if (/^numeric/.test(style) && numbers.every((x) => x.number)) {
        // biblatex prefixes a postnote that is a page or a range: `p. 3`.
        const raw = postArg ? argText(src, postArg) : "";
        const paged = postnoteText(raw);
        return this.biblatexCite(name, numbers, style, pre, raw && paged !== raw ? esc(paged) : post, ctx, n);
      }
      this.note("cite", `citation style ${style}: citations show live preview's author-year labels`, ctx, n, "info");
    } else if (keys.every((k) => this.o.bib.bibcites.has(k))) {
      const cites = keys.map((k) => this.o.bib.bibcites.get(k)!);
      const natbib = this.natbib();
      if (natbib) {
        if (name.toLowerCase() === "cite" && natbib.defaultCite === "custom") this.note("cite", "Custom \\cite definition: the export uses natbib's intrinsic default", ctx, n, "warning");
        return this.natbibCite(name, keys, cites, given(n.args[0]), pre, post, natbib, given(a) || given(b));
      }
      const citePackage = this.o.log?.info.get("cite-package")?.split(",");
      if (citePackage) {
        // Keep actual publisher punctuation, including IEEE's separate [1], [2] and [1]–[3].
        // The log holds unexecuted TeX layout primitives. Drop penalties/glue, preserving
        // their visible spacing, then use the same numeric sorting/range rules as natbib.
        const punct = (key: string, fallback: string) => {
          const raw = this.o.log?.info.get(key);
          if (raw === undefined) return fallback;
          const cleaned = raw.replace(/\\penalty\s*(?:[+-]?\d+|\\[A-Za-z@]+)\s*/g, "")
            .replace(/\\hskip\s*[^\\{}]*(?:\\relax)?/g, " ");
          return texText(`{x}${cleaned}{x}`).slice(1, -1);
        };
        const separator = punct("citepunct", ", ");
        const dash = punct("citedash", "–");
        const pieces = numericLabels(keys.map((key, i) => ({ key, prefix: "", number: texText(cites[i].label) })), {
          sort: citePackage.includes("sort"), compress: citePackage.includes("compress"),
        }).map(piece => "sep" in piece ? { sep: piece.sep === "–" ? dash : separator } : piece);
        const labels = this.labelHtml(pieces);
        if (this.o.log?.info.get("cite-super") === "1" && !post) return `<sup class="llx-cite">${labels}</sup>`;
        return `<span class="llx-cite">${esc(punct("citeleft", "["))}${labels}${post ? esc(punct("citemid", ", ")) + post : ""}${esc(punct("citeright", "]"))}</span>`;
      }
      const labels = this.labelHtml(keys.map((key, i) => [...(i ? [{ sep: ", " }] : []), { key, text: texText(cites[i].label) }]).flat());
      return `<span class="llx-cite">[${labels}${post ? `, ${post}` : ""}]</span>`;
    } else this.note("cite", "citations without labels from the build show live preview's author-year labels", ctx, n, "info");
    const text = citeText(keys, preArg ? argText(src, preArg) : null, postArg ? argText(src, postArg) : null, this.o.refs);
    if (text.missing) this.note("cite", `\\${name}{${keys.join(",")}}: not in the bibliography`, ctx, n);
    return `<span class="llx-cite${text.missing ? " is-missing" : ""}">${esc(text.text)}</span>`;
  }

  /** biblatex's numeric styles: `[pre 1–3, 5, post]`, `\textcite`'s `Li and Doe [2]`, `\footcite`, `\supercite`. */
  private biblatexCite(name: string, numbers: CiteNumber[], style: string, pre: string, post: string, ctx: Ctx, at: TexNode): string {
    const comp = style === "numeric-comp";
    const sort = comp || this.o.log?.info.get("sortcites") === "1";
    const labels = (list: CiteNumber[]) => this.labelHtml(numericLabels(list, { sort, compress: comp }));
    const bracket = (inner: string, first: boolean, last: boolean) => `[${first && pre ? `${pre} ` : ""}${inner}${last && post ? `, ${post}` : ""}]`;
    const span = this.span(at, ctx);
    const entry = (key: string) => this.o.bib.entries.get(key);
    const html = (tex: string) => this.texHtml(tex, ctx, span);
    switch (name) {
      case "textcite":
      case "Textcite":
        return `<span class="llx-cite">${numbers
          .map((x, i) => {
            const e = entry(x.key);
            const who = e ? citeNames(e, html) : esc(x.key);
            return `${i === 0 && name === "Textcite" ? upperFirst(who) : who} ${bracket(labels([x]), i === 0, i === numbers.length - 1)}`;
          })
          .join("; ")}</span>`;
      case "citeauthor":
      case "Citeauthor": {
        const who = numbers.map((x) => (entry(x.key) ? citeNames(entry(x.key)!, html) : esc(x.key))).join("; ");
        return name === "Citeauthor" ? upperFirst(who) : who;
      }
      case "citeyear":
        return numbers.map((x) => html(entry(x.key)?.fields.get("year") ?? "")).join(", ");
      case "citetitle":
        return numbers.map((x) => `<i>${html(entry(x.key)?.fields.get("title") ?? x.key)}</i>`).join(", ");
      case "supercite":
        return `<sup class="llx-cite">${bracket(labels(numbers), true, true)}</sup>`;
      case "footcite":
      case "footcitetext":
        return this.addFootnote(() => `<span class="llx-cite">${bracket(labels(numbers), true, true)}</span>.`, ctx, at, null);
      default:
        return `<span class="llx-cite">${bracket(labels(numbers), true, true)}</span>`;
    }
  }

  /** natbib (numbers or author-year, its punctuation): `[1, Sec. 3]`, `Roe and Placeholder [3]`, `(Doe, 2023)`. */
  private natbibCite(
    name: string,
    keys: string[],
    cites: BibCite[],
    star: boolean,
    pre: string,
    post: string,
    nb: NonNullable<ReturnType<Emitter["natbib"]>>,
    hasNotes = false,
  ): string {
    const upper = /^[A-Z]/.test(name);
    const intrinsic = !nb.numbers && !hasNotes ? "citet" : "citep";
    const kind = name.toLowerCase() === "cite" ? ["citep", "citet"].includes(nb.defaultCite) ? nb.defaultCite : intrinsic : name.toLowerCase();
    const who = (i: number) => {
      const text = esc(texText(star && cites[i].full ? cites[i].full : cites[i].authors));
      return upper && i === 0 ? upperFirst(text) : text;
    };
    const year = (i: number) => esc(texText(cites[i].year));
    const [open, close] = nb.super && kind !== "citet" ? ["", ""] : [esc(nb.open), esc(nb.close)];
    const note = post ? `${esc(nb.cmt)} ${post}` : "";
    const lead = pre ? `${pre} ` : "";
    const one = (i: number) => this.labelHtml([{ key: keys[i], text: texText(cites[i].label) }]);
    const all = () => this.labelHtml(numericLabels(keys.map((key, i) => ({ key, prefix: "", number: texText(cites[i].label) })), nb));
    const each = (f: (i: number) => string) => keys.map((_k, i) => f(i)).join(`${esc(nb.sep)} `);
    const last = keys.length - 1;
    let html: string;
    if (kind === "citeauthor") html = each(who);
    else if (kind === "citeyear") html = each(year);
    else if (kind === "citeyearpar") html = `${open}${lead}${each(year)}${note}${close}`;
    else if (nb.numbers) {
      if (kind === "citet") html = each((i) => `${who(i)} ${open}${i === 0 ? lead : ""}${one(i)}${i === last ? note : ""}${close}`);
      else if (kind === "citealt") html = each((i) => `${who(i)} ${one(i)}`);
      else if (kind === "citealp" || kind === "citenum") html = `${lead}${all()}${note}`;
      else html = nb.super ? `<sup>${all()}</sup>` : `${open}${lead}${all()}${note}${close}`;
    } else {
      const ay = (i: number) => `${who(i)}${esc(nb.aysep)} ${year(i)}`;
      if (kind === "citep") html = `${open}${lead}${each(ay)}${note}${close}`;
      else if (kind === "citealp") html = `${lead}${each(ay)}${note}`;
      else if (kind === "citealt") html = each((i) => `${who(i)} ${year(i)}`);
      else html = each((i) => `${who(i)} ${open}${i === 0 ? lead : ""}${year(i)}${i === last ? note : ""}${close}`);
    }
    return `<span class="llx-cite">${html}</span>`;
  }

  private footnote(n: TexNode & { t: "macro" }, ctx: Ctx): string {
    const own = given(n.args[0]) ? texText(argText(ctx.file.src, n.args[0])) : null;
    return this.addFootnote(() => this.flow(n.args[1]?.body ?? [], ctx), ctx, n, own);
  }

  /** A footnote (see footnoteMark) whose text `html` renders after its mark took its number. */
  private addFootnote(html: () => string, ctx: Ctx, at: TexNode, own: string | null): string {
    const note = this.footnoteMark(ctx, at, own);
    this.footnotes.push({ ...note, html: html() });
    this.count("footnotes");
    return `<sup class="llx-fn"><a class="llx-fn-link" href="${attr(hrefId(note.id))}" id="${attr(note.ref)}">${esc(note.mark)}</a></sup>`;
  }

  /** A footnote's mark: the one given (`\footnote[3]`, no step), else TeX's next footnote step, else the count. */
  private footnoteMark(ctx: Ctx, at: TexNode, own: string | null): Omit<Footnote, "html"> {
    const index = this.footnotes.length + this.marks.length + 1;
    let mark = own;
    if (mark === null) {
      const step = this.o.queue?.take("footnote", this.span(at, ctx));
      mark = step ? texText(step.value) : String(index);
      if (step) this.numbers.push({ counter: "footnote", value: mark, shown: true });
    }
    return { id: this.uniqueId(`llx-fn${index}`), ref: this.uniqueId(`llx-fnref${index}`), mark };
  }

  /** `\footnotemark`: a mark whose text a later `\footnotetext` gives. */
  private footnotemark(n: TexNode & { t: "macro" }, ctx: Ctx): string {
    const own = given(n.args[0]) ? texText(argText(ctx.file.src, n.args[0])) : null;
    const note = this.footnoteMark(ctx, n, own);
    this.marks.push(note);
    return `<sup class="llx-fn"><a class="llx-fn-link" href="${attr(hrefId(note.id))}" id="${attr(note.ref)}">${esc(note.mark)}</a></sup>`;
  }

  /** `\footnotetext`: the text of the oldest waiting mark (the one with its mark when given), else a note without a mark in the text. */
  private footnotetext(n: TexNode & { t: "macro" }, ctx: Ctx): void {
    const own = given(n.args[0]) ? texText(argText(ctx.file.src, n.args[0])) : null;
    const i = own === null ? 0 : this.marks.findIndex((m) => m.mark === own);
    const waiting = i >= 0 ? this.marks.splice(i, 1)[0] : undefined;
    const note = waiting ?? { id: this.uniqueId(`llx-fn${this.footnotes.length + 1}`), ref: "", mark: own ?? String(this.footnotes.length + 1) };
    this.footnotes.push({ ...note, html: this.flow(n.args[1]?.body ?? [], ctx) });
    this.count("footnotes");
  }

  /** An external link (http(s), mailto, ftp), else the text. */
  private link(url: string, text: string): string {
    const safe = safeUrl(url);
    return safe && !safe.startsWith("#") ? `<a href="${attr(safe)}">${esc(text)}</a>` : esc(text);
  }

  /** \maketitle: the preamble's \title, \subtitle, \author, \institute, \date (elegantbook's \version, \extrainfo); \thanks become footnotes. */
  private titleBlock(ctx: Ctx, at: TexNode, rest: () => TexNode[]): void {
    if (!this.frontmatter) return;
    const frontmatter = this.frontmatter;
    const root = this.o.plan.files.get(this.o.plan.rootKey)!;
    const anonymous = this.o.log?.info.get("title-anonymous") === "true";
    // \maketitle reads on to the next line before its \thanks step: its span runs up to what follows.
    const span = this.span(at, ctx);
    const next = ctx.at ? undefined : rest().find((x) => x.t !== "space" && x.t !== "par" && x.t !== "comment");
    if (next) span.to = Math.max(span.to, lineAt(ctx.file, next.from) - 1);
    // Some classes finish storing a preamble abstract after reading the following line.
    // At the first title trigger every preceding title/abstract record is now represented.
    this.o.queue?.takeFrontmatterToc({ ...span, to: next ? Math.max(span.to, lineAt(ctx.file, next.from)) : span.to + 1 }, true, this.frontmatter.abstracts.length ? this.name("abstract") : undefined);
    const rctx: Ctx = { file: root, visit: 0, float: null, depth: 0, at: span };
    // IEEE/ACM/LNCS/Springer/AASTeX do not print the inherited article \date in their
    // paper title. AMS and REVTeX expose it; the existing generic/elegant contract remains.
    const printsDate = !this.frontmatter.paper || /^(?:ams|revtex)/.test(this.frontmatter.className);
    const part = (name: string) => {
      const value = frontmatter[name as "title" | "subtitle" | "author" | "institute" | "date" | "version" | "extrainfo"];
      if (!value) return "";
      const sourceCtx: Ctx = { ...rctx, file: value.file, metadata: frontmatter.paper };
      // \thanks: a footnote whose mark ends the part.
      let marks = "";
      for (const x of anonymous ? [] : value.nodes) {
        if (x.t === "macro" && x.name === "thanks") marks += this.footnote({ ...x, args: [{ kind: "o", from: x.from, to: x.from, body: null }, ...x.args] }, sourceCtx);
      }
      // Authors \and-separated: one list.
      const names: TexNode[][] = [[]];
      for (const x of value.nodes) {
        if (x.t === "macro" && x.name === "and") names.push([]);
        else names[names.length - 1].push(x);
      }
      return names.map((n) => joinCjk(this.inline(n, sourceCtx)).trim()).filter(Boolean).join(", ") + marks;
    };
    this.header = {
      title: part("title"),
      subtitle: part("subtitle"),
      author: this.frontmatter.paper || anonymous ? "" : part("author"),
      institute: anonymous ? "" : part("institute"),
      // Source arguments retain their rich inline markup and \thanks. An omitted date uses
      // the class's actual \@date captured just before \maketitle, including an empty default.
      date: !printsDate ? "" : this.frontmatter.date ? part("date") : this.frontmatter.paper ? "" : this.o.log?.info.has("title-date") ? this.texHtml(this.o.log.info.get("title-date")!, rctx, span) : "",
      version: part("version"),
      extrainfo: part("extrainfo"),
    };
    const meta = this.frontmatter;
    const authorSources = anonymous || !meta.paper ? [] : meta.authors;
    const affiliationSources = anonymous ? [] : meta.affiliations;
    const affiliations = affiliationSources.map(a => ({ label: a.id, id: this.uniqueId(`llx-aff-${a.id}`), html: this.frontPart(a.content), current: a.current }));
    const byId = new Map(affiliations.map(a => [a.label, a.id]));
    const authors = authorSources.map(a => ({
      name: this.frontPart(a.name),
      affiliations: a.affiliationIds.map(label => ({ label, id: byId.get(label) ?? null })),
      emails: a.emails.map(value => {
        const email = texText(value.file.src.slice(value.from, value.to)).trim();
        return `<a href="mailto:${attr(email)}">${esc(email)}</a>`;
      }),
      notes: a.notes.map(value => this.frontPart(value)),
      ...(a.orcid ? { orcid: this.frontPart(a.orcid) } : {}),
      ...(a.corresponding ? { corresponding: true } : {}),
    }));
    if (meta.paper) {
      this.header.author = authors.map(a => a.name).join(", ");
      if (anonymous) this.header.institute = "";
    }
    const notes = anonymous ? [] : meta.notes.map(value => this.frontPart(value));
    if (meta.paper || meta.abstracts.length || meta.keywords.length || meta.subjects.length || meta.dedication || notes.length) this.header.paper = {
      authors, affiliations,
      abstracts: meta.abstracts.map(value => this.frontPart(value, true)),
      keywords: meta.keywords.map(value => this.frontPart(value)),
      subjects: meta.subjects.map(value => ({ label: value.kind === "ccsdesc" ? "CCS Concepts" : value.kind === "subjclass" ? `${value.qualifier ? `${value.qualifier} ` : ""}Mathematics Subject Classification` : "Subject", html: this.frontPart(value) })),
      dedication: meta.dedication ? this.frontPart(meta.dedication) : "", notes,
    };
  }

  private frontPart(value: FrontmatterPart, block = false): string {
    const root = this.o.plan.files.get(this.o.plan.rootKey)!;
    const ctx: Ctx = { file: value.file, visit: value.visit ?? (value.file === root ? 0 : -1), float: null, depth: 0, metadata: true };
    return block ? this.flow(value.nodes, ctx) : joinCjk(this.inline(value.nodes, ctx)).trim();
  }

  // ---- helpers -------------------------------------------------------------------------------

  /**
   * A colour (a name or an xcolor expression over the probe's colours and xcolor's base names) as
   * the page's colour variable (profiles.ts lightens it in dark mode); null when it cannot be read.
   */
  private color(name: string, ctx: Ctx, at: { from: number; to: number }): string | null {
    const c = name.trim();
    const known = (n: string): Rgb | null => {
      const probed = this.o.log?.colors.get(n);
      return (probed ? parseColor(probed) : null) ?? this.colors.get(n) ?? BASE_COLORS[n] ?? null;
    };
    const rgb = this.colors.get(c) ?? xcolor(c, known);
    if (!rgb) {
      this.note("unknown-macro", `colour ${c}: not defined for the export (shown in the text colour)`, ctx, at, "info");
      return null;
    }
    this.colors.set(c, rgb);
    return `var(--llx-c-${colorId(c)})`;
  }

  /** A name the class prints (`\figurename` ...): the probe's, else the profile's. */
  name(key: string): string {
    return this.o.log?.names.get(key) || fallbackName(this.o.profile, key);
  }

  anchor(key: string): string {
    if (!key || this.ids.has(key)) return "";
    this.ids.add(key);
    this.sourceLabels.add(key);
    return `<a id="${attr(key)}"></a>`;
  }

  private uniqueId(id: string): string {
    let out = id;
    for (let i = 2; this.ids.has(out); i++) out = `${id}-${i}`;
    this.ids.add(out);
    return out;
  }

  span(n: { from: number; to: number }, ctx: Ctx): Span {
    if (ctx.at) return ctx.at;
    return { visit: ctx.visit, from: lineAt(ctx.file, n.from), to: lineAt(ctx.file, Math.max(n.from, n.to - 1)) };
  }

  count(name: string, by = 1): void {
    this.counts[name] = (this.counts[name] ?? 0) + by;
  }

  private abs(key: string): string | undefined {
    return this.o.plan.files.get(key)?.abs;
  }

  /** A report item at a construct; notes without a place merge per message. */
  note(kind: ReportItem["kind"], message: string, ctx: Ctx, at: { from: number; to: number }, severity: ReportItem["severity"] = "warning"): void {
    if (severity === "info") {
      if (this.notes.has(message)) return;
      this.notes.add(message);
    }
    const where = ctx.file.abs && !ctx.at ? { file: ctx.file.abs, line: lineAt(ctx.file, at.from) } : {};
    this.o.report.add({ severity, kind, message, ...where });
  }

  private unknownMacro(name: string, ctx: Ctx, n: TexNode): void {
    const u = this.unknown.get(name);
    if (u) u.count++;
    else this.unknown.set(name, { count: 1, file: ctx.file.abs, line: ctx.file.abs ? lineAt(ctx.file, n.from) : 0 });
  }
}

/** Paragraphs and blocks of one node list; font switches carry across its paragraphs. */
class Flow {
  private out = "";
  private para = "";
  private raw = "";
  private style: Style = NO_STYLE;
  /** The style the open paragraph started with, and the spans opened in it since. */
  private paraStyle: Style = NO_STYLE;
  private spans = 0;
  private cont = false;

  constructor(
    private em: Emitter,
    private ctx: Ctx,
    private lead = "",
  ) {}

  /** HTML a caller rendered as a block (an \input file's). */
  block(html: string): void {
    this.endParagraph(false);
    this.emitBlock(html);
  }

  add(n: TexNode, rest: () => TexNode[]): void {
    this.em.checkSliceWork();
    if (this.em.insideDrawn(n, this.ctx)) return;
    if (n.t === "text") {
      this.raw += n.s;
      return;
    }
    if (n.t === "comment") return;
    this.flushText();
    if (n.t === "par" || (n.t === "macro" && n.name === "par")) {
      this.endParagraph(false);
      return;
    }
    if (n.t === "space") {
      this.para += " ";
      return;
    }
    if (n.t === "macro" && (n.name in SWITCHES || n.name === "color")) {
      const next = this.em.switchStyle(n, this.ctx, this.style);
      if (next !== this.style) {
        this.style = next;
        if (this.para.trim()) {
          this.para += `<span${styleAttrs(next)}>`;
          this.spans++;
        } else this.paraStyle = next;
      }
      return;
    }
    if (n.t === "macro" && (((n.name === "caption" || n.name === "subcaption") && this.ctx.float) || n.name === "captionof")) {
      this.endParagraph(false);
      this.emitBlock(this.em.caption(n, this.ctx, rest));
      return;
    }
    if (n.t === "macro" && LEVELS[n.name] >= RUN_IN) {
      // \paragraph: a bold lead of the paragraph that follows.
      this.endParagraph(false);
      this.lead += `${this.em.heading(n, this.ctx, rest, true)} `;
      return;
    }
    if (n.t === "macro" && n.name === "label" && !this.para.trim()) {
      // A label between blocks anchors the next one.
      this.out += this.em.anchor(argText(this.ctx.file.src, n.args[0]).trim());
      return;
    }
    const block = this.em.block(n, this.ctx, rest);
    if (block === null) {
      this.para += this.em.inlineNode(n, this.ctx);
      return;
    }
    // A display inside a paragraph: the text after it continues the paragraph (no indent).
    const display = n.t === "math";
    this.endParagraph(display);
    this.emitBlock(block);
  }

  finish(): string {
    this.flushText();
    this.endParagraph(false);
    return this.out;
  }

  private flushText(): void {
    if (this.raw) this.para += texLigatures(this.raw);
    this.raw = "";
  }

  private emitBlock(html: string): void {
    if (!html) return;
    this.out += styled(this.style) ? `<div${styleAttrs(this.style)}>${html}</div>` : html;
  }

  private endParagraph(continues: boolean): void {
    this.flushText();
    const text = this.para.trim();
    if (text || this.lead) {
      const cls = this.cont || this.lead ? "llx-cont" : "";
      const attrs = styled(this.paraStyle)
        ? ` class="${[cls, ...this.paraStyle.classes].filter(Boolean).join(" ")}"${this.paraStyle.color ? ` style="color:${attr(this.paraStyle.color)}"` : ""}`
        : cls
          ? ` class="${cls}"`
          : "";
      this.out += `<p${attrs}>${this.lead}${joinCjk(text)}${"</span>".repeat(this.spans)}</p>`;
      this.em.count("paragraphs");
      this.lead = "";
    }
    this.para = "";
    this.spans = 0;
    this.paraStyle = this.style;
    this.cont = continues;
  }
}

const isInput = isFileInput;
