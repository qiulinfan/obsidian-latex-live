// Environment and command rules for the live editor (docs/live-rules.md): which environments
// render as formulas, which only collapse their \begin/\end lines (wrappers), and which commands
// hide until the cursor touches them. Pure: no Obsidian, no CodeMirror.
//   Sources   user settings > detection from the project's preamble > the built-in defaults.
//             A template visualization profile that names an environment wins over all three
//             (TexRender drops it from the rules). The rules affect the live editor only: the
//             PDF, references and HTML export keep native TeX authority.
//   Detection a \newenvironment / \NewDocumentEnvironment whose begin code is exactly
//             `\begin{E}` and end code `\end{E}` for a built-in formula environment E is an
//             alias of E; one whose code is only wrapper environments and layout commands is a
//             wrapper; a \newcommand whose body is only layout commands and uses every
//             argument is hidden, unless the sources assign the name while typesetting
//             (runtimeAssigned). Anything else is not guessed.

/** How many arguments a hidden command takes: `optional` when the first is `[..]`. */
export interface Arity {
  readonly args: number;
  readonly optional: boolean;
}

export interface EnvRules {
  /** Formula environments -> the environment MathJax reads (itself for the built-in ones). */
  readonly math: ReadonlyMap<string, string>;
  /** Environments whose \begin and \end lines (with their arguments) collapse; the content renders as usual. */
  readonly wrappers: ReadonlySet<string>;
  /** Commands (no backslash) hidden with their arguments; null arity: the `[..]`/`{..}` right after it. */
  readonly hidden: ReadonlyMap<string, Arity | null>;
}

/** What the user saves (settings.envRules): only additions to the defaults, and names kept as source. */
export interface UserEnvRules {
  /** Environment -> a built-in formula environment, or "source" to keep any environment's markup. */
  formulas: Record<string, string>;
  /** Wrapper environments; `!name` keeps that environment as source. */
  wrappers: string[];
  /** Hidden commands without the backslash; `!name` keeps that command visible. */
  hidden: string[];
}

export const EMPTY_USER_RULES: UserEnvRules = { formulas: {}, wrappers: [], hidden: [] };

/** latexHighlight's MATH_ENVS (kept in sync by a test; this module imports no editor code). */
const BASE_MATH = [
  "equation", "equation*", "align", "align*", "gather", "gather*",
  "multline", "multline*", "flalign", "flalign*", "alignat", "alignat*",
  "eqnarray", "eqnarray*", "displaymath", "math",
];
/**
 * amsmath's alignment forms MathJax reads that MATH_ENVS lacks. mathtools' own environments
 * (dcases, multlined, matrix*, ...) go inside a formula, where MathJax already reads them.
 */
const EXTRA_MATH = ["xalignat", "xalignat*", "xxalignat"];
export const DEFAULT_MATH_ENVS: readonly string[] = [...BASE_MATH, ...EXTRA_MATH];

export const DEFAULT_WRAPPERS: readonly string[] = [
  "itemize", "enumerate", "description", "problemset", "center",
  "figure", "figure*", "table", "table*",
  "subequations", "minipage", "flushleft", "flushright",
];

/** The built-in hidden commands and their arities. */
export const DEFAULT_HIDDEN: ReadonlyMap<string, Arity> = new Map([
  ...["centering", "raggedright", "raggedleft", "vfill", "hfill", "medskip", "smallskip", "bigskip", "noindent", "par", "newpage", "clearpage"]
    .map((n): [string, Arity] => [n, { args: 0, optional: false }]),
  ...["vspace", "hspace"].map((n): [string, Arity] => [n, { args: 1, optional: false }]),
]);

/** Commands a layout-only body may also use: they typeset nothing. */
const NEUTRAL = new Set(["relax", "ignorespaces", "ignorespacesafterend", "unskip"]);

