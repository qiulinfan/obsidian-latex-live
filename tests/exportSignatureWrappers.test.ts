import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { planExport } from "../src/export/plan";
import { censusSpec, projectSignatures, withCensus } from "../src/export/signatures";
import { argText, parseTex, walkTex, type TexNode } from "../src/export/texTree";
import { emptyDefinitions, projectDefinitions } from "../src/tex/macros";
import { resolveTexBinDir } from "../src/tex/binaries";

const temps: string[] = [];
after(() => { for (const path of temps) rmSync(path, { recursive: true, force: true }); });

function project(declarations: string, body: string, cr = false) {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-signature-wrappers-"));
  temps.push(dir);
  const root = join(dir, "main.tex");
  writeFileSync(root, `\\documentclass{wrapped}\n\\begin{document}\n${body}\n\\end{document}\n`);
  const cls = `\\ProvidesClass{wrapped}\n\\LoadClass{article}\n${declarations}\n`;
  writeFileSync(join(dir, "wrapped.cls"), cr ? cls.replace(/\n/g, "\r") : cls);
  const defs = projectDefinitions(root);
  const signatures = projectSignatures(defs, defs.files.map(path => readFileSync(path, "utf8")), new Map());
  return { root, dir, defs, signatures };
}

function macros(nodes: TexNode[], name: string) {
  const out: Extract<TexNode, { t: "macro" }>[] = [];
  walkTex(nodes, node => { if (node.t === "macro" && node.name === name && !node.code) out.push(node); });
  return out;
}

test("class @startsection wrappers retain public section arguments, including star and short title", () => {
  const source = String.raw`\section*{Unnumbered heading}\section[Short]{Full heading}\subsection{Detail}`;
  const { defs, signatures } = project(String.raw`
\renewcommand{\section}{\@startsection{section}{1}{\z@}{3pt}{2pt}{\bfseries}}
\renewcommand{\subsection}{\@startsection{subsection}{2}{\z@}{2pt}{1pt}{\bfseries}}
`, source);
  assert.equal(defs.macros.get("section")?.args, 0, "the wrapper has no direct # parameters");
  const sections = macros(parseTex(source, signatures), "section");
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map(node => argText(source, node.args.at(-1))), ["Unnumbered heading", "Full heading"]);
  assert.equal(argText(source, sections[1].args[1]), "Short");
  assert.equal(source.slice(sections[0].args[0].from, sections[0].args[0].to), "*");
  assert.equal(argText(source, macros(parseTex(source, signatures), "subsection")[0].args.at(-1)), "Detail");
});

test("known delegated readers preserve a public signature but unknown wrappers remain zero-argument", () => {
  const { signatures } = project(String.raw`
\renewcommand{\caption}{\@dblarg{\@caption\@captype}}
\def\label{\@ifnextchar[{\indexedlabel}{\plainlabel}}
\newcommand{\customreader}{\@dblarg\@customreader}
`, "");
  const source = String.raw`\caption[Short]{Full caption}\label{key}\customreader{ordinary group}`;
  const tree = parseTex(source, signatures);
  assert.equal(argText(source, macros(tree, "caption")[0].args.at(-1)), "Full caption");
  assert.equal(argText(source, macros(tree, "label")[0].args.at(-1)), "key");
  assert.deepEqual(macros(tree, "customreader")[0].args, [], "an unknown command has no established public contract");
});

test("explicit user redefinitions and zero-argument constants override an earlier class wrapper", () => {
  const { root, defs } = project(String.raw`\renewcommand{\section}{\@startsection{section}{1}{\z@}{3pt}{2pt}{\bfseries}}`, "");
  // Definitions follow the real project order: class first, the user's preamble afterwards.
  writeFileSync(root, String.raw`\documentclass{wrapped}
\renewcommand{\section}[2]{#1: #2}
\renewcommand{\caption}{Constant caption}
\begin{document}\section{First}{Second}\caption{ordinary group}\end{document}`);
  const updated = projectDefinitions(root);
  assert.equal(defs.macros.get("section")?.args, 0);
  const signatures = projectSignatures(updated, updated.files.map(path => readFileSync(path, "utf8")), new Map());
  const source = String.raw`\section{First}{Second}\caption{ordinary group}`;
  const tree = parseTex(source, signatures);
  assert.deepEqual(macros(tree, "section")[0].args.map(arg => argText(source, arg)), ["First", "Second"]);
  assert.deepEqual(macros(tree, "caption")[0].args, [], "a genuine zero-argument user definition is not treated as a reader");
});

