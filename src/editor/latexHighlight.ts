import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

/**
 * Obsidian inlines its own copy of the CM6 language plumbing, so
 * `syntaxHighlighting` and Lezer style props never reach custom editor
 * views. LaTeX is therefore tokenized directly into class decorations.
 */

export interface TokState {
  /** Closing delimiter of the open math span: "$", "$$", "\\)", "\\]", or "env:<name>". */
  math: string | null;
  /** Name of the open verbatim-like environment. */
  verbatim: string | null;
  /** Inside the text an `\iffalse` skips: the conditionals open in it (see iffalseEnd); absent outside. */
  iffalse?: number;
}

export const MATH_ENVS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*",
  "multline", "multline*", "flalign", "flalign*", "alignat", "alignat*",
  "eqnarray", "eqnarray*", "displaymath", "math",
]);
export const VERBATIM_ENVS = new Set([
  "verbatim", "verbatim*", "Verbatim", "Verbatim*", "BVerbatim", "BVerbatim*", "LVerbatim",
  "LVerbatim*", "lstlisting", "minted", "comment", "tcblisting", "tcboutputlisting",
  "filecontents", "filecontents*",
]);
/** natbib's and biblatex's citation commands (the capitalized ones start a sentence). */
export const CITE_COMMANDS = new Set([
  "cite", "Cite", "citep", "Citep", "citet", "Citet", "citealt", "Citealt", "citealp", "Citealp",
  "parencite", "Parencite", "textcite", "Textcite", "autocite", "Autocite", "footcite",
]);
const SECTIONS = new Set([
  "part", "chapter", "section", "subsection", "subsubsection", "paragraph",
  "subparagraph", "part*", "chapter*", "section*", "subsection*",
  "subsubsection*",
]);
const ARG_REFS = new Set([
  "label", "ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref",
  ...CITE_COMMANDS, "nocite",
  "input", "include", "includegraphics", "subfile", "bibliography",
  "addbibresource", "usepackage", "documentclass", "url",
]);

const CMD_RE = /\\([A-Za-z@]+\*?|.)/y;
const ENV_ARG_RE = /\s*\{([^}]*)\}/y;
const REF_ARG_RE = /(\s*(?:\[[^\]]*\]\s*)*)\{([^}]*)\}/y;

type Push = (from: number, to: number, cls: string) => void;

/**
 * TeX skipping the text of an `\iffalse` from s[from], `depth` conditionals already open in it:
 * `end` is the index after the `\fi` (or top-level `\else`) that ends it, which starts at `at`;
 * -1 when `s` ends first, with the conditionals then open. Conditionals nest (`\ifx`, `\ifdraft`);
 * etoolbox's and ifthen's `\if..{` macros take braces and are none, nor is the math `\iff`;
 * comments are skipped.
 */
