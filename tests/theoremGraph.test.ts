import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildTheoremGraph, type TheoremGraph, type TheoremNode } from "../src/tex/theoremGraph";
import { projectDefinitions } from "../src/tex/macros";
import { theoremMap } from "../src/tex/theorems";
import { stripComments } from "../src/tex/project";
import { planExport } from "../src/export/plan";
import type { AuxLabel } from "../src/tex/aux";

const temps: string[] = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const PREAMBLE = String.raw`\usepackage{amsthm,amsmath}\newtheorem{theorem}{Theorem}\newtheorem{lemma}{Lemma}`;
function project(body: string, options: { cls?: string; preamble?: string; files?: Record<string, string>; edits?: Record<string, string>; labels?: ReadonlyMap<string, AuxLabel> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-theorem-graph-")); temps.push(dir);
  const source = `\\documentclass{${options.cls ?? "article"}}\n${options.preamble ?? PREAMBLE}\n\\begin{document}\n${body}\n\\end{document}\n`;
  const files = { "main.tex": source, ...options.files };
  for (const [key, text] of Object.entries(files)) { mkdirSync(join(dir, key, ".."), { recursive: true }); writeFileSync(join(dir, key), text); }
  const buffers = new Map(Object.entries(options.edits ?? {}).map(([key, text]) => [join(dir, key), key === "main.tex" ? `\\documentclass{${options.cls ?? "article"}}\n${options.preamble ?? PREAMBLE}\n\\begin{document}\n${text}\n\\end{document}` : text]));
  const root = join(dir, "main.tex");
  const defs = projectDefinitions(root, buffers);
  const read = (file: string) => buffers.get(file) ?? readFileSync(file, "utf8");
  const theorems = theoremMap(defs.files.map(file => stripComments(read(file))));
  const plan = planExport(root, { defs, theorems, read, mathOk: () => true });
  return { dir, plan, graph: buildTheoremGraph(plan, theorems, options.labels) };
}
const get = (graph: TheoremGraph, key: string): TheoremNode => { const ids = graph.byLabel.get(key); assert.equal(ids?.length, 1, key); return graph.nodes.get(ids![0])!; };
const pairs = (graph: TheoremGraph) => graph.edges.map(edge => [graph.nodes.get(edge.from)!.labels[0], edge.key]);

test("amsthm inline and long environments keep source ranges and only literal proof ref edges", () => {
  const { graph, plan } = project(String.raw`\begin{lemma}\label{lem:b}Supporting claim.\end{lemma}
\begin{theorem}[A result]\label{thm:a}Statement.
` + "Statement line.\n".repeat(260) + String.raw`\end{theorem}

% adjacency survives blank lines and comments
\begin{proof}
By \ref{lem:b}; \eqref{lem:b} and \cref{lem:b} add no graph edge.
\end{proof}`);
  const node = get(graph, "thm:a");
  assert.equal(node.title, "A result");
  assert.equal(node.proofs[0].association, "following");
  assert.ok(node.statement.to - node.statement.from > 3000);
  assert.equal(node.statement.file, plan.files.get("main.tex")!.abs);
  assert.equal(node.statement.line, 5);
  assert.deepEqual(pairs(graph), [["thm:a", "lem:b"]]);
});

test("contained proofs are owned, removed from statement body, and exposed as precise excluded ranges", () => {
  const { graph } = project(String.raw`\begin{lemma}\label{lem:b}Base.\end{lemma}
\begin{theorem}\label{thm:a}Main statement.
\begin{proof}Use \ref{lem:b}.\end{proof}
After the proof, more statement text.
\end{theorem}`);
  const node = get(graph, "thm:a");
  assert.equal(node.proofs[0].association, "contained");
  assert.equal(node.statement.nodes.some(n => n.t === "env" && n.name === "proof"), false);
  assert.equal(node.statement.excluded?.length, 1);
  assert.equal(node.statement.excluded![0].from, node.proofs[0].from);
  assert.deepEqual(pairs(graph), [["thm:a", "lem:b"]]);
});

test("contained input/group proofs have precise original exclusions without deleting surrounding statement content", () => {
  const { graph, plan } = project(String.raw`\begin{lemma}\label{lem:b}Base.\end{lemma}
\begin{theorem}\label{thm:a}{Grouped statement.\begin{proof}Use \ref{lem:b}.\end{proof} More statement.}\input{contained-proof}\end{theorem}`, {
    files: { "contained-proof.tex": String.raw`\begin{proof}Another \ref{lem:b}.\end{proof}` },
  });
  const node = get(graph, "thm:a");
  assert.equal(node.proofs.length, 2);
  assert.equal(node.statement.excluded?.length, 2);
  const group = node.statement.nodes.find(n => n.t === "group")!;
  assert.ok(group);
  const file = plan.files.get("main.tex")!;
  const doc = file.nodes.find(n => n.t === "env" && n.name === "document");
  assert.ok(doc?.t === "env" && doc.body.some(n => n.t === "env" && n.body.includes(group)), "statement container is an original AST object");
  assert.ok(node.statement.excluded!.some(source => source.key === "contained-proof.tex" && source.visit !== node.statement.visit));
  assert.deepEqual(pairs(graph), [["thm:a", "lem:b"], ["thm:a", "lem:b"]]);
});

test("native optional proof title selects a unique remote statement and never creates a header dependency edge", () => {
  const { graph } = project(String.raw`\begin{lemma}\label{lem:b}Base.\end{lemma}
\begin{theorem}\label{thm:a}A.\end{theorem}
A prose paragraph blocks nearest association.
\section{Later proofs}
\begin{proof}[Proof of \ref{thm:a}]Apply \ref{lem:b}.\end{proof}`);
  assert.equal(get(graph, "thm:a").proofs[0].association, "title-ref");
  assert.deepEqual(pairs(graph), [["thm:a", "lem:b"]]);
});

test("prose and headings block nearby fallback, whereas formatting/labels do not", () => {
  const { graph } = project(String.raw`\begin{theorem}\label{thm:a}A.\end{theorem}
Intervening prose.
\begin{proof}Unbound.\end{proof}
\begin{theorem}\label{thm:b}B.\end{theorem}
\section{New section}\begin{proof}Also unbound.\end{proof}
\begin{theorem}\label{thm:c}C.\end{theorem}
\label{outside}\medskip\begin{proof}Attached.\end{proof}`);
  assert.equal(get(graph, "thm:a").proofs.length, 0);
  assert.equal(get(graph, "thm:b").proofs.length, 0);
  assert.equal(get(graph, "thm:c").proofs.length, 1);
  assert.equal(graph.unresolved.filter(d => d.kind === "unassociated-proof").length, 2);
});

test("elegantbook implicit prefixed and explicit unprefixed labels follow the real argument protocol", () => {
  const { graph } = project(String.raw`\begin{lemma}{Supporting claim}{b}Base.\end{lemma}
\begin{theorem}{Named result}{a}Statement.\end{theorem}
\begin{proof}[Literal body \ref{thm:a}]Use \ref{lem:b}.\end{proof}
\begin{theorem}[Another]\label{explicit-key}Statement.\end{theorem}`, { cls: "elegantbook", preamble: "" });
  assert.equal(get(graph, "thm:a").title, "Named result");
  assert.equal(get(graph, "explicit-key").labels.includes("thm:explicit-key"), false);
  assert.equal(get(graph, "thm:a").proofs[0].association, "following", "fancy proof accepts no optional title, so bracket text is body");
  assert.deepEqual(pairs(graph), [["thm:a", "thm:a"], ["thm:a", "lem:b"]]);
});

test("LNCS native theorem and proof declarations are recognized", () => {
  const { graph } = project(String.raw`\begin{lemma}[Base]\label{lem:b}Base.\end{lemma}
\begin{theorem}[Claim]\label{thm:a}Result.\end{theorem}
\begin{proof}[Proof of \ref{thm:a}]Use \ref{lem:b}.\end{proof}`, { cls: "llncs", preamble: "" });
  assert.equal(get(graph, "thm:a").name, "Theorem");
  assert.equal(get(graph, "thm:a").proofs[0].association, "title-ref");
  assert.deepEqual(pairs(graph), [["thm:a", "lem:b"]]);
});

test("proofs and statement labels traverse exact input contexts and unsaved buffers", () => {
  const { graph, dir } = project(String.raw`\begin{lemma}\label{lem:old}Old.\end{lemma}
\begin{lemma}\label{lem:new}New.\end{lemma}
\import{chapter/}{statement}
\input{proof}`, {
    files: {
      "chapter/statement.tex": String.raw`\begin{theorem}\textbf{\label{thm:a}Statement}\input{label}\end{theorem}`,
      "chapter/label.tex": String.raw`\label{thm:alias}`,
      "label.tex": String.raw`\label{wrong-context}`,
      "proof.tex": String.raw`\begin{proof}\input{proof-body}\end{proof}`,
      "proof-body.tex": String.raw`Use \ref{lem:old}.`,
    }, edits: { "proof-body.tex": String.raw`Use \ref{lem:new}.` },
  });
  const node = get(graph, "thm:a");
  assert.deepEqual(node.labels, ["thm:a", "thm:alias"]);
  assert.equal(graph.byLabel.has("wrong-context"), false);
  assert.equal(node.proofs[0].file, join(dir, "proof.tex"));
  assert.deepEqual(pairs(graph), [["thm:a", "lem:new"]]);
  assert.equal(graph.edges[0].evidence.file, join(dir, "proof-body.tex"));
});

test("missing input blocks fallback but includeonly-excluded content does not", () => {
  const missing = project(String.raw`\begin{theorem}\label{thm:a}A.\end{theorem}\include{missing}\begin{proof}Unbound.\end{proof}`).graph;
  assert.equal(get(missing, "thm:a").proofs.length, 0);
  const excluded = project(String.raw`\begin{theorem}\label{thm:a}A.\end{theorem}\include{disabled}\begin{proof}Attached.\end{proof}`, { preamble: PREAMBLE + String.raw`\includeonly{other}`, files: { "disabled.tex": "Intervening prose." } }).graph;
  assert.equal(get(excluded, "thm:a").proofs.length, 1);
});

test("labels in groups/text args belong to the statement; nested math/float/proof/theorem labels do not", () => {
  const { graph } = project(String.raw`\begin{theorem}{\label{thm:a}Statement}\textit{\label{thm:alias}Formatted}
\begin{equation}\label{eq:x}x=1\end{equation}
\begin{figure}\caption{Picture}\label{fig:x}\end{figure}
\begin{lemma}\label{lem:b}Nested.\end{lemma}
\begin{proof}\label{proof:x}Body.\end{proof}
\end{theorem}`);
  assert.deepEqual(get(graph, "thm:a").labels, ["thm:a", "thm:alias"]);
  assert.equal(graph.byLabel.has("eq:x"), false);
  assert.equal(graph.byLabel.has("fig:x"), false);
  assert.equal(graph.byLabel.has("proof:x"), false);
  assert.equal(get(graph, "lem:b").env, "lemma");
});

test("proof refs in nested math are indexed with exact offsets; comments/verbatim/definitions are not", () => {
  const { graph, plan } = project(String.raw`\begin{lemma}\label{lem:b}B.\end{lemma}
\begin{theorem}\label{thm:a}A.\end{theorem}
\begin{proof}
$x=\text{by \ref{lem:b}}$.
\begin{align}x &= \ref{lem:b}\end{align}
% \ref{comment-key}
\verb|\ref{verbatim-key}|
\newcommand{\unused}{\ref{macro-key}}
\begin{verbatim}\ref{listing-key}\end{verbatim}
\end{proof}`);
  assert.deepEqual(pairs(graph), [["thm:a", "lem:b"], ["thm:a", "lem:b"]]);
  for (const edge of graph.edges) assert.equal(plan.files.get(edge.evidence.key)!.src.slice(edge.evidence.from, edge.evidence.to), String.raw`\ref{lem:b}`);
  assert.equal(graph.unresolved.length, 0);
});

test("literal ref comma stays a single key and non-theorem keys are not graph targets", () => {
  const aux = new Map<string, AuxLabel>([["eq:x", { number: "1", page: "1", title: "", anchor: "equation.1", kind: "equation", order: null }]]);
  const { graph } = project(String.raw`\begin{lemma}\label{lem:b}B.\end{lemma}
\begin{theorem}\label{thm:a}A.\end{theorem}\begin{proof}\ref{thm:a,lem:b}\ref{eq:x}\end{proof}`, { labels: aux });
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(graph.unresolved.map(d => [d.kind, d.key]), [["unresolved-ref", "thm:a,lem:b"], ["non-theorem-ref", "eq:x"]]);
});

test("compiled numbering is display text and confirmed non-theorem labels never become statement aliases", () => {
  const aux = (number: string, kind: string): AuxLabel => ({ number, kind, page: "1", title: "", anchor: "", order: null });
  const { graph } = project(String.raw`\begin{theorem}\label{thm:a}\label{eq:alias}A.\end{theorem}`, { labels: new Map([["thm:a", aux(String.raw`{\color{structurecolor}1.}`, "theorem")], ["eq:alias", aux("1", "equation")]]) });
  assert.equal(get(graph, "thm:a").number, "1.");
  assert.equal(graph.byLabel.has("eq:alias"), false);
});

test("different source origins with one label remain ambiguous, repeated same origin does not", () => {
  const { graph } = project(String.raw`\input{shared}\input{shared}\input{other}\begin{theorem}\label{thm:a}A.\end{theorem}\begin{proof}\ref{duplicate}\end{proof}`, { files: {
    "shared.tex": String.raw`\begin{lemma}\label{duplicate}One.\end{lemma}`,
    "other.tex": String.raw`\begin{lemma}\label{duplicate}Two.\end{lemma}`,
  } });
  assert.equal(graph.byLabel.get("duplicate")?.length, 2);
  assert.equal(graph.nodes.size, 3);
  assert.equal(graph.edges.length, 0);
  assert.ok(graph.unresolved.some(d => d.kind === "duplicate-label"));
});

test("cycles and self refs remain source facts, and multiple proof title targets stay ambiguous", () => {
  const { graph } = project(String.raw`\begin{theorem}\label{thm:a}A.\end{theorem}\begin{proof}\ref{thm:b}\ref{thm:a}\end{proof}
\begin{theorem}\label{thm:b}B.\end{theorem}\begin{proof}\ref{thm:a}\end{proof}
\begin{proof}[Proof of \ref{thm:a} and \ref{thm:b}]Ambiguous target.\end{proof}`);
  assert.deepEqual(pairs(graph), [["thm:a", "thm:b"], ["thm:a", "thm:a"], ["thm:b", "thm:a"]]);
  assert.equal(graph.unresolved.length, 1);
  assert.equal(graph.unresolved[0].kind, "ambiguous-proof");
});

test("unclosed environments never become complete nodes or proof associations", () => {
  const { graph } = project(String.raw`\begin{theorem}\label{thm:a}Still editing.`);
  assert.equal(graph.nodes.size, 0);
  assert.ok(graph.unresolved.some(d => d.kind === "incomplete-environment"));
});
