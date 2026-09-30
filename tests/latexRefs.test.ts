// T-L6: what reference chips say (latexRefs), checked against what pdfLaTeX printed for the
// synthetic probe tests/fixtures/aux/cleveref/probe.tex (hyperref, cleveref, amsthm; TeX Live
// 2026) under four preambles, read back from each PDF; and the elegantbook item numbers whose
// colour used to leak into chips.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_REF_NAMES, LatexRefs, RefNames, refNames, refText, sameRefNames } from "../src/editor/latexRefs";
import { readAuxLabels } from "../src/tex/aux";

const labels = readAuxLabels(resolve("tests/fixtures/aux/cleveref"));
const refs = (names: RefNames): LatexRefs => ({ numbers: new Map(), labels, cites: new Map(), names, theorems: new Map(), checkpoints: new Map() });

/** The probe's preambles: the cleveref options and the lines after its \newtheorem's. */
const THEOREMS = String.raw`\newtheorem{theorem}{Theorem}[section] \newtheorem{lemma}[theorem]{Lemma} \newtheorem{prop}{Proposition} \newtheorem{claim}{Claim}`;
const VARIANTS: Record<string, string> = {
  plain: String.raw`\usepackage[]{cleveref}`,
  capnoabbrev: String.raw`\usepackage[capitalise,noabbrev]{cleveref}`,
  cap: String.raw`\usepackage[capitalize]{cleveref}`,
  custom: [
    String.raw`\usepackage[noabbrev]{cleveref}`,
    String.raw`\crefname{prop}{prop.}{props.}\Crefname{lemma}{Lem.}{Lems.}\crefname{claim}{claim}{claims}`,
    String.raw`\renewcommand{\sectionautorefname}{Section}\def\propautorefname{Prop.}\AtBeginDocument{\def\subsectionautorefname{Subsec.}}`,
  ].join("\n"),
};

/** [reference, what each variant's PDF printed: plain, capnoabbrev, cap, custom]. */
const PRINTED: [string, string, string, string, string][] = [
  ["\\cref{sec:intro}", "section 1", "Section 1", "Section 1", "section 1"],
  ["\\Cref{sec:intro}", "Section 1", "Section 1", "Section 1", "Section 1"],
  ["\\cref{sub:one}", "section 1.1", "Section 1.1", "Section 1.1", "section 1.1"],
  ["\\cref{eq:one}", "eq. (1)", "Equation (1)", "Eq. (1)", "equation (1)"],
  ["\\Cref{eq:one}", "Equation (1)", "Equation (1)", "Equation (1)", "Equation (1)"],
  ["\\cref{eq:suba}", "eq. (5a)", "Equation (5a)", "Eq. (5a)", "equation (5a)"],
  ["\\cref{thm:a}", "theorem 1.1", "Theorem 1.1", "Theorem 1.1", "theorem 1.1"],
  ["\\cref{lem:shared}", "theorem 1.2", "Theorem 1.2", "Theorem 1.2", "theorem 1.2"],
  ["\\cref{prop:own}", "proposition 1", "Proposition 1", "Proposition 1", "prop. 1"],
  ["\\cref{claim:x}", "claim 1", "Claim 1", "Claim 1", "claim 1"],
  ["\\cref{fig:a}", "fig. 1", "Figure 1", "Fig. 1", "figure 1"],
  ["\\cref{tab:a}", "table 1", "Table 1", "Table 1", "table 1"],
  ["\\cref{it:a}", "item 1", "Item 1", "Item 1", "item 1"],
  ["\\cref{it:b}", "item 2a", "Item 2a", "Item 2a", "item 2a"],
  ["\\cref{fn:a}", "footnote 1", "Footnote 1", "Footnote 1", "footnote 1"],
  ["\\cref{app:a}", "section A", "Section A", "Section A", "section A"],
  ["\\cref{app:sub}", "section A.1", "Section A.1", "Section A.1", "section A.1"],
  ["\\cref{fig:a,fig:b}", "figs. 1 and 2", "Figures 1 and 2", "Figs. 1 and 2", "figures 1 and 2"],
  ["\\cref{eq:one,eq:two,eq:three}", "eqs. (1) to (3)", "Equations (1) to (3)", "Eqs. (1) to (3)", "equations (1) to (3)"],
  ["\\cref{eq:one,eq:two,eq:four}", "eqs. (1), (2) and (4)", "Equations (1), (2) and (4)", "Eqs. (1), (2) and (4)", "equations (1), (2) and (4)"],
  ["\\cref{eq:one,eq:three}", "eqs. (1) and (3)", "Equations (1) and (3)", "Eqs. (1) and (3)", "equations (1) and (3)"],
  ["\\cref{eq:one,eq:two,eq:three,eq:four}", "eqs. (1) to (4)", "Equations (1) to (4)", "Eqs. (1) to (4)", "equations (1) to (4)"],
  ["\\cref{sec:intro,thm:a}", "section 1 and theorem 1.1", "Section 1 and Theorem 1.1", "Section 1 and Theorem 1.1", "section 1 and theorem 1.1"],
  [
    "\\cref{sec:intro,thm:a,fig:a}",
    "section 1, theorem 1.1, and fig. 1",
    "Section 1, Theorem 1.1, and Figure 1",
    "Section 1, Theorem 1.1, and Fig. 1",
    "section 1, theorem 1.1, and figure 1",
  ],
  [
    "\\cref{eq:two,thm:a,eq:one}",
    "eqs. (1) and (2) and theorem 1.1",
    "Equations (1) and (2) and Theorem 1.1",
    "Eqs. (1) and (2) and Theorem 1.1",
    "equations (1) and (2) and theorem 1.1",
  ],
  ["\\cref{eq:four,eq:one}", "eqs. (1) and (4)", "Equations (1) and (4)", "Eqs. (1) and (4)", "equations (1) and (4)"],
  ["\\cref{sec:intro,sec:two,sec:three}", "sections 1 to 3", "Sections 1 to 3", "Sections 1 to 3", "sections 1 to 3"],
  ["\\cref{sec:intro,sec:three}", "sections 1 and 3", "Sections 1 and 3", "Sections 1 and 3", "sections 1 and 3"],
  ["\\Cref{fig:a,fig:b}", "Figures 1 and 2", "Figures 1 and 2", "Figures 1 and 2", "Figures 1 and 2"],
  ["\\cref{nope}", "??", "??", "??", "??"],
  ["\\autoref{sec:intro}", "section 1", "section 1", "section 1", "Section 1"],
  ["\\autoref{sub:one}", "subsection 1.1", "subsection 1.1", "subsection 1.1", "Subsec. 1.1"],
  ["\\autoref{eq:one}", "Equation 1", "Equation 1", "Equation 1", "Equation 1"],
  ["\\autoref{eq:suba}", "Equation 5a", "Equation 5a", "Equation 5a", "Equation 5a"],
  ["\\autoref{thm:a}", "Theorem 1.1", "Theorem 1.1", "Theorem 1.1", "Theorem 1.1"],
  ["\\autoref{lem:shared}", "Theorem 1.2", "Theorem 1.2", "Theorem 1.2", "Theorem 1.2"],
  ["\\autoref{prop:own}", "1", "1", "1", "Prop. 1"],
  ["\\autoref{claim:x}", "1", "1", "1", "1"],
  ["\\autoref{fig:a}", "Figure 1", "Figure 1", "Figure 1", "Figure 1"],
  ["\\autoref{tab:a}", "Table 1", "Table 1", "Table 1", "Table 1"],
  ["\\autoref{it:a}", "item 1", "item 1", "item 1", "item 1"],
  ["\\autoref{fn:a}", "footnote 1", "footnote 1", "footnote 1", "footnote 1"],
  ["\\autoref{app:a}", "Appendix A", "Appendix A", "Appendix A", "Appendix A"],
  ["\\autoref{app:sub}", "subsection A.1", "subsection A.1", "subsection A.1", "Subsec. A.1"],
  ["\\ref{it:b}", "2a", "2a", "2a", "2a"],
];

