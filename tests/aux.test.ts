// readAuxLabels on a static excerpt of the .aux files XeLaTeX writes for the synthetic
// elegantbook fixture (\include puts each chapter's labels in chapters/*.aux).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuxLabels } from "../src/tex/aux";

test("readAuxLabels: numbers, pages and anchors from every .aux under the build folder", () => {
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
        "\\@writefile{toc}{\\contentsline {chapter}{\\numberline {1}概率与期望}{1}{chapter.1}\\protected@file@percent }",
        "\\newlabel{chap:prob}{{1}{1}{概率与期望}{chapter.1}{}}",
        "\\newlabel{thm:total-exp}{{1.1}{1}{概率与期望}{tcb@cnt@theorem.1.1}{}}",
        "\\newlabel{eq:var-def}{{1.2}{1}{概率与期望}{equation.1.2}{}}",
        "\\newlabel{eq:var-def@cref}{{[equation][2][1]1.2}{[1][1][]1}}",
        "\\newlabel{sec:plain}{{\\relax 2.3}{7}}",
        "\\newlabel{broken}{{1.4}",
      ].join("\n"),
    );
    const labels = readAuxLabels(dir);
    assert.deepEqual([...labels.keys()].sort(), ["chap:prob", "eq:var-def", "sec:plain", "thm:total-exp"]);
    assert.deepEqual(labels.get("thm:total-exp"), { number: "1.1", page: "1", title: "概率与期望", anchor: "tcb@cnt@theorem.1.1" });
    assert.deepEqual(labels.get("sec:plain"), { number: "2.3", page: "7", title: "", anchor: "" }, "without hyperref");
    assert.equal(readAuxLabels(join(dir, "missing")).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
