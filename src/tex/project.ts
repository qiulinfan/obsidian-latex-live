import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "path";

export type Engine = "pdflatex" | "xelatex" | "lualatex";
export type EngineSetting = "auto" | Engine;

const MAX_CANDIDATES_PER_DIR = 60;
/** Files read while following one candidate root's \input chain. */
const MAX_REACHED_FILES = 80;

/** Remove `%` comments (not `\%`) so commented-out code is ignored. */
export function stripComments(text: string): string {
  return text.replace(/(^|[^\\])%.*$/gm, "$1");
}

export function hasDocumentclass(text: string): boolean {
  return /\\documentclass\s*(\[[^\]]*\])?\s*\{/.test(stripComments(text));
}

/** The `% !TEX root = ...` magic comment, resolved against the file's dir. */
export function magicRoot(text: string, file: string): string | null {
  const m = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im.exec(head(text));
  if (!m) return null;
  const target = resolve(dirname(file), m[1]);
  return existsSync(target) ? target : null;
}

/** The `% !TEX program = ...` (or TS-program) magic comment. */
export function magicEngine(text: string): Engine | null {
  const m = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\S+)/im.exec(head(text));
  return m ? normalizeEngine(m[1]) : null;
}

function normalizeEngine(name: string): Engine | null {
  const n = name.toLowerCase();
  if (n === "pdflatex" || n === "latex" || n === "pdftex") return "pdflatex";
  if (n === "xelatex" || n === "xetex") return "xelatex";
  if (n === "lualatex" || n === "luatex" || n === "lualatexmk") return "lualatex";
  return null;
}

function head(text: string): string {
  return text.split(/\r?\n/, 30).join("\n");
}

/** Files a document pulls in with \input, \include, \subfile, \import. */
export function referencedFiles(text: string, rootDir: string): string[] {
  return fileReferences(stripComments(text), rootDir).map((r) => r.path);
}

/**
 * The \input-like references of comment-free source with their offsets, in document order.
 * Paths resolve against `rootDir` (TeX reads them from the root document's folder); a name
 * without an extension is a `.tex` file.
 */
export function fileReferences(src: string, rootDir: string): { at: number; path: string }[] {
  const out: { at: number; path: string }[] = [];
  const add = (at: number, p: string) => {
    const trimmed = p.trim();
    if (!trimmed) return;
    const withExt = extname(trimmed) ? trimmed : `${trimmed}.tex`;
    out.push({ at, path: isAbsolute(withExt) ? withExt : resolve(rootDir, withExt) });
  };
  for (const m of src.matchAll(
    /\\(?:input|include|subfile|subfileinclude)\s*\{([^}]+)\}/g,
  )) {
    add(m.index ?? 0, m[1]);
  }
  for (const m of src.matchAll(
    /\\(?:sub)?(?:import|includefrom|inputfrom)\*?\s*\{([^}]*)\}\s*\{([^}]+)\}/g,
  )) {
    add(m.index ?? 0, join(m[1], m[2]));
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Pick the document root that compiles `file`: the magic comment, the file
 * itself when it has \documentclass, or the nearest .tex with \documentclass
 * in the same directory or an ancestor (up to `stopDir`) that includes it,
 * directly (preferred) or through other inputs (main -> appendix -> notation).
 * Falls back to the file itself.
 */
export function findRoot(file: string, stopDir: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return file;
  }
  const magic = magicRoot(text, file);
  if (magic) return magic;
  if (hasDocumentclass(text)) return file;

  const target = resolve(file);
  const stop = resolve(stopDir);
  let dir = dirname(target);
  for (;;) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).filter((n) => n.endsWith(".tex"));
    } catch {
      entries = [];
    }
    const roots: { path: string; refs: string[] }[] = [];
    for (const name of entries.slice(0, MAX_CANDIDATES_PER_DIR)) {
      const candidate = join(dir, name);
      if (candidate === target) continue;
      let t: string;
      try {
        t = readFileSync(candidate, "utf8");
      } catch {
        continue;
      }
      if (!hasDocumentclass(t)) continue;
      const refs = referencedFiles(t, dir).map((p) => resolve(p));
      if (refs.includes(target)) return candidate;
      roots.push({ path: candidate, refs });
    }
    for (const r of roots) if (reaches(r.refs, dir, target)) return r.path;
    if (dir === stop || !dir.startsWith(stop)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return file;
}

/**
 * Whether the files a root document inputs (`refs`) pull in `target` through their own
 * inputs, breadth first. Nested paths resolve against the root's folder, as TeX reads them.
 */
function reaches(refs: string[], rootDir: string, target: string): boolean {
  const queue = [...refs];
  const seen = new Set<string>();
  while (queue.length && seen.size < MAX_REACHED_FILES) {
    const file = queue.shift()!;
    if (file === target) return true;
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      queue.push(...referencedFiles(readFileSync(file, "utf8"), rootDir).map((p) => resolve(p)));
    } catch {
      // a missing input
    }
  }
  return false;
}

