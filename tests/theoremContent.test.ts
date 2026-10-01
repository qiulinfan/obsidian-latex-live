// Rich graph cards use the existing emitter on original AST slices, with private real MathJax.
// The fixtures prepare source plans only: no full export, probe, TeX process or KG query.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { formulaRefs, refNames, type LatexRefs } from "../src/editor/latexRefs";
import { MathError, ProjectMath } from "../src/editor/mathjaxProject";
import { emitSourceSlice, validateSourceSlice, type EmitInput, type SourceSlice } from "../src/export/emit";
import { drawingKey } from "../src/export/fragments";
import { planExport } from "../src/export/plan";
import { readProbeLog, StepQueue } from "../src/export/probeLog";
import { profileOf } from "../src/export/profiles";
import { ReportBuilder } from "../src/export/report";
import { walkTex, type TexNode } from "../src/export/texTree";
import { projectDefinitions } from "../src/tex/macros";
import { stripComments } from "../src/tex/project";
import { theoremMap } from "../src/tex/theorems";
import { nodeMathEnv } from "./support/exportHost";

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

async function prepared(body: string, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-theorem-content-")); dirs.push(dir);
  const root = join(dir, "main.tex");
  const source = `\\documentclass{article}\n\\usepackage{amsthm,graphicx}\n\\newcommand{\\RR}{\\mathbb{R}}\n\\newtheorem{theorem}{Theorem}\n\\title{MUST_NOT_BE_CARD_HEADER}\n\\begin{document}\n${body}\n\\end{document}\n`;
  writeFileSync(root, source);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  const defs = projectDefinitions(root);
  const sources = defs.files.map((f) => stripComments(readFileSync(f, "utf8")));
  const theorems = theoremMap(sources);
  const plan = planExport(root, { defs, theorems });
  const labels = new Map(["thm:local", "thm:outside", "eq:local"].map((key, i) => [key, { number: String(i + 1), page: "1", title: "", anchor: `${key.startsWith("eq") ? "equation" : "theorem"}.${i + 1}`, kind: key.startsWith("eq") ? "equation" : "theorem", order: null }]));
  const refs: LatexRefs = { labels, numbers: new Map([...labels].map(([k, v]) => [k, v.number])), names: refNames(sources, theorems), theorems, checkpoints: new Map(), cites: new Map() };
  const env = await nodeMathEnv();
  const project = ProjectMath.create(env.mj, env.document, { statements: defs.statements, physics: false, unsupported: defs.unsupported });
  const imageSites: string[] = [];
  const input: EmitInput = {
    plan, defs, refs, theorems, profile: profileOf(source, sources), log: null, queue: null,
    math: { render: (tex, display) => project.render(tex, display, refs.numbers, formulaRefs(refs)).outerHTML },
    images: { graphic: (_name, _page, site) => { imageSites.push(site ?? ""); return { src: "data:image/png;base64,ORIGINAL_IMAGE", width: 2, height: 1, dpi: 72 }; }, listingAt: () => null, pdfPages: () => "PDF image was not prepared" },
    fragments: new Map(), bib: { entries: new Map(), bbl: null, bibcites: new Map() }, report: new ReportBuilder(), idle: async () => {}, signal: new AbortController().signal,
  };
  const file = plan.files.get(plan.rootKey)!;
  const envs: (TexNode & { t: "env" })[] = [];
  walkTex(file.nodes, (n) => { if (n.t === "env") envs.push(n); });
  return { input, source, envs, file, dir, imageSites };
}

const document = (html: string) => new JSDOM(`<main>${html}</main>`).window.document;