test("a later style reader restores the public signature after an explicit user arity", () => {
  const { root, dir } = project(String.raw`\renewcommand{\section}{\@startsection{section}{1}{\z@}{3pt}{2pt}{\bfseries}}`, "");
  writeFileSync(join(dir, "late.sty"), String.raw`\ProvidesPackage{late}
\renewcommand{\section}{\@startsection{section}{1}{\z@}{4pt}{2pt}{\bfseries}}`);
  writeFileSync(root, String.raw`\documentclass{wrapped}
\renewcommand{\section}[2]{#1: #2}
\usepackage{late}
\begin{document}\section[Short]{Actual heading}\end{document}`);
  const defs = projectDefinitions(root);
  const signatures = projectSignatures(defs, defs.files.map(path => readFileSync(path, "utf8")), new Map());
  const source = String.raw`\section[Short]{Actual heading}`;
  const section = macros(parseTex(source, signatures), "section")[0];
  assert.equal(argText(source, section.args[1]), "Short");
  assert.equal(argText(source, section.args.at(-1)), "Actual heading");
});

test("section setup before the matching @startsection reader keeps its public arguments", () => {
  const { signatures } = project(String.raw`\def\section{\if@firstsection\maketitle\global\@firstsectionfalse\fi\@startsection{section}{1}{\z@}{4pt}{2pt}{\bfseries}}`, "");
  const source = String.raw`\section[Short]{Full heading}`;
  assert.equal(argText(source, macros(parseTex(source, signatures), "section")[0].args.at(-1)), "Full heading");
  const constant = project(String.raw`\renewcommand{\section}{Constant heading}\renewcommand{\caption}{\if@firstsection\maketitle\fi\@startsection{section}{1}{\z@}{4pt}{2pt}{\bfseries}}`, "").signatures;
  assert.equal(macros(parseTex(String.raw`\section{Ordinary group}`, constant), "section")[0].args.length, 0);
  assert.equal(macros(parseTex(String.raw`\caption{Ordinary group}`, constant), "caption")[0].args.length, 0, "a different public command does not inherit a section reader's signature");
});

test("CR-only class comments and delegated definitions preserve the same parser contract", () => {
  const { root, defs, signatures } = project("% discarded \\newcommand{\\ghost}[9]{bad}\n\\renewcommand{\\section}{\\@startsection{section}{1}{\\z@}{3pt}{2pt}{\\bfseries}}\n\\newcommand{\\population}[1]{N_{#1}}", String.raw`\section{Methods}`, true);
  assert.equal(defs.macros.has("ghost"), false);
  assert.equal(defs.macros.get("population")?.args, 1);
  const plan = planExport(root, { defs, theorems: new Map(), mathOk: () => true });
  assert.equal(argText(plan.files.get(plan.rootKey)!.src, macros(plan.files.get(plan.rootKey)!.nodes, "section")[0].args.at(-1)), "Methods");
  assert.equal(signatures.macros.get("section"), "s o m");
});

test("text superscripts and subscripts own their complete text arguments", () => {
  const source = String.raw`Ada\textsuperscript{1,*} and CO\textsubscript{2}`;
  const signatures = projectSignatures(emptyDefinitions(), [], new Map());
  const tree = parseTex(source, signatures);
  assert.equal(argText(source, macros(tree, "textsuperscript")[0].args[0]), "1,*");
  assert.equal(argText(source, macros(tree, "textsubscript")[0].args[0]), "2");
});