export function iffalseEnd(s: string, from: number, depth = 0): { end: number; at: number; depth: number } {
  const re = /\\(?:(if[A-Za-z@]*)(\s*\{)?|(fi|else)(?![A-Za-z@]))|%[^\n]*|\\./g;
  re.lastIndex = from;
  for (let m; (m = re.exec(s)); ) {
    if (m[1] !== undefined) {
      if (!m[2] && m[1] !== "iff") depth++;
    } else if ((m[3] === "fi" && depth-- === 0) || (m[3] === "else" && depth === 0)) {
      return { end: re.lastIndex, at: m.index, depth: 0 };
    }
  }
  return { end: -1, at: -1, depth };
}

/** `\iffalse` at s[i] starts skipped text: the block-comment idiom, first on its line (`\let\ifx\iffalse` does not). */
export const iffalseStarts = (s: string, i: number): boolean => !s.slice(s.lastIndexOf("\n", i - 1) + 1, i).trim();

export function tokenizeLine(
  text: string,
  base: number,
  s: TokState,
  push: Push,
): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (s.iffalse !== undefined) {
      const r = iffalseEnd(text, i, s.iffalse);
      if (r.end < 0) {
        push(base + i, base + n, "ll-comment");
        s.iffalse = r.depth;
        return;
      }
      if (r.at > i) push(base + i, base + r.at, "ll-comment");
      push(base + r.at, base + r.end, "ll-keyword");
      s.iffalse = undefined;
      i = r.end;
      continue;
    }
    if (s.verbatim) {
      const end = text.indexOf(`\\end{${s.verbatim}}`, i);
      if (end < 0) {
        push(base + i, base + n, "ll-verbatim");
        return;
      }
      if (end > i) push(base + i, base + end, "ll-verbatim");
      s.verbatim = null;
      i = end;
      continue;
    }
    const ch = text[i];
    if (ch === "%") {
      push(base + i, base + n, "ll-comment");
      return;
    }
    if (ch === "\\") {
      CMD_RE.lastIndex = i;
      const m = CMD_RE.exec(text);
      if (!m) {
        // A lone backslash ends the line (e.g. `\] \`).
        push(base + i, base + n, "ll-escape");
        return;
      }
      const name = m[1];
      const end = i + m[0].length;
      if ((name === "(" || name === "[") && !s.math) {
        push(base + i, base + end, "ll-math-delim");
        s.math = name === "(" ? "\\)" : "\\]";
      } else if ((name === ")" || name === "]") && s.math === `\\${name}`) {
        push(base + i, base + end, "ll-math-delim");
        s.math = null;
      } else if (name === "begin" || name === "end") {
        push(base + i, base + end, "ll-keyword");
        ENV_ARG_RE.lastIndex = end;
        const env = ENV_ARG_RE.exec(text);
        if (env) {
          const nameFrom = end + env[0].indexOf("{") + 1;
          push(base + nameFrom, base + nameFrom + env[1].length, "ll-env");
          i = end + env[0].length;
          if (name === "begin" && !s.math && MATH_ENVS.has(env[1])) {
            s.math = `env:${env[1]}`;
          } else if (name === "end" && s.math === `env:${env[1]}`) {
            s.math = null;
          } else if (name === "begin" && VERBATIM_ENVS.has(env[1])) {
            s.verbatim = env[1];
          }
          continue;
        }
      } else if (name === "iffalse" && !s.math && iffalseStarts(text, i)) {
        push(base + i, base + end, "ll-keyword");
        s.iffalse = 0;
      } else if (SECTIONS.has(name)) {
        push(base + i, base + end, "ll-section");
      } else if (ARG_REFS.has(name)) {
        push(base + i, base + end, "ll-command");
        REF_ARG_RE.lastIndex = end;
        const arg = REF_ARG_RE.exec(text);
        if (arg) {
          const from = end + arg[1].length + 1;
          push(base + from, base + from + arg[2].length, "ll-ref");
          i = from + arg[2].length + 1;
          continue;
        }
      } else if (/^[A-Za-z@]/.test(name)) {
        push(base + i, base + end, s.math ? "ll-command ll-in-math" : "ll-command");
      } else {
        push(base + i, base + end, "ll-escape");
      }
      i = end;
      continue;
    }
    if (ch === "$") {
      const double = text[i + 1] === "$";
      const delim = double ? "$$" : "$";
      if (s.math === delim) s.math = null;
      else if (!s.math) s.math = delim;
      push(base + i, base + i + delim.length, "ll-math-delim");
      i += delim.length;
      continue;
    }
    if (s.math) {
      const start = i;
      while (i < n && text[i] !== "\\" && text[i] !== "$" && text[i] !== "%") i++;
      push(base + start, base + i, "ll-math");
      continue;
    }
    if (ch === "{" || ch === "}" || ch === "[" || ch === "]") {
      push(base + i, base + i + 1, "ll-bracket");
    } else if (ch === "&" || ch === "~") {
      push(base + i, base + i + 1, "ll-escape");
    }
    i++;
  }
}

const MAX_TOKENIZE_LENGTH = 1_000_000;

function buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  if (doc.length > MAX_TOKENIZE_LENGTH) return Decoration.none;
  const end = view.visibleRanges.length
    ? view.visibleRanges[view.visibleRanges.length - 1].to
    : doc.length;
  const builder = new RangeSetBuilder<Decoration>();
  const state: TokState = { math: null, verbatim: null };
  const marks = new Map<string, Decoration>();
  const mark = (cls: string) => {
    let d = marks.get(cls);
    if (!d) marks.set(cls, (d = Decoration.mark({ class: cls })));
    return d;
  };
  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    if (line.from > end) break;
    tokenizeLine(line.text, line.from, state, (from, to, cls) => {
      if (to > from) builder.add(from, to, mark(cls));
    });
    // Inline math never spans a paragraph break.
    if (!line.text.trim() && (state.math === "$" || state.math === "\\)")) {
      state.math = null;
    }
  }
  return builder.finish();
}

export const latexHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
