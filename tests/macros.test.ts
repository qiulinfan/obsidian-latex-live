// T-L1: definition statements for the math renderer (design 4.2), on synthetic text and on
// the synthetic elegantbook fixture (tests/fixtures/elegantbook).
import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { definitionStatements, projectDefinitions } from "../src/tex/macros";

const BOOK = resolve("tests/fixtures/elegantbook");

/** A temporary project from relative path -> text; returns its folder. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ll-macros-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test("definitionStatements: normalization of every definition kind", () => {
  const st = definitionStatements(
    [
      "\\newcommand{\\R}{\\mathbb{R}}",
      "\\newcommand\\N{\\mathbb{N}}",
      "\\newcommand*{\\Z}{\\mathbb{Z}}",
      "\\renewcommand*{\\vec}[1]{\\boldsymbol{#1}}",
      "\\newcommand{\\E}[2][]{\\mathbb{E}_{#1}\\left[ #2 \\right]}",
      "\\newcommand{\\loss}[1][\\theta]{\\mathcal{L}(#1)}",
      "\\providecommand{\\Q}{\\mathbb{Q}}",
      "\\providecommand{\\R}{\\mathrm{R}}",
      "\\DeclareRobustCommand{\\half}{\\tfrac12}",
      "\\NewDocumentCommand{\\abs}{m}{\\lvert #1\\rvert}",
      "\\NewDocumentCommand{\\dv}{om}{\\frac{d#1}{d#2}}",
      "\\RenewDocumentCommand{\\dd}{O{1} m}{\\mathrm{d}^{#1}#2}",
      "\\NewDocumentCommand{\\set}{m o}{\\{#1\\}}",
      "\\NewDocumentCommand{\\flag}{s m}{#2}",
      "\\DeclareMathOperator{\\Var}{Var}",
      "\\DeclareMathOperator*{\\argmin}{arg\\,min}",
      "\\DeclarePairedDelimiter{\\ceil}{\\lceil}{\\rceil}",
      "\\DeclarePairedDelimiterX{\\braces}[1]{\\{}{\\}}{#1}",
      "\\def\\eps{\\varepsilon}",
      "\\gdef\\pair#1,#2.{(#1;#2)}",
      "\\let\\oldphi\\phi",
      "\\let\\oldpsi=\\psi",
      "\\newenvironment{mat}{\\begin{pmatrix}}{\\end{pmatrix}}",
      "\\renewenvironment*{keypoint}[1][Key]{\\textbf{#1}}{}",
      "\\definecolor{accent}{RGB}{0,120,2}",
      "\\usepackage{amsmath}",
      "\\newtheorem{theorem}{Theorem}",
      "% \\newcommand{\\hidden}{x}",
      "\\newcommand{\\outer}{\\newcommand{\\inner}{y}}",
    ].join("\n"),
  );
  assert.deepEqual(st, [
    "\\newcommand{\\R}{\\mathbb{R}}",
    "\\newcommand{\\N}{\\mathbb{N}}",
    "\\newcommand{\\Z}{\\mathbb{Z}}",
    "\\renewcommand{\\vec}[1]{\\boldsymbol{#1}}",
    "\\newcommand{\\E}[2][]{\\mathbb{E}_{#1}\\left[ #2 \\right]}",
    "\\newcommand{\\loss}[1][\\theta]{\\mathcal{L}(#1)}",
    "\\newcommand{\\Q}{\\mathbb{Q}}",
    "\\newcommand{\\half}{\\tfrac12}",
    "\\newcommand{\\abs}[1]{\\lvert #1\\rvert}",
    "\\newcommand{\\dv}[2][]{\\frac{d#1}{d#2}}",
    "\\newcommand{\\dd}[2][1]{\\mathrm{d}^{#1}#2}",
    "\\DeclareMathOperator{\\Var}{Var}",
    "\\DeclareMathOperator*{\\argmin}{arg\\,min}",
    "\\DeclarePairedDelimiter{\\ceil}{\\lceil}{\\rceil}",
    "\\DeclarePairedDelimiterX{\\braces}[1]{\\{}{\\}}{#1}",
    "\\def\\eps{\\varepsilon}",
    "\\def\\pair#1,#2.{(#1;#2)}",
    "\\let\\oldphi\\phi",
    "\\let\\oldpsi\\psi",
    "\\newenvironment{mat}{\\begin{pmatrix}}{\\end{pmatrix}}",
    "\\renewenvironment{keypoint}[1][Key]{\\textbf{#1}}{}",
    "\\definecolor{accent}{RGB}{0,120,2}",
    "\\newcommand{\\outer}{\\newcommand{\\inner}{y}}",
  ]);
});

test("definitionStatements: definer aliases, @ internals, \\makeatletter blocks, the provide rule", () => {
  const text = [
    "\\newcommand{\\nc}{\\newcommand}",
    "\\nc{\\bP}{\\mathbb{P}}",
    "\\let\\rnc\\renewcommand",
    "\\rnc{\\phi}{\\varphi}",
    "\\makeatletter",
    "\\def\\bk@x{1}",
    "\\newcommand{\\visibleInBlock}{2}",
    "\\makeatother",
    "\\newcommand{\\after}{\\bk@x}",
    "\\providecommand{\\known}{new}",
  ].join("\n");
  const defined = new Set(["known"]);
  assert.deepEqual(definitionStatements(text, defined), [
    "\\newcommand{\\bP}{\\mathbb{P}}",
    "\\renewcommand{\\phi}{\\varphi}",
  ]);
  assert.ok(defined.has("bP") && defined.has("phi"), "names defined here join `defined`");
  // A half-typed statement is skipped, the next one still found.
  assert.deepEqual(definitionStatements("\\newcommand{\\a}{x\n\\newcommand{\\b}{y}"), ["\\newcommand{\\b}{y}"]);
  assert.deepEqual(definitionStatements("\\newcommand{\\a}[x]{y}\n\\newcommand{\\b}{y}"), ["\\newcommand{\\b}{y}"]);
});

test("projectDefinitions: the fixture's statements in document order, packages and files", () => {
  const d = projectDefinitions(join(BOOK, "main.tex"));
  assert.deepEqual(
    d.files.map((f) => f.slice(BOOK.length + 1)),
    ["main.tex", "booknotes.sty", "macros.tex", "chapters/ch1.tex", "chapters/ch2.tex"],
  );
  // booknotes.sty (\usepackage) comes before macros.tex (\input), ch2's \Lip last.
  const names = d.statements.map((s) => /^\\\w+\*?\{?\\?([A-Za-z]+)/.exec(s)?.[1]);
  assert.deepEqual(names.slice(0, 2), ["Tr", "KL"], "\\sym mentions \\bn@style and is skipped");
  assert.equal(d.statements[d.statements.length - 1], "\\newcommand{\\Lip}{L}");
  assert.ok(d.statements.includes("\\newcommand{\\Z}{\\mathbb{Z}}"));
  assert.ok(d.statements.includes("\\newcommand{\\Prob}{\\mathbb{P}}"), "the \\nc alias");
  assert.ok(d.statements.includes("\\newcommand{\\Q}{\\mathbb{Q}}"));
  assert.ok(!d.statements.some((s) => s.includes("\\mathrm{R}")), "\\providecommand{\\R} after \\newcommand{\\R}");
  assert.ok(!d.statements.some((s) => s.includes("set") || s.includes("bk") || s.includes("hidden")));
  assert.ok(d.statements.indexOf("\\let\\oldphi\\phi") < d.statements.indexOf("\\renewcommand{\\phi}{\\varphi}"));
  assert.ok(
    d.statements.indexOf("\\newcommand{\\N}{\\mathbb{N}}") < d.statements.indexOf("\\renewcommand{\\N}{\\mathbb{N}_0}"),
    "main.tex's \\renewcommand after \\input{macros} comes after macros.tex's statements",
  );
  for (const p of ["mathtools", "tikz-cd", "booknotes", "amssymb"]) assert.ok(d.packages.has(p), p);
  assert.equal(d.packages.has("physics"), false);
  assert.deepEqual(d.macros.get("E"), { args: 2, optional: true });
});

test("projectDefinitions: an open editor's unsaved text replaces its file", () => {
  const ch2 = join(BOOK, "chapters", "ch2.tex");
  const text = readFileSync(ch2, "utf8").replace("\\newcommand{\\Lip}{L}", "\\newcommand{\\Lip}{K}\n\\newcommand{\\grad}{\\nabla}");
  const d = projectDefinitions(join(BOOK, "main.tex"), new Map([[ch2, text]]));
  assert.deepEqual(d.statements.slice(-2), ["\\newcommand{\\Lip}{K}", "\\newcommand{\\grad}{\\nabla}"]);
  assert.equal(projectDefinitions(join(BOOK, "main.tex")).statements.at(-1), "\\newcommand{\\Lip}{L}", "disk copy unchanged");
});

test("projectDefinitions: nested imports, repeated contexts, and body-only subfiles preserve source order", () => {
  const dir = project({
    "main.tex": "\\documentclass{article}\n\\newcommand{\\same}{S}\n\\import{a/}{../shared}\n\\newcommand{\\middle}{M}\n\\import{b/}{../shared}\n\\subfile{子目录/part}\n\\newcommand{\\last}{L}\n",
    "shared.tex": "\\input{localdefs}\n\\providecommand{\\same}{unused}\n",
    "a/localdefs.tex": "\\newcommand{\\inA}{A}\n\\renewcommand{\\same}{A}\n",
    "b/localdefs.tex": "\\newcommand{\\inB}{B}\n\\renewcommand{\\same}{B}\n",
    "子目录/part.tex": "\\documentclass[../main]{subfiles}\n\\newcommand{\\ignored}{X}\n\\input{neverread}\n\\begin{document}\n\\newcommand{\\inside}{I}\n\\input{local}\n\\end{document}\n\\newcommand{\\ignoredtail}{X}\n",
    "子目录/local.tex": "\\newcommand{\\submacro}{U}\n",
  });
  try {
    const d = projectDefinitions(join(dir, "main.tex"));
    assert.deepEqual(d.statements, [
      "\\newcommand{\\same}{S}", "\\newcommand{\\inA}{A}", "\\renewcommand{\\same}{A}",
      "\\newcommand{\\middle}{M}", "\\newcommand{\\inB}{B}", "\\renewcommand{\\same}{B}",
      "\\newcommand{\\inside}{I}", "\\newcommand{\\submacro}{U}", "\\newcommand{\\last}{L}",
    ]);
    assert.ok(d.macros.has("inA") && d.macros.has("inB") && d.macros.has("submacro"));
    assert.ok(!d.macros.has("ignored") && !d.macros.has("ignoredtail"));
    assert.equal(d.files.filter((f) => f === join(dir, "shared.tex")).length, 1, "files remain a unique dependency list");
    const unsaved = projectDefinitions(join(dir, "main.tex"), new Map([[join(dir, "b", "localdefs.tex"), "\\newcommand{\\inB}{Unsaved}\\renewcommand{\\same}{B}"]]));
    assert.ok(unsaved.statements.includes("\\newcommand{\\inB}{Unsaved}"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("projectDefinitions: a definer alias defined in one file is followed in the files read after it", () => {
  const dir = project({
    "main.tex": "\\documentclass{book}\n\\newcommand{\\nc}{\\newcommand}\n\\input{macros}\n\\begin{document}\n\\include{ch1}\n\\end{document}\n",
    "macros.tex": "\\nc{\\R}{\\mathbb{R}}\n\\let\\rnc\\renewcommand\n",
    "ch1.tex": "\\nc{\\Lip}[1]{L_{#1}}\n\\rnc{\\phi}{\\varphi}\n$\\R \\Lip{f}$\n",
  });
  try {
    const d = projectDefinitions(join(dir, "main.tex"));
    assert.deepEqual(d.statements, [
      "\\newcommand{\\R}{\\mathbb{R}}",
      "\\newcommand{\\Lip}[1]{L_{#1}}",
      "\\renewcommand{\\phi}{\\varphi}",
    ]);
    assert.deepEqual(d.macros.get("Lip"), { args: 1, optional: false }, "completion knows it too");
    assert.ok(d.macros.has("R"));
    // Read alone (no alias inherited), ch1 defines nothing.
    assert.deepEqual(projectDefinitions(join(dir, "ch1.tex")).statements, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projectDefinitions: macros MathJax cannot read are listed, not fed; a later readable definition wins", () => {
  const d = projectDefinitions(join(BOOK, "main.tex"));
  assert.deepEqual([...d.unsupported], [
    ["sym", "\\newcommand{\\sym}[1]{\\bn@style{#1}}"],
    ["set", "\\NewDocumentCommand{\\set}{m o}"],
  ]);
  const dir = project({
    "main.tex": [
      "\\documentclass{article}",
      "\\NewDocumentCommand{\\set}{m o}{\\{#1\\}}",
      "\\RenewDocumentCommand{\\set}{m}{\\{#1\\}}",
      "\\NewDocumentCommand{\\flag}{s m}{#2}",
      "\\def\\x@y{1}",
      "\\newcommand{\\wide}{\\a@" + "b".repeat(100) + "}",
      "\\ProvideDocumentCommand{\\flag}{s}{}",
    ].join("\n"),
  });
  try {
    const p = projectDefinitions(join(dir, "main.tex"));
    assert.deepEqual([...p.unsupported.keys()], ["flag", "wide"], "\\set's readable renewal, no internal \\x@y");
    assert.equal(p.unsupported.get("flag"), "\\NewDocumentCommand{\\flag}{s m}", "\\ProvideDocumentCommand of a defined name does nothing");
    assert.equal(p.unsupported.get("wide")!.length, 81, "shortened");
    assert.deepEqual(p.statements, ["\\newcommand{\\set}[1]{\\{#1\\}}"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
