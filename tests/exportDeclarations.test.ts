import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { definitionStatements, emptyDefinitions, mergeDefinitions, projectDefinitions } from "../src/tex/macros";
import { projectSignatures } from "../src/export/signatures";

const temps: string[] = [];
after(() => { for (const path of temps) rmSync(path, { recursive: true, force: true }); });
function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-export-declarations-"));
  temps.push(dir);
  for (const [name, text] of Object.entries(files)) { mkdirSync(join(dir, name, ".."), { recursive: true }); writeFileSync(join(dir, name), text); }
  return { dir, root: join(dir, "main.tex") };
}

test("parser declarations keep full unsupported bodies while MathJax's error text stays shortened", () => {
  const declaration = `\\newcommand{\\consumer}[2]{\\@reader{${"long body ".repeat(40)}}{#1}{#2}}`;
  const { root } = project({ "main.tex": `\\documentclass{article}\n${declaration}\n\\begin{document}Text.\\end{document}` });
  const defs = projectDefinitions(root);
  assert.equal(defs.declarations?.get("consumer"), declaration);
  assert.ok(defs.declarations!.get("consumer")!.length > 300);
  assert.equal(defs.unsupported.get("consumer")?.length, 81);
  assert.ok(defs.unsupported.get("consumer")?.endsWith("…"));
  assert.deepEqual(defs.statements, [], "the full declaration is never fed to MathJax");
});

test("makeatletter inside a macro body cannot erase a later public reader declaration", () => {
  const source = String.raw`\documentclass{article}
\newcommand{\prepare}{\makeatletter}
\def\section{\if@firstsection\maketitle\global\@firstsectionfalse\fi\@startsection{section}{1}{\z@}{4pt}{2pt}{\bfseries}}
\def\hidden@reader#1{#1}
\makeatother
\begin{document}\section{Dynamics}\end{document}`;
  const { root } = project({ "main.tex": source });
  const defs = projectDefinitions(root);
  assert.match(defs.declarations!.get("section")!, /\\@startsection\{section\}/);
  assert.equal(projectSignatures(defs, [source], new Map()).macros.get("section"), "s o m");
  assert.equal(defs.declarations?.has("hidden"), false, "a native internal control sequence is not a public name prefix");
  assert.deepEqual(defs.statements, definitionStatements(source), "MathJax retains exactly its existing filtered stream");
  assert.equal(defs.unsupported.has("section"), false, "parser-only native internals do not become MathJax errors");
});

test("parser provide rules honor a public definition omitted by MathJax's makeatletter filter", () => {
  const declaration = String.raw`\newcommand{\consumer}[2]{\@reader{#1}{#2}}`;
  const source = `\\documentclass{article}\n\\makeatletter\n${declaration}\n\\makeatother\n\\providecommand{\\consumer}[1]{Wrong fallback #1}\n\\begin{document}Text.\\end{document}`;
  const { root } = project({ "main.tex": source });
  const defs = projectDefinitions(root);
  assert.equal(defs.declarations?.get("consumer"), declaration);
  assert.equal(projectSignatures(defs, [source], new Map()).macros.get("consumer"), "m m");
  assert.deepEqual(defs.statements, definitionStatements(source), "the MathJax provide/defined set remains independent");
});

test("declarations follow input sites and later explicit overrides, including unsaved buffers", () => {
  const source = String.raw`\documentclass{article}
\newcommand{\consumer}[1]{Root #1}
\input{parts/definitions}
\renewcommand{\consumer}[3]{Late #1 #2 #3}
\providecommand{\consumer}[4]{Ignored #1 #2 #3 #4}
\begin{document}Text.\end{document}`;
  const { dir, root } = project({ "main.tex": source, "parts/definitions.tex": String.raw`\renewcommand{\consumer}[2]{Imported #1 #2}` });
  const defs = projectDefinitions(root);
  assert.equal(defs.declarations?.get("consumer"), String.raw`\renewcommand{\consumer}[3]{Late #1 #2 #3}`);
  assert.equal(projectSignatures(defs, [], new Map()).macros.get("consumer"), "m m m");
  const edited = source.replace(String.raw`\renewcommand{\consumer}[3]{Late #1 #2 #3}`, String.raw`\renewcommand{\consumer}[2]{Unsaved #1 #2}`);
  const updated = projectDefinitions(root, new Map([[root, edited], [join(dir, "parts/definitions.tex"), String.raw`\renewcommand{\consumer}[5]{Imported #1 #2 #3 #4 #5}`]]));
  assert.equal(updated.declarations?.get("consumer"), String.raw`\renewcommand{\consumer}[2]{Unsaved #1 #2}`);
  assert.equal(projectSignatures(updated, [], new Map()).macros.get("consumer"), "m m");
  assert.equal(readFileSync(root, "utf8"), source, "reading unsaved declarations does not rewrite source bytes");
});

test("mergeDefinitions carries complete effective declarations with the extra source taking priority", () => {
  const base = { ...emptyDefinitions(), declarations: new Map([["consumer", String.raw`\newcommand{\consumer}[1]{Base #1}`], ["other", String.raw`\newcommand{\other}{Other}`]]) };
  const extra = { ...emptyDefinitions(), declarations: new Map([["consumer", String.raw`\renewcommand{\consumer}[2]{Extra #1 #2}`]]) };
  const merged = mergeDefinitions(base, extra);
  assert.equal(merged.declarations?.get("consumer"), extra.declarations.get("consumer"));
  assert.equal(merged.declarations?.get("other"), base.declarations.get("other"));
  assert.notEqual(merged.declarations, base.declarations);
  assert.notEqual(merged.declarations, extra.declarations);
});