export const DEFAULT_RULES: EnvRules = Object.freeze({
  math: new Map(DEFAULT_MATH_ENVS.map((e) => [e, e])),
  wrappers: new Set(DEFAULT_WRAPPERS),
  hidden: new Map<string, Arity | null>(DEFAULT_HIDDEN),
});

const ENV_NAME = /^[^\s{}\\%#!]{1,120}$/;
const COMMAND_NAME = /^[A-Za-z@]{1,120}$/;

/** Validate a user's rules (the settings modal, and settings read from disk); throws a readable message. */
export function parseUserRules(value: unknown): UserEnvRules {
  if (value === undefined || value === null) return { formulas: {}, wrappers: [], hidden: [] };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Rules must be an object.");
  const v = value as Record<string, unknown>;
  const formulas = parseFormulaRules(v.formulas ?? {});
  const wrappers = parseNameList(v.wrappers ?? [], "environment");
  const hidden = parseNameList(v.hidden ?? [], "command");
  for (const w of wrappers) {
    if (!w.startsWith("!") && Object.hasOwn(formulas, w) && formulas[w] !== "source") {
      throw new Error(`${w} cannot be both a formula alias and a wrapper: its content has no $, so a collapsed shell would show it as plain text.`);
    }
  }
  return { formulas, wrappers, hidden };
}

/** `{ "myeq": "equation", "align": "source" }`. */
export function parseFormulaRules(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error('Use an object such as { "myeq": "equation" }.');
  const out: Record<string, string> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 200) throw new Error("Use at most 200 formula rules.");
  for (const [name, target] of entries) {
    if (!ENV_NAME.test(name)) throw new Error(`"${name}": use a literal environment name without \\, braces, spaces or !.`);
    if (typeof target !== "string") throw new Error(`${name}: the target must be a string.`);
    if (target !== "source" && !DEFAULT_RULES.math.has(target)) {
      throw new Error(`${name}: "${target}" is not a known formula environment (${DEFAULT_MATH_ENVS.join(", ")}), or "source".`);
    }
    out[name] = target;
  }
  return out;
}

/** `["subequations", "!center"]` or `["centering", "DeckLayout"]`. */
export function parseNameList(value: unknown, kind: "environment" | "command"): string[] {
  if (!Array.isArray(value)) throw new Error(kind === "environment" ? 'Use an array such as ["subequations"].' : 'Use an array such as ["centering", "DeckLayout"].');
  if (value.length > 200) throw new Error(`Use at most 200 ${kind} names.`);
  const seen = new Set<string>();
  return value.map((raw) => {
    if (typeof raw !== "string") throw new Error(`Each ${kind} name must be a string.`);
    const name = raw.startsWith("!") ? raw.slice(1) : raw;
    if (kind === "command" && name.startsWith("\\")) throw new Error(`"${raw}": write the command without its backslash.`);
    if (!(kind === "command" ? COMMAND_NAME : ENV_NAME).test(name)) {
      throw new Error(`"${raw}": use a literal ${kind} name without \\, braces or spaces${kind === "command" ? " (letters and @ only)" : ""}.`);
    }
    if (seen.has(name)) throw new Error(`"${name}" is listed twice.`);
    seen.add(name);
    return raw;
  });
}

/** What detection found in a project's sources (see Detection). */
export interface DetectedRules {
  readonly math: ReadonlyMap<string, string>;
  readonly wrappers: ReadonlySet<string>;
  readonly hidden: ReadonlyMap<string, Arity>;
}

export const NO_DETECTED: DetectedRules = { math: new Map(), wrappers: new Set(), hidden: new Map() };

/** Index after blanks and line breaks from s[i]. */
const skipSpace = (s: string, i: number): number => {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};

/** The balanced group opening at s[i] (`{` or `[`): its content and the index after it, or null. */
function group(s: string, i: number): { text: string; end: number } | null {
  const open = s[i];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  for (let j = i + 1, depth = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "{") depth++;
    else if (c === "}" && depth > 0) depth--;
    else if (c === close && depth === 0) return { text: s.slice(i + 1, j), end: j + 1 };
    else if (c === "}" && close === "]") return null;
  }
  return null;
}

