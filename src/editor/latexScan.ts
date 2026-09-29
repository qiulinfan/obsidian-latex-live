import type { Text } from "@codemirror/state";
import { texText } from "../tex/texText";
import { CITE_COMMANDS, MATH_ENVS, VERBATIM_ENVS, iffalseEnd, iffalseStarts } from "./latexHighlight";

// The constructs a LaTeX document renders: pure, no CodeMirror view and no Obsidian, so the
// hover and live preview share one scan and tests run it directly (design 4.3, 4.4).
//   Where     after \begin{document} when the file has one (chapter files have none and are
//             scanned whole), up to \end{document}; comments, verbatim environments (tcblisting
//             and fancyvrb's too), \verb-like inline verbatim, the text an `\iffalse` first on its
//             line skips (to its \fi or \else), and TikZ pictures (code until P5's crops: a
//             calc coordinate `($(a)!(b)!(c)$)` is no formula) are skipped.
//   Math      formulas end at a paragraph break, as in TeX: a half-typed `$`, `$$`, `\[` or
//             \begin{align} never pairs with a delimiter further down. Environments also
//             close within MAX_LINES lines. Inline math steps over text arguments, whose `$`
//             starts a nested formula (`$f = \text{当 $x>0$ 时} 1$` is one formula). Nothing
//             inside a formula is another construct.
//   Text      a construct's arguments close on its own line (a half-typed `\textbf{` is
//             none): headings at the start of their line, text styles, the \item's of the
//             lists open around them (with the marker LaTeX typesets, enumitem's resume and
//             series and \setcounter{enumi} followed), the \begin/\end lines of lists and
//             center alone on their lines, references, citations and labels. An \item[label]
//             with math or a reference in it keeps its label in place, scanned on.
//             A heading's title and a style's content are scanned on: constructs nest, in
//             document order. A definition (\newcommand, \def, \newenvironment, ...) is code:
//             nothing in it is a construct (macro files have no \begin{document}).
//   Cost      memoized per document (Text), like the highlighter's own state.
// The highlighter keeps its own tokenizer; half-typed delimiters may differ there.

/** A formula: `$..$`, `\(..\)`, `\[..\]`, `$$..$$` or a math environment. */
export interface LatexMath {
  readonly kind: "math";
  readonly from: number;
  readonly to: number;
  readonly display: boolean;
  /**
   * A display formula that owns whole lines: only whitespace (or a comment) around it on its
   * first and last line. Inline math (`$x$` alone on a line too) is never a block.
   */
  readonly block: boolean;
  /** The math environment (`align*`), or null for delimiters. */
  readonly env: string | null;
  /** MathJax input: the text between the delimiters, or the whole environment. */
  readonly src: string;
  /** Keys of the \label's inside. */
  readonly labels: readonly string[];
}

/** `\part` .. `\subparagraph` (starred too) at the start of a line, its title closed there (#5). */
export interface LatexHeading {
  readonly kind: "heading";
  readonly from: number;
  /** After the title's closing brace. */
  readonly to: number;
  /** 1 (\part, \chapter), 2 (\section) .. 6 (\subparagraph). */
  readonly level: number;
  readonly titleFrom: number;
  readonly titleTo: number;
}

export type TextStyle = "strong" | "em" | "u" | "tt" | "sc";

/** `\textbf{..}`, `\textit`, `\emph`, `\underline`, `\texttt`, `\textsc` (#6). */
export interface LatexStyle {
  readonly kind: "style";
  readonly from: number;
  readonly to: number;
  readonly style: TextStyle;
  readonly contentFrom: number;
  readonly contentTo: number;
}

/** `\item` or `\item[label]` in an itemize, enumerate or description (#7). */
export interface LatexItem {
  readonly kind: "item";
  readonly from: number;
  /** After `\item` or its `[label]`. */
  readonly to: number;
  /** What LaTeX typesets for it: a bullet by depth, a number (`1.`, `(a)`, `ii.`), or the label ("" when in place). */
  readonly marker: string;
  /** A description's term (bold). */
  readonly term: boolean;
  /**
   * A label with math or a reference in it stays in place (`\item[$\sigma$-algebra]`): its text,
   * between `\item[` and `]`; its constructs follow in the scan.
   */
  readonly labelFrom?: number;
  readonly labelTo?: number;
}

