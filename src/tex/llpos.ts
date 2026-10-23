import { readFileSync } from "fs";
import { resolve } from "path";

// Position records (docs/design.md 4.6, Positions): every compile reads a small recorder first
// (the compiler writes it to its output dir), which writes where each outermost TikZ picture
// landed in the PDF to `<job>.llpos`. Crops take a block's box from there before asking
// SyncTeX (blockCrop's Positions).
//   Recorder  the env/<X>/after hook of each RECORDED environment (depth 1, horizontal mode) takes
//             the box the environment just added back off the list (\lastbox), puts a savepos
//             mark and a deferred \write in front of it and the box back unchanged. At shipout the
//             \write gives `\llpos{serial}{env}{abs page}{x}{y}{wd}{ht}{dp}{file}{line}` (sp; x, y
//             the box's left baseline point from the page's bottom left; file \CurrentFilePath/
//             \CurrentFile; line \inputlineno at \end). Writes in boxes TeX throws away (beamer's
//             trial typesetting, a gobbled \only) never fire. The output opens at
//             begindocument/before, so the same file works on the command line and inside a
//             preamble format. Without the LaTeX 2020-10 hooks or a savepos primitive it does
//             nothing.
//   Version   POS_RECORDER_VERSION goes into the preamble format's key: a changed recorder
//             rebuilds the format it is baked into.

/**
 * Environments the recorder records: the pictures of envRules' BLOCK_ENVS but pgfpicture (beamer
 * themes draw with it). Tables are drawn, never cropped.
 */
export const RECORDED_ENVS: ReadonlySet<string> = new Set(["tikzpicture", "tikzcd", "circuitikz"]);

export const POS_RECORDER_VERSION = 2;
/** The recorder's file name in the output dir. */
export const POS_RECORDER_FILE = "latex-live-pos.tex";

export const POS_RECORDER = String.raw`% latex-live position recorder (written by the plugin; src/tex/llpos.ts), version ${POS_RECORDER_VERSION}.
\makeatletter
\ifdefined\pdfsavepos
  \let\llpos@savepos\pdfsavepos \let\llpos@xpos\pdflastxpos \let\llpos@ypos\pdflastypos
\else\ifdefined\savepos
  \let\llpos@savepos\savepos \let\llpos@xpos\lastxpos \let\llpos@ypos\lastypos
\fi\fi
\ifdefined\llpos@savepos\ifdefined\ReadonlyShipoutCounter
\newwrite\llpos@out
\AddToHook{begindocument/before}{\immediate\openout\llpos@out=\jobname.llpos\relax}
\newbox\llpos@box
\newcount\llpos@depth
\newcount\llpos@serial
\def\llpos@file{\ifdefined\CurrentFilePath\ifx\CurrentFilePath\@empty\else\CurrentFilePath/\fi\fi\ifdefined\CurrentFile\CurrentFile\fi}
\def\llpos@begin{\global\advance\llpos@depth\@ne}
\def\llpos@after#1{%
  \ifnum\llpos@depth=\@ne
    \ifhmode
      \setbox\llpos@box\lastbox
      \ifvoid\llpos@box\else
        \global\advance\llpos@serial\@ne
        \llpos@savepos
        \edef\llpos@tmp{\noexpand\write\llpos@out{\noexpand\string\noexpand\llpos
          {\the\llpos@serial}{#1}{\noexpand\the\noexpand\ReadonlyShipoutCounter}%
          {\noexpand\the\noexpand\llpos@xpos}{\noexpand\the\noexpand\llpos@ypos}%
          {\number\wd\llpos@box}{\number\ht\llpos@box}{\number\dp\llpos@box}%
          {\llpos@file}{\the\inputlineno}}}%
        \llpos@tmp
        \box\llpos@box
      \fi
    \fi
  \fi
  \global\advance\llpos@depth\m@ne}
\def\llpos@hook#1{%
  \AddToHook{env/#1/begin}{\llpos@begin}%
  \AddToHook{env/#1/after}{\llpos@after{#1}}}
${[...RECORDED_ENVS].map((e) => `\\llpos@hook{${e}}`).join("")}
\fi\fi
\makeatother
`;

/** `\input` of a file for a TeX command line or pretex code: forward slashes (Windows too). */
export function texInput(path: string): string {
  return `\\input{${path.replace(/\\/g, "/")}}`;
}

/** One recorded box: PDF points (bp) from the page's bottom left. */
export interface PosRecord {
  readonly serial: number;
  readonly env: string;
  /** 1-based PDF page. */
  readonly page: number;
  /** The box's left edge and its bottom (baseline minus depth). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** Height plus depth. */
  readonly height: number;
  /** Absolute (resolved against the root's folder), as `toLogical` maps it. */
  readonly file: string;
  /** 1-based: the line TeX read when the environment ended. */
  readonly line: number;
}

/** sp per bp. */
const SP_PER_BP = 65536 * 72.27 / 72;

/** The records of a `.llpos` file's text, in serial order. */
export function parseLlpos(text: string, rootDir: string, toLogical: (p: string) => string = resolve): PosRecord[] {
  const out: PosRecord[] = [];
  for (const m of text.matchAll(/^\\llpos\{(\d+)\}\{([^{}]*)\}\{(-?\d+)\}\{(-?\d+)\}\{(-?\d+)\}\{(-?\d+)\}\{(-?\d+)\}\{(-?\d+)\}\{([^\r\n]*)\}\{(\d+)\}\r?$/gm)) {
    const [serial, page, x, y, wd, ht, dp, line] = [m[1], m[3], m[4], m[5], m[6], m[7], m[8], m[10]].map(Number);
    out.push({
      serial,
      env: m[2],
      page,
      x: x / SP_PER_BP,
      y: (y - dp) / SP_PER_BP,
      width: wd / SP_PER_BP,
      height: (ht + dp) / SP_PER_BP,
      file: toLogical(resolve(rootDir, m[9])),
      line,
    });
  }
  return out.sort((a, b) => a.serial - b.serial);
}

/** The records next to `pdfPath` (`<job>.llpos`), or null without the file. */
export function readLlpos(pdfPath: string, rootDir: string, toLogical?: (p: string) => string): PosRecord[] | null {
  let text: string;
  try {
    text = readFileSync(pdfPath.replace(/\.pdf$/i, "") + ".llpos", "utf8");
  } catch {
    return null;
  }
  return parseLlpos(text, rootDir, toLogical);
}