/**
 * Whether `code` typesets nothing but wrapper environments and layout commands (`hidden`'s
 * arities consumed; `#n` only inside their arguments).
 */
export function onlyLayout(code: string, wrappers: ReadonlySet<string>, hidden: ReadonlyMap<string, Arity | null>): boolean {
  const re = /\\([A-Za-z@]+\*?)|(\S)/y;
  for (let i = skipSpace(code, 0); i < code.length; i = skipSpace(code, i)) {
    re.lastIndex = i;
    const m = re.exec(code);
    if (!m || m[2] !== undefined) return false;
    const name = m[1];
    const base = name.endsWith("*") ? name.slice(0, -1) : name;
    i = re.lastIndex;
    if (base === "begin" || base === "end") {
      const env = group(code, skipSpace(code, i));
      if (!env || !wrappers.has(env.text.trim())) return false;
      i = env.end;
      if (base === "begin") for (let g; (g = group(code, skipSpace(code, i))); ) i = g.end;
    } else if (NEUTRAL.has(name)) {
      continue;
    } else if (hidden.has(base)) {
      const arity = hidden.get(base) ?? null;
      const end = commandEnd(code, i, arity, true);
      if (end < 0) return false;
      i = end;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * The index after a hidden command's arguments from s[i] (just after its name): `arity`'s
 * optional and mandatory groups, or with no arity the groups right after it. -1 when a
 * mandatory argument is missing. `spaces`: arguments may follow blanks and line breaks.
 */
export function commandEnd(s: string, i: number, arity: Arity | null, spaces = false, argEnd: (s: string, i: number) => number = (t, k) => group(t, k)?.end ?? -1): number {
  const skip = (k: number) => (spaces ? skipSpace(s, k) : skipBlanks(s, k));
  if (!arity) {
    while (s[i] === "{" || s[i] === "[") {
      const e = argEnd(s, i);
      if (e < 0) break;
      i = e;
    }
    return i;
  }
  let k = skip(i);
  if (arity.optional && s[k] === "[") {
    const e = argEnd(s, k);
    if (e < 0) return -1;
    i = e;
    k = skip(e);
  }
  for (let n = arity.optional ? 1 : 0; n < arity.args; n++) {
    if (s[k] !== "{") return -1;
    const e = argEnd(s, k);
    if (e < 0) return -1;
    i = e;
    k = skip(e);
  }
  return i;
}

const skipBlanks = (s: string, i: number): number => {
  while (s[i] === " " || s[i] === "\t") i++;
  return i;
};

const ENV_DEFINER = /\\(?:(?:re)?newenvironment\*?|(New|Renew|Provide|Declare)DocumentEnvironment)\s*\{\s*([^{}\s]+)\s*\}/g;
const COMMAND_DEFINER = /\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand)\*?\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))/g;

/**
 * Rules the project's sources imply (see Detection), in source order (a later definition
 * wins). `sources` have their comments stripped.
 */