/** A `\begin` or `\end` line of a list or center, alone on its line (#8). */
export interface LatexEnvLine {
  readonly kind: "envline";
  readonly from: number;
  readonly to: number;
  readonly env: string;
  readonly begin: boolean;
}

/** `\ref`, `\eqref`, `\pageref`, `\autoref`, `\cref`, `\Cref`, `\nameref` (starred too) (#9). */
export interface LatexRef {
  readonly kind: "ref";
  readonly from: number;
  readonly to: number;
  /** The command without its star. */
  readonly command: string;
  readonly keys: readonly string[];
}

/** `\cite`, `\citep`, `\citet`, `\parencite`, `\textcite`, `\autocite` (CITE_COMMANDS) with their notes (#10). */
export interface LatexCite {
  readonly kind: "cite";
  readonly from: number;
  readonly to: number;
  readonly command: string;
  readonly keys: readonly string[];
  /** `\cite[pre][post]{k}`; one optional argument is the postnote. Null when absent or empty. */
  readonly prenote: string | null;
  readonly postnote: string | null;
}

/** `\label{k}` outside math (#11). */
export interface LatexLabel {
  readonly kind: "label";
  readonly from: number;
  readonly to: number;
  readonly key: string;
}

export type LatexConstruct =
  | LatexMath
  | LatexHeading
  | LatexStyle
  | LatexItem
  | LatexEnvLine
  | LatexRef
  | LatexCite
  | LatexLabel;

/** A math environment closes within this many lines, or it is not one (half-typed). */
const MAX_LINES = 200;

const cache = new WeakMap<Text, readonly LatexConstruct[]>();
const mathCache = new WeakMap<Text, readonly LatexMath[]>();

/** The constructs of a document in document order (nested ones after their parent; memoized per Text). */
export function scanLatex(doc: Text): readonly LatexConstruct[] {
  let hit = cache.get(doc);
  if (!hit) cache.set(doc, (hit = scanText(doc.toString())));
  return hit;
}

/** The formulas of a document in order (they never nest; memoized per Text). */
export function formulas(doc: Text): readonly LatexMath[] {
  let hit = mathCache.get(doc);
  if (!hit) mathCache.set(doc, (hit = scanLatex(doc).filter((c): c is LatexMath => c.kind === "math")));
  return hit;
}

/** The formula containing `pos` (its delimiters included), or null. */
export function mathAt(doc: Text, pos: number): LatexMath | null {
  const all = formulas(doc);
  let lo = 0;
  let hi = all.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = all[mid];
    if (pos < c.from) hi = mid - 1;
    else if (pos > c.to) lo = mid + 1;
    else return c;
  }
  return null;
}

const lineEnd = (s: string, i: number): number => {
  const e = s.indexOf("\n", i);
  return e < 0 ? s.length : e;
};

/** s[i] is a line break followed by a blank line: a paragraph break. */
function paragraphBreak(s: string, i: number): boolean {
  let j = i + 1;
  while (s[j] === " " || s[j] === "\t" || s[j] === "\r") j++;
  return s[j] === "\n";
}

