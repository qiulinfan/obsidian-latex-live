import { MATH_ENVS } from "../editor/latexHighlight";
import { MathError, ProjectMath, type MathJaxLike, type ProjectMathInput } from "../editor/mathjaxProject";
import { abortError, isAbortError } from "../tex/run";

// Math for the HTML export (design 3.4, D5). Formulas render through a ProjectMath (the project's
// definitions and shims, failures throw MathError) with a CHTML output jax of the export's own, so
// its stylesheet holds only this export's glyph rules. The page keeps the rules its HTML uses: the
// glyph rules of the characters it shows, the family classes it uses, their @font-face rules with
// the woff files inline as data URIs (in Obsidian fetched from MathJax's fontURL, in tests read from
// node_modules/mathjax: the same bytes), and MathJax's layout rules.
// Displays are laid out here as amsmath numbers them (`displayLayout`): rows end at the outer
// environment's own `\\` (never inside split, aligned or cases, whose rows amsmath and MathJax leave
// untagged), each row with its own `\tag`, `\notag`/`\nonumber` and labels; `\intertext` (MathJax
// has none) splits the alignment into parts with a paragraph between them. The emitter gives each
// numbered row the number TeX printed (the probe's steps) and `displayTex` writes it as `\tag{..}`.
// How TeX steps the equation counter (measured with the probe, amsmath 2.17, TeX Live 2026):
//   - equation steps once at its \begin; with an own \tag, \notag or \nonumber it restores the
//     counter (the step is taken and not shown);
//   - multline and the rows of align, gather, flalign and alignat step only when numbered;
//   - eqnarray steps at its start and after each numbered row and undoes the last step (eqnarray*
//     steps once and undoes it);
//   - a trailing `\\` before `\end` makes one more, empty row, which TeX numbers.

/** What the export needs from its environment to render math. */
export interface MathEnv {
  /** Obsidian's MathJax (3.2.2, with its internals). */
  mj: MathJaxLike;
  /** The document MathJax creates its nodes in. */
  document: Document;
  /** A MathJax woff file (`MathJax_Main-Regular.woff`) as bytes. */
  font(file: string, signal?: AbortSignal): Promise<Uint8Array>;
}

/** How TeX numbers a display environment (null: it prints only its own tags). */
export type Numbering = "equation" | "multline" | "rows" | "eqnarray" | "eqnarray*" | null;

const NUMBERING: Record<string, Numbering> = {
  equation: "equation",
  multline: "multline",
  align: "rows",
  gather: "rows",
  flalign: "rows",
  alignat: "rows",
  eqnarray: "eqnarray",
  "eqnarray*": "eqnarray*",
};
/** Environments whose rows end at their own `\\`. */
const ROWS = /^(?:align|gather|flalign|alignat|eqnarray)\*?$/;

export interface DisplayRow {
  /** Where the row's tag goes (before its `\\`, or before the `\end`): an offset in the display's source. */
  at: number;
  /** Its own `\tag`/`\tag*`, or `\notag`/`\nonumber`. */
  own: "tag" | "notag" | null;
  /** An own tag's argument as written (`$\star$`). */
  tag: string | null;
  labels: string[];
}

export type DisplayPart =
  | { kind: "math"; from: number; to: number; rows: DisplayRow[] }
  /** An `\intertext` argument (inside its braces). */
  | { kind: "text"; from: number; to: number };

export interface DisplayLayout {
  /** The environment (`align`), or null for `\[..\]` and `$$..$$`. */
  env: string | null;
  numbering: Numbering;
  /** What each math part starts and ends with: `\begin{alignat}{2}` and `\end{alignat}` ("" without an environment). */
  open: string;
  close: string;
  parts: DisplayPart[];
  /** Every `\label` key, in order. */
  labels: string[];
}

const TOKEN =
  /\\(begin|end)\s*\{([^{}]*)\}|\\label\s*\{([^{}]*)\}|\\(tag\*?|notag|nonumber|intertext|shortintertext)(?![A-Za-z@])|\\\\|\\[A-Za-z@]+|\\[^A-Za-z@]|%[^\n]*|[{}]/g;

/** The brace group at s[i] (after white space): its inside and where it ends; null without one. */
function braceGroup(s: string, i: number): { from: number; to: number; end: number } | null {
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { from: i + 1, to: j, end: j + 1 };
  }
  return null;
}

/**
 * A display formula's rows and parts (see the file comment). `src` is the formula as the parser
 * gives it: `\begin{env}..\end{env}` for an environment, the inside of `\[..\]` or `$$..$$` else.
 */