test("LNCS theorem readers expose their optional note without granting unrelated readers that spec", () => {
  assert.equal(censusSpec(String.raw`macro:->\@spthm {theorem}{Theorem}{\itshape }`), "o");
  assert.equal(censusSpec(String.raw`macro:->\@Thm {theorem}{Theorem}`), "o");
  assert.equal(censusSpec(String.raw`macro:->\@spthmother {theorem}`), "");
  const signatures = withCensus(projectSignatures(emptyDefinitions(), [], new Map()), new Map([["customthm", String.raw`macro:->\@spthm {theorem}{Theorem}{\itshape }`]]));
  const source = String.raw`\begin{customthm}[Growth bound]Body\end{customthm}`;
  const env = parseTex(source, signatures)[0];
  assert.equal(env.t, "env");
  if (env.t === "env") assert.equal(argText(source, env.args[0]), "Growth bound");
});

// The official class remains external (its distribution notice is retained by the downloader).
// Set this path after preparing the pinned Springer fixture to run the real-source regression.
const springer = process.env.LATEX_LIVE_SPRINGER_FIXTURE ?? resolve("node_modules/.cache/bio-template-audit/candidate/springer");
test("unchanged Springer sn-jnl class keeps headings in their parsed arguments", { skip: !existsSync(join(springer, "sn-jnl.cls")) && "Springer external fixture not prepared" }, () => {
  const root = join(springer, "main.tex");
  const defs = projectDefinitions(root);
  const plan = planExport(root, { defs, theorems: new Map(), mathOk: () => true });
  const file = plan.files.get(plan.rootKey)!;
  assert.deepEqual(macros(file.nodes, "section").map(node => argText(file.src, node.args.at(-1))), ["Introduction", "Methods", "Results"]);
  assert.equal(defs.macros.get("section")?.args, 0, "the unmodified official class uses a wrapper");
  const authors = macros(file.nodes, "author");
  assert.equal(authors.length, 2);
  assert.equal(file.src.slice(authors[0].args[0].from, authors[0].args[0].to), "*");
  assert.equal(argText(file.src, authors[0].args[1]), "1");
  assert.equal(argText(file.src, authors[0].args.at(-1)), String.raw`\fnm{Ada} \sur{Botanist}`);
  assert.equal(argText(file.src, authors[1].args[1]), "2");
  const affiliations = macros(file.nodes, "affil");
  assert.equal(affiliations.length, 2);
  assert.equal(file.src.slice(affiliations[0].args[0].from, affiliations[0].args[0].to), "*");
  assert.equal(argText(file.src, affiliations[0].args[1]), "1");
  assert.match(argText(file.src, affiliations[0].args.at(-1)), /Department of Biology/);
});

const texBin = resolveTexBinDir("");
const aasClass = texBin ? spawnSync(join(texBin, "kpsewhich"), ["aastex701.cls"], { encoding: "utf8" }).stdout?.trim() ?? "" : "";
test("unmodified installed AASTeX 7.0.1 setup wrapper parses its first section title", { skip: !aasClass || !existsSync(aasClass) ? "AASTeX 7.0.1 not installed" : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-signature-aas-"));
  temps.push(dir);
  writeFileSync(join(dir, "aastex701.cls"), readFileSync(aasClass));
  const root = join(dir, "main.tex");
  writeFileSync(root, String.raw`\documentclass{aastex701}
\begin{document}\title{Synthetic note}\author[0000-0000-0000-0001]{Ada}\section[Short]{Dynamics}\end{document}`);
  const defs = projectDefinitions(root);
  const plan = planExport(root, { defs, theorems: new Map(), mathOk: () => true });
  const file = plan.files.get(plan.rootKey)!;
  const section = macros(file.nodes, "section")[0];
  assert.equal(argText(file.src, section.args.at(-1)), "Dynamics");
  assert.equal(argText(file.src, section.args[1]), "Short");
  const author = macros(file.nodes, "author")[0];
  assert.equal(argText(file.src, author.args.at(-1)), "Ada");
  assert.equal(argText(file.src, author.args.find(arg => arg.kind === "o")), "0000-0000-0000-0001");
});