/** A command whose argument is text inside math: a `$` or `\(` in it starts a nested formula. */
const TEXT_ARG = /\\(?:text(?:rm|sf|tt|bf|md|it|sl|up|sc|normal)?|mbox|hbox|fbox)\s*\{/y;

/**
 * Offset of `close` after `from` in the same paragraph (skipping escapes and comments), or -1.
 * An inline formula steps over text arguments (`\text{if $x$ odd}`); one that does not close in
 * the paragraph is read as plain math, so a half-typed `$\text{a $` still pairs.
 */
function findClose(s: string, from: number, close: string): number {
  const inline = close === "$" || close === "\\)";
  let lines = 0;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      if (s.startsWith(close, j)) return j;
      if (inline) {
        TEXT_ARG.lastIndex = j;
        const e = TEXT_ARG.exec(s) ? textEnd(s, TEXT_ARG.lastIndex) : -1;
        if (e >= 0) {
          j = e;
          continue;
        }
      }
      j++; // \$, \%, \\ and the first letter of a command
    } else if (c === "$") {
      if (close === "$" || (close === "$$" && s[j + 1] === "$")) return j;
    } else if (c === "%") {
      j = lineEnd(s, j) - 1;
    } else if (c === "\n" && (paragraphBreak(s, j) || ++lines > MAX_LINES)) {
      return -1;
    }
  }
  return -1;
}

/** Offset of the `}` ending a text argument whose content starts at s[i] (formulas in it skipped), or -1. */
function textEnd(s: string, i: number): number {
  for (let j = i, depth = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      if (s[j + 1] === "(") {
        const e = findClose(s, j + 2, "\\)");
        if (e < 0) return -1;
        j = e + 1;
      } else j++;
    } else if (c === "$") {
      const e = findClose(s, j + 1, "$");
      if (e < 0) return -1;
      j = e;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      if (depth-- === 0) return j;
    } else if (c === "%") {
      j = lineEnd(s, j) - 1;
    } else if (c === "\n" && paragraphBreak(s, j)) {
      return -1;
    }
  }
  return -1;
}

/** Offset after `\begin{document}` outside comments, or 0 when there is none. */
function bodyStart(s: string): number {
  for (const m of s.matchAll(/\\begin\s*\{document\}/g)) {
    const at = m.index ?? 0;
    const line = s.slice(s.lastIndexOf("\n", at - 1) + 1, at);
    if (!/(^|[^\\])%/.test(line)) return at + m[0].length;
  }
  return 0;
}

const aloneOnLines = (s: string, from: number, to: number): boolean =>
  !s.slice(s.lastIndexOf("\n", from - 1) + 1, from).trim() && /^\s*(%.*)?$/.test(s.slice(to, lineEnd(s, to)));

const labelsIn = (src: string): string[] => [...src.matchAll(/\\label\s*\{([^{}]*)\}/g)].map((m) => m[1].trim());

const COMMAND = /[A-Za-z@]+\*?/y;
const ENV_ARG = /\s*\{([^{}\n]*)\}/y;

/** Index after inline verbatim (`\verb|..|`, `\lstinline{..}`) whose argument starts at s[i]. */
function skipVerbatim(s: string, i: number, name: string): number {
  if (name === "mintinline") {
    ENV_ARG.lastIndex = i;
    if (ENV_ARG.exec(s)) i = ENV_ARG.lastIndex;
  } else if (name === "lstinline" && s[i] === "[") {
    const e = s.indexOf("]", i);
    if (e > 0) i = e + 1;
  }
  const delim = s[i] === "{" && name !== "verb" && name !== "verb*" ? "}" : s[i];
  if (!delim || /[\sA-Za-z]/.test(delim)) return i;
  const e = s.indexOf(delim, i + 1);
  return e < 0 || e > lineEnd(s, i) ? lineEnd(s, i) : e + 1;
}

const INLINE_VERBATIM = new Set(["verb", "verb*", "lstinline", "mintinline"]);

// ---- text constructs (design 4.4 #5-#11) -------------------------------------------------

const SECTION_LEVELS: Record<string, number> = {
  part: 1,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};