test("original statement/proof slices render prose, private project math, lists, inputs, images and outside references", async () => {
  const p = await prepared(String.raw`\input{unrelated}
\begin{theorem}[Bound]\label{thm:local}
Rich \textbf{statement}: $x\in\RR$ and see \ref{thm:outside}.
\begin{proof}
Use \emph{two steps}.
\begin{enumerate}\item First $x^2\ge0$.\item Then \ref{thm:outside}.\end{enumerate}
\input{proof-extra}
\includegraphics[width=.4\linewidth]{audit.png}
\begin{equation}\label{eq:local}x^2\ge0.\end{equation}
\footnote{A rich note with $x$ and \ref{thm:outside}.}
\end{proof}
\end{theorem}
OUTSIDE_DOCUMENT_TEXT`, { "unrelated.tex": "UNRELATED_INPUT_MUST_NOT_RENDER", "proof-extra.tex": String.raw`Included \textit{detail} with $y\in\RR$.` });
  const theorem = p.envs.find((n) => n.name === "theorem")!, proof = p.envs.find((n) => n.name === "proof")!;
  const source: SourceSlice = { key: p.file.key, visit: 0, nodes: [theorem], excluded: [{ key: p.file.key, visit: 0, from: proof.from, to: proof.to }] };
  const statement = await emitSourceSlice(p.input, source, { idPrefix: "statement-" });
  const doc = document(statement.body);
  assert.match(doc.body.textContent!, /Theorem 1 \(Bound\)/);
  assert.equal(doc.querySelector("b")!.textContent, "statement");
  assert.ok(doc.querySelector("mjx-container"));
  assert.equal(doc.querySelector(".llx-proof"), null);
  assert.doesNotMatch(doc.body.textContent!, /two steps|OUTSIDE_DOCUMENT|UNRELATED_INPUT|MUST_NOT_BE_CARD_HEADER/);
  const reference = doc.querySelector("a.llx-ref")!;
  assert.equal(reference.getAttribute("href"), "#thm:outside");
  assert.equal(reference.getAttribute("data-ll-tex-ref"), "thm:outside");
  assert.equal(doc.querySelector('[data-ll-tex-label="thm:local"]')!.id, "statement-thm:local");
  const content = await emitSourceSlice(p.input, { key: p.file.key, visit: 0, nodes: proof.body }, { idPrefix: "proof-" });
  const details = document(content.body);
  assert.equal(details.querySelector("em")!.textContent, "two steps");
  assert.equal(details.querySelectorAll("ol li").length, 2);
  assert.match(details.body.textContent!, /Included detail with/);
  assert.ok(details.querySelector("i"));
  assert.equal(details.querySelector("img")!.getAttribute("src"), "data:image/png;base64,ORIGINAL_IMAGE");
  assert.equal(p.imageSites.length, 1);
  assert.ok(p.imageSites[0].startsWith("0@"));
  assert.equal(content.footnotes.length, 1);
  assert.match(content.footnotes[0].html, /mjx-container/);
  assert.match(content.footnotes[0].html, /data-ll-tex-ref="thm:outside"/);
  assert.ok(content.footnotes[0].id.startsWith("proof-"));
  assert.ok(content.footnotes[0].ref.startsWith("proof-"));
  assert.equal(details.querySelector(".llx-fn-link")!.getAttribute("href"), `#${content.footnotes[0].id}`);
  assert.doesNotMatch(details.body.textContent!, /UNRELATED_INPUT|OUTSIDE_DOCUMENT/);
  assert.deepEqual(p.input.report.items, [], "a card never adds warnings to a cached full-document report");
});

test("slice queues are isolated, excluded nested proof identity is preserved, and repeated cards get unique IDs", async () => {
  const p = await prepared(String.raw`\begin{theorem}\label{thm:local}Statement. {Keep before.\begin{proof}HIDDEN_NESTED_PROOF\end{proof} Keep after.}\end{theorem}`);
  const theorem = p.envs.find((n) => n.name === "theorem")!, proof = p.envs.find((n) => n.name === "proof")!;
  const log = readProbeLog(`llxstep{theorem}{1}{}{main.tex}{7}\n`);
  p.input.log = log;
  p.input.queue = new StepQueue(log, p.input.plan.visits);
  const before = p.input.queue.orphans;
  const source = { key: p.file.key, visit: 0, nodes: [theorem], excluded: [{ key: p.file.key, visit: 0, from: proof.from, to: proof.to }] };
  const a = await emitSourceSlice(p.input, source), b = await emitSourceSlice(p.input, source);
  assert.match(document(a.body).body.textContent!, /Keep before.*Keep after/);
  assert.doesNotMatch(a.body, /HIDDEN_NESTED_PROOF/);
  assert.notEqual(document(a.body).querySelector("[id]")!.id, document(b.body).querySelector("[id]")!.id);
  assert.deepEqual(p.input.queue.orphans, before);
});

test("owned proofs inside an input are excluded by exact child visit while surrounding content stays rich", async () => {
  const p = await prepared(String.raw`\begin{theorem}\label{thm:local}\input{contained}\end{theorem}`, { "contained.tex": String.raw`Before $x$.\begin{proof}INPUT_OWNED_PROOF\end{proof}After \textbf{detail}.` });
  const theorem = p.envs.find((n) => n.name === "theorem")!;
  const visit = p.input.plan.visits.findIndex((v) => v.key === "contained.tex");
  const child = p.input.plan.files.get("contained.tex")!;
  let proof: TexNode & { t: "env" } | undefined;
  walkTex(child.nodes, (n) => { if (n.t === "env" && n.name === "proof") proof = n; });
  const out = await emitSourceSlice(p.input, { key: p.file.key, visit: 0, nodes: [theorem], excluded: [{ key: child.key, visit, from: proof!.from, to: proof!.to }] });
  const doc = document(out.body);
  assert.match(doc.body.textContent!, /Before.*After detail/);
  assert.doesNotMatch(doc.body.textContent!, /INPUT_OWNED_PROOF/);
  assert.ok(doc.querySelector("mjx-container"));
  assert.equal(doc.querySelector("b")!.textContent, "detail");
});