export function detectEnvRules(sources: readonly string[]): DetectedRules {
  const math = new Map<string, string>();
  const wrappers = new Set<string>();
  const hidden = new Map<string, Arity>();
  const commands = new Map<string, { arity: Arity; body: string }>();
  const layoutWrappers = DEFAULT_RULES.wrappers;
  const layoutHidden = DEFAULT_RULES.hidden;
  const forget = (name: string) => {
    math.delete(name);
    wrappers.delete(name);
  };
  for (const s of sources) {
    for (const m of s.matchAll(ENV_DEFINER)) {
      const name = m[2];
      let i = skipSpace(s, (m.index ?? 0) + m[0].length);
      if (m[1]) {
        const spec = group(s, i); // xparse's argument spec
        if (!spec || s[i] !== "{") continue;
        i = skipSpace(s, spec.end);
      } else {
        for (let k = 0; k < 2 && s[i] === "["; k++) {
          const g = group(s, i);
          if (!g) break;
          i = skipSpace(s, g.end);
        }
      }
      const begin = s[i] === "{" ? group(s, i) : null;
      const j = begin ? skipSpace(s, begin.end) : -1;
      const end = begin && s[j] === "{" ? group(s, j) : null;
      if (!begin || !end) continue;
      forget(name);
      const opens = /^\s*\\begin\s*\{\s*([^{}\s]+)\s*\}\s*$/.exec(begin.text);
      const closes = /^\s*\\end\s*\{\s*([^{}\s]+)\s*\}\s*$/.exec(end.text);
      if (opens && closes && opens[1] === closes[1] && DEFAULT_RULES.math.has(opens[1])) {
        math.set(name, DEFAULT_RULES.math.get(opens[1])!);
      } else if (onlyLayout(begin.text, layoutWrappers, layoutHidden) && onlyLayout(end.text, layoutWrappers, layoutHidden)) {
        wrappers.add(name);
      }
    }
    for (const m of s.matchAll(COMMAND_DEFINER)) {
      const name = m[1] ?? m[2];
      let i = skipSpace(s, (m.index ?? 0) + m[0].length);
      let args = 0;
      let optional = false;
      const n = /^\[\s*(\d)\s*\]/.exec(s.slice(i, i + 8));
      if (n) {
        args = Number(n[1]);
        i = skipSpace(s, i + n[0].length);
        if (s[i] === "[") {
          const g = group(s, i);
          if (!g) continue;
          optional = args > 0;
          i = skipSpace(s, g.end);
        }
      }
      const body = s[i] === "{" ? group(s, i) : null;
      if (!body) continue;
      hidden.delete(name);
      commands.set(name, { arity: { args, optional }, body: body.text });
      // An argument the body never uses is typed text that would vanish with the command.
      const usesAll = Array.from({ length: args }, (_, k) => new RegExp(`#${k + 1}(?!\\d)`)).every((re) => re.test(body.text));
      if (usesAll && onlyLayout(body.text, layoutWrappers, layoutHidden)) hidden.set(name, { args, optional });
    }
  }
  for (const name of runtimeAssigned(sources, commands)) hidden.delete(name);
  return { math, wrappers, hidden };
}

/** Primitives and etoolbox/LaTeX helpers that change the macro named right after them. */
const ASSIGN = String.raw`\\(?:g@addto@macro|addto@macro|appto|gappto|eappto|xappto|def|gdef|edef|xdef|let)(?![A-Za-z@])`;
const ASSIGN_NAME = new RegExp(String.raw`${ASSIGN}\s*\\([A-Za-z@]+)`, "g");
const ASSIGN_ARG = new RegExp(String.raw`${ASSIGN}(?:\s*\\expandafter)*\s*#(\d)`, "g");

/** The arguments of a call from s[i] (just after the command name), by position; a missing optional one is "". */
function callArgs(s: string, i: number, arity: Arity): string[] | null {
  const out: string[] = [];
  let k = skipSpace(s, i);
  if (arity.optional) {
    const g = s[k] === "[" ? group(s, k) : null;
    out.push(g?.text ?? "");
    if (g) k = skipSpace(s, g.end);
  }
  while (out.length < arity.args) {
    const g = s[k] === "{" ? group(s, k) : null;
    if (!g) return null;
    out.push(g.text);
    k = skipSpace(s, g.end);
  }
  return out;
}

/**
 * Names the sources change while the document typesets: `\g@addto@macro\x`, `\def\x`, `\let\x`,
 * … anywhere, and a name passed to a macro that assigns its `#k` (`\collect{\educationContent}`),
 * also through macros that pass their own `#j` on (`\researchEntry` -> `\@experienceEntry` ->
 * `\collect`). What such a macro's definition says empty is not what prints.
 */
