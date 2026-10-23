// Beamer decks (docs/beamer.md): detection of banners, image and layout macros (envRules), the
// frames counted per file in reading order, the .nav's pages (src/tex/beamer.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { deckFrames, navPages } from "../src/tex/beamer";
import { detectEnvRules, frameStarts, mergeEnvRules, EMPTY_USER_RULES } from "../src/tex/envRules";

const PREAMBLE = [
  "\\documentclass[aspectratio=169]{beamer}",
  "\\newlength{\\DeckItemSkip}",
  "\\newcommand{\\DeckFamily@grouped}{\\setlength{\\DeckItemSkip}{6pt}}",
  "\\newcommand{\\DeckFamily@table}{\\renewcommand{\\arraystretch}{1.2}}",
  "\\newcommand{\\DeckLayout}[1]{\\csname DeckFamily@#1\\endcsname}",
  "\\newcommand{\\DeckGap}{\\par\\addvspace{\\DeckItemSkip}}",
  "\\newcommand{\\DeckOdd}[1]{\\csname DeckNone@#1\\endcsname}", // no such family: not guessed
  "\\newcommand{\\sectionframe}[3]{\\begin{frame}[plain]\\centering{\\Huge #1}\\\\#2\\\\#3\\end{frame}}",
  "\\newcommand{\\DeckFigure}[2][]{\\centering\\includegraphics[#1]{#2}}",
  "\\newcommand{\\R}{\\mathbb{R}}",
  "\\newcommand{\\Note}[1]{\\textbf{#1}}",
].join("\n");

test("detection in beamer: layout macros hidden, frame macros banners, \\includegraphics macros images", () => {
  const d = detectEnvRules([PREAMBLE]);
  assert.equal(d.beamer, true);
  assert.deepEqual([...d.hidden.keys()].sort(), ["DeckFamily@grouped", "DeckFamily@table", "DeckGap", "DeckLayout"]);
  assert.deepEqual([...d.banners], [["sectionframe", { args: 3, optional: false }]]);
  assert.deepEqual([...d.images], [["DeckFigure", { args: 2, optional: true, path: 2 }]]);
  const rules = mergeEnvRules(EMPTY_USER_RULES, d);
  assert.ok(rules.hidden.has("pause") && rules.hidden.has("small"), "beamer hides \\pause and font sizes");
  assert.ok(rules.wrappers.has("columns") && rules.wrappers.has("column"));
  const paper = detectEnvRules([PREAMBLE.replace("{beamer}", "{article}")]);
  assert.equal(paper.beamer, false);
  assert.deepEqual([...paper.banners], [], "papers: no banners");
  assert.deepEqual([...paper.images], []);
  assert.equal(paper.hidden.has("DeckLayout"), false, "\\csname is a layout only in beamer");
  assert.equal(mergeEnvRules(EMPTY_USER_RULES, paper).hidden.has("pause"), false);
});

test("detection in beamer: a register filled while typesetting or a discarded argument stays source", () => {
  const d = detectEnvRules([
    [
      PREAMBLE,
      "\\newcommand{\\DeckNotes}{}", // filled by \appto below
      "\\newcommand{\\DeckSkip}[1]{\\setlength{\\DeckItemSkip}{6pt}}", // #1 unused
      "\\newcommand{\\DeckUses}{\\DeckSkip{x}\\DeckGap}", // through a command that stays source
      "\\newcommand{\\DeckPart}[1]{\\DeckFigure{#1}\\DeckNotes}", // its layout part is a register
    ].join("\n"),
    "\\appto\\DeckNotes{\\item later}",
  ]);
  assert.deepEqual([...d.hidden.keys()].sort(), ["DeckFamily@grouped", "DeckFamily@table", "DeckGap", "DeckLayout"]);
  assert.deepEqual([...d.images.keys()], ["DeckFigure"], "an image macro around a register is not an image");
  assert.deepEqual([...d.banners.keys()], ["sectionframe"]);
});

