import { MATH_ENVS, VERBATIM_ENVS, iffalseEnd, iffalseStarts } from "../editor/latexHighlight";

// The export's LaTeX parser (design D1): tolerant, offset-exact, and consistent with the editor's
// lexical rules (latexHighlight's MATH_ENVS, VERBATIM_ENVS and `\iffalse` skipping; latexScan's
// text-argument rule inside math). Arguments follow per-command signatures (signatures.ts), so
// a user macro, elegantbook's `g o t\label g` theorems and `\\[2pt]` read like TeX reads them.
// Every node covers source offsets [from, to); the top-level nodes cover the whole input, so the
// planner can insert at exact offsets and the emitter can slice any construct's source.
// TeX's own rules the tree keeps:
//   - `%` eats the rest of its line, the line break and the next line's indentation (a comment
//     node); a blank line after it still ends the paragraph.
//   - a blank line is a `par`; other white space (at most one line break) is a `space`.
//   - `\verb`, `\lstinline`, `\mintinline` and the verbatim environments are raw text (`verb`);
//     `\url` and `\href`'s target are raw arguments (`v`).
//   - math (`$..$`, `$$..$$`, `\(..\)`, `\[..\]`, the math environments) is raw source: an inline
//     formula ends at the paragraph and steps over text arguments (`\text{当 $x$ 时}`).
//   - definitions (`\newcommand`, `\def`, `\newenvironment`, ...) are code: one macro node, no
//     arguments, spanning the whole definition.
//   - an `\end` closes the innermost open environment of that name (inner ones stay unclosed);
//     an `\end` nothing opened is a stray `end` macro.

/** One argument of a macro or environment. */
export interface TexArg {
  /** s a star, t a token (`t\label`), o `[..]`, m mandatory, g optional `{..}`, v raw `{..}`. */
  kind: "s" | "t" | "o" | "m" | "g" | "v";
  /** The argument with its delimiters; from === to when it is absent. */
  from: number;
  to: number;
  /** The content parsed (o, m, g); null when absent and for s, t, v. */
  body: TexNode[] | null;
}

export type TexNode =
  | { t: "text"; from: number; to: number; s: string }
  | { t: "space"; from: number; to: number }
  | { t: "par"; from: number; to: number }
  | { t: "comment"; from: number; to: number }
  | { t: "group"; from: number; to: number; body: TexNode[] }
  | { t: "macro"; from: number; to: number; name: string; args: TexArg[]; code?: true }
  | {
      t: "env";
      from: number;
      to: number;
      name: string;
      args: TexArg[];
      body: TexNode[];
      bodyFrom: number;
      bodyTo: number;
      /** Its `\end` was found (else it runs to the end of what encloses it). */
      closed: boolean;
    }
  | {
      t: "math";
      from: number;
      to: number;
      display: boolean;
      /** The math environment, or null for the delimiters. */
      env: string | null;
      /** The formula between the delimiters (`\begin{align}` .. `\end{align}` excluded). */
      srcFrom: number;
      srcTo: number;
    }
  | {
      t: "verb";
      from: number;
      to: number;
      /** The verbatim environment, or null for `\verb`-like commands (their name in `cmd`). */
      env: string | null;
      cmd?: string;
      /** Options before the text (`\begin{lstlisting}[caption=..]`, `\lstinline[..]`). */
      args: TexArg[];
      textFrom: number;
      textTo: number;
    };

/**
 * Argument specs, xparse's letters: `s` a star, `t<token>` (`t\label`), `o` or `O{default}` a
 * `[..]` argument, `m` mandatory, `g` an optional brace group, `v` a raw brace group (`\url`).
 */
export type Spec = string;

/** A project's traditional `\newenvironment` definition, before argument substitution. */
export interface EnvironmentDefinition {
  args: number;
  optional?: string;
  begin: string;
  end: string;
}

