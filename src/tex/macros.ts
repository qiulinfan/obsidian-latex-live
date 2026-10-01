import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { contextualFileReferences, stripComments, subfileSource } from "./project";

/**
 * What a project defines: macro arities, colors and environments for completion, and the
 * definition statements the math renderer feeds its private MathJax instance.
 */
export interface Definitions {
  /**
   * Macro name (no backslash) -> number of arguments; `optional` when the first is `[...]`;
   * `math` for operators (\DeclareMathOperator), which rank like math commands.
   */
  macros: Map<string, { args: number; optional: boolean; math?: boolean }>;
  colors: Set<string>;
  environments: Set<string>;
  /**
   * Definitions normalized for MathJax (see definitionStatements), in document order: the
   * statements of an \input file stand where it is read, a local package's where it is
   * loaded. Filled by projectDefinitions only.
   */
  statements: string[];
  /** Last effective full normalized declaration per macro, in execution order, for source parsers. */
  declarations?: ReadonlyMap<string, string>;
  /**
   * Macros whose last definition (document order) MathJax cannot read, -> that definition: an
   * xparse spec other than `m`s after one `o`, a body using `@` internals. Filled by
   * projectDefinitions only.
   */
  unsupported: Map<string, string>;
  /** Packages loaded with \usepackage or \RequirePackage (`physics` changes MathJax's \div). */
  packages: Set<string>;
  /** The files read, root first. Filled by projectDefinitions only. */
  files: string[];
}

export const emptyDefinitions = (): Definitions => ({
  macros: new Map(),
  colors: new Set(),
  environments: new Set(),
  statements: [],
  declarations: new Map(),
  unsupported: new Map(),
  packages: new Set(),
  files: [],
});

const DEFINERS = ["newcommand", "renewcommand", "providecommand", "DeclareRobustCommand"];

/** Definer aliases (`\nc` -> `newcommand`) of earlier files: a file uses those it inherits too. */
type Aliases = ReadonlyMap<string, string>;

const NO_ALIASES: Aliases = new Map();

/** Definers renamed by the document: `\newcommand{\nc}{\newcommand}`, `\let\nc\newcommand`. */
function definerAliases(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(
    /\\(?:(?:re)?newcommand\*?\s*\{?\s*\\([A-Za-z]+)\s*\}?\s*\{\s*\\((?:re)?newcommand|providecommand)\s*\}|let\s*\\([A-Za-z]+)\s*=?\s*\\((?:re)?newcommand))/g,
  )) {
    out.set(m[1] ?? m[3], m[2] ?? m[4]);
  }
  return out;
}

/**
 * Scan one file's text for \newcommand-style definitions (including aliases such as
 * elegantbook's `\newcommand{\nc}{\newcommand}`, its own and `inherited` ones), \def,
 * \DeclareMathOperator, \NewDocumentCommand, colors, environments and packages. Adds to `into`.
 */
