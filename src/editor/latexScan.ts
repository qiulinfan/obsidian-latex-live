import type { Text } from "@codemirror/state";
import { MATH_ENVS, VERBATIM_ENVS } from "./latexHighlight";

// The constructs a LaTeX document renders: pure, no CodeMirror view and no Obsidian, so the
// hover and live preview share one scan and tests run it directly (design 4.3).
//   Where     after \begin{document} when the file has one (chapter files have none and are
//             scanned whole), up to \end{document}; comments, verbatim environments and
//             \verb-like inline verbatim are skipped.
//   Bounds    math ends at a paragraph break, as in TeX: a half-typed `$`, `$$`, `\[` or
//             \begin{align} never pairs with a delimiter further down. Environments also
//             close within MAX_LINES lines. Inline math steps over text arguments, whose `$`
//             starts a nested formula (`$f = \text{当 $x>0$ 时} 1$` is one formula).
//   Cost      memoized per document (Text), like the highlighter's own state.
// The highlighter keeps its own tokenizer; half-typed delimiters may differ there.

/** A formula: `$..$`, `\(..\)`, `\[..\]`, `$$..$$` or a math environment. */
export interface LatexMath {
  readonly kind: "math";
  readonly from: number;
  readonly to: number;
  readonly display: boolean;
  /** It owns whole lines: only whitespace (or a comment) around it on its first and last line. */
  readonly block: boolean;
  /** The math environment (`align*`), or null for delimiters. */
  readonly env: string | null;
  /** MathJax input: the text between the delimiters, or the whole environment. */
  readonly src: string;
  /** Keys of the \label's inside. */
  readonly labels: readonly string[];
}

export type LatexConstruct = LatexMath;

/** A math environment closes within this many lines, or it is not one (half-typed). */
const MAX_LINES = 200;

const cache = new WeakMap<Text, readonly LatexConstruct[]>();

/** The constructs of a document in order (memoized per Text). */
export function scanLatex(doc: Text): readonly LatexConstruct[] {
  let hit = cache.get(doc);
  if (!hit) cache.set(doc, (hit = scanText(doc.toString())));
  return hit;
}

/** The formula containing `pos` (its delimiters included), or null. */
export function mathAt(doc: Text, pos: number): LatexMath | null {
  const all = scanLatex(doc);
  let lo = 0;
  let hi = all.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = all[mid];
    if (pos < c.from) hi = mid - 1;
    else if (pos > c.to) lo = mid + 1;
    else return c.kind === "math" ? c : null;
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

function scanText(s: string): LatexConstruct[] {
  const out: LatexConstruct[] = [];
  const math = (from: number, to: number, display: boolean, env: string | null, src: string) => {
    if (src.trim()) out.push({ kind: "math", from, to, display, block: aloneOnLines(s, from, to), env, src, labels: labelsIn(src) });
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
      } else if (VERBATIM_ENVS.has(env)) {
        const e = s.indexOf(`\\end{${env}}`, j);
        j = e < 0 ? n : e + env.length + 6;
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
      }
    }
    i = j;
  }
  return out;
}