export interface Signatures {
  macros: ReadonlyMap<string, Spec>;
  envs: ReadonlyMap<string, Spec>;
  /** Definers the document renamed (`\newcommand{\nc}{\newcommand}`: nc -> newcommand). */
  definers?: ReadonlyMap<string, string>;
  /** Bodies of traditional `\newenvironment`/`\renewenvironment` definitions. */
  environmentDefs?: ReadonlyMap<string, EnvironmentDefinition>;
}

/** Arguments of the verbatim environments before their text. */
const VERBATIM_ARGS: Record<string, Spec> = {
  lstlisting: "o",
  minted: "o m",
  Verbatim: "o",
  "Verbatim*": "o",
  BVerbatim: "o",
  LVerbatim: "o",
  tcblisting: "m",
  filecontents: "o m",
  "filecontents*": "o m",
};

/** Commands with a text argument inside math: `$`, `\(` in it open a nested formula. */
const TEXT_ARG = /^(?:text(?:rm|sf|tt|bf|md|it|sl|up|sc|normal)?|mbox|hbox|fbox|intertext|shortintertext|tag)$/;
const DEFINERS =
  /^(?:(?:re|provide)?newcommand|DeclareRobustCommand|(?:New|Renew|Provide|Declare)DocumentCommand|(?:re)?newenvironment|(?:New|Renew|Provide|Declare)DocumentEnvironment|DeclareMathOperator|DeclarePairedDelimiterX?|newtheorem|definecolor|(?:[gex]?def)|let)$/;
/** The arguments a definer takes (the parameter text of `\def` is read separately). */
const DEFINER_SPECS: Record<string, Spec> = {
  newenvironment: "s m o o m m",
  renewenvironment: "s m o o m m",
  NewDocumentEnvironment: "m m m m",
  RenewDocumentEnvironment: "m m m m",
  ProvideDocumentEnvironment: "m m m m",
  DeclareDocumentEnvironment: "m m m m",
  NewDocumentCommand: "m m m",
  RenewDocumentCommand: "m m m",
  ProvideDocumentCommand: "m m m",
  DeclareDocumentCommand: "m m m",
  DeclareMathOperator: "s m m",
  DeclarePairedDelimiter: "m m m",
  DeclarePairedDelimiterX: "m o m m m",
  newtheorem: "s m o m o",
  definecolor: "o m m m",
};
/** Formulas nested in text arguments nested in formulas stop being followed this deep. */
const MAX_NESTING = 4;

const SPEC_RE = /t\\[A-Za-z@]+|t\S|O\{[^}]*\}|[somgv]/g;

const isLetter = (c: string | undefined) =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "@");
const isBlank = (c: string | undefined) => c === " " || c === "\t" || c === "\r";