export function displayLayout(src: string, env: string | null): DisplayLayout {
  let bodyFrom = 0;
  let bodyTo = src.length;
  if (env) {
    bodyFrom = /^\s*\\begin\s*\{[^{}]*\}/.exec(src)?.[0].length ?? 0;
    // alignat's column count opens every part.
    const count = /^alignat\*?$/.test(env) ? /^\s*\{[^{}]*\}/.exec(src.slice(bodyFrom)) : null;
    if (count) bodyFrom += count[0].length;
    const end = src.lastIndexOf("\\end");
    if (end >= bodyFrom) bodyTo = end;
  }
  const splits = env !== null && ROWS.test(env);
  const labels: string[] = [];
  const parts: DisplayPart[] = [];
  let rows: DisplayRow[] = [];
  let row: DisplayRow = { at: bodyTo, own: null, tag: null, labels: [] };
  let partFrom = bodyFrom;
  let depth = 0;
  const re = new RegExp(TOKEN.source, "g");
  re.lastIndex = bodyFrom;
  for (let m = re.exec(src); m && m.index < bodyTo; m = re.exec(src)) {
    const t = m[0];
    const cmd = m[4];
    if (m[3] !== undefined) {
      labels.push(m[3].trim());
      row.labels.push(m[3].trim());
    } else if (t === "{" || m[1] === "begin") depth++;
    else if (t === "}" || m[1] === "end") depth = Math.max(0, depth - 1);
    else if (t === "\\\\" && depth === 0 && splits) {
      row.at = m.index;
      rows.push(row);
      row = { at: bodyTo, own: null, tag: null, labels: [] };
    } else if (cmd === "tag" || cmd === "tag*") {
      row.own = "tag";
      const g = braceGroup(src, re.lastIndex);
      row.tag = g ? src.slice(g.from, g.to) : null;
    } else if (cmd === "notag" || cmd === "nonumber") row.own ??= "notag";
    else if ((cmd === "intertext" || cmd === "shortintertext") && depth === 0 && env) {
      const g = braceGroup(src, re.lastIndex);
      if (!g) continue;
      parts.push({ kind: "math", from: partFrom, to: m.index, rows });
      parts.push({ kind: "text", from: g.from, to: g.to });
      rows = [];
      partFrom = g.end;
      re.lastIndex = g.end;
    }
  }
  rows.push(row);
  parts.push({ kind: "math", from: partFrom, to: bodyTo, rows });
  return {
    env,
    numbering: env ? (NUMBERING[env] ?? null) : null,
    open: src.slice(0, bodyFrom),
    close: src.slice(bodyTo),
    // A part with nothing but white space and comments (an \intertext first) renders nothing.
    parts: parts.filter((p) => p.kind === "text" || p.rows.length > 1 || src.slice(p.from, p.to).replace(/%[^\n]*/g, "").trim()),
    labels,
  };
}

/** A tag's text for MathJax's text mode (no text command for `\`, `^`, `~`: look-alikes). */
const tagArgument = (text: string): string =>
  text.replace(/[\\{}$&#%_^~]/g, (c) => (c === "\\" ? "∖" : c === "^" ? "ˆ" : c === "~" ? "˜" : `\\${c}`));

/** The TeX of one math part of a display, each row `tag` names a number for ending in `\tag{number}`. */
export function displayTex(
  src: string,
  layout: DisplayLayout,
  part: DisplayPart & { kind: "math" },
  tag: (row: DisplayRow) => string | null = () => null,
): string {
  let out = layout.open;
  let last = part.from;
  let start = part.from;
  for (const row of part.rows) {
    const number = tag(row);
    // An empty row (after a trailing `\\`) keeps its number in MathJax only with something in it.
    const empty = !src.slice(start, row.at).replace(/^\\\\\*?(?:\s*\[[^\]]*\])?/, "").replace(/%[^\n]*/g, "").trim();
    start = row.at;
    if (number === null) continue;
    out += `${src.slice(last, row.at)}${empty ? "{}" : ""}\\tag{${tagArgument(number)}}`;
    last = row.at;
  }
  return out + src.slice(last, part.to) + layout.close;
}

/** The math environment a display's source is, or null (the inside of `\[..\]` or `$$..$$`). */
export function displayEnv(src: string): string | null {
  const env = /^\s*\\begin\s*\{([^{}]*)\}/.exec(src)?.[1];
  return env && MATH_ENVS.has(env) ? env : null;
}

/**
 * Where TeX puts equation numbers: left with `leqno` (a class option, or amsmath's or mathtools'
 * package option) in the comment-free `sources`, and the AMS classes' default. This is only
 * the planning hint: the probe's actual engine state is authoritative after it runs.
 */
export function tagSide(sources: readonly string[]): "left" | "right" {
  const has = (option: string) => {
    const patterns = [
      new RegExp(String.raw`\\documentclass\s*\[[^\]]*\b${option}\b`),
      new RegExp(String.raw`\\(?:usepackage|RequirePackage)\s*\[[^\]]*\b${option}\b[^\]]*\]\s*\{[^}]*\b(?:amsmath|mathtools)\b`),
      new RegExp(String.raw`\\PassOptionsToPackage\s*\{[^}]*\b${option}\b[^}]*\}\s*\{[^}]*\b(?:amsmath|mathtools)\b`),
    ];
    return sources.some((src) => patterns.some((re) => re.test(src)));
  };
  if (has("reqno")) return "right";
  if (has("leqno")) return "left";
  return sources.some((src) => /\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*ams(?:art|book|proc)\s*\}/.test(src)) ? "left" : "right";
}