function runtimeAssigned(sources: readonly string[], commands: ReadonlyMap<string, { arity: Arity; body: string }>): Set<string> {
  const assigned = new Set<string>();
  for (const s of sources) for (const m of s.matchAll(ASSIGN_NAME)) assigned.add(m[1]);
  // Macro -> the argument positions it assigns, directly or through another such macro.
  const assigns = new Map<string, Set<number>>();
  for (const [name, d] of commands) {
    const ks = [...d.body.matchAll(ASSIGN_ARG)].map((m) => Number(m[1]));
    if (ks.length) assigns.set(name, new Set(ks));
  }
  const passed = (src: string, onArg: (arg: string) => void) => {
    for (const [name, ks] of assigns) {
      const arity = commands.get(name)!.arity;
      for (const m of src.matchAll(new RegExp(String.raw`\\${name}(?![A-Za-z@])`, "g"))) {
        const args = callArgs(src, (m.index ?? 0) + m[0].length, arity);
        for (const k of ks) onArg((args?.[k - 1] ?? "").replace(/\\noexpand\s*/g, "").trim());
      }
    }
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, d] of commands) passed(d.body, (arg) => {
      const j = /^#(\d)$/.exec(arg);
      if (!j) return;
      const ks = assigns.get(name) ?? new Set<number>();
      if (ks.has(Number(j[1]))) return;
      ks.add(Number(j[1]));
      assigns.set(name, ks);
      changed = true;
    });
  }
  for (const s of sources) passed(s, (arg) => {
    const a = /^\\([A-Za-z@]+)$/.exec(arg);
    if (a) assigned.add(a[1]);
  });
  return assigned;
}

/** A key that is equal exactly when two rule sets are. */
export function rulesKey(r: EnvRules): string {
  return JSON.stringify([[...r.math].sort(), [...r.wrappers].sort(), [...r.hidden].sort((a, b) => (a[0] < b[0] ? -1 : 1))]);
}

/**
 * The rules in force: the defaults, then the detected rules, then the user's (each later layer
 * replacing what an earlier one says about a name), then `profiled` environments (a template
 * profile's box or source) taken out of the formula and wrapper rules. `arity` gives a user's
 * hidden command its arguments (the project's \newcommand), else the built-in table's, else
 * none known.
 */
export function mergeEnvRules(
  user: UserEnvRules,
  detected: DetectedRules = NO_DETECTED,
  arity: (name: string) => Arity | undefined = () => undefined,
  profiled: Iterable<string> = [],
): EnvRules {
  const math = new Map(DEFAULT_RULES.math);
  const wrappers = new Set(DEFAULT_RULES.wrappers);
  const hidden = new Map(DEFAULT_RULES.hidden);
  const setEnv = (name: string, kind: "math" | "wrapper" | "source", target?: string) => {
    math.delete(name);
    wrappers.delete(name);
    if (kind === "math") math.set(name, target!);
    else if (kind === "wrapper") wrappers.add(name);
  };
  for (const [name, target] of detected.math) setEnv(name, "math", target);
  for (const name of detected.wrappers) setEnv(name, "wrapper");
  for (const [name, a] of detected.hidden) hidden.set(name, a);
  for (const [name, target] of Object.entries(user.formulas)) {
    setEnv(name, target === "source" ? "source" : "math", DEFAULT_RULES.math.get(target));
  }
  for (const raw of user.wrappers) {
    if (raw.startsWith("!")) setEnv(raw.slice(1), "source");
    else setEnv(raw, "wrapper");
  }
  for (const raw of user.hidden) {
    if (raw.startsWith("!")) hidden.delete(raw.slice(1));
    else hidden.set(raw, arity(raw) ?? detected.hidden.get(raw) ?? DEFAULT_HIDDEN.get(raw) ?? null);
  }
  for (const name of profiled) {
    math.delete(name);
    wrappers.delete(name);
  }
  return { math, wrappers, hidden };
}
