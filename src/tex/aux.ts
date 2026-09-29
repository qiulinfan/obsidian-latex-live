import { type Dirent, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { groupEnd } from "./texText";

/** One `\newlabel` of the last compile. */
export interface AuxLabel {
  /**
   * The number field without its outer braces (`1.2`, `A.1`, `\color {structurecolor}1.` for an
   * elegantbook item); texText gives what it typesets.
   */
  number: string;
  page: string;
  /** hyperref's title and anchor (`equation.1.1.2`, `tcb@cnt@theorem.1`); empty without it. \autoref names the anchor's type. */
  title: string;
  anchor: string;
  /**
   * What \cref calls the label: cleveref's type from the `k@cref` twin (`subequation`, `enumii`,
   * `section` for an appendix section when hyperref came first), else the anchor's counter
   * (`theorem` for elegantbook's `tcb@cnt@theorem`, `equation` for amsmath's `AMS` tags, `enumi`
   * for `Item`, `footnote` for `Hfootnote`, `figure` for `figure.caption.2`); "" when neither says.
   */
  kind: string;
  /**
   * cleveref's sort key: the enclosing counters' values, then the label's own (`[2, 1, 3]` for
   * equation 2.1.3 numbered within sections); null without the twin.
   */
  order: readonly number[] | null;
}

/** Folders below the output folder searched for .aux files (\include writes chapters/*.aux). */
const MAX_DEPTH = 3;

/**
 * The labels of every .aux file under `outDir`: `\newlabel{k}{{num}{page}{title}{anchor}{}}`,
 * including the implicit labels of classes such as elegantbook's `{title}{label}` theorems,
 * which only the .aux knows, with cleveref's `k@cref` twin (`{[type][value][enclosing]num}`)
 * folded in. Empty when nothing compiled yet.
 */
export function readAuxLabels(outDir: string): Map<string, AuxLabel> {
  const out = new Map<string, AuxLabel>();
  const twins = new Map<string, { type: string; order: number[] }>();
  for (const file of auxFiles(outDir, 0)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\\newlabel\{([^{}]+)\}\{/g)) {
      const key = m[1];
      const fields = groups(text, (m.index ?? 0) + m[0].length);
      if (key.endsWith("@cref")) {
        const twin = /^\[([^\]]+)\]\[(-?\d+)\]\[([^\]]*)\]/.exec(fields[0] ?? "");
        if (twin) {
          const order = twin[3].split(",").filter((v) => v.trim()).map(Number);
          order.push(Number(twin[2]));
          twins.set(key.slice(0, -5), { type: twin[1], order: order.every(Number.isFinite) ? order : [] });
        }
        continue;
      }
      if (fields.length < 2) continue;
      const anchor = fields[3] ?? "";
      out.set(key, { number: plain(fields[0]), page: plain(fields[1]), title: fields[2] ?? "", anchor, kind: anchorKind(anchor), order: null });
    }
  }
  for (const [key, label] of out) {
    const twin = twins.get(key);
    if (!twin) continue;
    label.kind = twin.type;
    label.order = twin.order.length ? twin.order : null;
  }
  return out;
}

/** The cleveref type an anchor's counter stands for (see AuxLabel.kind). */
function anchorKind(anchor: string): string {
  const counter = anchor.split(".", 1)[0].replace(/^tcb@cnt@/, "");
  if (counter === "AMS") return "equation";
  if (counter === "Item") return "enumi";
  if (counter === "Hfootnote") return "footnote";
  return counter;
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

/**
 * A number or page field: `\relax` and `\ignorespaces` removed, and the groups around the whole
 * field (`{{$\star $}}` is `$\star $`); inner groups stay, so texText sees where an argument ends
 * (elegantbook's item `{{\color {structurecolor}1.}}` is `\color {structurecolor}1.`, `1.`).
 */
function plain(field: string): string {
  let t = field.replace(/\\(?:relax|ignorespaces)(?![A-Za-z])\s*/g, "").trim();
  while (t.startsWith("{") && groupEnd(t, 0) === t.length) t = t.slice(1, -1).trim();
  return t;
}