const STYLES: Record<string, TextStyle> = {
  textbf: "strong",
  textit: "em",
  emph: "em",
  underline: "u",
  texttt: "tt",
  textsc: "sc",
};
const LISTS = new Set(["itemize", "enumerate", "description"]);
/** Environments whose \begin and \end lines collapse (figure and table come with P4). */
const COLLAPSED_ENVS = new Set([...LISTS, "center"]);
const REFS = new Set(["ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref"]);
/** Commands whose arguments are code: a definition runs to its first line break outside braces. */
const DEFINERS = new Set([
  "newcommand", "renewcommand", "providecommand", "DeclareRobustCommand",
  "def", "gdef", "edef", "xdef", "let",
  "NewDocumentCommand", "RenewDocumentCommand", "ProvideDocumentCommand", "DeclareDocumentCommand",
  "newenvironment", "renewenvironment", "NewDocumentEnvironment", "RenewDocumentEnvironment",
  "DeclareMathOperator", "DeclarePairedDelimiter", "DeclarePairedDelimiterX", "newtheorem",
]);
/**
 * TikZ code (#14, a PDF crop in P5): nothing in it is a construct. `($(a)!(b)!(c)$)` is a calc
 * coordinate, `$\t$` a \foreach variable, a node's `[label={\textbf{A}}]` an option.
 */
const TIKZ_ENVS = new Set(["tikzpicture", "tikzcd", "pgfpicture", "circuitikz"]);
/** The counters of enumerate levels 1-4 (\setcounter{enumii}{3} inside a list). */
const ENUM_COUNTERS: Record<string, number> = { enumi: 1, enumii: 2, enumiii: 3, enumiv: 4 };
/** An \item label with math, a reference, a citation or a \label stays in place (a marker is text). */
const hasConstructs = (label: string): boolean =>
  /\$|\\\(/.test(label) ||
  [...label.matchAll(/\\([A-Za-z]+)/g)].some((m) => REFS.has(m[1]) || CITE_COMMANDS.has(m[1]) || m[1] === "label");

/**
 * The end of a definition starting at s[i]: the first line break outside braces (a body may
 * span lines), a paragraph break, or MAX_LINES lines for a half-typed one.
 */
function definitionEnd(s: string, i: number): number {
  for (let j = i, depth = 0, lines = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "%") j = lineEnd(s, j) - 1;
    else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === "\n" && (depth === 0 || paragraphBreak(s, j) || ++lines > MAX_LINES)) return j;
  }
  return s.length;
}

/** Spaces and tabs from s[i] (arguments stay on their line). */
const skipBlanks = (s: string, i: number): number => {
  while (s[i] === " " || s[i] === "\t") i++;
  return i;
};

/**
 * The index after the argument opened by s[i] (`{` or `[`) when it closes on this line
 * (braces balanced; an optional argument ends at its first `]` outside braces), else -1.
 */
function argEnd(s: string, i: number): number {
  const optional = s[i] === "[";
  for (let j = i + 1, depth = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      if (s[j + 1] === "\n") return -1;
      j++;
    } else if (c === "\n" || c === "%") {
      return -1;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      if (depth === 0) return optional ? -1 : j + 1;
      depth--;
    } else if (c === "]" && optional && depth === 0) {
      return j + 1;
    }
  }
  return -1;
}

type Counter = "arabic" | "alph" | "Alph" | "roman" | "Roman";

/** How a list's items are marked: a bullet, or a counter with the text around it. */
type ListMarks = { bullet: string } | { counter: Counter; before: string; after: string };

interface OpenList {
  env: string;
  marks: ListMarks | null;
  /** The next number (enumerate). */
  next: number;
  /** enumitem's series this list belongs to (`series=s`, `resume=s`): its end saves its counter there. */
  series: string | null;
  /** Its end also saves its marks: under the series for `series=s`, for its environment unless `resume*`. */
  savesSeriesMarks: boolean;
  savesMarks: boolean;
  /** What the lists ended inside this one left for `resume` (enumitem keeps it in their group). */
  saved: Map<string, Resumable>;
}

/** Where a list ended: its next number and its marks (for `resume*`). */
interface Resumable {
  next: number;
  marks: ListMarks | null;
}