/** Parse `s` into nodes covering it exactly (see the file comment). */
export function parseTex(s: string, sig: Signatures): TexNode[] {
  const n = s.length;
  let i = 0;
  /** The control sequence at s[at] === "\\": its name and the index after it. */
  const csAt = (at: number): [string, number] => {
    const j = at + 1;
    if (j >= n) return ["", j];
    if (!isLetter(s[j])) return [s[j], j + 1];
    let k = j;
    while (k < n && isLetter(s[k])) k++;
    return [s.slice(j, k), k];
  };
  const lineEnd = (at: number) => {
    const k = s.indexOf("\n", at);
    return k < 0 ? n : k;
  };
  const skipBlank = (at: number) => {
    while (isBlank(s[at])) at++;
    return at;
  };
  /** The end of a comment at s[at] === "%": its line break and the next line's indentation. */
  const commentEnd = (at: number) => {
    const e = lineEnd(at);
    return e < n ? skipBlank(e + 1) : n;
  };
  /** s[at] === "\n" starts a blank line. */
  const blankLineAt = (at: number) => s[skipBlank(at + 1)] === "\n";
  /** Spaces, comments and at most one line break (a blank line ends the argument search). */
  const skipSpaces = (at: number): number => {
    let j = at;
    let breaks = 0;
    for (;;) {
      if (isBlank(s[j])) j++;
      else if (s[j] === "\n" && breaks === 0) {
        breaks++;
        j++;
      } else if (s[j] === "%") j = commentEnd(j);
      else return j;
    }
  };
  /** The index after the group opened at s[at] === "{" (escapes, comments skipped), or n. */
  const groupEnd = (at: number): number => {
    for (let j = at + 1, depth = 0; j < n; j++) {
      const c = s[j];
      if (c === "\\") j++;
      else if (c === "%") j = lineEnd(j);
      else if (c === "{") depth++;
      else if (c === "}" && depth-- === 0) return j + 1;
    }
    return n;
  };
  /** The index after a raw group opened at s[at] === "{" (`\url`: `%` and `\` are characters), or n. */
  const rawGroupEnd = (at: number): number => {
    for (let j = at + 1, depth = 0; j < n; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}" && depth-- === 0) return j + 1;
    }
    return n;
  };
  /** The index after the `[..]` opened at s[at] (first `]` outside braces), or -1 past a paragraph. */
  const optEnd = (at: number): number => {
    for (let j = at + 1, depth = 0; j < n; j++) {
      const c = s[j];
      if (c === "\\") j++;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === "]" && depth <= 0) return j + 1;
      else if (c === "\n" && blankLineAt(j)) return -1;
    }
    return -1;
  };
  /**
   * Where a formula closes: the index of `close` (or of the `\end{env}` closing `env`) from `at`,
   * stepping over comments, escapes and text arguments; -1 when a paragraph ends an inline one
   * first or nothing closes it.
   */
  const mathEnd = (at: number, close: string, env: string | null, nesting: number): number => {
    let depth = 0;
    for (let j = at; j < n; j++) {
      const c = s[j];
      if (c === "%") {
        j = lineEnd(j);
        continue;
      }
      if (c === "\\") {
        if (!env && s.startsWith(close, j)) return j;
        const [name, e] = csAt(j);
        if (env && (name === "begin" || name === "end") && s.startsWith(`{${env}}`, skipBlank(e))) {
          if (name === "begin") depth++;
          else if (depth-- === 0) return j;
        }
        if (!env && nesting < MAX_NESTING && TEXT_ARG.test(name)) {
          const k = skipSpaces(e);
          if (s[k] === "{") {
            j = textEnd(k, nesting + 1) - 1;
            continue;
          }
        }
        j = e - 1;
        continue;
      }
      if (!env && s.startsWith(close, j)) return j;
      if (!env && c === "\n" && blankLineAt(j)) return -1;
    }
    return -1;
  };
  /** The index after a text argument inside math opened at s[at] === "{": its `$..$` are formulas. */
  const textEnd = (at: number, nesting: number): number => {
    for (let j = at + 1, depth = 0; j < n; j++) {
      const c = s[j];
      if (c === "\\") {
        if (s[j + 1] === "(") {
          const e = mathEnd(j + 2, "\\)", null, nesting);
          if (e > 0) j = e + 1;
        } else j++;
      } else if (c === "$") {
        const e = mathEnd(j + 1, "$", null, nesting);
        if (e > 0) j = e;
      } else if (c === "%") j = lineEnd(j);
      else if (c === "{") depth++;
      else if (c === "}" && depth-- === 0) return j + 1;
    }
    return n;
  };

  /** Read the arguments of `spec` from s[at]; the index after them. */
  const readArgs = (at: number, spec: Spec): { args: TexArg[]; end: number } => {
    const args: TexArg[] = [];
    let j = at;
    for (const l of spec.match(SPEC_RE) ?? []) {
      if (l === "s" || l[0] === "t") {
        // A star or token follows directly (xparse skips spaces before them too).
        const k = skipBlank(j);
        const tok = l === "s" ? "*" : l.slice(1);
        const hit = s.startsWith(tok, k) && !(tok[0] === "\\" && isLetter(s[k + tok.length]));
        args.push({ kind: l === "s" ? "s" : "t", from: hit ? k : j, to: hit ? k + tok.length : j, body: null });
        if (hit) j = k + tok.length;
        continue;
      }
      const k = skipSpaces(j);
      if (l === "o" || l[0] === "O") {
        const e = s[k] === "[" ? optEnd(k) : -1;
        if (e > 0) {
          args.push({ kind: "o", from: k, to: e, body: sub(k + 1, e - 1) });
          j = e;
        } else args.push({ kind: "o", from: j, to: j, body: null });
        continue;
      }
      if (s[k] === "{") {
        const e = l === "v" ? rawGroupEnd(k) : groupEnd(k);
        const inner = s[e - 1] === "}" ? e - 1 : e;
        args.push({ kind: l as "m" | "g" | "v", from: k, to: e, body: l === "v" ? null : sub(k + 1, Math.max(k + 1, inner)) });
        j = e;
        continue;
      }
      if (l === "g") {
        args.push({ kind: "g", from: j, to: j, body: null });
        continue;
      }
      // A mandatory argument without braces: one token (a command or a character).
      if (k < n && s[k] !== "}" && s[k] !== "\n") {
        const e = s[k] === "\\" ? csAt(k)[1] : k + 1;
        args.push({ kind: l as "m" | "v", from: k, to: e, body: l === "v" ? null : sub(k, e) });
        j = e;
      } else args.push({ kind: l as "m" | "v", from: j, to: j, body: null });
    }
    return { args, end: j };
  };

  /** Parse s[from, to) (the position `i` is kept). */
  const sub = (from: number, to: number): TexNode[] => {
    const save = i;
    i = from;
    const out = list(to, []);
    i = save;
    return out;
  };

  /** A `\verb`-like command at s[at] (its name ends at e): the raw text up to its delimiter. */
  const verbCommand = (at: number, name: string, e: number): TexNode => {
    let k = e;
    const args: TexArg[] = [];
    if (name === "verb" && s[k] === "*") k++;
    else if (name === "lstinline" || name === "mintinline") {
      const r = readArgs(k, name === "lstinline" ? "o" : "m");
      args.push(...r.args);
      k = r.end;
    }
    const d = s[k];
    const close = d === "{" ? "}" : d;
    const end = d === undefined || d === "\n" ? -1 : s.indexOf(close, k + 1);
    const stop = end < 0 || s.slice(k + 1, end).includes("\n") ? lineEnd(k) : end;
    const to = Math.min(n, end === stop ? stop + 1 : stop);
    return { t: "verb", from: at, to, env: null, cmd: name, args, textFrom: Math.min(k + 1, stop), textTo: stop };
  };

  /** A definition at s[at] (the definer's name ends at e): code up to its end. */
  const definition = (name: string, e: number): number => {
    let j = e;
    if (name === "let") {
      const k = skipBlank(j);
      j = s[k] === "\\" ? csAt(k)[1] : k + 1;
      let k2 = skipBlank(j);
      if (s[k2] === "=") k2 = skipBlank(k2 + 1);
      if (s[k2] === " ") k2++;
      return s[k2] === "\\" ? csAt(k2)[1] : Math.min(n, k2 + 1);
    }
    if (/def$/.test(name)) {
      // \def\name<parameter text>{body}
      const b = s.indexOf("{", j);
      return b < 0 ? lineEnd(j) : groupEnd(b);
    }
    return readArgs(j, DEFINER_SPECS[name] ?? "s m o o m").end;
  };

  /** Nodes until `to`, or until an `\end` of an environment in `open` (i is left at that `\end`). */
  const list = (to: number, open: readonly string[]): TexNode[] => {
    const out: TexNode[] = [];
    let text = -1;
    const flush = () => {
      if (text >= 0 && i > text) out.push({ t: "text", from: text, to: i, s: s.slice(text, i) });
      text = -1;
    };
    const literal = (upTo: number) => {
      if (text < 0) text = i;
      i = upTo;
    };
    while (i < to) {
      const c = s[i];
      if (c === "%") {
        flush();
        const e = Math.min(commentEnd(i), to);
        out.push({ t: "comment", from: i, to: e });
        i = e;
        continue;
      }
      if (isBlank(c) || c === "\n") {
        flush();
        const from = i;
        // After a comment that ate the line break, a line break here ends a blank line.
        const lineStart = s.lastIndexOf("\n", from - 1);
        let breaks = lineStart >= 0 && !s.slice(lineStart + 1, from).trim() ? 1 : 0;
        while (i < to && (isBlank(s[i]) || s[i] === "\n")) {
          if (s[i] === "\n") breaks++;
          i++;
        }
        out.push(breaks >= 2 ? { t: "par", from, to: i } : { t: "space", from, to: i });
        continue;
      }
      if (c === "{") {
        flush();
        const e = Math.min(groupEnd(i), to);
        const inner = s[e - 1] === "}" && e - 1 > i ? e - 1 : e;
        out.push({ t: "group", from: i, to: e, body: sub(i + 1, inner) });
        i = e;
        continue;
      }
      if (c === "$") {
        const display = s[i + 1] === "$";
        const open = display ? 2 : 1;
        const e = mathEnd(i + open, display ? "$$" : "$", null, 0);
        if (e < 0 || e + open > to) {
          literal(i + open);
          continue;
        }
        flush();
        out.push({ t: "math", from: i, to: e + open, display, env: null, srcFrom: i + open, srcTo: e });
        i = e + open;
        continue;
      }
      if (c !== "\\") {
        literal(i + 1);
        continue;
      }
      const [name, e] = csAt(i);
      if (name === "(" || name === "[") {
        const m = mathEnd(e, name === "(" ? "\\)" : "\\]", null, 0);
        if (m < 0 || m + 2 > to) {
          literal(e);
          continue;
        }
        flush();
        out.push({ t: "math", from: i, to: m + 2, display: name === "[", env: null, srcFrom: e, srcTo: m });
        i = m + 2;
        continue;
      }
      if (name === "verb" || name === "lstinline" || name === "mintinline") {
        flush();
        const node = verbCommand(i, name, e);
        out.push(node);
        i = Math.min(node.to, to);
        continue;
      }
      if (name === "iffalse" && iffalseStarts(s, i)) {
        flush();
        const r = iffalseEnd(s, e);
        const stop = r.end < 0 ? to : Math.min(r.end, to);
        out.push({ t: "comment", from: i, to: stop });
        i = stop;
        continue;
      }
      if (name === "begin" || name === "end") {
        const k = skipBlank(e);
        const close = s[k] === "{" ? s.indexOf("}", k) : -1;
        const env = close > 0 && close < to ? s.slice(k + 1, close).trim() : "";
        if (!env || /[\n{\\]/.test(env)) {
          literal(e);
          continue;
        }
        flush();
        if (name === "end") {
          if (open.includes(env)) return out; // the environment's owner consumes it
          out.push({ t: "macro", from: i, to: close + 1, name: "end", args: [] }); // stray
          i = close + 1;
          continue;
        }
        out.push(environment(i, env, close + 1, to, open));
        continue;
      }
      flush();
      const definer = DEFINERS.test(name) ? name : sig.definers?.get(name);
      if (definer) {
        const end = Math.min(definition(definer, e), to);
        out.push({ t: "macro", from: i, to: end, name, args: [], code: true });
        i = end;
        continue;
      }
      const { args, end } = readArgs(e, sig.macros.get(name) ?? "");
      const stop = Math.min(end, to);
      out.push({ t: "macro", from: i, to: stop, name, args });
      i = stop;
    }
    flush();
    return out;
  };

  /** The environment `name` whose `\begin{name}` spans [from, after). */
  const environment = (from: number, name: string, after: number, to: number, open: readonly string[]): TexNode => {
    const endTag = `\\end{${name}}`;
    if (MATH_ENVS.has(name)) {
      const m = mathEnd(after, "", name, 0);
      const stop = m < 0 || m > to ? to : m;
      const endTo = m < 0 || m > to ? to : Math.min(s.indexOf("}", m) + 1, to);
      i = endTo;
      return { t: "math", from, to: endTo, display: name !== "math", env: name, srcFrom: after, srcTo: stop };
    }
    if (VERBATIM_ENVS.has(name)) {
      const { args, end } = readArgs(after, VERBATIM_ARGS[name] ?? "");
      const m = s.indexOf(endTag, end);
      const stop = m < 0 || m > to ? to : m;
      const endTo = stop === m ? m + endTag.length : to;
      i = endTo;
      return { t: "verb", from, to: endTo, env: name, args, textFrom: end, textTo: stop };
    }
    const { args, end } = readArgs(after, sig.envs.get(name) ?? "");
    i = Math.min(end, to);
    const bodyFrom = i;
    const body = list(to, [...open, name]);
    const bodyTo = i;
    let endTo = i;
    let closed = false;
    if (s.startsWith("\\end", i)) {
      const k = skipBlank(i + 4);
      const close = s.indexOf("}", k);
      if (s[k] === "{" && close > 0 && s.slice(k + 1, close).trim() === name) {
        endTo = close + 1;
        closed = true;
      }
    }
    i = endTo;
    return { t: "env", from, to: endTo, name, args, body, bodyFrom, bodyTo, closed };
  };

  return list(n, []);
}

