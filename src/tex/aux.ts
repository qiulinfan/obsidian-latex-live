import { type Dirent, readdirSync, readFileSync } from "fs";
import { join } from "path";

/** One `\newlabel` of the last compile. */
export interface AuxLabel {
  /** The number as typeset: `1.2`, `A.1`. */
  number: string;
  page: string;
  /** hyperref's title and anchor (`equation.1.1.2`, `tcb@cnt@theorem.1`); empty without it. */
  title: string;
  anchor: string;
}

/** Folders below the output folder searched for .aux files (\include writes chapters/*.aux). */
const MAX_DEPTH = 3;

/**
 * The labels of every .aux file under `outDir`: `\newlabel{k}{{num}{page}{title}{anchor}{}}`,
 * including the implicit labels of classes such as elegantbook's `{title}{label}` theorems,
 * which only the .aux knows. cleveref's `k@cref` twins are skipped. Empty when nothing
 * compiled yet.
 */
export function readAuxLabels(outDir: string): Map<string, AuxLabel> {
  const out = new Map<string, AuxLabel>();
  for (const file of auxFiles(outDir, 0)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\\newlabel\{([^{}]+)\}\{/g)) {
      const key = m[1];
      if (key.endsWith("@cref")) continue;
      const fields = groups(text, (m.index ?? 0) + m[0].length);
      if (fields.length < 2) continue;
      out.set(key, { number: plain(fields[0]), page: plain(fields[1]), title: fields[2] ?? "", anchor: fields[3] ?? "" });
    }
  }
  return out;
}

function auxFiles(dir: string, depth: number): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".aux")) out.push(join(dir, e.name));
    else if (e.isDirectory() && depth < MAX_DEPTH) out.push(...auxFiles(join(dir, e.name), depth + 1));
  }
  return out;
}

/** The `{...}` groups from `i` up to the unmatched `}` that closes the entry. */
function groups(s: string, i: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "{") {
      if (depth++ === 0) start = j + 1;
    } else if (c === "}") {
      if (depth === 0) break;
      if (--depth === 0) out.push(s.slice(start, j));
    } else if (c === "\n" && depth === 0) break;
  }
  return out;
}

/** A number or page as text: `\relax`, `\ignorespaces` and braces removed. */
const plain = (s: string): string => s.replace(/\\(?:relax|ignorespaces)(?![A-Za-z])\s*/g, "").replace(/[{}]/g, "").trim();
