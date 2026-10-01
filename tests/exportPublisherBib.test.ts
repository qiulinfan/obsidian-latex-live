// Publisher .bbl vocabulary measured on unmodified REVTeX4-2 4.2f and AASTeX701 7.0.1.
// The entry text below is original synthetic content; its wrappers are the installed bst's
// actual output. The complete physics audit also compares these entries with real PDF text.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BBL_SIGNATURES, bblShutText } from "../src/export/bibliography";
import { projectSignatures } from "../src/export/signatures";
import { argText, parseTex } from "../src/export/texTree";
import { emptyDefinitions } from "../src/tex/macros";
import { theoremMap } from "../src/tex/theorems";
import { emitDoc, removeExportTemps } from "./support/exportHost";

after(removeExportTemps);

const APS = String.raw`\begin{thebibliography}{1}
\bibitem[{\citenamefont {Audit}\ and\ \citenamefont {Check}(2024)}]{audit}
\BibitemOpen
\bibfield {author} {\bibinfo {author} {\bibfnamefont {A.}~\bibnamefont {Audit}}\ and\ \bibinfo {author} {\bibfnamefont {B.}~\bibnamefont {Check}},\ }
\bibfield {title} {\bibinfo {title} {Synthetic oscillator baseline},\ }
\href@noop {} {\bibfield {journal} {\bibinfo {journal} {Synthetic Physics}\ }\textbf {\bibinfo {volume} {1}},\ \bibinfo {pages} {1} (\bibinfo {year} {2024})}\BibitemShut {NoStop}
\end{thebibliography}`;

const AIP = String.raw`\begin{thebibliography}{1}
\bibitem[{\citenamefont {Audit}\ and\ \citenamefont {Check}(2024)}]{audit}
\BibitemOpen
\bibfield {author} {\bibinfo {author} {\bibnamefont {Audit}, \bibfnamefont {A.}}and\ \bibinfo {author} {\bibnamefont {Check}, \bibfnamefont {B.}},\ }
\bibfield {title} {\enquote {\bibinfo {title} {Synthetic oscillator baseline},}\ }
\href@noop {} {\bibfield {journal} {\bibinfo {journal} {Synthetic Physics}\ }\textbf {\bibinfo {volume} {1}},\ \bibinfo {pages} {1--3} (\bibinfo {year} {2024})}\BibitemShut {NoStop}
\end{thebibliography}`;

const AAS = String.raw`\begin{thebibliography}{}
\bibitem[{A. Audit \& B. Check(2024)Audit \& Check}]{audit}
Audit, A., \& Check, B. 2024, \bibinfo{title}{Synthetic oscillator baseline,} Synthetic Physics, 1, 1
\end{thebibliography}`;

const AUX = String.raw`\bibcite{audit}{{1}{2024}{{Audit and Check}}{{}}}`;
const plain = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ");

for (const [name, bbl] of [["APS", APS], ["AIP", AIP], ["AASTeX", AAS]]) {
  test(`publisher bibliography: ${name} drops field keys and internal markers`, async () => {
    const out = await emitDoc({ preamble: "", body: String.raw`\bibliography{refs}`, bbl, aux: AUX, llx: "" });
    assert.deepEqual(out.report.items, []);
    assert.equal(out.counts.bibitems, 1);
    const text = plain(out.body);
    assert.match(text, /Synthetic oscillator baseline/);
    assert.match(text, /Synthetic Physics/);
    assert.doesNotMatch(text, /\b(?:author|title|journal|volume|pages|year|NoStop|BibitemOpen)\b|@noop/);
    if (name !== "AASTeX") {
      assert.match(out.body, /<b>1<\/b>/);
      assert.match(text, /\(2024\)\./);
    }
    if (name === "AIP") assert.match(text, /“Synthetic oscillator baseline,”/);
  });
}

test("publisher bibliography: wrapper payload keeps nested math, formatting, accents and links", async () => {
  const bbl = String.raw`\begin{thebibliography}{1}
\bibitem{audit}\bibfield{title}{\bibinfo{title}{\emph{An $L^2$ result by M\"uller}}};
\href@noop{discarded target}{\textbf{Volume 3}};
\href{https://example.invalid/paper}{\bibinfo{note}{read here}}\BibitemShut{Stop}
\end{thebibliography}`;
  const out = await emitDoc({ preamble: "", body: String.raw`\bibliography{refs}`, bbl, aux: AUX, llx: "" });
  assert.deepEqual(out.report.items, []);
  assert.match(out.body, /<em>An <mjx-container/);
  assert.match(out.body, /Müller<\/em>/);
  assert.match(out.body, /<b>Volume 3<\/b>/);
  assert.match(out.body, /href="https:\/\/example.invalid\/paper"[^>]*>read here<\/a>/);
  assert.doesNotMatch(out.body, /discarded target|NoStop|Stop<|bibfield|bibinfo|@noop/);
});

