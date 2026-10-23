import { readFileSync } from "fs";
import { dirname } from "path";
import { Arity, frameStarts } from "./envRules";
import { contextualFileReferences } from "./project";
import { texText } from "./texText";

// A beamer deck's frames and title page (docs/beamer.md), for live preview's frame cards. Pure
// but for the files read: no Obsidian, no CodeMirror.
//   Pages     the .nav of the last compile lists each frame's PDF pages in order
//             (`\headcommand {\beamer@framepages {a}{b}}`, one per frame, overlays spanning a..b).
//   Frames    the frames (frameStarts: \begin{frame} and the banner commands' calls) of the files
//             the root's body reads, depth-first in reading order: each file's offset (the
//             frames before it) and count. A file read twice keeps its first place.
//   Title     the preamble's \title, \subtitle, \author, \institute and \date (the long form; the
//             last one wins, as in LaTeX), as text, and where \title is.

export interface FramePages {
  readonly first: number;
  readonly last: number;
}

/** The frames' pages of a .nav file's text, in frame order. */
export function navPages(nav: string): FramePages[] {
  const out: FramePages[] = [];
  for (const m of nav.matchAll(/\\beamer@framepages\s*\{(\d+)\}\s*\{(\d+)\}/g)) out.push({ first: Number(m[1]), last: Number(m[2]) });
  return out;
}

/** The .nav pages at `path`, or [] without the file. */
export function readNavPages(path: string): FramePages[] {
  try {
    return navPages(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

export interface DeckFrames {
  /** Per file (absolute path): the frames before it and its own. */
  readonly files: ReadonlyMap<string, { readonly offset: number; readonly count: number }>;
  readonly total: number;
}

/**
 * The frames of the files `root`'s body reads (see Frames); `text(path)` gives a file's text, or
 * null when it cannot be read.
 */
export function deckFrames(root: string, banners: ReadonlyMap<string, Arity>, text: (path: string) => string | null): DeckFrames {
  const files = new Map<string, { offset: number; count: number }>();
  const rootDir = dirname(root);
  let total = 0;
  const visit = (file: string, inputDirs: readonly string[], isRoot: boolean) => {
    if (files.has(file) || files.size >= 500) return;
    const src = text(file);
    if (src === null) return;
    const entry = { offset: total, count: 0 };
    files.set(file, entry);
    const starts = frameStarts(src, banners, isRoot);
    const body = isRoot ? Math.max(0, src.search(/\\begin\s*\{document\}/)) : 0;
    const refs = contextualFileReferences(maskComments(src), rootDir, inputDirs).filter((r) => r.at >= body);
    let k = 0;
    for (const ref of refs) {
      for (; k < starts.length && starts[k] < ref.at; k++) total++;
      visit(ref.path, ref.inputDirs, false);
    }
    total += starts.length - k;
    entry.count = starts.length;
  };
  visit(root, [rootDir], true);
  return { files, total };
}

/** Comments blanked out, offsets kept. */
const maskComments = (s: string): string => s.replace(/(^|[^\\])(%.*)$/gm, (_m, p: string, c: string) => p + " ".repeat(c.length));

export interface TitleFields {
  readonly title: string;
  readonly subtitle: string;
  readonly author: string;
  readonly institute: string;
  readonly date: string;
}

/** The title page's fields and \title's place (0-based line), or null without a \title. */
export interface DeckTitle {
  readonly fields: TitleFields;
  readonly file: string;
  readonly line: number;
}

const FIELDS = ["title", "subtitle", "author", "institute", "date"] as const;

/**
 * The title page (see Title) of `files` (the root first, then the files it reads, in reading
 * order), their texts by `text`; only the root's preamble and files other than the root count.
 */
export function deckTitle(files: readonly string[], text: (path: string) => string | null): DeckTitle | null {
  const found: Partial<Record<(typeof FIELDS)[number], string>> = {};
  let where: { file: string; line: number } | null = null;
  files.forEach((file, i) => {
    const raw = text(file);
    if (raw === null) return;
    let src = maskComments(raw);
    if (i === 0) {
      const begin = src.search(/\\begin\s*\{document\}/);
      if (begin >= 0) src = src.slice(0, begin);
    }
    for (const m of src.matchAll(/\\(title|subtitle|author|institute|date)(?![A-Za-z@])\s*/g)) {
      let k = (m.index ?? 0) + m[0].length;
      if (src[k] === "[") {
        const e = groupEnd(src, k, "[", "]");
        if (e < 0) continue;
        k = e;
        while (/\s/.test(src[k] ?? "")) k++;
      }
      if (src[k] !== "{") continue;
      const e = groupEnd(src, k, "{", "}");
      if (e < 0) continue;
      const name = m[1] as (typeof FIELDS)[number];
      found[name] = asText(src.slice(k + 1, e - 1));
      if (name === "title") where = { file, line: src.slice(0, m.index).split("\n").length - 1 };
    }
  });
  if (!where) return null;
  const fields = { title: "", subtitle: "", author: "", institute: "", date: "", ...found };
  return { fields, ...(where as { file: string; line: number }) };
}

/** The index after the group opening at s[i], or -1. */
function groupEnd(s: string, i: number, open: string, close: string): number {
  for (let j = i, depth = 0; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j + 1;
  }
  return -1;
}

/** A field as text: `\\` (and `\\[3pt]`) break lines, `\and` separates authors. */
function asText(src: string): string {
  return src
    .split(/\\\\\s*(?:\[[^\]]*\])?|\\and(?![A-Za-z@])|\\newline(?![A-Za-z@])/)
    .map((part) => texText(part).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
