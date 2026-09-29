import assert from "node:assert/strict";
import { test } from "node:test";
import { TokState, tokenizeLine } from "../src/editor/latexHighlight";

function tokens(lines: string[]): [string, string][] {
  const s: TokState = { math: null, verbatim: null };
  const out: [string, string][] = [];
  for (const line of lines) {
    tokenizeLine(line, 0, s, (from, to, cls) => out.push([line.slice(from, to), cls]));
  }
  return out;
}

test("commands, comments, escapes", () => {
  assert.deepEqual(tokens(["\\textbf{x} 50\\% % note"]), [
    ["\\textbf", "ll-command"],
    ["{", "ll-bracket"],
    ["}", "ll-bracket"],
    ["\\%", "ll-escape"],
    ["% note", "ll-comment"],
  ]);
});

test("inline and display math", () => {
  const t = tokens(["a $x^2 \\alpha$ b \\[ y \\]"]);
  assert.deepEqual(t, [
    ["$", "ll-math-delim"],
    ["x^2 ", "ll-math"],
    ["\\alpha", "ll-command ll-in-math"],
    ["$", "ll-math-delim"],
    ["\\[", "ll-math-delim"],
    [" y ", "ll-math"],
    ["\\]", "ll-math-delim"],
  ]);
});

test("math environments span lines", () => {
  const t = tokens(["\\begin{align}", "a &= b", "\\end{align}", "text"]);
  assert.deepEqual(t, [
    ["\\begin", "ll-keyword"],
    ["align", "ll-env"],
    ["a &= b", "ll-math"],
    ["\\end", "ll-keyword"],
    ["align", "ll-env"],
  ]);
});

test("verbatim content is not tokenized", () => {
  const t = tokens(["\\begin{verbatim}", "\\notacommand % x", "\\end{verbatim}"]);
  assert.deepEqual(t, [
    ["\\begin", "ll-keyword"],
    ["verbatim", "ll-env"],
    ["\\notacommand % x", "ll-verbatim"],
    ["\\end", "ll-keyword"],
    ["verbatim", "ll-env"],
  ]);
});

test("reference arguments and sections", () => {
  assert.deepEqual(tokens(["\\section{A} \\cite[p.~3]{knuth}"]), [
    ["\\section", "ll-section"],
    ["{", "ll-bracket"],
    ["}", "ll-bracket"],
    ["\\cite", "ll-command"],
    ["knuth", "ll-ref"],
  ]);
});

test("a trailing lone backslash does not throw", () => {
  assert.deepEqual(tokens(["text \\", "\\] \\"]), [
    ["\\", "ll-escape"],
    ["\\]", "ll-escape"],
    ["\\", "ll-escape"],
  ]);
});

test("\\iffalse first on its line comments out text up to its \\fi or \\else, nested conditionals counted", () => {
  const t = tokens(["\\iffalse", "$x$ \\ifx\\a\\b $y$ \\fi \\ifdef{\\z}{}{} $A \\iff B$", "\\fi $z$", "a \\iffalse \\let\\ifx\\iffalse"]);
  assert.deepEqual(t.slice(0, 4), [
    ["\\iffalse", "ll-keyword"],
    ["$x$ \\ifx\\a\\b $y$ \\fi \\ifdef{\\z}{}{} $A \\iff B$", "ll-comment"],
    ["\\fi", "ll-keyword"],
    ["$", "ll-math-delim"],
  ]);
  assert.ok(!t.slice(4).some(([, cls]) => cls === "ll-comment"), "not first on its line: code, never a comment");
});

test("tcolorbox's, fancyvrb's and filecontents' verbatim environments are not tokenized", () => {
  for (const env of ["tcblisting", "BVerbatim", "Verbatim*", "filecontents*"]) {
    assert.deepEqual(tokens([`\\begin{${env}}`, "$x$ \\cite{k}", `\\end{${env}}`])[2], ["$x$ \\cite{k}", "ll-verbatim"], env);
  }
});
