// A project's math renderer: a private MathJax TeX input jax and MathDocument built from the
// classes inside Obsidian's own MathJax bundle (MathJax._, 3.2.2), sharing Obsidian's CHTML
// output jax (design 4.1). Pure: no Obsidian import, so tests run it on the same bundle.
//   Why private  definitions fed to the global MathJax (tex2chtml) stay defined in every
//                Markdown note and cannot be removed; noerrors/noundefined hide failures as
//                red text; a \label rendered twice errors. Here failures throw (MathError),
//                macros stay per project, and tex.reset() before each render clears labels.
//   Feeding      one statement per convert, each in its own try: with a throwing
//                formatError, one bad statement in a block would drop the rest.
//   Lifetime     MathJax 3.2.2's tagformat and mathtools register a tags class per TeX input
//                (`configTags-N`, `MathtoolsTags-N`, closing over it) in the global
//                TagsFactory, which never removes one: each input built would stay alive
//                (about 70 KB). The input makes its tags object while it is built, so those
//                names are pointed at the no-tags class right after (`buildTex`). Labels are
//                a render argument, so a compile that renumbers them builds nothing.
//                textmacros parses text-mode arguments (\text, \mbox, \tag's number) with
//                parse options of its own that MathJax never clears: each such render would
//                keep that formula's MathML alive (about 17 KB). They are cleared after every
//                convert.
//   Renders      side-effect free: a definition inside a formula (`\def\x{..} \x`) applies to
//                that formula only (the definition tables are restored after it).
//   Glyph CSS    shared output jax: MathJax's stylesheet gets these renders' glyphs
//                (texRender installs it).
//   Fallback     without the internals (a MathJax upgrade), Obsidian's public tex2chtml
//                renders without project macros (`isolated` false, one console warning).
//                Definitions are never fed to the global instance.

/** The parts of Obsidian's `window.MathJax` used here. */
export interface MathJaxLike {
  tex2chtml(src: string, options?: { display?: boolean }): HTMLElement;
  chtmlStylesheet?(): HTMLStyleElement;
  config?: { tex?: { packages?: unknown }; options?: Record<string, unknown> };
  startup?: { output?: unknown; promise?: Promise<unknown> };
  /** MathJax's internal classes (the combined components expose them). */
  _?: unknown;
}

export interface ProjectMathInput {
  /** Normalized definition statements in document order (tex/macros definitionStatements). */
  statements: readonly string[];
  /** The project loads the physics package (MathJax's physics changes \div: only on request). */
  physics: boolean;
  /**
   * Macros whose last definition MathJax cannot read (tex/macros `Definitions.unsupported`):
   * name -> that definition. Formulas using one fail instead of drawing MathJax's own macro of
   * the same name (braket's \set).
   */
  unsupported?: ReadonlyMap<string, string>;
}

/** A formula MathJax could not render: its message ("Undefined control sequence \foo"). */
export class MathError extends Error {}

/** TeX input macros for common packages MathJax lacks. */
export const SHIMS: Record<string, string | [string, number]> = {
  bm: ["\\boldsymbol{#1}", 1],
  ensuremath: ["#1", 1],
  mathbbm: ["\\mathbb{#1}", 1],
  SI: ["#1\\,\\mathrm{#2}", 2],
  si: ["\\mathrm{#1}", 1],
  num: ["#1", 1],
};

interface TexJax {
  reset(): void;
  parseOptions?: {
    handlers?: { retrieve?(name: string): { map?: unknown } | null };
    packageData?: { get(name: string): unknown };
  };
}

interface TagsFactory {
  add(name: string, cls: unknown): void;
  create(name: string): object;
}

interface MathDoc {
  convert(math: string, options: { display: boolean; end?: number }): Element;
}

interface Internals {
  input: { tex_ts: { TeX: new (options: object) => TexJax }; tex?: { Tags?: { TagsFactory?: TagsFactory } } };
  mathjax: { mathjax: { document(doc: Document, options: object): MathDoc } };
  core?: { MathItem?: { STATE?: { COMPILED?: number } } };
}

