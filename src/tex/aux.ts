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

/**
 * Every `\newlabel{k}{..}` of the .aux files under `outDir` (cleveref's `k@cref` twins too) by
 * key, its value as written with its braces (`{{1.2}{3}{Title}{equation.1.2}{}}`): a TeX run that
 * defines `r@k` with it (`\global\@namedef{r@k}` and the value) resolves references as the
 * compile did (fragment compiles).
 */
export function readAuxDefinitions(outDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of auxFiles(outDir, 0)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\\newlabel\{([^{}]+)\}\{/g)) {
      const fields = groups(text, (m.index ?? 0) + m[0].length);
      if (fields.length) out.set(m[1], `{${fields.map((f) => `{${f}}`).join("")}}`);
    }
  }
  return out;
}

/** An \include'd file's counters as it ended (its .aux's `\@setckpt`), and its chapter's number. */
export interface AuxCheckpoint {
  /** The checkpoint's `\setcounter{c}{n}`: `tcb@cnt@theorem` -> 4. */
  readonly counters: ReadonlyMap<string, number>;
  /**
   * What `\thechapter` printed for the file's last numbered chapter, from its hyperref anchor
   * (`chapter.4` -> `4`, `appendix.A` -> `A`; not the chapter counter, which is 1 in the first
   * appendix, nor the toc's `\numberline`, `第四章` under elegantbook's `chinese`); null without one.
   */
  readonly chapter: string | null;
}

/**
 * The checkpoints of the .aux files under `outDir` by their \include name as written
 * (`chapters/ch4`): what each included file ended with (see AuxCheckpoint). Empty for a document
 * that includes nothing.
 */
export function readAuxCheckpoints(outDir: string): Map<string, AuxCheckpoint> {
  const out = new Map<string, AuxCheckpoint>();
  for (const file of auxFiles(outDir, 0)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const at = text.indexOf("\\@setckpt");
    if (at < 0) continue;
    const [name, body] = groups(text, at + "\\@setckpt".length);
    if (!name || body === undefined) continue;
    const counters = new Map<string, number>();
    for (const m of body.matchAll(/\\setcounter\{([^{}]+)\}\{(-?\d+)\}/g)) counters.set(m[1], Number(m[2]));
    let chapter: string | null = null;
    for (const m of text.matchAll(/\\contentsline\s*\{chapter\}/g)) {
      const anchor = groups(text, (m.index ?? 0) + m[0].length)[2] ?? "";
      const n = /^(?:chapter|appendix)\.([^.*]+)$/.exec(anchor.trim());
      if (n) chapter = n[1];
    }
    out.set(name.trim().replace(/^\.\//, "").replace(/\.tex$/i, ""), { counters, chapter });
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

/** The .aux files under `dir`, without those of fragment compiles (`frag-<hash>.aux`, fragment.ts). */
function auxFiles(dir: string, depth: number): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".aux") && !/^frag-[0-9a-f]{16}\.aux$/.test(e.name)) out.push(join(dir, e.name));
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