test("publisher bibliography: @ stays in the control word and marker consumes its full argument", () => {
  const source = String.raw`\href@noop{}{\bibinfo{journal}{Payload}}\BibitemShut{NoStop} tail`;
  const nodes = parseTex(source, { macros: new Map(Object.entries(BBL_SIGNATURES)), envs: new Map() });
  const first = nodes[0];
  assert.equal(first.t, "macro");
  if (first.t !== "macro") return;
  assert.equal(first.name, "href@noop");
  assert.equal(first.args.length, 2);
  assert.equal(argText(source, first.args[1]), String.raw`\bibinfo{journal}{Payload}`);
  const shut = nodes.find((n) => n.t === "macro" && n.name === "BibitemShut");
  assert.ok(shut?.t === "macro");
  assert.equal(argText(source, shut.args[0]), "NoStop");
  assert.equal(source.slice(shut.from, shut.to), String.raw`\BibitemShut{NoStop}`);
  assert.equal(bblShutText("NoStop"), ".");
  assert.equal(bblShutText("Stop"), "");
  assert.equal(bblShutText("custom"), null);
});

test("publisher bibliography: known argument specs do not swallow adjacent prose", () => {
  const source = String.raw`\bibfield{title}{Paper}\BibitemOpen text \BibitemShut{Stop} next`;
  const defs = emptyDefinitions();
  const nodes = parseTex(source, projectSignatures(defs, [], theoremMap([])));
  assert.equal(nodes.filter((n) => n.t === "macro").length, 3);
  assert.ok(nodes.some((n) => n.t === "text" && n.s === "text"));
  assert.ok(nodes.some((n) => n.t === "text" && n.s === "next"));
});

test("publisher bibliography: same-named project macro keeps its normal meaning in body text", async () => {
  const out = await emitDoc({
    preamble: String.raw`\newcommand{\bibinfo}[2]{#1: \textbf{#2}}`,
    body: String.raw`Outside \bibinfo{kind}{payload}.\bibliography{refs}`,
    bbl: AAS, aux: AUX, llx: "",
  });
  assert.match(out.body, /Outside kind: <b>payload<\/b>\./);
  assert.doesNotMatch(out.body, /title: <b>Synthetic/);
  assert.deepEqual(out.report.items, []);
});

test("publisher bibliography: unknown publisher commands and marker modes remain reported", async () => {
  const bbl = String.raw`\begin{thebibliography}{1}\bibitem{audit}\unknownPublisherWord{visible}\BibitemShut{Custom}\end{thebibliography}`;
  const out = await emitDoc({ preamble: "", body: String.raw`\bibliography{refs}`, bbl, aux: AUX, llx: "" });
  assert.ok(out.report.items.some((i) => i.kind === "unknown-macro" && i.message.includes("unknownPublisherWord")));
  assert.ok(out.report.items.some((i) => i.kind === "unknown-macro" && i.message.includes("BibitemShut")));
});

const ACM = String.raw`\begin{thebibliography}{1}\bibitem{audit}
Ada Audit. 2024. \newblock \showarticletitle{A \emph{synthetic} title}.
\newblock \bibinfo{journal}{\emph{Synthetic Computing}} \bibinfo{volume}{1}.
\end{thebibliography}`;

test("publisher bibliography: ACM's default article-title wrapper preserves rich title", async () => {
  const out = await emitDoc({ preamble: "", body: String.raw`\bibliography{refs}`, bbl: ACM, aux: AUX, llx: "" });
  assert.match(out.body, /A <em>synthetic<\/em> title/);
  assert.deepEqual(out.report.items, []);
});

for (const definition of [
  String.raw`\newcommand{\showarticletitle}[1]{}`,
  String.raw`\providecommand{\showarticletitle}[1]{}`,
  String.raw`\def\showarticletitle#1{}`,
  String.raw`\gdef\showarticletitle#1{}`,
]) test(`publisher bibliography: ACM's explicit ${definition.split("{")[0]} title suppression wins`, async () => {
  const out = await emitDoc({ preamble: definition, body: String.raw`\bibliography{refs}`, bbl: ACM, aux: AUX, llx: "" });
  assert.doesNotMatch(out.body, /synthetic|title/);
  assert.match(out.body, /<em>Synthetic Computing<\/em>/);
  assert.deepEqual(out.report.items, []);
});

for (const definition of [
  String.raw`\newcommand{\showarticletitle}[1]{\textbf{#1}}`,
  String.raw`\DeclareRobustCommand{\showarticletitle}[1]{\textbf{#1}}`,
  String.raw`\def\showarticletitle#1{\textbf{#1}}`,
]) test(`publisher bibliography: ACM's explicit ${definition.split("{")[0]} formatting keeps nested title markup`, async () => {
  const out = await emitDoc({ preamble: definition, body: String.raw`\bibliography{refs}`, bbl: ACM, aux: AUX, llx: "" });
  assert.match(out.body, /<b>A <em>synthetic<\/em> title<\/b>/);
  assert.deepEqual(out.report.items, []);
});