/** A reference's chip text, from its source. */
function chip(source: string, names: RefNames): string {
  const m = /^\\([A-Za-z]+)\{([^}]*)\}$/.exec(source)!;
  return refText(m[1], m[2].split(","), refs(names)).text;
}

test("T-L6 \\cref, \\Cref and \\autoref chips read as the PDF printed them, under four preambles", () => {
  Object.keys(VARIANTS).forEach((variant, column) => {
    const names = refNames([THEOREMS, VARIANTS[variant]]);
    const got = PRINTED.map(([source]) => chip(source, names));
    assert.deepEqual(got, PRINTED.map((row) => row[column + 1]), variant);
  });
});

test("T-L6 refNames: definitions in any file and form; the variant not given follows the given one; subtypes copy their parent", () => {
  const names = refNames([
    "\\PassOptionsToPackage{capitalize}{cleveref}\n\\RequirePackage{hyperref,cleveref}",
    "\\providecommand*{\\lemmaautorefname}{Lemma}\\providecommand{\\sectionautorefname}{Sec.}\\renewcommand*\\equationautorefname{Eq.}",
    "\\Crefname{keypoint}{Key point}{Key points}\\crefname{section}{\\S}{\\S\\S}\\newtheorem{conj}[theorem]{Conjecture}",
  ]);
  assert.equal(names.autoref.get("lemma"), "Lemma", "\\providecommand of a name hyperref lacks");
  assert.equal(names.autoref.get("section"), "section", "\\providecommand does not replace hyperref's own");
  assert.deepEqual([names.autoref.get("equation"), names.autoref.get("AMS")], ["Eq.", "Eq."], "AMS tags follow \\equationautorefname");
  assert.deepEqual(names.cref.get("keypoint"), ["Key point", "Key points"], "capitalize: \\cref's follows \\Crefname as given");
  assert.deepEqual([names.cref.get("section"), names.Cref.get("section")], [["§", "§§"], ["§", "§§"]]);
  assert.deepEqual(names.cref.get("subsection"), ["§", "§§"], "a subsection copies its section's name");
  assert.deepEqual([names.cref.get("conj"), names.Cref.get("conj")], [["Conjecture", null], ["Conjecture", null]], "a theorem title: singular only");
  assert.deepEqual(DEFAULT_REF_NAMES.cref.get("subequation"), ["eq.", "eqs."]);
  assert.equal(sameRefNames(refNames(["\\usepackage{cleveref}"]), DEFAULT_REF_NAMES), true);
  assert.equal(sameRefNames(names, DEFAULT_REF_NAMES), false);
});

