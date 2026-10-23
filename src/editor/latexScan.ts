import type { Text } from "@codemirror/state";
import { texText } from "../tex/texText";
import { Arity, DEFAULT_RULES, EnvRules, commandEnd, blockEnvKind, layoutSettingEnd } from "../tex/envRules";
import { CITE_COMMANDS, VERBATIM_ENVS, iffalseEnd, iffalseStarts } from "./latexHighlight";

// The constructs a LaTeX document renders: pure, no CodeMirror view and no Obsidian, so the
// hover and live preview share one scan and tests run it directly (design 4.3, 4.4).
//   Where     after \begin{document} when the file has one (chapter files have none and are
//             scanned whole), up to \end{document}; comments, verbatim environments (tcblisting
//             and fancyvrb's too), \verb-like inline verbatim, the text an `\iffalse` first on its
//             line skips (to its \fi or \else), and the inside of TikZ pictures (code: a calc
//             coordinate `($(a)!(b)!(c)$)` is no formula) are skipped.
//   Math      formulas end at a paragraph break, as in TeX: a half-typed `$`, `$$`, `\[` or
//             \begin{align} never pairs with a delimiter further down. Environments also
//             close within MAX_LINES lines. Inline math steps over text arguments, whose `$`
//             starts a nested formula (`$f = \text{当 $x>0$ 时} 1$` is one formula). Nothing
//             inside a formula is another construct.
//   Text      a construct's arguments close on its own line (a half-typed `\textbf{` is
//             none): headings at the start of their line, text styles, the \item's of the
//             lists open around them (with the marker LaTeX typesets, enumitem's resume and
//             series and \setcounter{enumi} followed; elegantbook's problemset is an
//             enumerate), the \begin/\end lines of lists and center alone on their lines,
//             references, citations and labels. An \item[label]
//             with math or a reference in it keeps its label in place, scanned on. Figure and
//             table \begin/\end lines alone on their lines collapse like lists (#8), an
//             \includegraphics alone on its line is an image (#13). A wrapper's \begin line takes
//             the hidden commands and layout settings (envRules' layoutSettingEnd) after it
//             (`\begin{center}\small`); a layout setting (`\renewcommand{\arraystretch}{1.35}`) is
//             a hidden command. A \resizebox, \scalebox or \rotatebox whose `{` ends its line
//             and holds just a table is a shell (#23): its line and its `}` line are hidden
//             commands; adjustbox is a wrapper.
//             A heading's title and a style's content are scanned on: constructs nest, in
//             document order. A definition (\newcommand, \def, \newenvironment, ...) is code:
//             nothing in it is a construct (macro files have no \begin{document}).
//   Envs      any other environment whose \begin (with the arguments and \label on its line) and
//             \end are alone on their lines, within MAX_LINES lines, is an `env` construct: the
//             language decides with the project's theorem map whether it is a box (#12), and
//             envRules' BLOCK_ENVS whether it is a table (#23) or a TikZ picture (#14, its
//             inside skipped). The arguments
//             are scanned on (a title's math); nested environments pair by name. `blockAt`
//             finds them (and figure and table floats) for the render hover's crops.
//   Cost      memoized per document (Text), like the highlighter's own state. Formulas inside
//             text arguments inside formulas nest at most MAX_NESTING deep (deeper, a text
//             argument reads as math), so no document overflows the stack; where a text argument
//             ends is found once per position and nesting in a scan, so unclosed ones
//             (`\text{$\text{$..`) cost a few passes over their paragraph, not exponentially many.
//   Rules     which environments are formulas and wrappers (collapsed \begin/\end lines) and
//             which commands hide come from an EnvRules (src/tex/envRules.ts; the built-in
//             defaults unless the caller passes the project's): an alias formula environment
//             (`myeq` -> equation) goes to MathJax as its target, a wrapper's \begin line takes
//             its arguments, a hidden command its arity's arguments. A \caption in a figure or
//             table is a `caption` (its content scanned on).
//   Center    the lines after `\centering` (from its own line when text follows it there) up to
//             the end of its group (an unmatched `}` or \end, a \raggedright or \raggedleft), and
//             a center environment's lines, are a `center` construct (papers too).
//   Beamer    with rules.beamer (docs/beamer.md): \frametitle and \framesubtitle (their titles
//             scanned on), \titlepage and \maketitle, the `<..>` of \item and of \only, \onslide,
//             \uncover, \visible and \alt (`overlay`: what hides; their arguments are scanned on),
//             a banner command's call (its arguments scanned on), and an image macro's call alone
//             on its line (after hidden commands there: `\centering\DeckFigure{..}`) as an `image`.
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
  /** The math environment as written (`align*`, an alias `myeq`), or null for delimiters. */
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

/** A wrapper's `\begin` (with its arguments) or `\end`, alone on its lines (#8; a list, center, figure, table, subequations, minipage, ...). */
export interface LatexEnvLine {
  readonly kind: "envline";
  readonly from: number;
  readonly to: number;
  readonly env: string;
  readonly begin: boolean;
}

/** An argument on a \begin line: its content's range, `{..}` or `[..]`. */
export interface LatexArg {
  readonly optional: boolean;
  readonly from: number;
  readonly to: number;
}

/**
 * An environment whose \begin and \end are alone on their lines (not a list, center, figure,
 * table, formula or verbatim): a theorem-like box when the project defines it (#12), else what
 * envRules' BLOCK_ENVS makes it (a table #23, a TikZ picture #14).
 */