test("a cached complex drawing is namespaced, absent drawings and MathJax failures expose escaped source", async () => {
  const p = await prepared(String.raw`\begin{proof}\begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}\end{proof}`);
  const proof = p.envs.find((n) => n.name === "proof")!;
  const plain = await emitSourceSlice(p.input, { key: p.file.key, visit: 0, nodes: proof.body });
  assert.match(plain.body, /class="llx-source"/);
  assert.match(document(plain.body).body.textContent!, /\\draw/);
  assert.ok(plain.items.some((i) => i.kind === "fragment"));
  const fragment = p.input.plan.fragments.find((f) => f.what === "tikzpicture")!;
  p.input.fragments = new Map([[drawingKey(0, fragment.id), '<svg class="llx-frag"><defs><path id="g" d="M0 0L1 1"/><clipPath id="clip"><path d="M0 0"/></clipPath></defs><g data-id="7" style="clip-path:url(#clip)"><use href="#g"/></g></svg>']]);
  const cached = await emitSourceSlice(p.input, { key: p.file.key, visit: 0, nodes: proof.body }, { idPrefix: "cached-" });
  const svg = document(cached.body);
  assert.ok(svg.querySelector("#cached-g"));
  assert.equal(svg.querySelector("use")!.getAttribute("href"), "#cached-g");
  assert.equal(svg.querySelector("g[data-id]")!.getAttribute("data-id"), "7");
  assert.equal(svg.querySelector("g[data-id]")!.getAttribute("style"), "clip-path:url(#cached-clip)");
  const math = await prepared(String.raw`\begin{proof}Raw <&> $\missing{x}$ after.\end{proof}`);
  math.input.math = { render: () => { throw new MathError("Unsupported macro"); } };
  const failed = await emitSourceSlice(math.input, { key: math.file.key, visit: 0, nodes: math.envs.find((n) => n.name === "proof")!.body });
  assert.match(failed.body, /&lt;&amp;&gt;/);
  assert.match(failed.body, /llx-math-error/);
  assert.match(document(failed.body).body.textContent!, /\\missing\{x\}/);
});

test("strict source identity/context/bounds and aborts reject without rendering or modifying source", async () => {
  const p = await prepared(String.raw`\begin{proof}Short proof.\end{proof}`);
  const proof = p.envs.find((n) => n.name === "proof")!;
  const source = { key: p.file.key, visit: 0, nodes: proof.body };
  assert.doesNotThrow(() => validateSourceSlice(p.input.plan, source));
  assert.throws(() => validateSourceSlice(p.input.plan, { ...source, key: "foreign.tex" }), /plan visit/);
  await assert.rejects(emitSourceSlice(p.input, { ...source, key: "foreign.tex" }), /plan visit/);
  await assert.rejects(emitSourceSlice(p.input, { ...source, nodes: [{ ...proof }] }), /reconstructed|foreign/);
  await assert.rejects(emitSourceSlice(p.input, { ...source, excluded: [{ key: p.file.key, visit: 0, from: proof.from + 1, to: proof.to }] }), /environment range/);
  const large = await prepared(`\\begin{proof}${"x".repeat(64_001)}\\end{proof}`);
  await assert.rejects(emitSourceSlice(large.input, { key: large.file.key, visit: 0, nodes: large.envs.find((n) => n.name === "proof")!.body }), /character limit/);
  const expanded = await prepared(String.raw`\begin{proof}\bloat\end{proof}`);
  expanded.input.defs.macros.set("bloat", { args: 0, optional: false, math: false });
  expanded.input.defs.statements.push(`\\newcommand{\\bloat}{${"Visible text. ".repeat(22_000)}}`);
  await assert.rejects(emitSourceSlice(expanded.input, { key: expanded.file.key, visit: 0, nodes: expanded.envs.find((n) => n.name === "proof")!.body }), /expanded character limit/);
  const controller = new AbortController(); controller.abort(); p.input.signal = controller.signal;
  await assert.rejects(emitSourceSlice(p.input, source), { name: "AbortError" });
  assert.equal(readFileSync(join(p.dir, "main.tex"), "utf8"), p.source);
});
