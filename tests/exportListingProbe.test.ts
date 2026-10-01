import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { planExport } from "../src/export/plan";
import { prepareWorkDir, runProbe } from "../src/export/probe";
import { readProbeLog, StepQueue, type ProbeListing } from "../src/export/probeLog";
import { projectDefinitions } from "../src/tex/macros";
import { theoremMap } from "../src/tex/theorems";
import { nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

const dirs: string[] = [];
after(() => { removeExportTemps(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const skip = !texBin && "no TeX installation found";
const compact = (style: string) => style.replace(/\s+/g, "");
function planOf(root: string) {
  const defs = projectDefinitions(root);
  return planExport(root, { defs, theorems: theoremMap(defs.files.map((f) => readFileSync(f, "utf8"))) });
}
function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-listing-probe-")); dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return { dir, root: join(dir, "main.tex") };
}

test("listing queues preserve visit/line/order and ignore settings inside SVG fragments", () => {
  const record = (language: string, line: number) => `llxlisting{${language}}{}{\\color {red}}{\\itshape}{}{parts}{same.tex}{${line}}`;
  const log = readProbeLog([
    "llxin{parts}{same.tex}{4}", record("python", 2), record("c", 2),
    "llxopen{0}", record("ruby", 3), "llxclose{0}", "llxout{parts}{same.tex}",
    "llxin{parts}{same.tex}{5}", record("java", 2), "llxout{parts}{same.tex}",
  ].join("\n"));
  const queue = new StepQueue(log, [{ key: "main.tex", occ: 0 }, { key: "parts/same.tex", occ: 0 }, { key: "parts/same.tex", occ: 1 }]);
  const first = { visit: 1, from: 2, to: 2 };
  assert.equal(queue.takeListing(first)?.language, "python");
  assert.equal(queue.takeListing(first)?.language, "c");
  assert.equal(queue.takeListing({ visit: 1, from: 3, to: 3 }), null);
  assert.equal(queue.takeListing({ visit: 2, from: 2, to: 2 })?.language, "java");
  assert.equal(queue.takeListing({ visit: 2, from: 2, to: 2 }), null);
  assert.equal(log.listings[2].frag, 0);
  assert.equal(log.unreadable, 0);
  const afterInput = readProbeLog([
    "llxin{parts}{same.tex}{4}", "llxout{parts}{same.tex}",
    "llxlisting{python}{}{}{}{}{}{main.tex}{4}",
  ].join("\n"));
  const afterQueue = new StepQueue(afterInput, [{ key: "main.tex", occ: 0 }, { key: "parts/same.tex", occ: 0 }]);
  assert.equal(afterQueue.takeListing({ visit: 1, from: 1, to: 1 }), null);
  assert.equal(afterQueue.takeListing({ visit: 0, from: 4, to: 4 })?.language, "python", "an empty child cannot discard a parent listing later on the input's line");
});

test("real listings Init captures global/local/style/group settings for all listing forms", { skip, timeout: 60_000 }, async () => {
  const main = String.raw`\documentclass{article}
\usepackage{xcolor,listings,multirow}
\newcommand\MyKeyword{\color{blue}\bfseries}
\lstdefinestyle{base}{language=Python,keywordstyle=\MyKeyword,commentstyle=\itshape}
\lstdefinestyle{child}{style=base,stringstyle=\color{blue}}
\lstset{language=Python,keywordstyle={\color{red}\bfseries},commentstyle={\color{gray}},stringstyle={\color{green}}}
\begin{document}
\lstinline|return "global"|
\lstinline[style=child]|return "inherited"|
\lstinline|return "after style"|
\lstinline[language={[ANSI]C},keywordstyle=\color{orange}]|int x=0;|
\lstinline|return "after local"|
\lstset{language=Java,keywordstyle=\color{purple}}
\begin{lstlisting}
public int x=0;
\end{lstlisting}
{\lstset{language=Python,stringstyle=\ttfamily}\escapechar=-1\lstinline|return "group"|}
\lstinline|return "after group"|
\lstinputlisting[language=Python,commentstyle=\color{cyan}]{code.py}
\input{same}
\input{same}
\begin{tabular}{l}
\lstinline[language=Ruby]|def f|\\
\multirow{1}{*}{cell}
\end{tabular}
\end{document}`;
  const { root } = fixture({ "main.tex": main, "same.tex": String.raw`\lstinline[language=Python]|return x| and \lstinline[language={[ANSI]C}]|int x;|` + "\n", "code.py": "return 1\n" });
  const host = nodeExportHost(root);
  const plan = planOf(root);
  await prepareWorkDir(plan, host);
  const result = await runProbe(plan, host);
  assert.ok(result.llx, result.output);
  assert.equal((result.log.match(/(?:^! |\.tex:\d+:)/gm) ?? []).length, 0, result.log.slice(-1500));
  const log = readProbeLog(result.llx!);
  assert.equal(log.unreadable, 0);
  assert.equal(log.listings.length, 14);
  const settings = (record: ProbeListing) => [record.language, compact(record.keywordstyle), compact(record.commentstyle), compact(record.stringstyle)];
  assert.deepEqual(settings(log.listings[0]), ["python", String.raw`\color{red}\bfseries`, String.raw`\color{gray}`, String.raw`\color{green}`]);
  assert.deepEqual(settings(log.listings[1]), ["python", String.raw`\MyKeyword`, String.raw`\itshape`, String.raw`\color{blue}`], "style tokens remain unexpanded");
  assert.deepEqual(settings(log.listings[2]), settings(log.listings[0]), "local style restores global settings");
  assert.equal(log.listings[3].language, "c");
  assert.equal(log.listings[3].dialect, "ansi");
  assert.equal(compact(log.listings[3].keywordstyle), String.raw`\color{orange}`);
  assert.deepEqual(settings(log.listings[4]), settings(log.listings[0]), "local C does not change global Python");
  assert.equal(log.listings[5].language, "java");
  assert.equal(compact(log.listings[5].keywordstyle), String.raw`\color{purple}`);
  assert.equal(log.listings[6].language, "python");
  assert.equal(compact(log.listings[6].stringstyle), String.raw`\ttfamily`);
  assert.equal(log.listings[7].language, "java");
  assert.equal(compact(log.listings[7].stringstyle), String.raw`\color{green}`);
  assert.equal(log.listings[8].language, "python");
  assert.equal(compact(log.listings[8].commentstyle), String.raw`\color{cyan}`);
  assert.deepEqual(log.listings.slice(9, 13).map((r) => r.language), ["python", "c", "python", "c"]);
  assert.notEqual(log.listings[9].visit, log.listings[11].visit);
  assert.equal(log.listings[9].line, log.listings[10].line);
  assert.equal(log.listings[13].frag, plan.fragments[0].id);
  const queue = new StepQueue(log, plan.visits);
  for (const visit of [1, 2]) {
    const span = { visit, from: 1, to: 1 };
    assert.equal(queue.takeListing(span)?.language, "python");
    assert.equal(queue.takeListing(span)?.language, "c");
  }
  assert.equal(queue.takeListing({ visit: 0, from: 22, to: 25 }), null, "the SVG's listing never reaches native code markup");
});

test("an elegantbook listing records the installed class defaults without source-side lstset", { skip, timeout: 60_000 }, async () => {
  const { root } = fixture({ "main.tex": String.raw`\PassOptionsToPackage{fontset=fandol}{ctex}
\documentclass[lang=cn]{elegantbook}
\begin{document}
\lstinline|\def\x{1}|
\end{document}` });
  const host = nodeExportHost(root, { engine: "xelatex" });
  const plan = planOf(root);
  await prepareWorkDir(plan, host);
  const result = await runProbe(plan, host);
  assert.ok(result.llx, result.output);
  assert.equal((result.log.match(/(?:^! |\.tex:\d+:)/gm) ?? []).length, 0);
  const [record] = readProbeLog(result.llx!).listings;
  assert.equal(record.language, "tex");
  assert.equal(record.dialect, "latex");
  assert.equal(compact(record.keywordstyle), String.raw`\color{winered}`);
  assert.equal(compact(record.commentstyle), String.raw`\color{gray}`);
});

test("a document with no listings package produces no listing records or errors", { skip, timeout: 60_000 }, async () => {
  const { root } = fixture({ "main.tex": String.raw`\documentclass{article}\begin{document}Text.\end{document}` });
  const host = nodeExportHost(root);
  const plan = planOf(root);
  await prepareWorkDir(plan, host);
  const result = await runProbe(plan, host);
  assert.ok(result.llx, result.output);
  assert.deepEqual(readProbeLog(result.llx!).listings, []);
  assert.equal((result.log.match(/^! /gm) ?? []).length, 0);
});
