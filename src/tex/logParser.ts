import { existsSync } from "fs";
import { isAbsolute, resolve } from "path";

export type Severity = "error" | "warning" | "info";

export interface TexDiagnostic {
  severity: Severity;
  /** Absolute path of the source file, or null when the log does not say. */
  file: string | null;
  /** 1-based source line, or null. */
  line: number | null;
  message: string;
}

export interface ParsedLog {
  diagnostics: TexDiagnostic[];
  /** The log asks for another LaTeX pass (labels, cross-references). */
  rerun: boolean;
  /** Citations need BibTeX/Biber, which only a full build runs. */
  needsBibliography: boolean;
  /** Pages reported by "Output written on ...", or null if no PDF was written. */
  pages: number | null;
}

const ERROR_RE = /^(.*?):(\d+): (.*)$/;
const LATEX_WARNING_RE = /^LaTeX Warning: (.*)$/;
const PACKAGE_WARNING_RE = /^(?:Package|Class) (\S+) Warning: (.*)$/;
const INPUT_LINE_RE = /on input line (\d+)\.?/;
const OVERFULL_RE = /^Overfull \\[hv]box .* (?:at lines? (\d+)(?:--\d+)?|detected at line (\d+))/;
const OUTPUT_RE = /^Output written on .* \((\d+) pages?/;
const RERUN_RE =
  /Rerun to get|Label\(s\) may have changed|Please rerun LaTeX|Rerun LaTeX/;
const BIB_RE =
  /Please \(re\)run Biber|Please \(re\)run BibTeX|Citation .* undefined|There were undefined citations|Empty bibliography/;
// A file opened in the log: "(" directly followed by a path with an extension.
const FILE_OPEN_RE = /\((\.{0,2}\/[^\s()]*|[A-Za-z]:[\\/][^\s()]*|[^\s()/]+\.(?:tex|ltx|sty|cls|bbl|cfg|def|clo|fd|aux|toc|lof|lot|out|ind|nav|snm))/y;

/**
 * Parse a TeX log produced with `-file-line-error` and a wide
 * `max_print_line`. Errors carry exact file:line; warnings are attributed to
 * the innermost file open at that point of the log (best effort).
 */
export function parseLog(log: string, rootDir: string): ParsedLog {
  const lines = log.split(/\r?\n/);
  const diagnostics: TexDiagnostic[] = [];
  const fileStack: (string | null)[] = [];
  let rerun = false;
  let needsBibliography = false;
  let pages: number | null = null;

  const toAbs = (p: string): string =>
    isAbsolute(p) ? resolve(p) : resolve(rootDir, p);
  const currentFile = (): string | null => {
    for (let i = fileStack.length - 1; i >= 0; i--) {
      const f = fileStack[i];
      if (f) return f;
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];

    if (RERUN_RE.test(text)) rerun = true;
    if (BIB_RE.test(text)) needsBibliography = true;
    const out = OUTPUT_RE.exec(text);
    if (out) pages = Number(out[1]);

    const err = ERROR_RE.exec(text);
    if (err && looksLikePath(err[1])) {
      const { message, next } = collectError(lines, i, err[3]);
      diagnostics.push({
        severity: "error",
        file: toAbs(err[1]),
        line: Number(err[2]),
        message,
      });
      i = next;
      continue;
    }
    if (/^! /.test(text)) {
      // Errors without file:line (e.g. emergency stop from the terminal).
      const { message, next } = collectError(lines, i, text.slice(2));
      const lineMatch = lines
        .slice(i, next + 1)
        .map((l) => /^l\.(\d+)/.exec(l))
        .find(Boolean);
      diagnostics.push({
        severity: "error",
        file: currentFile(),
        line: lineMatch ? Number(lineMatch[1]) : null,
        message,
      });
      i = next;
      continue;
    }

    const lw = LATEX_WARNING_RE.exec(text);
    const pw = lw ? null : PACKAGE_WARNING_RE.exec(text);
    if (lw || pw) {
      let message = lw ? lw[1] : `${pw![1]}: ${pw![2]}`;
      let j = i + 1;
      const cont = pw ? new RegExp(`^\\(${escapeRe(pw[1])}\\)\\s*(.*)$`) : null;
      while (j < lines.length && lines[j].trim() !== "") {
        const m = cont ? cont.exec(lines[j]) : null;
        if (cont && !m) break;
        message += " " + (m ? m[1] : lines[j].trim());
        j++;
      }
      message = message.replace(/\s+/g, " ").trim();
      const ln = INPUT_LINE_RE.exec(message);
      diagnostics.push({
        severity: "warning",
        file: currentFile(),
        line: ln ? Number(ln[1]) : null,
        message,
      });
      i = j - 1;
      continue;
    }

    const of = OVERFULL_RE.exec(text);
    if (of) {
      diagnostics.push({
        severity: "info",
        file: currentFile(),
        line: Number(of[1] ?? of[2]),
        message: text.trim(),
      });
      continue;
    }

    trackFiles(text, fileStack, toAbs);
  }

  return { diagnostics: dedupe(diagnostics), rerun, needsBibliography, pages };
}

function looksLikePath(s: string): boolean {
  return /\.[A-Za-z]+$/.test(s) && !/\s{2}/.test(s) && !s.startsWith("(");
}

/** Gather an error's continuation lines up to the `l.<n>` context line. */
function collectError(
  lines: string[],
  start: number,
  first: string,
): { message: string; next: number } {
  let message = first.trim();
  let j = start + 1;
  for (; j < lines.length && j < start + 12; j++) {
    const l = lines[j];
    if (/^l\.\d+/.test(l)) break;
    if (l.trim() === "" || /^For immediate help type H/.test(l)) continue;
    if (/^\S.*:\d+: /.test(l) || /^! /.test(l)) {
      j--;
      break;
    }
    // Package errors continue on "(pkg)   ..." lines; the rest is help text.
    if (/^\(\S+\)\s/.test(l)) {
      message += " " + l.replace(/^\(\S+\)\s*/, "").trim();
    }
  }
  return { message: message.replace(/\s+/g, " ").trim(), next: j };
}

function trackFiles(
  text: string,
  stack: (string | null)[],
  toAbs: (p: string) => string,
): void {
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === "(") {
      FILE_OPEN_RE.lastIndex = k;
      const m = FILE_OPEN_RE.exec(text);
      if (m) {
        const abs = toAbs(m[1]);
        stack.push(existsSync(abs) ? abs : null);
        k += m[0].length - 1;
      } else {
        stack.push(null);
      }
    } else if (ch === ")") {
      stack.pop();
    }
  }
}

function dedupe(diags: TexDiagnostic[]): TexDiagnostic[] {
  const seen = new Set<string>();
  return diags.filter((d) => {
    const key = `${d.severity}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