const BULLETS = ["•", "◦", "▪"];
const ENUM_DEFAULTS: ListMarks[] = [
  { counter: "arabic", before: "", after: "." },
  { counter: "alph", before: "(", after: ")" },
  { counter: "roman", before: "", after: "." },
  { counter: "Alph", before: "", after: "." },
];
const SHORT_COUNTERS: Record<string, Counter> = { "1": "arabic", a: "alph", A: "Alph", i: "roman", I: "Roman" };
const COUNTER_COMMAND = /\\(arabic|alph|Alph|roman|Roman)\*/;

/** The top-level comma-separated parts of an option list (commas in braces stay). */
function optionParts(option: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= option.length; i++) {
    const c = option[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if ((c === "," && depth === 0) || i === option.length) {
      out.push(option.slice(start, i));
      start = i + 1;
    }
  }
  return out;
}

/**
 * An enumitem option list (`label=(\alph*), start=2`, `nosep`): every part a key of two or
 * more letters, with or without a value. Anything else (`(a)`, `i)`, `Step 1:`) is a short form.
 */
const isKeyValue = (option: string): boolean => optionParts(option).every((p) => /^\s*[A-Za-z*]{2,}\s*(?:=[^]*)?$/.test(p));

/** `key=value` pairs of an option list (a value's outer braces dropped). */
function keyValues(option: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of optionParts(option)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const v = part.slice(eq + 1).trim();
    out.set(part.slice(0, eq).trim(), /^\{[^]*\}$/.test(v) ? v.slice(1, -1) : v);
  }
  return out;
}

/** Stands for the counter while a label template becomes text. */
const COUNTER_MARK = "\u0001";

/** A label template with the counter at `at` (`length` characters) as marks. */
function template(label: string, counter: Counter, at: number, length: number): ListMarks {
  const [before, after = ""] = texText(label.slice(0, at) + COUNTER_MARK + label.slice(at + length)).split(COUNTER_MARK);
  return { counter, before, after };
}

/**
 * The enumerate package's short form (`[(a)]`, `[\bfseries Step 1:]`): the first 1, a, A, i
 * or I outside braces and commands is the counter, the rest is text.
 */
function shortForm(option: string): ListMarks | null {
  let depth = 0;
  for (let i = 0; i < option.length; i++) {
    const c = option[i];
    if (c === "\\") {
      const m = /^\\(?:[A-Za-z]+|.)/.exec(option.slice(i));
      i += (m?.[0].length ?? 1) - 1;
    } else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && Object.hasOwn(SHORT_COUNTERS, c)) return template(option, SHORT_COUNTERS[c], i, 1);
  }
  return null;
}

/** What a list's option sets (null: nothing): see listOptions. */
interface ListOptions {
  /** enumitem `label=`, or the enumerate package's short form. */
  marks: ListMarks | null;
  /** enumitem `start=`. */
  start: number | null;
  /** `resume` / `resume*` (null series: the last list of this environment), `resume=s` / `resume*=s`. */
  resume: { star: boolean; series: string | null } | null;
  /** `series=s`. */
  series: string | null;
  /** Keys without a value (`nosep`; a series' name is `resume*=` it). */
  bare: string[];
}

/** A list's option (enumitem keys, or the enumerate package's short form). */
function listOptions(env: string, option: string | null): ListOptions {
  const out: ListOptions = { marks: null, start: null, resume: null, series: null, bare: [] };
  if (option === null) return out;
  const kv = isKeyValue(option) ? keyValues(option) : null;
  const label = kv ? kv.get("label") : option;
  if (env === "itemize") {
    const text = label ? texText(label) : "";
    if (text) out.marks = { bullet: text };
  } else if (env === "enumerate" && label) {
    const m = kv ? COUNTER_COMMAND.exec(label) : null;
    out.marks = m ? template(label, m[1] as Counter, m.index, m[0].length) : kv ? null : shortForm(label);
  }
  if (!kv) return out;
  const start = Number(kv.get("start"));
  if (kv.has("start") && Number.isInteger(start)) out.start = start;
  out.bare = optionParts(option)
    .map((p) => p.trim())
    .filter((p) => p && !p.includes("="));
  if (out.bare.includes("resume")) out.resume = { star: false, series: null };
  if (out.bare.includes("resume*")) out.resume = { star: true, series: null };
  if (kv.has("resume")) out.resume = { star: false, series: kv.get("resume")! };
  if (kv.has("resume*")) out.resume = { star: true, series: kv.get("resume*")! };
  out.series = kv.get("series") ?? null;
  return out;
}