/** MathJax's CHTML output jax, as far as the export uses it. */
interface ChtmlOutput {
  /** The MathDocument of its last render (CommonOutputJax.setDocument). */
  document?: unknown;
  styleSheet(html: unknown): { textContent: string | null };
}

const NO_LABELS: ReadonlyMap<string, string> = new Map();

/** The page's stylesheet for its math: rules, the woff files embedded, and the files it could not get. */
export interface MathStyles {
  css: string;
  /** Bytes of the embedded woff files. */
  fontBytes: number;
  missing: string[];
}

export class ExportMath {
  /** Display flag + source -> the CHTML markup or MathJax's error. */
  private cache = new Map<string, string | MathError>();

  private constructor(
    private readonly env: MathEnv,
    private readonly math: ProjectMath,
    private readonly output: ChtmlOutput,
    private readonly refs: ((command: string, keys: readonly string[]) => string) | undefined,
  ) {}

  /**
   * An export's math: `input` the project's definitions, `refs` the reference texts formulas show
   * (latexRefs' formulaRefs), `tagSide` "left" for TeX's leqno. Throws when MathJax's internals
   * are missing (a MathJax other than 3.2).
   */
  static create(
    env: MathEnv,
    input: ProjectMathInput,
    o: { refs?: (command: string, keys: readonly string[]) => string; tagSide?: "left" | "right" } = {},
  ): ExportMath {
    const x = env.mj._ as { output?: { chtml_ts?: { CHTML?: new (options: object) => ChtmlOutput } } } | undefined;
    const Chtml = x?.output?.chtml_ts?.CHTML;
    if (typeof Chtml !== "function") throw new Error("MathJax's CHTML output was not found (MathJax 3.2 expected).");
    const shared = env.mj.startup?.output as { font?: { options?: { fontURL?: string } } } | undefined;
    const output = new Chtml({ fontURL: shared?.font?.options?.fontURL ?? "", adaptiveCSS: true });
    const math = ProjectMath.create(env.mj, env.document, input, { output, tagSide: o.tagSide });
    if (!math.isolated) throw new Error("MathJax's internals were not found (MathJax 3.2 expected).");
    return new ExportMath(env, math, output, o.refs);
  }

  /** Definition statements MathJax rejected, with its message. */
  get failed(): readonly { statement: string; message: string }[] {
    return this.math.failed;
  }

  /** `tex` as CHTML markup: labels dropped, references as their texts; throws MathError. */
  render(tex: string, display: boolean): string {
    const key = `${display ? "D" : "I"}${tex}`;
    let hit = this.cache.get(key);
    if (hit === undefined) {
      try {
        hit = this.math.render(tex, display, NO_LABELS, this.refs).outerHTML;
      } catch (e) {
        hit = e instanceof MathError ? e : new MathError(e instanceof Error ? e.message : String(e));
      }
      this.cache.set(key, hit);
    }
    if (hit instanceof MathError) throw hit;
    return hit;
  }

  /**
   * The plan's check (design 3.3): MathJax renders the formula, every math part of a display
   * (without the tags the emitter adds). Renders are cached, so an inline formula renders once.
   */
  ok(src: string, display: boolean): boolean {
    try {
      if (!display) this.render(src, false);
      else {
        const layout = displayLayout(src, displayEnv(src));
        for (const p of layout.parts) if (p.kind === "math") this.render(displayTex(src, layout, p), true);
      }
      return true;
    } catch (e) {
      if (e instanceof MathError) return false;
      throw e;
    }
  }

