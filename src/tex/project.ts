import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "path";

export type Engine = "pdflatex" | "xelatex" | "lualatex";
export type EngineSetting = "auto" | Engine;

const MAX_CANDIDATES_PER_DIR = 60;

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
  const src = stripComments(text);
  const out: string[] = [];
  const add = (p: string) => {
    const trimmed = p.trim();
    if (!trimmed) return;
    const withExt = extname(trimmed) ? trimmed : `${trimmed}.tex`;
    out.push(isAbsolute(withExt) ? withExt : resolve(rootDir, withExt));
  };
  for (const m of src.matchAll(
    /\\(?:input|include|subfile|subfileinclude)\s*\{([^}]+)\}/g,
  )) {
    add(m[1]);
  }
  for (const m of src.matchAll(
    /\\(?:sub)?(?:import|includefrom|inputfrom)\*?\s*\{([^}]*)\}\s*\{([^}]+)\}/g,
  )) {
    add(join(m[1], m[2]));
  }
  return out;
}

/**
 * Pick the document root that compiles `file`: the magic comment, the file
 * itself when it has \documentclass, or the nearest .tex with \documentclass
 * in the same directory or an ancestor (up to `stopDir`) that includes it.
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
      if (referencedFiles(t, dir).some((p) => resolve(p) === target)) {
        return candidate;
      }
    }
    if (dir === stop || !dir.startsWith(stop)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return file;
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
    /\\documentclass\s*(\[[^\]]*\])?\s*\{ctex(art|rep|book|beamer)\}/.test(preamble)
  ) {
    return "xelatex";
  }
  return "pdflatex";
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
