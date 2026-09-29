// T-L6: readAuxLabels on static excerpts of the .aux files XeLaTeX writes for the synthetic
// elegantbook fixture (\include puts each chapter's labels in chapters/*.aux) and pdfLaTeX for a
// synthetic cleveref article (tests/fixtures/aux), and on hand-made edge cases.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readAuxLabels } from "../src/tex/aux";

const AUX = resolve("tests/fixtures/aux");
/** Each label as [key, number, page, kind]. */
const rows = (dir: string) => [...readAuxLabels(dir)].map(([k, l]) => [k, l.number, l.page, l.kind]).sort();

test("T-L6 elegantbook: chapters/*.aux of \\include, tcolorbox theorem anchors, figure and table captions", () => {
  assert.deepEqual(rows(join(AUX, "book")), [
    ["chap:linalg", "2", "2", "chapter"],
    ["chap:prob", "1", "1", "chapter"],
    ["def:prob-space", "1.1", "1", "definition"],
    ["eq:total-exp", "1.1", "1", "equation"],
    ["eq:trace", "2.1", "2", "equation"],
    ["eq:var-def", "1.2", "1", "equation"],
    ["eq:var-short", "1.3", "1", "equation"],
    ["fig:grid", "2.1", "2", "figure"],
    ["pro:psd", "2.1", "2", "proposition"],
    ["tab:decomp", "2.1", "2", "table"],
    ["thm:total-exp", "1.1", "1", "theorem"],
  ]);
  const thm = readAuxLabels(join(AUX, "book")).get("thm:total-exp");
  assert.deepEqual(thm, { number: "1.1", page: "1", title: "概率与期望", anchor: "tcb@cnt@theorem.1.1", kind: "theorem", order: null });
});

test("T-L6 cleveref article: the twins' type (it wins over the anchor) and sort key; AMS tags, items, footnotes, appendix", () => {
  assert.deepEqual(rows(join(AUX, "article")), [
    ["app:derivations", "A", "3", "appendix"],
    ["def:linear", "2.1", "1", "theorem"], // amsthm's shared counter: hyperref and cleveref both say theorem
    ["eq:bv-expand", "2a", "1", "subequation"],
    ["eq:wstar", "$\\star $", "2", "equation"], // \tag{$\star$}
    ["fig:curve", "1", "2", "figure"],
    ["fn:toy", "1", "1", "footnote"], // no twin: hyperref's Hfootnote
    ["it:tight", "i", "3", "enumi"], // no twin: hyperref's Item, cleveref's enumi
    ["lem:plain", "3.2", "3", "lemma"], // no hyperref: cleveref's type
    ["sec:intro", "1", "1", "section"],
  ]);
  const labels = readAuxLabels(join(AUX, "article"));
  const order = (k: string) => labels.get(k)?.order;
  assert.deepEqual([order("def:linear"), order("eq:bv-expand"), order("sec:intro"), order("fn:toy")], [[2, 1], [2, 1], [1], null]);
});

test("readAuxLabels: numbers, pages and anchors from every .aux under the build folder; broken lines skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-aux-"));
  try {
    mkdirSync(join(dir, "chapters"));
    writeFileSync(
      join(dir, "main.aux"),
      "\\relax\n\\abx@aux@refcontext{nyt/global//global/global/global}\n\\@input{chapters/ch1.aux}\n\\gdef \\@abspage@last{3}\n",
    );
    writeFileSync(
      join(dir, "chapters", "ch1.aux"),
      [
        "\\relax",
        "\\newlabel{thm:total-exp}{{1.1}{1}{概率与期望}{tcb@cnt@theorem.1.1}{}}",
        "\\newlabel{eq:var-def}{{1.2}{1}{概率与期望}{equation.1.2}{}}",
        "\\newlabel{eq:var-def@cref}{{[equation][2][1]1.2}{[1][1][]1}}",
        "\\newlabel{sec:plain}{{\\relax 2.3}{7}}",
        // elegantbook's enumerate labels are coloured: `label=\\color{structurecolor}\\arabic*.`
        "\\newlabel{it:probe}{{{{\\color  {structurecolor}1.}}}{7}{随机梯度}{Item.7}{}}",
        "\\newlabel{eq:e@cref}{{[equation][3][2,1]2.1.3}{[1][1][]1}{}{}{}}",
        "\\newlabel{eq:e}{{2.1.3}{1}{}{equation.2.1.3}{}}",
        "\\newlabel{broken}{{1.4}",
      ].join("\n"),
    );
    const labels = readAuxLabels(dir);
    assert.deepEqual([...labels.keys()].sort(), ["eq:e", "eq:var-def", "it:probe", "sec:plain", "thm:total-exp"]);
    assert.deepEqual(labels.get("sec:plain"), { number: "2.3", page: "7", title: "", anchor: "", kind: "", order: null }, "without hyperref or cleveref");
    assert.equal(labels.get("it:probe")?.number, "\\color  {structurecolor}1.", "outer groups go, the colour's argument stays a group (texText drops it)");
    assert.deepEqual([labels.get("eq:var-def")?.order, labels.get("eq:e")?.order], [[1, 2], [2, 1, 3]], "a twin before or after its label");
    assert.equal(readAuxLabels(join(dir, "missing")).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
