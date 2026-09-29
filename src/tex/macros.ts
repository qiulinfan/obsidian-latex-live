import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { referencedFiles, stripComments } from "./project";

/** What a project defines that completion needs: macro arities, colors, environments. */
export interface Definitions {
  /**
   * Macro name (no backslash) -> number of arguments; `optional` when the first is `[...]`;
   * `math` for operators (\DeclareMathOperator), which rank like math commands.
   */
  macros: Map<string, { args: number; optional: boolean; math?: boolean }>;
  colors: Set<string>;
  environments: Set<string>;
}

export const emptyDefinitions = (): Definitions => ({
  macros: new Map(),
  colors: new Set(),
  environments: new Set(),
});

const DEFINERS = ["newcommand", "renewcommand", "providecommand", "DeclareRobustCommand"];

/**
 * Scan one file's text for \newcommand-style definitions (including aliases such as
 * elegantbook's `\newcommand{\nc}{\newcommand}`), \def, \DeclareMathOperator,
 * \NewDocumentCommand, colors and environments. Adds to `into`.
 */
export function scanDefinitions(text: string, into: Definitions = emptyDefinitions()): Definitions {
  const src = stripComments(text);
  const definers = new Set(DEFINERS);
  for (const m of src.matchAll(
    /\\(?:(?:re)?newcommand\*?\s*\{?\s*\\([A-Za-z]+)\s*\}?\s*\{\s*\\((?:re)?newcommand|providecommand)\s*\}|let\s*\\([A-Za-z]+)\s*=?\s*\\((?:re)?newcommand))/g,
  )) {
    definers.add(m[1] ?? m[3]);
  }
  const names = [...definers].join("|");
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
  return into;
}

const fileCache = new Map<string, { mtime: number; defs: Definitions; text: string }>();

function readScanned(path: string): { defs: Definitions; text: string } | null {
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const hit = fileCache.get(path);
  if (hit && hit.mtime === mtime) return hit;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const entry = { mtime, text, defs: scanDefinitions(text) };
  fileCache.set(path, entry);
  return entry;
}

const MAX_FILES = 80;

/**
 * Definitions of a project: the root document, the files it \input's (recursively), and
 * the local .sty/.cls files it loads from its own directory. Files are re-read only when
 * their mtime changes.
 */
export function projectDefinitions(root: string): Definitions {
  const out = emptyDefinitions();
  const rootDir = dirname(root);
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length && seen.size < MAX_FILES) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const hit = readScanned(file);
    if (!hit) continue;
    for (const [k, v] of hit.defs.macros) out.macros.set(k, v);
    for (const c of hit.defs.colors) out.colors.add(c);
    for (const e of hit.defs.environments) out.environments.add(e);
    queue.push(...referencedFiles(hit.text, rootDir));
    const src = stripComments(hit.text);
    for (const m of src.matchAll(/\\(usepackage|RequirePackage|documentclass|LoadClass)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      const ext = m[1] === "documentclass" || m[1] === "LoadClass" ? ".cls" : ".sty";
      for (const name of m[2].split(",")) {
        const local = join(rootDir, name.trim() + ext);
        if (name.trim() && existsSync(local)) queue.push(local);
      }
    }
  }
  return out;
}

/** Merge `extra` (e.g. the unsaved editor text) over `base` into a new object. */
export function mergeDefinitions(base: Definitions, extra: Definitions): Definitions {
  return {
    macros: new Map([...base.macros, ...extra.macros]),
    colors: new Set([...base.colors, ...extra.colors]),
    environments: new Set([...base.environments, ...extra.environments]),
  };
}
