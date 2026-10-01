// Native citation semantics: actual cite.sty punctuation/options and natbib command aliases.
// Each original tiny manuscript is compiled with real TeX, then HTML is compared both with
// explicit expected text and with extracted PDF text. No citation is executed by the probe
// merely to identify the active formatter.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { exportHtml } from "../src/export/exporter";
import { readProbeLog } from "../src/export/probeLog";
import { nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

const dirs: string[] = [];
after(() => { removeExportTemps(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const gs = spawnSync("gs", ["--version"]).status === 0;
const skip = !texBin ? "no TeX installation" : !gs ? "Ghostscript required for independent native PDF citation comparison" : false;
const compact = (s: string) => s.replace(/\s+/g, "");
const bibliography = String.raw`\begin{thebibliography}{3}
\bibitem[Alpha(2020)]{a}An original synthetic reference by Alpha.
\bibitem[Beta(2021)]{b}An original synthetic reference by Beta.
\bibitem[Gamma(2022)]{c}An original synthetic reference by Gamma.
\end{thebibliography}`;

interface CitationCase { name: string; cls: string; preamble: string; citations: string[]; expected: string[]; flags?: Record<string, string>; }
const cases: CitationCase[] = [
  { name: "IEEE pair and sorted compressed range", cls: "[conference]IEEEtran", preamble: String.raw`\usepackage{cite}`, citations: [String.raw`\cite{a,b}`, String.raw`\cite{c,a,b}`], expected: ["[1], [2]", "[1]–[3]"], flags: { "cite-package": "sort,compress", citepunct: "], [", citedash: "]--[" } },
  { name: "cite.sty custom punctuation", cls: "article", preamble: String.raw`\usepackage{cite}\renewcommand{\citeleft}{(}\renewcommand{\citeright}{)}\renewcommand{\citepunct}{; }\renewcommand{\citedash}{ to }`, citations: [String.raw`\cite{a,b}`, String.raw`\cite{c,a,b}`], expected: ["(1; 2)", "(1 to 3)"] },
  { name: "cite.sty nosort/nocompress and default layout glue", cls: "article", preamble: String.raw`\usepackage[nosort,nocompress]{cite}`, citations: [String.raw`\cite{c,a,b}`], expected: ["[3, 1, 2]"], flags: { "cite-package": "nosort,nocompress" } },
  { name: "cite.sty note separator", cls: "article", preamble: String.raw`\usepackage{cite}\renewcommand{\citemid}{; }`, citations: [String.raw`\cite[p. 5]{a}`], expected: ["[1; p. 5]"] },
  { name: "natbib intrinsic author/year cite and optional notes", cls: "article", preamble: String.raw`\usepackage[authoryear]{natbib}`, citations: [String.raw`\cite{a}`, String.raw`\cite[p. 5]{a}`, String.raw`\cite[]{a}`, String.raw`\citet{b}`, String.raw`\citep{b}`], expected: ["Alpha (2020)", "(Alpha, 2020, p. 5)", "(Alpha, 2020)", "Beta (2021)", "(Beta, 2021)"], flags: { "natbib-default-cite": "auto" } },
  { name: "natbib intrinsic numeric cite stays numeric", cls: "article", preamble: String.raw`\usepackage[numbers]{natbib}`, citations: [String.raw`\cite{a,b}`, String.raw`\citet{a}`], expected: ["[1, 2]", "Alpha [1]"], flags: { "natbib-default-cite": "auto" } },
  { name: "natbib user alias citep", cls: "article", preamble: String.raw`\usepackage[authoryear]{natbib}\let\cite\citep`, citations: [String.raw`\cite{a}`, String.raw`\citet{a}`], expected: ["(Alpha, 2020)", "Alpha (2020)"], flags: { "natbib-default-cite": "citep" } },
  { name: "ACM author/year default citep versus explicit citet", cls: "[acmsmall]acmart", preamble: String.raw`\citestyle{acmauthoryear}\setcopyright{none}\settopmatter{printacmref=false}`, citations: [String.raw`\cite{a,b}`, String.raw`\citet{a}`], expected: ["[Alpha 2020; Beta 2021]", "Alpha [2020]"], flags: { "natbib-default-cite": "citep" } },
  { name: "ACM user alias citet preserves author choice", cls: "[acmsmall]acmart", preamble: String.raw`\citestyle{acmauthoryear}\let\cite\citet\setcopyright{none}\settopmatter{printacmref=false}`, citations: [String.raw`\cite{a}`, String.raw`\citep{a}`], expected: ["Alpha [2020]", "[Alpha 2020]"], flags: { "natbib-default-cite": "citet" } },
  { name: "AIP author/year cite remains textual", cls: "[aip,jcp,author-year]revtex4-2", preamble: "", citations: [String.raw`\cite{a}`, String.raw`\citep{a}`], expected: ["Alpha (2020)", "(Alpha, 2020)"], flags: { "natbib-default-cite": "auto" } },
];

for (const c of cases) test(`native citations: ${c.name}`, { skip, timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-native-citations-")); dirs.push(dir);
  const root = join(dir, "main.tex");
  const [, options = "", cls] = /^(\[[^\]]*\])?(.*)$/.exec(c.cls)!;
  const bib = /\\usepackage(?:\[[^\]]*\])?\{cite\}/.test(c.preamble) ? bibliography.replace(/\[[^\]]+\]/g, "") : bibliography;
  writeFileSync(root, `\\documentclass${options}{${cls}}\n${c.preamble}\n\\begin{document}\n\\title{Synthetic citation audit}\n\\author{Alice Alpha}\n\\maketitle\n\\section{Citation examples}\n${c.citations.map((tex, i) => `Example ${i + 1}: ${tex}.\\par`).join("\n")}\n${bib}\n\\end{document}\n`);
  const host = nodeExportHost(root, { engine: "pdflatex" });
  const { html, report } = await exportHtml(root, host, () => {}, new AbortController().signal);
  const document = new JSDOM(html).window.document;
  const actual = [...document.querySelectorAll(".llx-cite")].map(e => (e.textContent ?? "").replace(/\s+/g, " ").trim());
  const pdf = execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=txtwrite", "-sOutputFile=-", join(host.buildDir, "main.pdf")]).toString("utf8");
  const log = readProbeLog(readFileSync(join(host.workDir, "main.llx"), "utf8"));
  if (process.env.NATIVE_CITATION_AUDIT_OUT) {
    const out = join(process.env.NATIVE_CITATION_AUDIT_OUT, c.name.replace(/[^A-Za-z0-9]+/g, "-")); mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "result.json"), JSON.stringify({ ...c, actual, flags: Object.fromEntries(log.info), report }, null, 2));
    writeFileSync(join(out, "export.html"), html); writeFileSync(join(out, "pdf-text.txt"), pdf);
    cpSync(host.buildDir, join(out, "build"), { recursive: true }); cpSync(host.workDir, join(out, "probe"), { recursive: true });
  }
  assert.deepEqual(actual.map(compact), c.expected.map(compact));
  for (const expected of c.expected) assert.ok(compact(pdf).includes(compact(expected)), `native PDF lacks expected citation ${expected}`);
  for (const [key, value] of Object.entries(c.flags ?? {})) assert.equal(log.info.get(key), value);
  assert.deepEqual(report.items.filter(i => i.severity !== "info"), [], JSON.stringify(report.items));
  assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/g, ""), /(?:citepunctpenalty|citemidpenalty|\.13emplus)/);
});