  /** The stylesheet the math in `html` needs (see the file comment); "" without math. */
  async stylesheet(html: string, signal?: AbortSignal): Promise<MathStyles> {
    const check = () => { if (signal?.aborted) throw abortError("The export was cancelled."); };
    check();
    if (!html.includes("<mjx-container")) return { css: "", fontBytes: 0, missing: [] };
    const sheet = this.output.styleSheet(this.output.document);
    const { css, fonts } = pageMathCss(sheet.textContent ?? "", html);
    let fontBytes = 0;
    const missing: string[] = [];
    const data = new Map<string, string>();
    for (const file of new Set(fonts.values())) {
      check();
      try {
        const reading = this.env.font(file, signal);
        let cancel: (() => void) | undefined;
        let bytes: Uint8Array;
        try {
          bytes = signal ? await Promise.race([
            reading,
            new Promise<never>((_, reject) => {
              cancel = () => reject(abortError("The export was cancelled."));
              signal.addEventListener("abort", cancel, { once: true });
              if (signal.aborted) cancel();
            }),
          ]) : await reading;
        } finally { if (cancel) signal?.removeEventListener("abort", cancel); }
        check();
        fontBytes += bytes.byteLength;
        data.set(file, `data:font/woff;base64,${Buffer.from(bytes).toString("base64")}`);
      } catch (e) {
        if (isAbortError(e)) throw e;
        check();
        missing.push(file);
      }
    }
    // A face whose file could not be read goes: the text falls back to the reader's fonts.
    const out = css.replace(/@font-face[^{]*\{[^{}]*url\("?[^")]*?([\w-]+\.woff)"?\)[^{}]*\}\s*/g, (rule, file: string) => {
      const uri = data.get(file);
      return uri ? rule.replace(/url\("?[^")]*"?\)/, `url("${uri}")`) : "";
    });
    return { css: out, fontBytes, missing };
  }
}

/** A flat stylesheet's rules (MathJax's nests none); braces inside strings (the `{` glyph's content) stay. */
function cssRules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  let start = 0;
  let open = -1;
  let quote = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{" && open < 0) open = i;
    else if (c === "}" && open >= 0) {
      out.push({ selector: css.slice(start, open).trim(), body: css.slice(open + 1, i) });
      start = i + 1;
      open = -1;
    }
  }
  return out;
}

/**
 * MathJax's stylesheet reduced to what `html` uses: glyph rules (`mjx-c.mjx-c1D465.TEX-I::before`)
 * of the characters it shows, family classes (`.TEX-I`, `.MJX-TEX`) it uses, the stretchy
 * delimiters' families when it has one, the @font-face rules of those families (and of families
 * inline styles name, `MJXZERO`); every other rule stays. `fonts` maps each kept family to its file.
 */
export function pageMathCss(css: string, html: string): { css: string; fonts: Map<string, string> } {
  const classes = new Set<string>();
  const glyphs = new Set<string>();
  for (const m of html.matchAll(/<mjx-([a-z-]+)[^>]*?\sclass="([^"]*)"/g)) {
    const list = m[2].split(/\s+/).filter(Boolean);
    for (const c of list) classes.add(c);
    if (m[1] === "c") glyphs.add([...list].sort().join(" "));
  }
  const families = new Set<string>();
  for (const m of html.matchAll(/font-family:\s*([^;"]+)/g)) for (const f of m[1].split(",")) families.add(f.trim());
  const stretchy = /<mjx-stretchy-[hv]/.test(html);
  const kept: string[] = [];
  const faces: { family: string; file: string; rule: string }[] = [];
  const familiesOf = (body: string) => /font-family:\s*([^;]+)/.exec(body)?.[1].replace(/!\s*important/, "").split(",").map((f) => f.trim()) ?? [];
  for (const { selector, body } of cssRules(css)) {
    const rule = `${selector} { ${body.trim().replace(/\s*\n\s*/g, " ")} }`;
    if (selector.startsWith("@font-face")) {
      const family = /font-family:\s*([^;]+);/.exec(body)?.[1].trim();
      const file = /url\("?[^")]*?([\w-]+\.woff)"?\)/.exec(body)?.[1];
      if (family && file) faces.push({ family, file, rule });
      continue;
    }
    const glyph = /^mjx-c((?:\.[\w-]+)+)::before$/.exec(selector);
    if (glyph) {
      if (glyphs.has(glyph[1].slice(1).split(".").sort().join(" "))) kept.push(rule);
      continue;
    }
    const family = /^\.((?:TEX|MJX)-[\w-]+)$/.exec(selector);
    if (family) {
      if (!classes.has(family[1])) continue;
      for (const f of familiesOf(body)) families.add(f);
      kept.push(rule);
      continue;
    }
    if (/mjx-stretchy/.test(selector) && /font-family/.test(body)) {
      if (!stretchy) continue;
      for (const f of familiesOf(body)) families.add(f);
    }
    kept.push(rule);
  }
  const fonts = new Map<string, string>();
  for (const f of faces) {
    if (!families.has(f.family)) continue;
    fonts.set(f.family, f.file);
    kept.push(f.rule);
  }
  return { css: kept.join("\n"), fonts };
}