/**
 * Engine for a root document: magic comment, then an explicit setting, then
 * the directory's latexmkrc `$pdf_mode`, then package heuristics.
 */
export function detectEngine(
  rootText: string,
  rootDir: string,
  setting: EngineSetting,
): Engine {
  const magic = magicEngine(rootText);
  if (magic) return magic;
  if (setting !== "auto") return setting;

  for (const rc of ["latexmkrc", ".latexmkrc"]) {
    const p = join(rootDir, rc);
    if (!existsSync(p)) continue;
    try {
      const m = /\$pdf_mode\s*=\s*(\d)/.exec(
        readFileSync(p, "utf8").replace(/#.*$/gm, ""),
      );
      if (m?.[1] === "4") return "lualatex";
      if (m?.[1] === "5") return "xelatex";
      if (m?.[1] === "1") return "pdflatex";
    } catch {
      // Unreadable rc files fall through to the heuristics.
    }
  }

  const preamble = stripComments(rootText).split("\\begin{document}")[0];
  if (/\\(?:usepackage|RequirePackage)\s*(\[[^\]]*\])?\s*\{[^}]*\b(luatexja|luacode|lua-ul|luamplib)\b/.test(preamble)) {
    return "lualatex";
  }
  if (
    /\\(?:usepackage|RequirePackage)\s*(\[[^\]]*\])?\s*\{[^}]*\b(fontspec|xeCJK|unicode-math|polyglossia|ctex)\b/.test(preamble) ||
    loadsCtex(preamble)
  ) {
    return "xelatex";
  }
  return "pdflatex";
}

const DOCUMENTCLASS = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{\s*([^}\s]+)\s*\}/;

/**
 * The document class loads ctex itself: the ctex classes, and the elegant*
 * classes (elegantbook, elegantnote, elegantpaper) in Chinese (see elegantLang).
 * pdfLaTeX fails on these without a PDF.
 */
function loadsCtex(preamble: string): boolean {
  const m = DOCUMENTCLASS.exec(preamble);
  if (m && /^ctex(?:art|rep|book|beamer)$/.test(m[2])) return true;
  return elegantLang(preamble) === "cn";
}

/**
 * The language of an elegant* class (elegantbook, elegantnote, elegantpaper) in the
 * `\documentclass` of comment-free source: `lang=cn` or a bare `cn` option (`cn` is
 * elegantnote's default, `en` the others'); null for other classes. elegantbook's
 * `chinese` is a heading scheme (`scheme=chinese`), not a language.
 */
export function elegantLang(src: string): string | null {
  const m = DOCUMENTCLASS.exec(src);
  const elegant = m && /^elegant(book|note|paper)$/.exec(m[2]);
  if (!m || !elegant) return null;
  let lang = elegant[1] === "note" ? "cn" : "en";
  for (const option of (m[1] ?? "").split(",")) {
    const [key, value] = option.split("=").map((s) => s.trim());
    if (value !== undefined) {
      if (key === "lang") lang = value;
    } else if (/^(?:cn|en|it|fr|nl|hu|de|es|mn|pt|jp)$/.test(key)) {
      lang = key;
    }
  }
  return lang;
}

/** The preamble (up to \begin{document}), used to key the format cache. */
export function preambleOf(text: string): string | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const code = stripComments(lines[i]);
    if (/\\begin\s*\{document\}|\\endofdump/.test(code)) {
      return lines.slice(0, i).join("\n");
    }
  }
  return null;
}

/**
 * The files a root document reads before \begin{document} (its preamble's \input chains,
 * followed): preamble code such as \hypersetup, \tcbset or \setlist in a `setup.tex`, never
 * decorated in live preview (design 4.4). Empty for a document without a body.
 */
export function preambleFiles(root: string): Set<string> {
  const out = new Set<string>();
  let text: string;
  try {
    text = readFileSync(root, "utf8");
  } catch {
    return out;
  }
  const preamble = preambleOf(text);
  if (preamble === null) return out;
  const rootDir = dirname(root);
  const queue = referencedFiles(preamble, rootDir);
  while (queue.length && out.size < MAX_REACHED_FILES) {
    const file = resolve(queue.shift()!);
    if (out.has(file)) continue;
    out.add(file);
    try {
      queue.push(...referencedFiles(readFileSync(file, "utf8"), rootDir));
    } catch {
      // a missing input
    }
  }
  return out;
}

/**
 * TeX tools report physical paths (symlinks resolved, e.g. /private/var on
 * macOS). Map those back under the logical directory the vault uses.
 */
export function logicalMapper(dir: string): (p: string) => string {
  const logical = resolve(dir);
  let physical = logical;
  try {
    physical = realpathSync(logical);
  } catch {
    // Missing directories keep the identity mapping.
  }
  return (p: string) => {
    const abs = resolve(p);
    if (physical === logical) return abs;
    if (abs === physical) return logical;
    return abs.startsWith(physical + sep)
      ? logical + abs.slice(physical.length)
      : abs;
  };
}