/** The raw text of an argument without its delimiters (`v` arguments, keys, file names). */
export function argText(src: string, arg: TexArg | undefined): string {
  if (!arg || arg.to <= arg.from) return "";
  const open = src[arg.from];
  const delimited = (open === "{" && src[arg.to - 1] === "}") || (open === "[" && src[arg.to - 1] === "]");
  return delimited ? src.slice(arg.from + 1, arg.to - 1) : src.slice(arg.from, arg.to);
}

/** An argument that is present (the star or token was there, the group or brackets were). */
export const given = (arg: TexArg | undefined): arg is TexArg => !!arg && arg.to > arg.from;

/**
 * The text a traditional environment expands to, within its own group. Its body is copied
 * verbatim: parameters belong to the begin/end definitions, never to the user's body.
 * The planner decides whether that text has an HTML representation or still needs TeX.
 */
export function expandEnvironment(src: string, node: TexNode & { t: "env" }, sig: Signatures): string | null {
  const def = sig.environmentDefs?.get(node.name);
  if (!def || !node.closed) return null;
  const args = node.args.map((a, i) => (i === 0 && def.optional !== undefined && !given(a) ? def.optional : argText(src, a)));
  // Definitions are token lists. A control word at a substitution boundary must not become
  // a different command when represented as source (`\itshape` + `Body` is not `\itshapeBody`).
  const join = (left: string, right: string) => left + (/\\[A-Za-z@]+$/.test(left) && /^[A-Za-z@]/.test(right) ? " " : "") + right;
  const substitute = (text: string) => {
    let out = "";
    let from = 0;
    for (const m of text.matchAll(/##|#([1-9])/g)) {
      out = join(out, text.slice(from, m.index));
      out = join(out, m[1] ? (args[Number(m[1]) - 1] ?? "") : "#");
      from = m.index! + m[0].length;
    }
    return join(out, text.slice(from));
  };
  return join(join(substitute(def.begin), src.slice(node.bodyFrom, node.bodyTo)), substitute(def.end));
}

/** Call `f` on every node of the tree, arguments included, depth first in source order. */
export function walkTex(nodes: readonly TexNode[], f: (node: TexNode) => void | false): void {
  for (const node of nodes) {
    if (f(node) === false) continue;
    if (node.t === "group") walkTex(node.body, f);
    else if (node.t === "macro" || node.t === "env" || node.t === "verb") {
      for (const a of node.args) if (a.body) walkTex(a.body, f);
      if (node.t === "env") walkTex(node.body, f);
    }
  }
}
