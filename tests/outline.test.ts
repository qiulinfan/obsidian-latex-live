import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { planExport } from "../src/export/plan";
import { projectDefinitions } from "../src/tex/macros";
import { buildProjectOutline, type OutlineHeading } from "../src/tex/outline";
import { theoremMap } from "../src/tex/theorems";
import { stripComments } from "../src/tex/project";

const temps: string[] = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
function project(body: string, files: Record<string, string> = {}, preamble = "", edits: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-outline-"));
  temps.push(dir);
  const source = `\\documentclass{book}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
  for (const [key, text] of Object.entries({ "main.tex": source, ...files })) {
    mkdirSync(join(dir, key, ".."), { recursive: true });
    writeFileSync(join(dir, key), text);
  }
  const root = join(dir, "main.tex");
  const buffers = new Map(Object.entries(edits).map(([key, text]) => [join(dir, key), text]));
  const defs = projectDefinitions(root, buffers);
  const read = (path: string) => buffers.get(path) ?? readFileSync(path, "utf8");
  return planExport(root, { defs, theorems: theoremMap(defs.files.map((path) => stripComments(read(path)))), read });
}
const flat = (nodes: readonly OutlineHeading[]): OutlineHeading[] => nodes.flatMap((n) => [n, ...flat(n.children)]);

test("outline follows actual input order and nests root headings around imported chapters", () => {
  const plan = project(String.raw`\part{Part A}
\input{chapter}
\section{Root conclusion}
\chapter{Part B}
\input{later}`, {
    "chapter.tex": String.raw`\chapter{Included chapter}\section{First}\subsection{Nested}\section{Second}`,
    "later.tex": String.raw`\section{Later}`,
  });
  const outline = buildProjectOutline(plan);
  assert.deepEqual(flat(outline.headings).map((h) => h.title), ["Part A", "Included chapter", "First", "Nested", "Second", "Root conclusion", "Part B", "Later"]);
  assert.equal(outline.headings[0].children[0].title, "Included chapter");
  assert.equal(outline.headings[0].children[0].children[2].title, "Root conclusion");
  assert.equal(outline.headings[0].children[1].children[0].key, "later.tex");
  assert.equal(outline.count, 8);
});

test("short/starred/multiline/balanced titles keep exact navigation and ignore title-contained fake headings", () => {
  const plan = project(String.raw`  \section*[Short]{A \textbf{long}
title with {braces} and $x$}
\subsection{Child}
\section{Title \section{fake} retained as text}`);
  const headings = flat(buildProjectOutline(plan).headings);
  assert.deepEqual(headings.map((h) => h.title), ["A long title with braces and x", "Child", "Title fake retained as text"]);
  assert.equal(headings[0].starred, true);
  assert.equal(headings[0].line, 4);
  assert.equal(headings[0].column, 2);
  assert.equal(plan.files.get("main.tex")!.src.slice(headings[0].from, headings[0].to).startsWith("\\section*"), true);
});

test("preamble/definitions/comments/verbatim/math and false branches produce no headings", () => {
  const plan = project(String.raw`% \section{Comment}
\newcommand{\demo}{\section{Definition}}
\begin{verbatim}
\section{Verbatim}
\end{verbatim}
\verb|\section{Inline raw}|
$\section{Math}$
\begin{align}\section{Math env}\end{align}
\iffalse
\section{False branch}
\else
\section{True branch}
\fi
\section{Real}`, {}, String.raw`\section{Preamble}`);
  assert.deepEqual(flat(buildProjectOutline(plan).headings).map((h) => h.title), ["True branch", "Real"]);
});

test("import contexts/subfiles/repeated inputs/includeonly use the planner's exact visits", () => {
  const plan = project(String.raw`\chapter{Base}
\import{one/}{chapter}
\import{two/}{chapter}
\input{repeat}\input{repeat}
\subfile{standalone}
\include{included}\include{excluded}`, {
    "one/chapter.tex": String.raw`\section{One}\subimport{sub/}{piece}`,
    "one/sub/piece.tex": String.raw`\subsection{One nested}`,
    "two/chapter.tex": String.raw`\section{Two}`,
    "repeat.tex": String.raw`\subsection{Repeated}`,
    "standalone.tex": String.raw`\documentclass{article}\section{Not body}\begin{document}\section{Subfile body}\end{document}\section{After body}`,
    "included.tex": String.raw`\section{Included}`,
    "excluded.tex": String.raw`\section{Excluded}`,
  }, String.raw`\includeonly{included}`);
  const headings = flat(buildProjectOutline(plan).headings);
  assert.deepEqual(headings.map((h) => h.title), ["Base", "One", "One nested", "Two", "Repeated", "Repeated", "Subfile body", "Included"]);
  const repeat = headings.filter((h) => h.title === "Repeated");
  assert.equal(repeat[0].file, repeat[1].file);
  assert.notEqual(repeat[0].id, repeat[1].id);
  assert.equal(headings[2].key, "one/sub/piece.tex");
});

test("outline is bounded for cycles and reports a display limit without losing navigation", () => {
  const plan = project(String.raw`\chapter{Base}\input{cycle}`, { "cycle.tex": String.raw`\section{Cycle}\input{cycle}` });
  const normal = buildProjectOutline(plan);
  assert.ok(normal.count <= 34 && normal.count > 1);
  const limited = buildProjectOutline(plan, 3);
  assert.equal(limited.count, 3);
  assert.equal(limited.truncated, true);
});

test("committed unsaved sources win and incomplete titles stay out of the outline", () => {
  const plan = project(String.raw`\chapter{Root}\input{chapter}`, { "chapter.tex": String.raw`\section{Disk}` }, "", {
    "chapter.tex": "\\section{Committed}\n\\subsection{Half typed",
  });
  assert.deepEqual(flat(buildProjectOutline(plan).headings).map((h) => h.title), ["Root", "Committed"]);
});