export interface LatexEnv {
  readonly kind: "env";
  /** At `\begin`. */
  readonly from: number;
  /** After `\end{env}`. */
  readonly to: number;
  readonly env: string;
  /** After `\begin{env}` and the arguments (and a \label) on its line. */
  readonly beginTo: number;
  /** At `\end{env}`. */
  readonly endFrom: number;
  /** The `{..}` and `[..]` arguments right after `\begin{env}`, on its line. */
  readonly args: readonly LatexArg[];
  /**
   * The key of a \label right after the arguments (tcolorbox's `t\label`), or else first on the
   * next line: the head's number. Null without one.
   */
  readonly label: string | null;
}

/** `\includegraphics[..]{file}` alone on its line (#13). */
export interface LatexImage {
  readonly kind: "image";
  readonly from: number;
  readonly to: number;
  readonly block: true;
  /** The file argument as written (`figures/grid.png`, `grid`). */
  readonly path: string;
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

/**
 * An environment the render hover crops from the PDF (design 4.8): an `env` construct, or a
 * figure or table float between its \begin and \end lines.
 */
export interface LatexBlock {
  readonly kind: "block";
  readonly from: number;
  readonly to: number;
  readonly env: string;
}

/** A hidden layout command with its arguments (`\centering`, `\vspace{1em}`, a user's `\DeckLayout{..}`). */
export interface LatexCommand {
  readonly kind: "command";
  readonly from: number;
  readonly to: number;
  /** The command without its star. */
  readonly name: string;
  /** Alone on its lines: the line collapses with it. */
  readonly block: boolean;
}

/** `\caption[short]{content}`: `float` is the figure or table it is in (null outside one). */
export interface LatexCaption {
  readonly kind: "caption";
  readonly from: number;
  readonly to: number;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly float: "figure" | "table" | null;
  /** The \label in the caption, else the first one after it in the float: the caption's number. */
  readonly label: string | null;
}

/** The lines from `from`'s to `to`'s are centered (see Center). */
export interface LatexCenter {
  readonly kind: "center";
  readonly from: number;
  readonly to: number;
}

/** `\frametitle{..}` or `\framesubtitle{..}` (beamer). */
export interface LatexFrameTitle {
  readonly kind: "frametitle";
  readonly from: number;
  readonly to: number;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly sub: boolean;
}

/** `\titlepage`, or `\maketitle` in beamer. */
export interface LatexTitlePage {
  readonly kind: "titlepage";
  readonly from: number;
  readonly to: number;
  readonly block: boolean;
}

/** An overlay's markup (beamer): `\pause` is a hidden command; this is `<2->` of `\item<2->`, or `\only<2>{` and `}`. */
export interface LatexOverlay {
  readonly kind: "overlay";
  readonly from: number;
  readonly to: number;
  /** The ranges that hide, in order (the first starts at `from`, the last ends at `to`). */
  readonly hide: readonly { readonly from: number; readonly to: number }[];
}

/** A call of a command whose body is a frame (beamer's `\sectionframe{..}{..}`): a section banner. */
export interface LatexBanner {
  readonly kind: "banner";
  readonly from: number;
  readonly to: number;
  readonly name: string;
  readonly args: readonly LatexArg[];
}

export type LatexConstruct =
  | LatexMath
  | LatexHeading
  | LatexStyle
  | LatexItem
  | LatexEnvLine
  | LatexEnv
  | LatexImage
  | LatexRef
  | LatexCite
  | LatexLabel
  | LatexCommand
  | LatexCaption
  | LatexCenter
  | LatexFrameTitle
  | LatexTitlePage
  | LatexOverlay
  | LatexBanner;

/** A math environment (or an `env`) closes within this many lines, or it is not one (half-typed). */
const MAX_LINES = 200;
/** Formulas in text arguments in formulas nest this deep at most (see Cost). */
const MAX_NESTING = 8;

interface Caches {
  all: WeakMap<Text, readonly LatexConstruct[]>;
  math: WeakMap<Text, readonly LatexMath[]>;
  blocks: WeakMap<Text, readonly LatexBlock[]>;
}
const caches = new WeakMap<EnvRules, Caches>();
const cachesOf = (rules: EnvRules): Caches => {
  let hit = caches.get(rules);
  if (!hit) caches.set(rules, (hit = { all: new WeakMap(), math: new WeakMap(), blocks: new WeakMap() }));
  return hit;
};

/** The constructs of a document in document order (nested ones after their parent; memoized per Text and rules). */
export function scanLatex(doc: Text, rules: EnvRules = DEFAULT_RULES): readonly LatexConstruct[] {
  const { all } = cachesOf(rules);
  let hit = all.get(doc);
  if (!hit) all.set(doc, (hit = scanText(doc.toString(), rules)));
  return hit;
}

/** The formulas of a document in order (they never nest; memoized per Text and rules). */
export function formulas(doc: Text, rules: EnvRules = DEFAULT_RULES): readonly LatexMath[] {
  const { math } = cachesOf(rules);
  let hit = math.get(doc);
  if (!hit) math.set(doc, (hit = scanLatex(doc, rules).filter((c): c is LatexMath => c.kind === "math")));
  return hit;
}

/** The formula containing `pos` (its delimiters included), or null. */
export function mathAt(doc: Text, pos: number, rules: EnvRules = DEFAULT_RULES): LatexMath | null {
  const all = formulas(doc, rules);
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

/** The environments and floats of a document (see LatexBlock; memoized per Text and rules). */
export function blocks(doc: Text, rules: EnvRules = DEFAULT_RULES): readonly LatexBlock[] {
  const cache = cachesOf(rules).blocks;
  let hit = cache.get(doc);
  if (hit) return hit;
  const out: LatexBlock[] = [];
  const open: LatexEnvLine[] = [];
  for (const c of scanLatex(doc, rules)) {
    if (c.kind === "env") out.push({ kind: "block", from: c.from, to: c.to, env: c.env });
    else if (c.kind === "envline" && FLOATS.has(c.env)) {
      if (c.begin) open.push(c);
      else {
        const at = open.map((o) => o.env).lastIndexOf(c.env);
        if (at >= 0) out.push({ kind: "block", from: open[at].from, to: c.to, env: c.env });
        open.length = Math.max(0, at);
      }
    }
  }
  cache.set(doc, (hit = out));
  return hit;
}

/** The innermost block around `pos` (its \begin and \end included) that `accept` takes, or null. */
export function blockAt(doc: Text, pos: number, accept: (b: LatexBlock) => boolean, rules: EnvRules = DEFAULT_RULES): LatexBlock | null {
  let best: LatexBlock | null = null;
  for (const b of blocks(doc, rules)) {
    if (b.from <= pos && pos <= b.to && (!best || b.to - b.from < best.to - best.from) && accept(b)) best = b;
  }
  return best;
}

/** The blocks around [from, to] (containing it, not equal to it). */
export function blocksAround(doc: Text, from: number, to: number, rules: EnvRules = DEFAULT_RULES): LatexBlock[] {
  return blocks(doc, rules).filter((b) => b.from <= from && to <= b.to && (b.from !== from || b.to !== to));
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
 * textEnd's answers during one scan by position and nesting (see Cost): without them, text
 * arguments that never close (`\text{$\text{$..`) are read again for every formula around them,
 * exponentially in their nesting.
 */
type TextEnds = Map<number, number>;

/**
 * Offset of `close` after `from` in the same paragraph (skipping escapes and comments), or -1.
 * An inline formula steps over text arguments (`\text{if $x$ odd}`); one that does not close in
 * the paragraph is read as plain math, so a half-typed `$\text{a $` still pairs.
 */
function findClose(s: string, from: number, close: string, ends: TextEnds, nesting = 0): number {
  const inline = (close === "$" || close === "\\)") && nesting < MAX_NESTING;
  let lines = 0;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      if (s.startsWith(close, j)) return j;
      if (inline) {
        TEXT_ARG.lastIndex = j;
        const e = TEXT_ARG.exec(s) ? textEnd(s, TEXT_ARG.lastIndex, nesting + 1, ends) : -1;
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

/**
 * Offset of the `}` ending a text argument whose content starts at s[i] (formulas in it skipped,
 * `nesting` text arguments deep), or -1; remembered in `ends`.
 */
function textEnd(s: string, i: number, nesting: number, ends: TextEnds): number {
  const key = i * (MAX_NESTING + 1) + nesting;
  let e = ends.get(key);
  if (e === undefined) ends.set(key, (e = textArgEnd(s, i, nesting, ends)));
  return e;
}

function textArgEnd(s: string, i: number, nesting: number, ends: TextEnds): number {
  for (let j = i, depth = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      if (s[j + 1] === "(") {
        const e = findClose(s, j + 2, "\\)", ends, nesting);
        if (e < 0) return -1;
        j = e + 1;
      } else j++;
    } else if (c === "$") {
      const e = findClose(s, j + 1, "$", ends, nesting);
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

/**
 * A table's \begin (#23) may share its line with the first rules (`\begin{tabular}{cll}\toprule`),
 * its \end with the \end of the wrappers around it (`\end{tabular}\end{center}`) and a shell's `}`.
 */
const TABLE_BEGIN_TAIL = /^(?:\s*\\(?:hline|toprule|midrule)(?![A-Za-z])(?:\[[^\]\n]*\])?)*\s*(%.*)?$/;
const TABLE_END_TAIL = /^(?:\s*(?:\\end\s*\{[^{}\n]*\}|\}))*\s*(%.*)?$/;
const tableAlone = (s: string, from: number, to: number, tail: RegExp): boolean =>
  !s.slice(s.lastIndexOf("\n", from - 1) + 1, from).trim() && tail.test(s.slice(to, lineEnd(s, to)));

/** Box commands around a table (#23): their mandatory arguments before the box's own `{`. */
const TABLE_SHELLS = new Map([["resizebox", 2], ["scalebox", 1], ["rotatebox", 1]]);

/**
 * A box command at s[i] (its name ending at j) whose `{` ends its line and holds just a table
 * (`\resizebox{\textwidth}{!}{%`, then the tabular, then `}`): its line, and its `}` when that is
 * alone on its line (else it follows the table's \end on its line). The table shows at its
 * normal size; the shell's lines collapse like a wrapper's.
 */
function tableShell(s: string, i: number, j: number, mandatory: number): { openTo: number; close: number | null; tableEnd: number } | null {
  if (s.slice(s.lastIndexOf("\n", i - 1) + 1, i).trim()) return null;
  const opt = () => {
    const k = skipBlanks(s, j);
    if (s[k] === "[") j = argEnd(s, k);
  };
  if (s[j] === "*") j++;
  for (let a = 0; a < mandatory && j > 0; a++) {
    opt();
    const k = skipBlanks(s, j);
    j = s[k] === "{" ? argEnd(s, k) : -1;
  }
  if (j < 0) return null;
  opt();
  const open = skipBlanks(s, j);
  if (s[open] !== "{" || !/^\s*(%.*)?$/.test(s.slice(open + 1, lineEnd(s, open)))) return null;
  const head = /^(?:\s|%[^\n]*)*\\begin\s*\{([^{}\n]*)\}/.exec(s.slice(open + 1, open + 400));
  const env = head?.[1].trim();
  if (!env || blockEnvKind(env) !== "table") return null;
  const endTag = `\\end{${env}}`;
  const tableEnd = s.indexOf(endTag, open);
  if (tableEnd < 0 || lineBreaks(s, open, tableEnd) > MAX_LINES) return null;
  const after = /^(?:[ \t]*(?:%[^\n]*)?\n)*?[ \t]*\}/.exec(s.slice(tableEnd + endTag.length));
  if (!after) return null;
  const close = tableEnd + endTag.length + after[0].length - 1;
  return { openTo: open + 1, close: close > lineEnd(s, tableEnd) && aloneOnLines(s, close, close + 1) ? close : null, tableEnd };
}

const labelsIn = (src: string): string[] => [...src.matchAll(/\\label\s*\{([^{}]*)\}/g)].map((m) => m[1].trim());

const COMMAND = /[A-Za-z@]+\*?/y;
const ENV_ARG = /\s*\{([^{}\n]*)\}/y;
const LABEL = /[ \t]*\\label\s*\{([^{}\n]*)\}/y;

/** Index after inline verbatim (`\verb|..|`, `\lstinline{..}`) whose argument starts at s[i]. */
function skipVerbatim(s: string, i: number, name: string, includeOpenEnd = false): number {
  if ((name === "mintinline" || name === "lstinline") && s[i] === "[") {
    const e = s.indexOf("]", i);
    if (e > 0) i = e + 1;
  }
  if (name === "mintinline") {
    ENV_ARG.lastIndex = i;
    if (ENV_ARG.exec(s)) i = ENV_ARG.lastIndex;
  }
  const delim = s[i] === "{" && name !== "verb" && name !== "verb*" ? "}" : s[i];
  if (!delim || /[\sA-Za-z]/.test(delim)) return i;
  const e = s.indexOf(delim, i + 1);
  return e < 0 || e > lineEnd(s, i) ? lineEnd(s, i) + (includeOpenEnd ? 1 : 0) : e + 1;
}

const INLINE_VERBATIM = new Set(["verb", "verb*", "lstinline", "mintinline"]);

const literalCache = new WeakMap<Text, readonly { from: number; to: number }[]>();

/** Whether insertion at pos is in literal code or a comment, including unfinished code. */
export function literalAt(doc: Text, pos: number): boolean {
  if (doc.length > 1_000_000) return true;
  let ranges = literalCache.get(doc);
  if (!ranges) {
    const text = doc.toString();
    const found: { from: number; to: number }[] = [];
    const commands = /%[^\n]*|\\(?:[A-Za-z@]+\*?|[^\n])/g;
    for (let match; (match = commands.exec(text)); ) {
      const from = match.index;
      const name = match[0].slice(1);
      let to = commands.lastIndex;
      if (match[0][0] === "%") {
        to++;
      } else if (INLINE_VERBATIM.has(name)) {
        to = skipVerbatim(text, to, name, true);
        if (to === commands.lastIndex) continue;
      } else if (name === "begin") {
        ENV_ARG.lastIndex = to;
        const env = ENV_ARG.exec(text);
        if (!env || !VERBATIM_ENVS.has(env[1])) continue;
        const close = `\\end{${env[1]}}`;
        const end = text.indexOf(close, ENV_ARG.lastIndex);
        to = end < 0 ? text.length + 1 : end + close.length;
      } else if (name === "iffalse" && iffalseStarts(text, from)) {
        const end = iffalseEnd(text, to).end;
        to = end < 0 ? text.length + 1 : end;
      } else {
        const base = name.endsWith("*") ? name.slice(0, -1) : name;
        if (DEFINERS.has(base)) commands.lastIndex = definitionEnd(text, to);
        continue;
      }
      found.push({ from, to });
      commands.lastIndex = to;
    }
    literalCache.set(doc, (ranges = found));
  }
  let lo = 0, hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (pos <= range.from) hi = mid;
    else if (pos >= range.to) lo = mid + 1;
    else return true;
  }
  return false;
}

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
type ListKind = "itemize" | "enumerate" | "description";
/**
 * The list environments (#7) and the list each one is. elegantbook's problemset (its exercises:
 * an enumerate after a heading; no other class or package in TeX Live defines one) takes a
 * [title], not list options.
 */
const LIST_KINDS: Readonly<Record<string, ListKind>> = { itemize: "itemize", enumerate: "enumerate", description: "description", problemset: "enumerate" };
const LISTS = new Set(Object.keys(LIST_KINDS));
const FLOATS = new Set(["figure", "figure*", "table", "table*"]);
/** Environments whose \begin and \end lines collapse. */
const REFS = new Set(["ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref"]);
/** Commands whose arguments are code: a definition runs to its first line break outside braces. */
const DEFINERS = new Set([
  "newcommand", "renewcommand", "providecommand", "DeclareRobustCommand",
  "def", "gdef", "edef", "xdef", "let",
  "NewDocumentCommand", "RenewDocumentCommand", "ProvideDocumentCommand", "DeclareDocumentCommand",
  "newenvironment", "renewenvironment", "NewDocumentEnvironment", "RenewDocumentEnvironment",
  "DeclareMathOperator", "DeclarePairedDelimiter", "DeclarePairedDelimiterX", "newtheorem",
]);
/** The counters of enumerate levels 1-4 (\setcounter{enumii}{3} inside a list). */
const ENUM_COUNTERS: Record<string, number> = { enumi: 1, enumii: 2, enumiii: 3, enumiv: 4 };
/**
 * Text with math, a reference, a citation or a \label: an \item label or a theorem's title that
 * stays in place (a marker or a head chip is text).
 */
export const hasConstructs = (label: string): boolean =>
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
 * The index after a balanced argument (an optional argument ends at its first `]` outside
 * braces), else -1. Inline constructs stay on one line; environment heads allow bounded wraps.
 */
function argEnd(s: string, i: number, maxLines = 0): number {
  const optional = s[i] === "[";
  let lines = 0;
  for (let j = i + 1, depth = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      if (s[j + 1] === "\n") { if (!maxLines) return -1; }
      else j++;
    } else if (c === "\n") {
      if (++lines > maxLines || paragraphBreak(s, j)) return -1;
    } else if (c === "%") {
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

/**
 * Hidden commands and layout settings from s[j] on the same line (`\centering\small`), or null
 * when there are none; `centering`: one of them is `\centering`.
 */
function layoutTail(s: string, j: number, rules: EnvRules): { end: number; centering: boolean } | null {
  const cmd = /[ \t]*\\([A-Za-z@]+\*?)/y;
  let end = j;
  let centering = false;
  for (let m; (cmd.lastIndex = end), (m = cmd.exec(s)); ) {
    const name = m[1];
    const base = name.endsWith("*") ? name.slice(0, -1) : name;
    let e = layoutSettingEnd(s, cmd.lastIndex, name, argEnd);
    if (e < 0 && rules.hidden.has(base)) e = commandEnd(s, cmd.lastIndex, rules.hidden.get(base) ?? null, false, (t, k) => argEnd(t, k));
    if (e < 0) break;
    centering ||= base === "centering";
    end = e;
  }
  return end > j ? { end, centering } : null;
}

type Counter = "arabic" | "alph" | "Alph" | "roman" | "Roman";

/** How a list's items are marked: a bullet, or a counter with the text around it. */
type ListMarks = { bullet: string } | { counter: Counter; before: string; after: string };

interface OpenList {
  env: string;
  /** The list it is (elegantbook's problemset: an enumerate). */
  kind: ListKind;
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

/** An environment open in the scan (see LatexEnv); `at` is its place in the output, -1 when its \begin line is not alone. */
interface OpenEnv {
  env: string;
  from: number;
  beginTo: number;
  args: LatexArg[];
  label: string | null;
  at: number;
}

/** The balanced `{..}` and `[..]` arguments after `\begin{env}`, including wrapped titles. */
function beginArgs(s: string, j: number): { args: LatexArg[]; beginTo: number } {
  const args: LatexArg[] = [];
  let k = skipBlanks(s, j);
  while (s[k] === "{" || s[k] === "[") {
    const e = argEnd(s, k, MAX_LINES);
    if (e < 0) break;
    args.push({ optional: s[k] === "[", from: k + 1, to: e - 1 });
    k = skipBlanks(s, e);
  }
  return { args, beginTo: args.length ? args[args.length - 1].to + 1 : j };
}

/** The line breaks in s[from, to). */
function lineBreaks(s: string, from: number, to: number): number {
  let count = 0;
  for (let k = s.indexOf("\n", from); k >= 0 && k < to; k = s.indexOf("\n", k + 1)) count++;
  return count;
}

/** The keys of a `{a, b}` argument. */
const keysOf = (arg: string): string[] =>
  arg
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

/** An optional argument's text, or null when empty. */
const note = (arg: string | undefined): string | null => (arg !== undefined && arg.trim() ? arg.trim() : null);

/** A caption being scanned: its label is settled at its float's \end. */
type OpenCaption = { -readonly [K in keyof LatexCaption]: LatexCaption[K] };

/** beamer's overlay commands and how many arguments they take. */
const OVERLAY_COMMANDS: Readonly<Record<string, number>> = { only: 1, onslide: 1, uncover: 1, visible: 1, alt: 2 };

/** The index after an overlay spec `<..>` on its line at s[i], or -1. */
function overlayEnd(s: string, i: number): number {
  if (s[i] !== "<") return -1;
  const m = /^<[^<>\n{}]*>/.exec(s.slice(i, i + 80));
  return m ? i + m[0].length : -1;
}

/**
 * Where a declaration's scope from s[i] ends: at an unmatched `}` or \end, a \raggedright or
 * \raggedleft outside groups, or after MAX_LINES lines.
 */
function scopeEnd(s: string, i: number): number {
  for (let j = i, depth = 0, envs = 0, lines = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "%") j = lineEnd(s, j) - 1;
    else if (c === "{") depth++;
    else if (c === "}") {
      if (depth-- === 0) return j;
    } else if (c === "\n") {
      if (++lines > MAX_LINES) return j;
    } else if (c === "\\") {
      COMMAND.lastIndex = j + 1;
      const name = COMMAND.exec(s)?.[0];
      if (!name) {
        j++;
        continue;
      }
      if (name === "begin") envs++;
      else if (name === "end" && envs-- === 0) return j;
      else if ((name === "raggedright" || name === "raggedleft") && !depth && !envs) return j;
      j += name.length;
    }
  }
  return s.length;
}

/** The centered lines from s[i] (after `\centering` or `\begin{center}`) to its scope's end, or null. */
function centerFrom(s: string, i: number): LatexCenter | null {
  const restBlank = /^\s*(%.*)?$/.test(s.slice(i, lineEnd(s, i)));
  const from = restBlank ? lineEnd(s, i) + 1 : s.lastIndexOf("\n", i - 1) + 1;
  const stop = scopeEnd(s, i);
  const stopLine = s.lastIndexOf("\n", stop - 1) + 1;
  const to = s.slice(stopLine, stop).trim() ? stop : stopLine - 1;
  return to > from ? { kind: "center", from, to } : null;
}

function scanText(s: string, rules: EnvRules): LatexConstruct[] {
  // An `env` holds its place (null) from its \begin: constructs stay in document order.
  const out: (LatexConstruct | null)[] = [];
  /** The figures and tables open here, with their captions. */
  const floats: { env: string; captions: OpenCaption[] }[] = [];
  const envs: OpenEnv[] = [];
  /** A table shell's `}` line (#23), by its table's \end. */
  const shellCloses = new Map<number, LatexCommand>();
  const ends: TextEnds = new Map();
  const math = (from: number, to: number, display: boolean, env: string | null, src: string) => {
    if (!src.trim()) return;
    out.push({ kind: "math", from, to, display, block: display && aloneOnLines(s, from, to), env, src, labels: labelsIn(src) });
  };
  const lists: OpenList[] = [];
  const depthOf = (kind: ListKind) => lists.reduce((d, l) => (l.kind === kind ? d + 1 : d), 0);
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
      const close = findClose(s, i + open, open === 2 ? "$$" : "$", ends);
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
      const close = findClose(s, i + 2, display ? "\\]" : "\\)", ends);
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
    const shell = TABLE_SHELLS.has(base) ? tableShell(s, i, j, TABLE_SHELLS.get(base)!) : null;
    if (shell) {
      out.push({ kind: "command", from: i, to: shell.openTo, name: base, block: true });
      if (shell.close !== null) shellCloses.set(shell.tableEnd, { kind: "command", from: shell.close, to: shell.close + 1, name: base, block: true });
      i = shell.openTo;
      continue;
    }
    // Hidden commands and layout settings alone on their line collapse together (`\centering\small`).
    const run = layoutTail(s, i, rules);
    if (run && aloneOnLines(s, i, run.end)) {
      out.push({ kind: "command", from: i, to: run.end, name: base, block: true });
      if (run.centering) pushCenter(out, centerFrom(s, run.end));
      i = run.end;
      continue;
    }
    const setting = layoutSettingEnd(s, j, name, argEnd);
    if (setting > 0) {
      out.push({ kind: "command", from: i, to: setting, name: base, block: aloneOnLines(s, i, setting) });
      i = setting;
      continue;
    }
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
    if (base === "includegraphics") {
      let k = arg;
      for (let o = 0; o < 2 && s[k] === "["; o++) {
        const e = argEnd(s, k);
        if (e < 0) break;
        k = skipBlanks(s, e);
      }
      const e = s[k] === "{" ? argEnd(s, k) : -1;
      const path = e > 0 ? s.slice(k + 1, e - 1).trim() : "";
      if (path && aloneOnLines(s, i, e)) {
        out.push({ kind: "image", from: i, to: e, block: true, path });
        i = e;
        continue;
      }
    }
    if (name === "item" && lists.length) {
      const list = lists[lists.length - 1];
      const spec = rules.beamer ? overlayEnd(s, arg) : -1;
      if (spec > 0) {
        const after = skipBlanks(s, spec);
        if (s[after] !== "[") {
          // `\item<2->`: the marker replaces \item, the spec hides.
          out.push({ kind: "item", from: i, to: j, marker: itemMarker(list), term: list.kind === "description" });
          out.push({ kind: "overlay", from: arg, to: spec, hide: [{ from: arg, to: spec }] });
          i = spec;
          continue;
        }
        j = spec; // `\item<2->[label]`: the label's item covers the spec
      }
      const lab = spec > 0 ? skipBlanks(s, spec) : arg;
      const e = s[lab] === "[" ? argEnd(s, lab) : -1;
      const label = e > 0 ? s.slice(lab + 1, e - 1) : null;
      const term = list.kind === "description";
      if (label !== null && hasConstructs(label)) {
        // `\item[` and `]` hide; the label's text and its formulas and references render in place.
        out.push({ kind: "item", from: i, to: e, marker: "", term, labelFrom: lab + 1, labelTo: e - 1 });
        i = lab + 1;
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
      const list = m ? lists.filter((l) => l.kind === "enumerate")[ENUM_COUNTERS[m[1]] - 1] : undefined;
      if (m && list && (base === "stepcounter" || m[2] !== undefined)) {
        const v = Number(m[2]);
        list.next = base === "stepcounter" ? list.next + 1 : base === "setcounter" ? v + 1 : list.next + v;
        i = arg + m[0].length;
        continue;
      }
    }
    if (rules.beamer) {
      const hit = beamerConstruct(s, i, j, base, rules, out);
      if (hit > 0) {
        i = hit;
        continue;
      }
    }
    if (rules.hidden.has(base)) {
      const e = commandEnd(s, j, rules.hidden.get(base) ?? null, false, (t, k) => argEnd(t, k));
      if (e > 0) {
        out.push({ kind: "command", from: i, to: e, name: base, block: aloneOnLines(s, i, e) });
        if (base === "centering") pushCenter(out, centerFrom(s, e));
        i = e;
        continue;
      }
    }
    if (base === "centering") pushCenter(out, centerFrom(s, j));
    if (base === "caption") {
      const short = s[arg] === "[" ? argEnd(s, arg, MAX_LINES) : arg;
      const open = short < 0 ? -1 : skipBlanks(s, short);
      const e = open >= 0 && s[open] === "{" ? argEnd(s, open, MAX_LINES) : -1;
      if (e > 0) {
        const float = floats[floats.length - 1];
        const caption: OpenCaption = {
          kind: "caption",
          from: i,
          to: e,
          contentFrom: open + 1,
          contentTo: e - 1,
          float: float ? (float.env.startsWith("figure") ? "figure" : "table") : null,
          label: labelsIn(s.slice(open + 1, e - 1))[0] ?? null,
        };
        out.push(caption);
        float?.captions.push(caption);
        i = open + 1; // constructs in the content
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
            // A problemset's enumerate ends inside its group: what it saves is lost with it.
            const marks = ended.savesMarks ? ended.marks : (resumable(env)?.marks ?? ended.marks);
            (at > 0 ? lists[at - 1].saved : topSaved).set(env, { next: ended.next, marks });
            if (ended.series !== null) {
              const was = series.get(ended.series);
              series.set(ended.series, { next: ended.next, marks: ended.savesSeriesMarks || !was ? ended.marks : was.marks });
            }
          }
        }
        if (FLOATS.has(env)) {
          const at = floats.map((f) => f.env).lastIndexOf(env);
          if (at >= 0) {
            // A caption without a \label of its own is numbered by the next one in its float.
            for (const c of floats[at].captions) {
              c.label ??= labelsIn(s.slice(c.to, i))[0] ?? null;
            }
            floats.length = at;
          }
        }
        if (rules.wrappers.has(env)) {
          if (aloneOnLines(s, i, j)) out.push({ kind: "envline", from: i, to: j, env, begin: false });
        } else if (!LISTS.has(env)) {
          // Environments pair by name; those left open inside it never close.
          const at = envs.map((e) => e.env).lastIndexOf(env);
          const open = envs[at];
          if (open) {
            envs.length = at;
            const alone = blockEnvKind(env) === "table" ? tableAlone(s, i, j, TABLE_END_TAIL) : aloneOnLines(s, i, j);
            if (open.at >= 0 && alone && lineBreaks(s, open.from, i) <= MAX_LINES) {
              const { from, beginTo, args, label } = open;
              out[open.at] = { kind: "env", from, to: j, env, beginTo, endFrom: i, args, label };
            }
            const close = shellCloses.get(i);
            if (close) out.push(close);
          }
        }
      } else if (VERBATIM_ENVS.has(env)) {
        const e = s.indexOf(`\\end{${env}}`, j);
        j = e < 0 ? n : e + env.length + 6;
      } else if (blockEnvKind(env) === "picture") {
        // TikZ code: nothing in it is a construct. `($(a)!(b)!(c)$)` is a calc coordinate, `$\t$`
        // a \foreach variable, a node's `[label={\textbf{A}}]` an option. A half-typed picture
        // (no \end yet) hides nothing below it. One whose \begin (with its options) and \end are
        // alone on their lines is an `env` (a PDF crop, #14).
        const e = s.indexOf(`\\end{${env}}`, j);
        if (e >= 0) {
          const to = e + env.length + 6;
          const { args, beginTo } = beginArgs(s, j);
          if (aloneOnLines(s, i, beginTo) && aloneOnLines(s, e, to) && lineBreaks(s, i, e) <= MAX_LINES) {
            out.push({ kind: "env", from: i, to, env, beginTo, endFrom: e, args, label: null });
          }
          j = to;
        }
      } else if (rules.math.has(env)) {
        const endTag = `\\end{${env}}`;
        const e = findClose(s, j, endTag, ends);
        if (e >= 0) {
          const to = e + endTag.length;
          // `math` and `displaymath` are delimiters; MathJax reads the other environments whole.
          // An alias goes to MathJax as its target.
          const target = rules.math.get(env)!;
          if (target === "math" || target === "displaymath") math(i, to, target === "displaymath", env, s.slice(j, e));
          else math(i, to, true, env, target === env ? s.slice(i, to) : `\\begin{${target}}${s.slice(j, e)}\\end{${target}}`);
          j = to;
        }
      } else if (rules.wrappers.has(env) || LISTS.has(env)) {
        if (FLOATS.has(env)) floats.push({ env, captions: [] });
        if (LISTS.has(env)) {
          const optAt = skipBlanks(s, j);
          const optEnd = s[optAt] === "[" ? argEnd(s, optAt) : -1;
          if (optEnd > 0) j = optEnd;
          const kind = LIST_KINDS[env];
          const o = listOptions(kind, optEnd > 0 && kind === env ? s.slice(optAt + 1, optEnd - 1) : null);
          // enumitem: `resume` continues the last list of this environment, `resume=s` a series,
          // `resume*` also takes its label; a series' name alone is `resume*=` it. `start=` wins.
          const named = o.bare.find((k) => series.has(k));
          const resume = o.resume ?? (named !== undefined ? { star: true, series: named } : null);
          const from = resume && (resume.series !== null ? series.get(resume.series) : resumable(env));
          const marks = o.marks ?? (from && resume?.star ? from.marks : null) ?? defaultMarks(kind, depthOf(kind) + 1);
          lists.push({
            env,
            kind,
            marks,
            next: o.start ?? from?.next ?? 1,
            series: o.series ?? resume?.series ?? null,
            savesSeriesMarks: o.series !== null,
            savesMarks: !(resume?.star && resume.series === null),
            saved: new Map(),
          });
        } else {
          // A wrapper's arguments collapse with its \begin line (`\begin{minipage}[t]{0.5\textwidth}`),
          // and a \label right after it (`\begin{subequations}\label{eq:sys}`).
          j = beginArgs(s, j).beginTo;
          const label = /^[ \t]*\\label\s*\{[^{}\n]*\}/.exec(s.slice(j, j + 200));
          if (label && aloneOnLines(s, i, j + label[0].length)) j += label[0].length;
        }
        // Layout commands after it on its line collapse with it (`\begin{center}\renewcommand{\arraystretch}{1.35}`).
        const tail = rules.wrappers.has(env) ? layoutTail(s, j, rules) : null;
        if (tail && aloneOnLines(s, i, tail.end)) {
          j = tail.end;
          if (tail.centering) pushCenter(out, centerFrom(s, j));
        }
        if (rules.wrappers.has(env) && aloneOnLines(s, i, j)) out.push({ kind: "envline", from: i, to: j, env, begin: true });
        if (env === "center") pushCenter(out, centerFrom(s, j));
      } else if (env !== "document") {
        if (FLOATS.has(env)) floats.push({ env, captions: [] }); // a float kept as source
        // A theorem-like candidate (#12): the arguments and a \label on its line (scanned on
        // from `j`: a title's formulas are constructs), or a \label first on the next line.
        const found = beginArgs(s, j);
        const { args } = found;
        let { beginTo } = found;
        LABEL.lastIndex = beginTo;
        let label = LABEL.exec(s);
        if (label) beginTo = LABEL.lastIndex;
        else {
          LABEL.lastIndex = lineEnd(s, beginTo) + 1;
          label = LABEL.lastIndex < n ? LABEL.exec(s) : null;
        }
        const alone = blockEnvKind(env) === "table" ? tableAlone(s, i, beginTo, TABLE_BEGIN_TAIL) : aloneOnLines(s, i, beginTo);
        const at = alone ? out.push(null) - 1 : -1;
        envs.push({ env, from: i, beginTo, args, label: label ? label[1].trim() : null, at });
      }
    }
    i = j;
  }
  return out.filter((c): c is LatexConstruct => c !== null);
}

/** A center construct, unless it is empty or an enclosing one already covers it. */
function pushCenter(out: (LatexConstruct | null)[], c: LatexCenter | null): void {
  if (!c) return;
  for (let k = out.length - 1; k >= 0; k--) {
    const o = out[k];
    if (o?.kind === "center" && o.to >= c.to) return;
    if (o?.kind === "center") break;
  }
  out.push(c);
}

/**
 * A beamer construct at s[i] (`\name`, its name ending at j): pushed, and the index to scan on
 * from; -1 when there is none.
 */
function beamerConstruct(s: string, i: number, j: number, base: string, rules: EnvRules, out: (LatexConstruct | null)[]): number {
  const arg = skipBlanks(s, j);
  if (base === "frametitle" || base === "framesubtitle") {
    const short = s[arg] === "[" ? argEnd(s, arg) : arg;
    const open = short < 0 ? -1 : skipBlanks(s, short);
    const e = open >= 0 && s[open] === "{" ? argEnd(s, open, MAX_LINES) : -1;
    if (e < 0) return -1;
    out.push({ kind: "frametitle", from: i, to: e, contentFrom: open + 1, contentTo: e - 1, sub: base === "framesubtitle" });
    return open + 1; // constructs in the title
  }
  if (base === "titlepage" || base === "maketitle") {
    out.push({ kind: "titlepage", from: i, to: j, block: aloneOnLines(s, i, j) });
    return j;
  }
  if (Object.hasOwn(OVERLAY_COMMANDS, base)) {
    const spec = overlayEnd(s, arg);
    if (spec < 0) return -1;
    // `\only<2>{` and its `}` hide; the argument is scanned on.
    const hide: { from: number; to: number }[] = [];
    let k = skipBlanks(s, spec);
    let start = i;
    let firstContent = -1;
    for (let a = 0; a < OVERLAY_COMMANDS[base] && s[k] === "{"; a++) {
      const e = argEnd(s, k, MAX_LINES);
      if (e < 0) break;
      hide.push({ from: start, to: k + 1 });
      if (firstContent < 0) firstContent = k + 1;
      start = e - 1;
      k = skipBlanks(s, e);
      if (a === OVERLAY_COMMANDS[base] - 1 || s[k] !== "{") hide.push({ from: e - 1, to: e });
    }
    if (!hide.length) hide.push({ from: i, to: spec });
    out.push({ kind: "overlay", from: i, to: hide[hide.length - 1].to, hide });
    return firstContent > 0 ? firstContent : spec;
  }
  const banner = rules.banners.get(base);
  if (banner) {
    const args = callArgs(s, j, banner);
    if (!args) return -1;
    const to = args.length ? args[args.length - 1].to + 1 : j;
    out.push({ kind: "banner", from: i, to, name: base, args });
    return args.length ? args[0].from : j;
  }
  const image = rules.images.get(base);
  if (image) {
    const args = callArgs(s, j, image);
    const path = args?.filter((a) => !a.optional)[image.path - (image.optional ? 2 : 1)];
    const e = args?.length ? args[args.length - 1].to + 1 : -1;
    if (!path || !/^[ \t]*(%.*)?$/.test(s.slice(e, lineEnd(s, e)))) return -1;
    // Hidden commands before it on its line go with it (`\centering\DeckFigure{..}`).
    const lineStart = s.lastIndexOf("\n", i - 1) + 1;
    const keep: LatexConstruct[] = [];
    let from = i;
    while (out.length) {
      const o = out[out.length - 1];
      if (o?.kind === "center") keep.unshift(o);
      else if (o?.kind === "command" && o.from >= lineStart && !s.slice(o.to, from).trim()) from = o.from;
      else break;
      out.pop();
    }
    if (s.slice(lineStart, from).trim()) {
      out.push(...keep);
      return -1;
    }
    out.push(...keep, { kind: "image", from, to: e, block: true, path: s.slice(path.from, path.to).trim() });
    return e;
  }
  return -1;
}

/**
 * The arguments of a call (an optional `[..]` when `arity` has one, then the mandatory `{..}`,
 * on its line or wrapped), or null when a mandatory one is missing.
 */
function callArgs(s: string, j: number, arity: Arity): LatexArg[] | null {
  const args: LatexArg[] = [];
  let k = skipBlanks(s, j);
  if (arity.optional && s[k] === "[") {
    const e = argEnd(s, k, MAX_LINES);
    if (e < 0) return null;
    args.push({ optional: true, from: k + 1, to: e - 1 });
    k = skipBlanks(s, e);
  }
  for (let n = arity.optional ? 1 : 0; n < arity.args; n++) {
    if (s[k] !== "{") return null;
    const e = argEnd(s, k, MAX_LINES);
    if (e < 0) return null;
    args.push({ optional: false, from: k + 1, to: e - 1 });
    k = skipBlanks(s, e);
  }
  return args;
}