/** A list's default marks at `depth` of its kind: bullets • ◦ ▪, numbers 1. (a) i. A. */
const defaultMarks = (env: string, depth: number): ListMarks | null =>
  env === "itemize" ? { bullet: BULLETS[(depth - 1) % BULLETS.length] } : env === "enumerate" ? ENUM_DEFAULTS[(depth - 1) % ENUM_DEFAULTS.length] : null;

function roman(n: number): string {
  const table: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [v, r] of table) for (; n >= v; n -= v) out += r;
  return out;
}

function counterText(counter: Counter, n: number): string {
  if (n < 1) return String(n);
  switch (counter) {
    case "alph":
      return n <= 26 ? String.fromCharCode(96 + n) : String(n);
    case "Alph":
      return n <= 26 ? String.fromCharCode(64 + n) : String(n);
    case "roman":
      return roman(n);
    case "Roman":
      return roman(n).toUpperCase();
    default:
      return String(n);
  }
}

/** The marker of an item without its own label. */
function itemMarker(list: OpenList): string {
  const marks = list.marks;
  if (!marks) return "";
  if ("bullet" in marks) return marks.bullet;
  return marks.before + counterText(marks.counter, list.next++) + marks.after;
}

/** The keys of a `{a, b}` argument. */
const keysOf = (arg: string): string[] =>
  arg
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

/** An optional argument's text, or null when empty. */
const note = (arg: string | undefined): string | null => (arg !== undefined && arg.trim() ? arg.trim() : null);