export function scanDefinitions(text: string, into: Definitions = emptyDefinitions(), inherited: Aliases = NO_ALIASES): Definitions {
  const src = stripComments(text);
  const names = [...DEFINERS, ...inherited.keys(), ...definerAliases(src).keys()].join("|");
  const def = new RegExp(
    `\\\\(?:${names})\\*?\\s*\\{?\\s*\\\\([A-Za-z@]+)\\s*\\}?\\s*(?:\\[(\\d)\\])?\\s*(\\[)?`,
    "g",
  );
  for (const m of src.matchAll(def)) {
    const args = m[2] ? Number(m[2]) : 0;
    into.macros.set(m[1], { args, optional: args > 0 && !!m[3] });
  }
  for (const m of src.matchAll(/\\DeclareMathOperator\*?\s*\{?\s*\\([A-Za-z@]+)/g)) {
    into.macros.set(m[1], { args: 0, optional: false, math: true });
  }
  for (const m of src.matchAll(/\\[egx]?def\s*\\([A-Za-z@]+)((?:#\d)*)\s*\{/g)) {
    into.macros.set(m[1], { args: m[2].length / 2, optional: false });
  }
  for (const m of src.matchAll(
    /\\(?:New|Renew|Provide|Declare)DocumentCommand\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*\{([^}]*)\}/g,
  )) {
    const spec = m[2].match(/[mo]/g) ?? [];
    into.macros.set(m[1], { args: spec.length, optional: spec[0] === "o" });
  }
  for (const m of src.matchAll(/\\(?:definecolor|colorlet|providecolor)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    into.colors.add(m[1].trim());
  }
  for (const m of src.matchAll(
    /\\(?:(?:re)?newenvironment\*?|newtheorem\*?|(?:New|Renew)DocumentEnvironment)\s*\{([^}]+)\}/g,
  )) {
    into.environments.add(m[1].trim());
  }
  for (const m of src.matchAll(PACKAGE_RE)) {
    if (m[1] !== "usepackage" && m[1] !== "RequirePackage") continue;
    for (const name of m[2].split(",")) if (name.trim()) into.packages.add(name.trim());
  }
  return into;
}

const PACKAGE_RE = /\\(usepackage|RequirePackage|documentclass|LoadClass)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;

// ---- definition statements for MathJax (design 4.2) ------------------------------------------

/** A definition statement at an offset of its file's comment-free text. */
interface Statement {
  at: number;
  /** Normalized source; for an unsupported definition, its source as written (shortened). */
  text: string;
  /** Complete declaration for parsers; `text` may be shortened for an unsupported MathJax definition. */
  declaration: string;
  /** The macro it defines (no backslash), or null (environments, colors). */
  name: string | null;
  /** From \providecommand: kept only while `name` is still undefined. */
  provide: boolean;
  /** MathJax cannot read it: `name` is recorded instead of fed (Definitions.unsupported). */
  unsupported?: boolean;
}

type Kind = "command" | "def" | "let" | "operator" | "paired" | "environment" | "color" | "document";

const STATEMENT_KINDS: Record<string, Kind> = {
  newcommand: "command",
  renewcommand: "command",
  providecommand: "command",
  DeclareRobustCommand: "command",
  def: "def",
  gdef: "def",
  edef: "def",
  xdef: "def",
  let: "let",
  DeclareMathOperator: "operator",
  DeclarePairedDelimiter: "paired",
  DeclarePairedDelimiterX: "paired",
  DeclarePairedDelimiterXPP: "paired",
  newenvironment: "environment",
  renewenvironment: "environment",
  definecolor: "color",
  NewDocumentCommand: "document",
  RenewDocumentCommand: "document",
  ProvideDocumentCommand: "document",
  DeclareDocumentCommand: "document",
};

/** Mandatory groups after the name of each \DeclarePairedDelimiter form. */
const PAIRED_GROUPS: Record<string, number> = {
  DeclarePairedDelimiter: 2,
  DeclarePairedDelimiterX: 3,
  DeclarePairedDelimiterXPP: 5,
};

/** Index after the balanced `{...}` or `[...]` that opens at s[i], or -1. */
function groupEnd(s: string, i: number): number {
  const open = s[i];
  if (open !== "{" && open !== "[") return -1;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "{") depth++;
    else if (c === "}") {
      if (--depth === 0 && open === "{") return j + 1;
      if (depth < 0) return -1;
    } else if (c === "]" && open === "[" && depth === 0) return j + 1;
  }
  return -1;
}

const skipSpace = (s: string, i: number): number => {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};

const CSNAME = /\\([A-Za-z]+|.)/y;

/** A control sequence at s[i]: its name and the index after it. */
function csAt(s: string, i: number): { name: string; end: number } | null {
  CSNAME.lastIndex = i;
  const m = CSNAME.exec(s);
  return m ? { name: m[1], end: i + m[0].length } : null;
}

/** The defined name, braced (`{\x}`) or not (`\x`), after optional spaces. */
function nameAt(s: string, i: number): { name: string; end: number } | null {
  i = skipSpace(s, i);
  if (s[i] !== "{") return csAt(s, i);
  const cs = csAt(s, skipSpace(s, i + 1));
  if (!cs) return null;
  const close = skipSpace(s, cs.end);
  return s[close] === "}" ? { name: cs.name, end: close + 1 } : null;
}

/** An optional `[...]` after spaces: its inner text and the index after it. */
function optionalAt(s: string, i: number): { value: string; end: number } | null {
  const at = skipSpace(s, i);
  const end = s[at] === "[" ? groupEnd(s, at) : -1;
  return end < 0 ? null : { value: s.slice(at + 1, end - 1), end };
}

/** A mandatory `{...}` after spaces: its inner text and the index after it. */
function groupAt(s: string, i: number): { value: string; end: number } | null {
  const at = skipSpace(s, i);
  const end = s[at] === "{" ? groupEnd(s, at) : -1;
  return end < 0 ? null : { value: s.slice(at + 1, end - 1), end };
}

/**
 * The statement of the definer `cmd` (kind `kind`) whose arguments start at s[i], normalized,
 * with the index after it; null when it is malformed or has no MathJax equivalent.
 */
function readStatement(
  s: string,
  i: number,
  cmd: string,
  kind: Kind,
): { text: string; name: string | null; provide: boolean; end: number; unsupported?: boolean } | null {
  const star = s[i] === "*" ? 1 : 0;
  switch (kind) {
    case "command": {
      // \newcommand*{\x}[n][default]{body}; the star makes MathJax "succeed" and define nothing.
      const name = nameAt(s, i + star);
      if (!name) return null;
      let at = name.end;
      const n = optionalAt(s, at);
      if (n && !/^\s*\d\s*$/.test(n.value)) return null;
      if (n) at = n.end;
      const dflt = n ? optionalAt(s, at) : null;
      if (dflt) at = dflt.end;
      const body = groupAt(s, at);
      if (!body) return null;
      const definer = cmd === "renewcommand" ? "renewcommand" : "newcommand";
      const args = (n ? `[${n.value.trim()}]` : "") + (dflt ? `[${dflt.value}]` : "");
      return {
        text: `\\${definer}{\\${name.name}}${args}{${body.value}}`,
        name: name.name,
        provide: cmd === "providecommand",
        end: body.end,
      };
    }
    case "def": {
      // \def\x#1,#2.{body}: the parameter text runs to the body's brace.
      const name = csAt(s, skipSpace(s, i));
      if (!name) return null;
      const open = s.indexOf("{", name.end);
      if (open < 0 || !/^[^\\{}]*$/.test(s.slice(name.end, open))) return null;
      const end = groupEnd(s, open);
      if (end < 0) return null;
      return { text: `\\def\\${name.name}${s.slice(name.end, open).trim()}${s.slice(open, end)}`, name: name.name, provide: false, end };
    }
    case "let": {
      const name = csAt(s, skipSpace(s, i));
      if (!name) return null;
      let at = skipSpace(s, name.end);
      if (s[at] === "=") at = skipSpace(s, at + 1);
      const target = csAt(s, at);
      if (!target) return null;
      return { text: `\\let\\${name.name}\\${target.name}`, name: name.name, provide: false, end: target.end };
    }
    case "operator": {
      const name = nameAt(s, i + star);
      const body = name && groupAt(s, name.end);
      if (!name || !body) return null;
      return {
        text: `\\DeclareMathOperator${star ? "*" : ""}{\\${name.name}}{${body.value}}`,
        name: name.name,
        provide: false,
        end: body.end,
      };
    }
    case "paired": {
      const name = nameAt(s, i);
      if (!name) return null;
      let at = name.end;
      let text = `\\${cmd}{\\${name.name}}`;
      const n = cmd === "DeclarePairedDelimiter" ? null : optionalAt(s, at);
      if (n) {
        text += `[${n.value}]`;
        at = n.end;
      }
      for (let k = 0; k < PAIRED_GROUPS[cmd]; k++) {
        const g = groupAt(s, at);
        if (!g) return null;
        text += `{${g.value}}`;
        at = g.end;
      }
      return { text, name: name.name, provide: false, end: at };
    }
    case "environment": {
      const env = groupAt(s, i + star);
      if (!env) return null;
      let at = env.end;
      const n = optionalAt(s, at);
      if (n) at = n.end;
      const dflt = n ? optionalAt(s, at) : null;
      if (dflt) at = dflt.end;
      const begin = groupAt(s, at);
      const end = begin && groupAt(s, begin.end);
      if (!begin || !end) return null;
      const args = (n ? `[${n.value.trim()}]` : "") + (dflt ? `[${dflt.value}]` : "");
      return {
        text: `\\${cmd}{${env.value.trim()}}${args}{${begin.value}}{${end.value}}`,
        name: null,
        provide: false,
        end: end.end,
      };
    }
    case "color": {
      const type = optionalAt(s, i);
      const name = groupAt(s, type ? type.end : i);
      const model = name && groupAt(s, name.end);
      const spec = model && groupAt(s, model.end);
      if (!name || !model || !spec) return null;
      return { text: `\\definecolor{${name.value}}{${model.value}}{${spec.value}}`, name: null, provide: false, end: spec.end };
    }
    case "document": {
      // xparse: only `m` arguments after at most one leading `o` / `O{default}`.
      const name = nameAt(s, i);
      const spec = name && groupAt(s, name.end);
      const body = spec && groupAt(s, spec.end);
      if (!name || !spec || !body) return null;
      const m = /^\s*(?:(o)|O\s*\{([^{}]*)\})?((?:\s*m)*)\s*$/.exec(spec.value);
      if (!m) {
        const text = `\\${cmd}{\\${name.name}}{${spec.value}}`;
        return { text, name: name.name, provide: cmd === "ProvideDocumentCommand", end: body.end, unsupported: true };
      }
      const optional = m[1] !== undefined || m[2] !== undefined;
      const n = (m[3].match(/m/g)?.length ?? 0) + (optional ? 1 : 0);
      const args = (n ? `[${n}]` : "") + (optional ? `[${m[2] ?? ""}]` : "");
      return {
        text: `\\newcommand{\\${name.name}}${args}{${body.value}}`,
        name: name.name,
        provide: cmd === "ProvideDocumentCommand",
        end: body.end,
      };
    }
  }
}

/** A control sequence with `@` in its name: package internals MathJax never knows. */
const INTERNAL = /\\[A-Za-z]*@/;

/** Longest unsupported definition kept for the message. */
const MAX_SHOWN = 80;

/**
 * The definition statements of comment-free source, in order (before the provide rule), with
 * the definer aliases `inherited` from earlier files and the source's own.
 */
function rawStatements(src: string, inherited: Aliases = NO_ALIASES, parser = false): Statement[] {
  // \makeatletter blocks define internals; blank them, keeping offsets.
  // Source parsers need the public consumer declarations inside them, while MathJax keeps
  // its existing filter. A makeatletter token inside a macro body must not hide later readers.
  if (!parser) src = src.replace(/\\makeatletter[\s\S]*?(?:\\makeatother|$)/g, (m) => " ".repeat(m.length));
  const aliases = new Map([...inherited, ...definerAliases(src)]);
  const re = new RegExp(`\\\\(${[...Object.keys(STATEMENT_KINDS), ...aliases.keys()].join("|")})(?![A-Za-z])`, "g");
  const out: Statement[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const cmd = aliases.get(m[1]) ?? m[1];
    const st = readStatement(src, m.index + m[0].length, cmd, STATEMENT_KINDS[cmd]);
    if (!st) continue;
    re.lastIndex = st.end;
    // An alias's own definition names a definer, not a macro.
    if (st.name && aliases.has(st.name)) continue;
    if (parser && (!st.name || !/^[A-Za-z]+$/.test(st.name) || /^\\def\\[A-Za-z]+@/.test(st.text))) continue;
    let unsupported = st.unsupported ?? false;
    if (INTERNAL.test(st.text)) {
      // An internal name itself (`\def\x@y`) is no user macro; a body with internals is unsupported.
      if (!parser && (!st.name || st.text.includes(`\\${st.name}@`))) continue;
      unsupported = true;
    }
    const text = unsupported && st.text.length > MAX_SHOWN ? `${st.text.slice(0, MAX_SHOWN)}…` : st.text;
    out.push({ at: m.index, text, declaration: st.text, name: st.name, provide: st.provide, unsupported });
  }
  return out;
}

/**
 * Apply the provide rule (a \providecommand defines only a name nothing defined yet) and add a
 * statement to `into`, or an unsupported definition to `unsupported`, which a later readable
 * definition of the name clears.
 */
function admit(st: Statement, defined: Set<string>, into: string[], unsupported: Map<string, string>): void {
  if (st.provide && st.name && defined.has(st.name)) return;
  if (st.name) {
    defined.add(st.name);
    unsupported.delete(st.name);
  }
  if (!st.unsupported) into.push(st.text);
  else if (st.name) unsupported.set(st.name, st.text);
}

/**
 * The definitions of `text` in the form MathJax's newcommand/mathtools/color packages read,
 * one statement each (fed separately: one that fails must not stop the rest):
 *   - \newcommand* and \renewcommand* lose the star (MathJax defines nothing with it);
 *     \DeclareRobustCommand becomes \newcommand, \providecommand too while the name is not in
 *     `defined` (names defined earlier; updated with this text's);
 *   - \NewDocumentCommand (Renew/Provide/Declare) becomes \newcommand when its spec is `m`s
 *     after at most one leading `o` / `O{default}`, and is left out otherwise (like a body
 *     using `@` internals; projectDefinitions lists both in `unsupported`);
 *   - \DeclareMathOperator, \DeclarePairedDelimiter(X), \def (\gdef, \edef, \xdef), \let,
 *     \newenvironment, \renewenvironment and \definecolor are kept;
 *   - definers renamed by the document (`\newcommand{\nc}{\newcommand}`) are followed;
 *   - \makeatletter blocks and statements mentioning a name with `@` are skipped.
 */
export function definitionStatements(text: string, defined: Set<string> = new Set()): string[] {
  const out: string[] = [];
  for (const st of rawStatements(stripComments(text))) admit(st, defined, out, new Map());
  return out;
}

// ---- project walk ----------------------------------------------------------------------------

interface FileScan {
  text: string;
  /** Comment-free text: statement and reference offsets point into it. */
  src: string;
  /** The definer aliases the file itself defines. */
  aliases: Map<string, string>;
  /** Its definitions and statements for the aliases it was last read with. */
  read: { key: string; defs: Definitions; statements: Statement[]; parserDeclarations: Statement[] } | null;
}

function scanFile(text: string): FileScan {
  const src = stripComments(text);
  return { text, src, aliases: definerAliases(src), read: null };
}

/** A file's definitions and statements, given the definer aliases of the files read before it. */
function readWith(scan: FileScan, aliases: Aliases): { defs: Definitions; statements: Statement[]; parserDeclarations: Statement[] } {
  const key = JSON.stringify([...aliases]);
  if (scan.read?.key !== key) {
    scan.read = { key, defs: scanDefinitions(scan.text, emptyDefinitions(), aliases), statements: rawStatements(scan.src, aliases), parserDeclarations: rawStatements(scan.src, aliases, true) };
  }
  return scan.read;
}

const fileCache = new Map<string, { mtime: number; scan: FileScan }>();
const bufferCache = new Map<string, FileScan>();

/** A file's scan: from `buffer` (unsaved editor text) when given, else from disk by mtime. */
function scanned(path: string, buffer: string | undefined): FileScan | null {
  if (buffer !== undefined) {
    let hit = bufferCache.get(path);
    if (hit?.text !== buffer) bufferCache.set(path, (hit = scanFile(buffer)));
    return hit;
  }
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const hit = fileCache.get(path);
  if (hit && hit.mtime === mtime) return hit.scan;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const scan = scanFile(text);
  fileCache.set(path, { mtime, scan });
  return scan;
}

const MAX_FILES = 80;

/**
 * Definitions of a project: the root document, the files it \input's (recursively), and
 * the local .sty/.cls files it loads from its own directory. Files are re-read only when
 * their mtime changes; `buffers` (absolute path -> text) replace the disk copy of files open
 * with unsaved edits. Statements follow document order: a referenced file's statements come
 * where it is read. A definer alias (`\nc`) defined in one file is followed in the files read
 * after it.
 */
export function projectDefinitions(root: string, buffers?: ReadonlyMap<string, string>): Definitions {
  const out = emptyDefinitions();
  const declarations = new Map<string, string>();
  out.declarations = declarations;
  const rootDir = dirname(root);
  const seen = new Set<string>();
  const files = new Set<string>();
  const defined = new Set<string>();
  const parserDefined = new Set<string>();
  const aliases = new Map<string, string>();
  const visit = (file: string, inputDirs: readonly string[], bodyOnly = false) => {
    const context = `${file}|${inputDirs.join("|")}|${bodyOnly}`;
    if (seen.has(context) || seen.size >= MAX_FILES) return;
    seen.add(context);
    const raw = scanned(file, buffers?.get(file));
    if (!raw) return;
    const hit = bodyOnly ? scanFile(subfileSource(raw.text)) : raw;
    if (!files.has(file)) { files.add(file); out.files.push(file); }
    for (const [k, v] of hit.aliases) aliases.set(k, v);
    const { defs, statements, parserDeclarations } = readWith(hit, aliases);
    for (const [k, v] of defs.macros) out.macros.set(k, v);
    for (const c of defs.colors) out.colors.add(c);
    for (const e of defs.environments) out.environments.add(e);
    for (const p of defs.packages) out.packages.add(p);
    const exists = (path: string) => buffers?.has(path) || existsSync(path);
    const refs = contextualFileReferences(hit.src, rootDir, inputDirs, exists);
    for (const m of hit.src.matchAll(PACKAGE_RE)) {
      const ext = m[1] === "documentclass" || m[1] === "LoadClass" ? ".cls" : ".sty";
      for (const name of m[2].split(",")) {
        const local = inputDirs.map((dir) => join(dir, name.trim() + ext)).find(exists);
        if (name.trim() && local) refs.push({ at: m.index ?? 0, path: local, inputDirs: [...inputDirs], bodyOnly: false });
      }
    }
    refs.sort((a, b) => a.at - b.at);
    let r = 0;
    const events = [
      ...statements.map(st => ({ st, parser: false })),
      ...parserDeclarations.map(st => ({ st, parser: true })),
    ].sort((a, b) => a.st.at - b.st.at || Number(a.parser) - Number(b.parser));
    for (const { st, parser } of events) {
      while (r < refs.length && refs[r].at < st.at) {
        const ref = refs[r++];
        visit(ref.path, ref.inputDirs, ref.bodyOnly);
      }
      if (!parser) admit(st, defined, out.statements, out.unsupported);
      else if (st.name && !(st.provide && parserDefined.has(st.name))) {
        parserDefined.add(st.name);
        declarations.set(st.name, st.declaration);
      }
    }
    while (r < refs.length) {
      const ref = refs[r++];
      visit(ref.path, ref.inputDirs, ref.bodyOnly);
    }
  };
  visit(root, [rootDir]);
  return out;
}

/** Merge `extra` (e.g. the unsaved editor text) over `base` into a new object. */
export function mergeDefinitions(base: Definitions, extra: Definitions): Definitions {
  return {
    macros: new Map([...base.macros, ...extra.macros]),
    colors: new Set([...base.colors, ...extra.colors]),
    environments: new Set([...base.environments, ...extra.environments]),
    statements: [...base.statements, ...extra.statements],
    declarations: new Map([...(base.declarations ?? []), ...(extra.declarations ?? [])]),
    unsupported: new Map([...base.unsupported, ...extra.unsupported]),
    packages: new Set([...base.packages, ...extra.packages]),
    files: [...base.files, ...extra.files],
  };
}