test("T-L6 a type cleveref cannot name prints ?? before its numbers (a warning chip); unknown labels are groups of their own", () => {
  const names = refNames([THEOREMS]);
  // A \newtheorem title names the singular only: two claims have no plural.
  const claims = refText("cref", ["claim:x", "claim:x"], refs(names));
  assert.deepEqual(claims, { text: "??1??1", missing: true });
  assert.deepEqual(refText("cref", ["fig:a", "nope", "eq:one"], refs(names)), { text: "fig. 1, ??, and eq. (1)", missing: true });
  assert.deepEqual(refText("cref", ["eq:one"], refs(names)), { text: "eq. (1)", missing: false });
});

test("T-L1 elegantbook's coloured item numbers: \\ref, \\autoref and \\cref show what the PDF prints", () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-refs-"));
  try {
    // XeLaTeX's .aux of an elegantbook chapter with `\begin{enumerate}\item ...\label{it:probe}`: its
    // enumerate labels are `\color{structurecolor}\arabic*.` (elegantbook.cls), nested ones `(\alph*).`.
    writeFileSync(
      join(dir, "ch3.aux"),
      [
        "\\newlabel{it:probe}{{{{\\color  {structurecolor}1.}}}{7}{随机梯度}{Item.7}{}}",
        "\\newlabel{it:probe2}{{{{\\color  {structurecolor}(a).}}}{7}{随机梯度}{Item.8}{}}",
      ].join("\n"),
    );
    const book: LatexRefs = { numbers: new Map(), labels: readAuxLabels(dir), cites: new Map(), names: DEFAULT_REF_NAMES, theorems: new Map(), checkpoints: new Map() };
    const text = (command: string, key: string) => refText(command, [key], book).text;
    assert.deepEqual(
      [text("ref", "it:probe"), text("autoref", "it:probe"), text("cref", "it:probe"), text("ref", "it:probe2")],
      ["1.", "item 1.", "item 1.", "(a)."],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-L9 \\autoref of a theorem: hyperref's name, else the theorem map's \\<env>name, else the number alone (as the PDFs print)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-refs-"));
  try {
    // The .aux labels of synthetic probes (TeX Live 2026): elegantbook in simple mode (XeLaTeX
    // printed `Theorem 1.1` and `定义 1.1`), in fancy mode with \elegantnewtheorem (`1.1`, `1.1`, `1.1`)
    // and amsthm's \newtheorem{thm}{Theorem} with hyperref (pdfLaTeX printed `1.1`, `1.2`).
    writeFileSync(
      join(dir, "main.aux"),
      [
        "\\newlabel{thm:simple}{{1.1}{1}{主}{theorem.1.1}{}}",
        "\\newlabel{def:simple}{{1.1}{1}{}{definition.1.1}{}}",
        "\\newlabel{thm:fancy}{{1.1}{1}{C}{tcb@cnt@theorem.1.1}{}}",
        "\\newlabel{fac:f}{{1.1}{1}{C}{tcb@cnt@fact.1.1}{}}",
        "\\newlabel{ex:coin}{{1.1}{1}{C}{exam.1.1}{}}",
        "\\newlabel{t1}{{1.1}{1}{Cauchy}{thm.1.1}{}}",
        "\\newlabel{l1}{{1.2}{1}{}{thm.1.2}{}}",
      ].join("\n"),
    );
    const labels = readAuxLabels(dir);
    const autoref = (preamble: string, key: string) => {
      const sources = [preamble];
      const refs: LatexRefs = { numbers: new Map(), labels, cites: new Map(), names: refNames(sources), theorems: new Map(), checkpoints: new Map() };
      return refText("autoref", [key], refs).text;
    };
    const simple = "\\documentclass[lang=cn,simple]{elegantbook}";
    assert.deepEqual([autoref(simple, "thm:simple"), autoref(simple, "def:simple")], ["Theorem 1.1", "定义 1.1"]);
    const fancy = "\\documentclass[lang=cn]{elegantbook}\n\\elegantnewtheorem{fact}{事实}{prostyle}{fac}";
    assert.deepEqual(["thm:fancy", "fac:f", "ex:coin"].map((k) => autoref(fancy, k)), ["1.1", "1.1", "1.1"]);
    const amsthm = "\\documentclass{article}\n\\usepackage{amsthm}\n\\newtheorem{thm}{Theorem}[section]\n\\newtheorem{lem}[thm]{Lemma}";
    assert.deepEqual([autoref(amsthm, "t1"), autoref(amsthm, "l1")], ["1.1", "1.2"], "amsthm defines no \\thmname");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