/** The internals needed for a private instance, or null. */
function internals(mj: MathJaxLike): Internals | null {
  const x = mj._ as Partial<Internals> | undefined;
  return typeof x?.input?.tex_ts?.TeX === "function" &&
    typeof x.mathjax?.mathjax?.document === "function" &&
    mj.startup?.output &&
    Array.isArray(mj.config?.tex?.packages)
    ? (x as Internals)
    : null;
}

let warned = false;

/** FNV-1a over the input: equal inputs render identically (for equal labels). */
export function inputEpoch(input: ProjectMathInput): number {
  const text = JSON.stringify([input.statements, input.physics, [...(input.unsupported ?? [])]]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String(e.message) : String(e);
}

/** A pattern for the control sequence `name` (a control word ends before a letter). */
const csPattern = (name: string): string =>
  /^[A-Za-z]+$/.test(name) ? `${name}(?![A-Za-z])` : name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** MathJax's per-input tags classes (see Lifetime). */
const INPUT_TAGS = /^(?:configTags|MathtoolsTags)-\d+$/;

/** A TeX input whose tags classes are released from MathJax's global TagsFactory (see Lifetime). */
function buildTex(x: Internals, options: object): TexJax {
  const factory = x.input.tex?.Tags?.TagsFactory;
  const add = factory?.add;
  if (!factory || typeof add !== "function" || typeof factory.create !== "function") return new x.input.tex_ts.TeX(options);
  const added: string[] = [];
  factory.add = (name, cls) => {
    if (INPUT_TAGS.test(name)) added.push(name);
    add(name, cls);
  };
  let tex: TexJax;
  try {
    tex = new x.input.tex_ts.TeX(options);
  } finally {
    factory.add = add;
  }
  const none = factory.create("none").constructor;
  for (const name of added) add(name, none);
  return tex;
}

type Table = Map<unknown, unknown>;

/** textmacros' parse options (see Lifetime), or null. */
function textOptions(tex: TexJax): { clear(): void } | null {
  const text = tex.parseOptions?.packageData?.get("textmacros") as { parseOptions?: { clear?: unknown } } | undefined;
  return typeof text?.parseOptions?.clear === "function" ? (text.parseOptions as { clear(): void }) : null;
}

/** The tables a definition writes to: \newcommand, \def, \let, \newenvironment, \definecolor. */
function definitionTables(tex: TexJax): Table[] {
  const o = tex.parseOptions;
  const color = o?.packageData?.get("color") as { model?: { userColors?: unknown } } | undefined;
  return [
    ...["new-Command", "new-Environment", "new-Delimiter"].map((name) => o?.handlers?.retrieve?.(name)?.map),
    color?.model?.userColors,
  ].filter((t): t is Table => Object.prototype.toString.call(t) === "[object Map]"); // MathJax's realm may differ
}

export class ProjectMath {
  /** Hash of the input: renders of equal epochs are interchangeable. */
  readonly epoch: number;

  /** Uses of the unsupported macros (`\set`), or null. */
  private readonly blocked: RegExp | null;

  private constructor(
    private readonly mj: MathJaxLike,
    private readonly jax: { tex: TexJax; doc: MathDoc; tables: Table[]; text: { clear(): void } | null } | null,
    private readonly unsupported: ReadonlyMap<string, string>,
    epoch: number,
    /** Statements MathJax rejected (and definitions it cannot read), with the message. */
    readonly failed: readonly { statement: string; message: string }[],
  ) {
    this.epoch = epoch;
    this.blocked = unsupported.size ? new RegExp(`\\\\(${[...unsupported.keys()].map(csPattern).join("|")})`) : null;
  }

  /** false: the public tex2chtml fallback, without project macros. */
  get isolated(): boolean {
    return this.jax !== null;
  }

  /** A renderer for `input`, creating nodes in `doc` (the window Obsidian's MathJax runs in). */
  static create(mj: MathJaxLike, doc: Document, input: ProjectMathInput): ProjectMath {
    const epoch = inputEpoch(input);
    const unsupported = input.unsupported ?? new Map<string, string>();
    const failed = [...unsupported.values()].map((statement) => ({ statement, message: "No MathJax equivalent" }));
    const x = internals(mj);
    if (!x) {
      if (!warned) console.warn("LaTeX Live: MathJax internals not found; formulas render without project macros.");
      warned = true;
      return new ProjectMath(mj, null, unsupported, epoch, failed);
    }
    const packages = (mj.config!.tex!.packages as string[])
      .filter((p) => p !== "noerrors" && p !== "noundefined")
      .concat(input.physics ? ["physics"] : []);
    const tex = buildTex(x, {
      packages,
      formatError: (_jax: unknown, err: unknown) => {
        throw err;
      },
      macros: SHIMS,
    });
    // Obsidian's document options: no menu, no assistive MathML, its safe protocols.
    const mdoc = x.mathjax.mathjax.document(doc, { ...mj.config?.options, InputJax: tex, OutputJax: mj.startup!.output });
    // Definitions need the parse only, not the CHTML output.
    const compiled = x.core?.MathItem?.STATE?.COMPILED;
    const text = textOptions(tex);
    for (const statement of input.statements) {
      try {
        tex.reset();
        mdoc.convert(statement, compiled === undefined ? { display: false } : { display: false, end: compiled });
      } catch (e) {
        failed.push({ statement, message: messageOf(e) });
      }
    }
    text?.clear();
    return new ProjectMath(mj, { tex, doc: mdoc, tables: definitionTables(tex), text }, unsupported, epoch, failed);
  }

  /**
   * The CHTML rendering of `src` (an `mjx-container`), its labels numbered from `labels` (label
   * key -> number text from the last compile's .aux files) and its references read by `refs`
   * (see prepareMath); throws MathError.
   */
  render(
    src: string,
    display: boolean,
    labels: ReadonlyMap<string, string> = NO_LABELS,
    refs?: (command: string, keys: readonly string[]) => string,
  ): Element {
    const name = this.blocked?.exec(src)?.[1];
    if (name) throw new MathError(`MathJax cannot read the project's \\${name}: ${this.unsupported.get(name)}`);
    const tex = prepareMath(src, labels, display, refs);
    if (!this.jax) {
      // Obsidian's instance would keep it for every Markdown note.
      if (DEFINES.test(tex)) throw new MathError("A definition inside a formula needs MathJax's internals");
      const node = this.mj.tex2chtml(tex, { display });
      const err = node.querySelector("[data-mjx-error]");
      if (err) throw new MathError(err.getAttribute("data-mjx-error") || "MathJax error");
      return node;
    }
    const { tex: input, doc, tables, text } = this.jax;
    const saved = tables.map((t) => new Map(t));
    input.reset();
    try {
      return doc.convert(tex, { display });
    } catch (e) {
      throw new MathError(messageOf(e));
    } finally {
      text?.clear();
      tables.forEach((t, i) => {
        const before = saved[i];
        if (t.size === before.size && [...t].every(([k, v]) => before.get(k) === v)) return;
        t.clear();
        for (const [k, v] of before) t.set(k, v);
      });
    }
  }
}

const NO_LABELS: ReadonlyMap<string, string> = new Map();

/** A definition command (tex/macros STATEMENT_KINDS and their relatives). */
const DEFINES = /\\(?:(?:re|provide)?newcommand|[egx]?def|let|Declare[A-Za-z]*|(?:New|Renew|Provide)DocumentCommand|(?:re)?newenvironment|definecolor)(?![A-Za-z])/;

/** Environments LaTeX numbers; starred ones, `\[ \]`, `$$` and `displaymath` print no number. */
const NUMBERED = /^\s*\\begin\s*\{(equation|align|alignat|flalign|gather|multline|eqnarray)\}/;

/** What rows are made of: environments, labels, a row's own number, commands, comments, groups. */
const ROW_TOKEN = /\\(begin|end)\s*\{[^{}]*\}|\\label\s*\{([^{}]*)\}|\\(?:tag|notag|nonumber)(?![A-Za-z])|\\[A-Za-z]+|\\[^A-Za-z]|%[^\n]*|[{}]/g;

/**
 * Formula source for MathJax. In a numbered environment (`\begin{equation}`, `align`, ...,
 * unstarred) a row's first `\label{k}` that the last compile numbered becomes `\tag{n}` at the
 * row's end, unless the row has its own \tag, \notag or \nonumber; `equation` and `multline`
 * are one row. Every other `\label` is dropped: inline math, `\[ \]`, `$$` and starred
 * environments print no number (LaTeX still writes their labels to the .aux). Rows end at the
 * outer environment's own `\\`, never inside a group or an inner environment, where MathJax
 * forbids \tag (`split`, `aligned`, `gathered`). `\ref{k}` / `\eqref{k}` become the number as
 * text (`??` when unknown) through \textup, which also works in text-mode arguments
 * (`\text{by \eqref{k}}`, `\tag{..}`); with `refs` (latexRefs' `formulaRefs`), every reference
 * command (\ref, \eqref, \pageref, \autoref, \cref, \Cref, \nameref, starred too) becomes the
 * text it returns. MathJax's tags are off, so rows without a label show no number.
 */
export function prepareMath(
  src: string,
  labels: ReadonlyMap<string, string>,
  display = true,
  refs?: (command: string, keys: readonly string[]) => string,
): string {
  const outer = display ? NUMBERED.exec(src)?.[1] : undefined;
  const rows = outer !== undefined && outer !== "equation" && outer !== "multline";
  let out = "";
  let last = 0;
  let depth = 0; // groups and environments: the outer environment's rows are at depth 1
  let tag: string | undefined;
  let own = false;
  const endRow = () => {
    if (tag && !own) out += `\\tag{${tag}}`;
    tag = undefined;
    own = false;
  };
  for (const m of src.matchAll(ROW_TOKEN)) {
    out += src.slice(last, m.index);
    last = m.index + m[0].length;
    const t = m[0];
    if (m[2] !== undefined) {
      if (outer) tag ??= labels.get(m[2].trim());
      continue;
    }
    if (t === "{" || m[1] === "begin") depth++;
    else if (t === "}" || m[1] === "end") {
      if (--depth === 0 && outer) endRow();
    } else if (t === "\\\\") {
      if (depth === 1 && rows) endRow();
    } else if (/^\\(?:tag|notag|nonumber)$/.test(t)) own = true;
    out += t;
  }
  const tex = out + src.slice(last);
  if (refs) {
    return tex.replace(REF_COMMAND, (_m, cmd: string, keys: string) =>
      `\\textup{${textArgument(refs(cmd, keys.split(",").map((k) => k.trim()).filter(Boolean)))}}`,
    );
  }
  return tex.replace(/\\(eqref|ref)\s*\{([^{}]*)\}/g, (_m, cmd: string, key: string) => {
    const n = labels.get(key.trim()) ?? "??";
    return cmd === "eqref" ? `\\textup{(${n})}` : `\\textup{${n}}`;
  });
}

const REF_COMMAND = /\\(eqref|ref|pageref|autoref|cref|Cref|nameref)\*?\s*\{([^{}]*)\}/g;

/**
 * Plain text as a text-mode argument: MathJax's text mode reads `\_`, `\{`, `\}`, `\%`, `\$`,
 * `\&`, `\#`, but has no text command for `\`, `^` or `~`: those become look-alikes.
 */
const textArgument = (text: string): string =>
  text.replace(/[\\{}$&#%_^~]/g, (c) => (c === "\\" ? "∖" : c === "^" ? "ˆ" : c === "~" ? "˜" : `\\${c}`));
