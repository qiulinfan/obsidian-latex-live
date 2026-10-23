import { Extension, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

// Where a jump lands (inverse SyncTeX, problem list, outline) and the flash that shows it.
//   Flash     the target line gets `ll-reveal-flash` for FLASH_MS: the cursor alone, at column 0
//             of a long wrapped line or behind a rendered formula, is easy to miss.
//   Click     SyncTeX answers with a line only, and inside a paragraph often the wrong one: TeX
//             breaks a paragraph into lines after reading all of it, so its boxes carry the line
//             of the paragraph's end (or start). A double-click in the PDF selects a word in its
//             text layer; that word, matched in the source paragraph around SyncTeX's line and
//             told apart from its other occurrences by the PDF words around it, places the cursor.

export const FLASH_MS = 1500;
/** How far from SyncTeX's line the paragraph is searched, never across a blank line. */
const PARA_REACH = 40;
/** PDF words on each side of the clicked one that tell its occurrences apart. */
const CONTEXT_WORDS = 6;
/** Source words on each side of an occurrence they are looked for in (macros add a few). */
const SOURCE_WINDOW = 12;

const flashEffect = StateEffect.define<number | null>({
  map: (pos, mapping) => (pos === null ? null : mapping.mapPos(pos)),
});
const flashMark = Decoration.line({ class: "ll-reveal-flash" });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashEffect)) continue;
      deco = e.value === null ? Decoration.none : Decoration.set(flashMark.range(tr.state.doc.lineAt(e.value).from));
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The flash's state; part of the LaTeX editor's extensions. */
export const revealFlash: Extension = flashField;

const timers = new WeakMap<EditorView, number>();

/** Flash the line holding `pos` for FLASH_MS. */
export function flashLine(view: EditorView, pos: number): void {
  if (!view.state.field(flashField, false)) return;
  const win = view.dom.ownerDocument.defaultView ?? window;
  const old = timers.get(view);
  if (old !== undefined) win.clearTimeout(old);
  view.dispatch({ effects: flashEffect.of(pos) });
  timers.set(view, win.setTimeout(() => {
    timers.delete(view);
    view.dispatch({ effects: flashEffect.of(null) });
  }, FLASH_MS));
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** The longest letter/digit run of a PDF text selection (ligatures unfolded), or null. */
export function wordOf(selection: string): string | null {
  const runs = selection.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  const word = runs.reduce((a, b) => (b.length > a.length ? b : a), "");
  return word.length >= 2 || CJK.test(word) ? word : null;
}

/** The double-clicked word and the PDF text before and after it on the page. */
export interface ClickText {
  word: string;
  before: string;
  after: string;
}

interface Token {
  text: string;
  from: number;
}

const WORDS = /[\p{L}\p{N}]+/gu;
// Command names, escaped characters and comments are not text in the PDF, nor the arguments of
// commands that name things (environments, labels, keys, files).
const SOURCE_WORDS = /\\(?:begin|end|label|[cC]?ref|eqref|autoref|pageref|cite[a-zA-Z]*|input|include|includegraphics|usepackage|documentclass|bibliography[a-zA-Z]*)\*?(?:\s*\[[^\]]*\])*\s*\{[^}]*\}|\\(?:[A-Za-z@]+|.)|%.*|([\p{L}\p{N}]+)/gu;

export function sourceTokens(src: string): Token[] {
  const out: Token[] = [];
  for (const m of src.matchAll(SOURCE_WORDS)) if (m[1]) out.push({ text: m[1], from: m.index! });
  return out;
}

/** The words of LaTeX source as they can appear in the PDF: command names and comments dropped. */
export function sourceWords(src: string): string[] {
  return sourceTokens(src).map((t) => t.text);
}

function pdfWords(text: string): string[] {
  return (text.normalize("NFKC").match(WORDS) ?? []).flatMap((word) =>
    word.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [],
  ).map((w) => w.toLowerCase());
}

/**
 * The 1-based line and 0-based column of the clicked word in the source paragraph holding
 * SyncTeX's `line` (up to PARA_REACH lines either way, never across a blank line), or null when
 * the word is not there. Occurrences are a whole word, else a part of one (a word hyphenated
 * across PDF lines, CJK text); each scores the PDF words around the click found next to it in
 * the source, and ties go to the one nearest SyncTeX's line.
 */
export function locateClick(doc: Text, line: number, click: ClickText): { line: number; column: number } | null {
  if (!click.word) return null;
  line = Math.min(Math.max(line, 1), doc.lines);
  let first = line, last = line;
  while (first > 1 && line - first < PARA_REACH && doc.line(first - 1).text.trim()) first--;
  while (last < doc.lines && last - line < PARA_REACH && doc.line(last + 1).text.trim()) last++;
  const start = doc.line(first).from;
  const tokens = sourceTokens(doc.sliceString(start, doc.line(last).to));
  let hits = tokens.flatMap((t, i) => (t.text === click.word ? [{ i, column: 0 }] : []));
  if (!hits.length) {
    hits = tokens.flatMap((t, i) => {
      const matches: { i: number; column: number }[] = [];
      for (let at = t.text.indexOf(click.word); at >= 0; at = t.text.indexOf(click.word, at + 1)) {
        matches.push({ i, column: at });
      }
      return matches;
    });
  }
  if (!hits.length) return null;
  const before = pdfWords(click.before).slice(-CONTEXT_WORDS);
  const after = pdfWords(click.after).slice(0, CONTEXT_WORDS);
  let best: { score: number; distance: number; pos: number } | null = null;
  for (const { i, column } of hits) {
    // Include the current token's two sides: a Chinese sentence has no word separators.
    const left = new Set(pdfWords([
      ...tokens.slice(Math.max(0, i - SOURCE_WINDOW), i).map((t) => t.text),
      tokens[i].text.slice(Math.max(0, column - 200), column),
    ].join(" ").slice(-200)).slice(-SOURCE_WINDOW));
    const right = new Set(pdfWords([
      tokens[i].text.slice(column + click.word.length, column + click.word.length + 200),
      ...tokens.slice(i + 1, i + 1 + SOURCE_WINDOW).map((t) => t.text),
    ].join(" ").slice(0, 200)).slice(0, SOURCE_WINDOW));
    const score = before.filter((w) => left.has(w)).length + after.filter((w) => right.has(w)).length;
    const pos = start + tokens[i].from + column;
    const distance = Math.abs(doc.lineAt(pos).number - line);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { score, distance, pos };
  }
  const at = doc.lineAt(best!.pos);
  return { line: at.number, column: best!.pos - at.from };
}

/**
 * Flash a rendered block (a formula or other widget): a line decoration cannot reach it, since
 * the widget replaces its lines. The class is taken off again after FLASH_MS.
 */
export function flashElement(view: EditorView, el: HTMLElement): void {
  const win = view.dom.ownerDocument.defaultView ?? window;
  el.classList.remove("ll-reveal-flash");
  void el.offsetWidth; // restart the animation when the same block is flashed again
  el.classList.add("ll-reveal-flash");
  win.setTimeout(() => el.classList.remove("ll-reveal-flash"), FLASH_MS);
}
