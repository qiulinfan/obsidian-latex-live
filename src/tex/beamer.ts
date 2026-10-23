import { readFileSync } from "fs";
import { dirname } from "path";
import { Arity, frameStarts } from "./envRules";
import { contextualFileReferences } from "./project";

// A beamer deck's frames (docs/beamer.md), for live preview's frame cards. Pure
// but for the files read: no Obsidian, no CodeMirror.
//   Pages     the .nav of the last compile lists each frame's PDF pages in order
//             (`\headcommand {\beamer@framepages {a}{b}}`, one per frame, overlays spanning a..b).
//   Frames    the frames (frameStarts: \begin{frame} and the banner commands' calls) of the files
//             the root's body reads, depth-first in reading order: each file's offset (the
//             frames before it) and count. A file read twice keeps its first place.

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