function scanText(s: string): LatexConstruct[] {
  const out: LatexConstruct[] = [];
  const math = (from: number, to: number, display: boolean, env: string | null, src: string) => {
    if (!src.trim()) return;
    out.push({ kind: "math", from, to, display, block: display && aloneOnLines(s, from, to), env, src, labels: labelsIn(src) });
  };
  const lists: OpenList[] = [];
  const depthOf = (env: string) => lists.reduce((d, l) => (l.env === env ? d + 1 : d), 0);
  /** enumitem's `resume` state: lists ended outside any list, and the series. */
  const topSaved = new Map<string, Resumable>();
  const series = new Map<string, Resumable>();
  /** What `resume` continues in an `env`: the last one ended in this list or around it. */
  const resumable = (env: string): Resumable | undefined => {
    for (let k = lists.length - 1; k >= 0; k--) {
      const hit = lists[k].saved.get(env);
      if (hit) return hit;
    }
    return topSaved.get(env);
  };
  const n = s.length;
  let i = bodyStart(s);
  while (i < n) {
    const c = s[i];
    if (c === "%") {
      i = lineEnd(s, i);
      continue;
    }
    if (c === "$") {
      const open = s[i + 1] === "$" ? 2 : 1;
      const close = findClose(s, i + open, open === 2 ? "$$" : "$");
      if (close < 0) {
        i += open;
        continue;
      }
      math(i, close + open, open === 2, null, s.slice(i + open, close));
      i = close + open;
      continue;
    }
    if (c !== "\\") {
      i++;
      continue;
    }
    if (s[i + 1] === "(" || s[i + 1] === "[") {
      const display = s[i + 1] === "[";
      const close = findClose(s, i + 2, display ? "\\]" : "\\)");
      if (close < 0) {
        i += 2;
        continue;
      }
      math(i, close + 2, display, null, s.slice(i + 2, close));
      i = close + 2;
      continue;
    }
    COMMAND.lastIndex = i + 1;
    const name = COMMAND.exec(s)?.[0];
    if (!name) {
      i += 2; // a control symbol: \$, \%, \\, \{
      continue;
    }
    let j = i + 1 + name.length;
    if (INLINE_VERBATIM.has(name)) {
      i = skipVerbatim(s, j, name);
      continue;
    }
    if (name === "iffalse" && iffalseStarts(s, i)) {
      const e = iffalseEnd(s, j).end;
      i = e < 0 ? n : e; // a half-typed one runs to the end, like TeX
      continue;
    }
    const base = name.endsWith("*") ? name.slice(0, -1) : name;
    if (DEFINERS.has(base)) {
      i = definitionEnd(s, j);
      continue;
    }
    const arg = skipBlanks(s, j);
    if (Object.hasOwn(SECTION_LEVELS, base) && !s.slice(s.lastIndexOf("\n", i - 1) + 1, i).trim()) {
      const short = s[arg] === "[" ? argEnd(s, arg) : arg;
      const open = short < 0 ? -1 : skipBlanks(s, short);
      const e = open >= 0 && s[open] === "{" ? argEnd(s, open) : -1;
      if (e > 0) {
        out.push({ kind: "heading", from: i, to: e, level: SECTION_LEVELS[base], titleFrom: open + 1, titleTo: e - 1 });
        i = open + 1; // constructs in the title
        continue;
      }
    }
    if (Object.hasOwn(STYLES, name) && s[arg] === "{") {
      const e = argEnd(s, arg);
      if (e > 0 && s.slice(arg + 1, e - 1).trim()) {
        out.push({ kind: "style", from: i, to: e, style: STYLES[name], contentFrom: arg + 1, contentTo: e - 1 });
        i = arg + 1; // constructs in the content
        continue;
      }
    }
    if ((REFS.has(base) || base === "label") && s[arg] === "{") {
      const e = argEnd(s, arg);
      const keys = e > 0 ? keysOf(s.slice(arg + 1, e - 1)) : [];
      if (keys.length) {
        if (base === "label") out.push({ kind: "label", from: i, to: e, key: s.slice(arg + 1, e - 1).trim() });
        else out.push({ kind: "ref", from: i, to: e, command: base, keys });
        i = e;
        continue;
      }
    }
    if (CITE_COMMANDS.has(base)) {
      const notes: string[] = [];
      let k = arg;
      while (s[k] === "[" && notes.length < 2) {
        const e = argEnd(s, k);
        if (e < 0) break;
        notes.push(s.slice(k + 1, e - 1));
        k = skipBlanks(s, e);
      }
      const e = s[k] === "{" ? argEnd(s, k) : -1;
      const keys = e > 0 ? keysOf(s.slice(k + 1, e - 1)) : [];
      if (keys.length) {
        const prenote = notes.length === 2 ? note(notes[0]) : null;
        out.push({ kind: "cite", from: i, to: e, command: base, keys, prenote, postnote: note(notes[notes.length - 1]) });
        i = e;
        continue;
      }
    }
    if (name === "item" && lists.length) {
      const list = lists[lists.length - 1];
      const e = s[arg] === "[" ? argEnd(s, arg) : -1;
      const label = e > 0 ? s.slice(arg + 1, e - 1) : null;
      const term = list.env === "description";
      if (label !== null && hasConstructs(label)) {
        // `\item[` and `]` hide; the label's text and its formulas and references render in place.
        out.push({ kind: "item", from: i, to: e, marker: "", term, labelFrom: arg + 1, labelTo: e - 1 });
        i = arg + 1;
        continue;
      }
      // \item[label] typesets its label and leaves the counter alone.
      const marker = label !== null ? texText(label) : itemMarker(list);
      out.push({ kind: "item", from: i, to: e > 0 ? e : j, marker, term });
      i = e > 0 ? e : j;
      continue;
    }
    if ((base === "setcounter" || base === "addtocounter" || base === "stepcounter") && lists.length) {
      // An enumerate's counter set inside it: the next \item continues from there.
      const m = /^\{\s*(enumi{1,3}|enumiv)\s*\}(?:\s*\{\s*(-?\d+)\s*\})?/.exec(s.slice(arg, arg + 60));
      const list = m ? lists.filter((l) => l.env === "enumerate")[ENUM_COUNTERS[m[1]] - 1] : undefined;
      if (m && list && (base === "stepcounter" || m[2] !== undefined)) {
        const v = Number(m[2]);
        list.next = base === "stepcounter" ? list.next + 1 : base === "setcounter" ? v + 1 : list.next + v;
        i = arg + m[0].length;
        continue;
      }
    }
    if (name === "begin" || name === "end") {
      ENV_ARG.lastIndex = j;
      const env = ENV_ARG.exec(s)?.[1].trim();
      if (env === undefined) {
        i = j;
        continue;
      }
      j = ENV_ARG.lastIndex;
      if (name === "end") {
        if (env === "document") break;
        if (LISTS.has(env)) {
          const at = lists.map((l) => l.env).lastIndexOf(env);
          if (at >= 0) {
            // enumitem saves the counter, and the keys unless the list only resumed them.
            const ended = lists[at];
            lists.length = at;
            const marks = ended.savesMarks ? ended.marks : (resumable(env)?.marks ?? ended.marks);
            (at > 0 ? lists[at - 1].saved : topSaved).set(env, { next: ended.next, marks });
            if (ended.series !== null) {
              const was = series.get(ended.series);
              series.set(ended.series, { next: ended.next, marks: ended.savesSeriesMarks || !was ? ended.marks : was.marks });
            }
          }
        }
        if (COLLAPSED_ENVS.has(env) && aloneOnLines(s, i, j)) out.push({ kind: "envline", from: i, to: j, env, begin: false });
      } else if (VERBATIM_ENVS.has(env)) {
        const e = s.indexOf(`\\end{${env}}`, j);
        j = e < 0 ? n : e + env.length + 6;
      } else if (TIKZ_ENVS.has(env)) {
        // A half-typed picture (no \end yet) hides nothing below it.
        const e = s.indexOf(`\\end{${env}}`, j);
        if (e >= 0) j = e + env.length + 6;
      } else if (MATH_ENVS.has(env)) {
        const endTag = `\\end{${env}}`;
        const e = findClose(s, j, endTag);
        if (e >= 0) {
          const to = e + endTag.length;
          // `math` and `displaymath` are delimiters; MathJax reads the other environments whole.
          if (env === "math" || env === "displaymath") math(i, to, env === "displaymath", env, s.slice(j, e));
          else math(i, to, true, env, s.slice(i, to));
          j = to;
        }
      } else if (COLLAPSED_ENVS.has(env)) {
        const optAt = skipBlanks(s, j);
        const optEnd = s[optAt] === "[" ? argEnd(s, optAt) : -1;
        if (optEnd > 0) j = optEnd;
        if (LISTS.has(env)) {
          const o = listOptions(env, optEnd > 0 ? s.slice(optAt + 1, optEnd - 1) : null);
          // enumitem: `resume` continues the last list of this environment, `resume=s` a series,
          // `resume*` also takes its label; a series' name alone is `resume*=` it. `start=` wins.
          const named = o.bare.find((k) => series.has(k));
          const resume = o.resume ?? (named !== undefined ? { star: true, series: named } : null);
          const from = resume && (resume.series !== null ? series.get(resume.series) : resumable(env));
          const marks = o.marks ?? (from && resume?.star ? from.marks : null) ?? defaultMarks(env, depthOf(env) + 1);
          lists.push({
            env,
            marks,
            next: o.start ?? from?.next ?? 1,
            series: o.series ?? resume?.series ?? null,
            savesSeriesMarks: o.series !== null,
            savesMarks: !(resume?.star && resume.series === null),
            saved: new Map(),
          });
        }
        if (aloneOnLines(s, i, j)) out.push({ kind: "envline", from: i, to: j, env, begin: true });
      }
    }
    i = j;
  }
  return out;
}