test("detection in beamer: long chains of layout macros and of assigning macros, each defined before the one it uses", () => {
  const name = (i: number) => "Lay" + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
  const lines = ["\\documentclass{beamer}"];
  // \Layaa .. \Layln, each using the next: only the last one is a layout by itself.
  for (let i = 0; i < 300; i++) lines.push(`\\newcommand{\\${name(i)}}{${i < 299 ? `\\${name(i + 1)}` : "\\small"}\\centering}`);
  // \Pass<k> hands its argument on to \Pass<k+1>, the last one \defs it: every \Val<k> is a register.
  const pass = (i: number) => "Pass" + name(i).slice(3);
  for (let i = 0; i < 200; i++) lines.push(`\\newcommand{\\${pass(i)}}[1]{${i < 199 ? `\\${pass(i + 1)}{#1}` : "\\def#1{x}"}}`, `\\newcommand{\\Val${name(i).slice(3)}}{}`);
  lines.push(...Array.from({ length: 200 }, (_, i) => `\\${pass(i)}{\\Val${name(i).slice(3)}}`));
  const t = performance.now();
  const d = detectEnvRules([lines.join("\n")]);
  const ms = performance.now() - t;
  assert.equal([...d.hidden.keys()].filter((n) => n.startsWith("Lay")).length, 300);
  assert.equal([...d.hidden.keys()].filter((n) => n.startsWith("Val")).length, 0);
  // A name found re-checks only the macros naming it (4 s here when every pass read every macro).
  assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
});

test("frameStarts:\\begin{frame} and banner calls outside comments; a root's from \\begin{document}", () => {
  const banners = new Map([["sectionframe", { args: 3, optional: false }]]);
  const s = "\\sectionframe{a}{b}{c}\n% \\begin{frame}\n\\begin{frame}{x}\n\\end{frame}\n\\sectionframes{no}";
  assert.deepEqual(frameStarts(s, banners).map((i) => s.slice(i, i + 6)), ["\\secti", "\\begin"]);
  const root = `${PREAMBLE}\n\\begin{document}\n\\begin{frame}\\end{frame}\n\\end{document}`;
  assert.equal(frameStarts(root, banners, true).length, 1, "the definition in the preamble is no frame");
});

test("deck: the .nav's pages, the frames per file in reading order", () => {
  assert.deepEqual(navPages("\\headcommand {\\beamer@framepages {1}{1}}\n\\headcommand {\\beamer@framepages {2}{4}}"), [
    { first: 1, last: 1 },
    { first: 2, last: 4 },
  ]);
  const dir = resolve("/deck");
  const files: Record<string, string> = {
    [join(dir, "main.tex")]: [
      "\\documentclass{beamer}",
      "\\input{preamble}",
      "\\title[Short]{Long \\\\ title}\\author{A \\and B}\\date[x]{Master\\textquotesingle s talk \\\\[3pt] 2026}",
      "\\begin{document}",
      "\\begin{frame}\\titlepage\\end{frame}",
      "\\input{slides/one}",
      "\\begin{frame}{between}\\end{frame}",
      "\\input{slides/two}",
      "% \\input{slides/three}",
      "\\end{document}",
    ].join("\n"),
    [join(dir, "preamble.tex")]: "\\institute{Uni}\n\\begin{frame}never counted\\end{frame}",
    [join(dir, "slides/one.tex")]: "\\begin{frame}a\\end{frame}\n\\sectionframe{x}{y}{z}\n\\begin{frame}b\\end{frame}",
    [join(dir, "slides/two.tex")]: "\\begin{frame}c\\end{frame}",
  };
  const text = (p: string) => files[p] ?? null;
  const banners = new Map([["sectionframe", { args: 3, optional: false }]]);
  const f = deckFrames(join(dir, "main.tex"), banners, text);
  assert.equal(f.total, 6);
  assert.deepEqual(f.files.get(join(dir, "slides/one.tex")), { offset: 1, count: 3 });
  assert.deepEqual(f.files.get(join(dir, "slides/two.tex")), { offset: 5, count: 1 });
  assert.equal(f.files.has(join(dir, "preamble.tex")), false, "the preamble's \\input is not the body");
});
