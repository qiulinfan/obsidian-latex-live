import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { planExport } from "../src/export/plan";
import { cssColor, readProbeLog, StepQueue, tocEntry } from "../src/export/probeLog";
import { censusSpec } from "../src/export/signatures";
import { projectDefinitions } from "../src/tex/macros";
import { stripComments } from "../src/tex/project";
import { texText } from "../src/tex/texText";
import { theoremMap } from "../src/tex/theorems";

// The probe's .llx reader and its step queues (src/export/probeLog.ts, design 3.2), on static
// logs: book.llx and article.llx are what XeLaTeX and pdfLaTeX wrote for the export fixtures'
// plans (regenerate them from a probe run of fresh copies); twice.llx is written by hand.

const STATIC = join(process.cwd(), "tests", "fixtures", "export-static");
const llx = (name: string) => readProbeLog(readFileSync(join(STATIC, name), "utf8"));

function planOf(name: string) {
  const root = join(process.cwd(), "tests", "fixtures", name, "main.tex");
  const defs = projectDefinitions(root);
  return planExport(root, { defs, theorems: theoremMap(defs.files.map((f) => stripComments(readFileSync(f, "utf8")))) });
}

test("records: names, colours, census, info, citations, fragments and visits", () => {
  const log = llx("book.llx");
  assert.equal(log.unreadable, 0);
  assert.equal(log.names.get("theorem"), "定理");
  assert.equal(log.names.get("figure"), "图");
  assert.equal(log.names.get("contents"), "目录");
  assert.equal(log.colors.get("structurecolor"), "rgb(60, 113, 183)");
  assert.equal(log.colors.get("main"), "rgb(0, 166, 82)");
  assert.match(log.envs.get("theorem")!, /__cmd_start_env:nnnnn \{ g o t\\label g \}/);
  assert.equal(censusSpec(log.envs.get("theorem")!), "g o t\\label g");
  assert.equal(censusSpec(log.envs.get("example")!), "o");
  assert.equal(censusSpec(log.envs.get("note")!), "");
  assert.equal(log.info.get("fontsize"), "10.95");
  assert.equal(log.info.get("tocdepth"), "1");
  assert.deepEqual(log.cites.get("zhang2020notes"), { number: "5", prefix: "" });
  assert.deepEqual(log.fragments.map((f) => [f.id, f.box ? Math.round(f.box.wd) : null]), [[1, 206], [0, null]]);
  // Project visits and the .fd files XeLaTeX read on the way.
  assert.deepEqual(
    log.visits.map((v) => v.key).filter((k) => k === "" || k.endsWith(".tex")),
    ["", "chapters/ch1.tex", "chapters/ch2.tex", "figures/tikz-projection.tex", "chapters/ch3.tex", "chapters/appendix.tex", "chapters/notation.tex"],
  );
  const article = llx("article.llx");
  assert.equal(article.envs.get("definition")?.includes("\\@thm"), true);
  assert.equal(censusSpec(article.envs.get("keypoint")!), "o");
});

test("contents entries: the number as the class prints it, the title", () => {
  assert.deepEqual(tocEntry("\\protect \\numberline {第一章}概率空间与期望"), { number: "第一章", title: "概率空间与期望" });
  assert.deepEqual(tocEntry("\\protect \\numberline {第 1{} 章}第一次作业"), { number: "第 1 章", title: "第一次作业" });
  assert.deepEqual(tocEntry("第三章~练习"), { number: null, title: "第三章 练习" });
  assert.deepEqual(tocEntry("\\protect \\numberline {A.1}交叉引用汇总"), { number: "A.1", title: "交叉引用汇总" });
});

test("colours: xcolor's models as CSS", () => {
  assert.equal(cssColor("rgb", "0.23529,0.44315,0.71765"), "rgb(60, 113, 183)");
  assert.equal(cssColor("gray", "0.5"), "rgb(128, 128, 128)");
  assert.equal(cssColor("cmyk", "0,1,1,0"), "rgb(255, 0, 0)");
  assert.equal(cssColor("RGB", "0,166,82"), "rgb(0, 166, 82)");
  assert.equal(cssColor("HTML", "3C71B7"), "#3c71b7");
  assert.equal(cssColor("hsb", "0.5,1,1"), null);
});

test("tcolorbox's double steps merge; headings take their contents records", () => {
  const plan = planOf("export-book");
  const q = new StepQueue(llx("book.llx"), plan.visits);
  const ch1 = plan.visits.findIndex((v) => v.key === "chapters/ch1.tex");
  const ch2 = plan.visits.findIndex((v) => v.key === "chapters/ch2.tex");
  assert.equal(tocEntry(q.take("toc", { visit: ch1, from: 1, to: 1 })!.value).number, "第一章");
  assert.equal(tocEntry(q.take("toc", { visit: ch1, from: 6, to: 6 })!.value).number, "1.1");
  // One box, two records at its line: the box takes one, nothing is left for the next.
  assert.equal(q.take("tcb@cnt@definition", { visit: ch1, from: 8, to: 15 })?.value, "1.1");
  assert.equal(q.take("tcb@cnt@definition", { visit: ch2, from: 5, to: 8 })?.value, "2.1");
  assert.deepEqual(q.orphans, []);
  // The enumerate package's labels.
  assert.deepEqual(
    [78, 79, 80].map((line) => texText(q.take("enumi", { visit: ch1, from: line, to: line })!.value)),
    ["(a)", "(b)", "(c)"],
  );
  // elegantbook's problemset labels ({\color{structurecolor}1.}) and its contents record.
  const ch3 = plan.visits.findIndex((v) => v.key === "chapters/ch3.tex");
  const q3 = new StepQueue(llx("book.llx"), plan.visits);
  for (const line of [1, 7, 25, 57]) q3.take("toc", { visit: ch3, from: line, to: line });
  assert.equal(tocEntry(q3.take("toc", { visit: ch3, from: 85, to: 89 })!.value).title, "第三章 练习");
  assert.equal(texText(q3.take("enumi", { visit: ch3, from: 86, to: 86 })!.value), "1.");
});

test("a record is positioned by its visit: the bibliography's entry after the last chapter is the root's", () => {
  const plan = planOf("export-book");
  const q = new StepQueue(llx("book.llx"), plan.visits);
  // Its fields name appendix.tex (TeX still names the file just closed) but it is at main.tex:43.
  const bib = q.take("toc", { visit: 0, from: 43, to: 43 });
  assert.equal(bib && tocEntry(bib.value).title, "参考文献");
  // Every earlier contents record was dropped on the way, as orphans.
  assert.equal(q.orphans.filter((o) => o.counter === "toc").length, 15);
  // A figure reads a picture from another file: that file's lines lie inside the figure, and the
  // picture (fragment 1) took no step of its own, so dropping it leaves the caption's.
  const ch2 = plan.visits.findIndex((v) => v.key === "chapters/ch2.tex");
  const q2 = new StepQueue(llx("book.llx"), plan.visits);
  assert.deepEqual(q2.drop(1, ch2), []);
  assert.equal(q2.take("figure", { visit: ch2, from: 80, to: 85 })?.value, "2.1");
});

test("\\tag undo and subequations (pdfLaTeX, amsmath)", () => {
  const plan = planOf("export-article");
  const q = new StepQueue(llx("article.llx"), plan.visits);
  const method = plan.visits.findIndex((v) => v.key === "sections/method.tex");
  const results = plan.visits.findIndex((v) => v.key === "sections/results.tex");
  const intro = plan.visits.findIndex((v) => v.key === "sections/intro.tex");
  assert.equal(q.take("equation", { visit: intro, from: 12, to: 14 })?.value, "1");
  // subequations steps its parent twice at its \begin: one record.
  assert.equal(q.take("equation", { visit: method, from: 11, to: 20 })?.value, "2");
  assert.equal(q.take("equation", { visit: method, from: 12, to: 19 })?.value, "2a");
  assert.equal(q.take("equation", { visit: method, from: 12, to: 19 })?.value, "2b");
  // The \tag{$\star$} equation steps and restores the counter: the next equation steps to the
  // same value in another file; each takes its own.
  assert.equal(q.take("equation", { visit: method, from: 26, to: 28 })?.value, "3");
  assert.equal(q.take("equation", { visit: results, from: 43, to: 46 })?.value, "3");
  assert.equal(q.take("equation", { visit: results, from: 51, to: 55 })?.value, "4");
  assert.deepEqual(q.orphans, []);
  // enumitem's label=(\roman*).
  assert.equal(texText(q.take("enumi", { visit: results, from: 59, to: 59 })!.value), "(i)");
});

test("orphan and missing steps", () => {
  const plan = planOf("export-article");
  const q = new StepQueue(llx("article.llx"), plan.visits);
  const method = plan.visits.findIndex((v) => v.key === "sections/method.tex");
  const results = plan.visits.findIndex((v) => v.key === "sections/results.tex");
  // A construct with no step in its lines gets none, and the head stays for its owner.
  assert.equal(q.take("figure", { visit: method, from: 1, to: 40 }), null);
  assert.equal(q.take("figure", { visit: results, from: 20, to: 33 })?.value, "1");
  assert.equal(q.take("theorem", { visit: results, from: 41, to: 47 })?.value, "3.1");
  assert.deepEqual(q.orphans.map((o) => o.value), ["2.1", "2.2"], "the lemma and definition nothing took");
  // A construct skipped: its step is dropped as an orphan when a later one takes.
  const q2 = new StepQueue(llx("article.llx"), plan.visits);
  assert.equal(q2.take("theorem", { visit: method, from: 9, to: 21 })?.value, "2.2");
  assert.deepEqual(q2.orphans.map((o) => [o.counter, o.value, o.key, o.line]), [["theorem", "2.1", "sections/method.tex", 4]]);
  // An unknown plan visit (the probe never read that file) takes nothing.
  assert.equal(new StepQueue(llx("article.llx"), [{ key: "main.tex", occ: 0 }, { key: "nope.tex", occ: 0 }]).take("equation", { visit: 1, from: 1, to: 99 }), null);
});

test("a file visited twice: each visit takes its own steps", () => {
  const log = llx("twice.llx");
  const visits = [
    { key: "main.tex", occ: 0 },
    { key: "parts/common.tex", occ: 0 },
    { key: "parts/common.tex", occ: 1 },
  ];
  const q = new StepQueue(log, visits);
  assert.deepEqual(
    [q.take("enumi", { visit: 1, from: 2, to: 2 }), q.take("enumi", { visit: 1, from: 3, to: 3 })].map((s) => s && texText(s.value)),
    ["1.", "2."],
  );
  // After the first visit closed, the record naming common.tex is the root's line 6.
  assert.equal(q.take("equation", { visit: 0, from: 6, to: 6 })?.value, "1");
  assert.equal(q.take("toc", { visit: 0, from: 5, to: 5 })?.level, "section");
  assert.deepEqual(
    [q.take("enumi", { visit: 2, from: 2, to: 3 }), q.take("enumi", { visit: 2, from: 2, to: 3 })].map((s) => s && texText(s.value)),
    ["1.", "2."],
  );
  assert.deepEqual(q.orphans, []);
  // Taking the second visit's first drops the first visit's as orphans.
  const q2 = new StepQueue(log, visits);
  assert.equal(texText(q2.take("enumi", { visit: 2, from: 2, to: 2 })!.value), "1.");
  assert.deepEqual(q2.orphans.map((o) => [o.key, o.line]), [["parts/common.tex", 2], ["parts/common.tex", 3]]);
});

test("steps TeX took inside a fragment carry its id; dropping the fragment takes exactly those", () => {
  const log = readProbeLog(
    [
      "llxstep{equation}{1}{}{main.tex}{3}",
      "llxopen{0}",
      "llxblock{0}",
      "llxstep{equation}{2}{}{main.tex}{4}",
      "llxstep{footnote}{1}{}{main.tex}{4}",
      "llxclose{0}",
      "llxstep{figure}{1}{}{main.tex}{4}",
      "llxstep{equation}{3}{}{main.tex}{5}",
    ].join("\n"),
  );
  assert.equal(log.unreadable, 0);
  assert.deepEqual(log.steps.map((s) => s.frag ?? null), [null, 0, 0, null, null]);
  const q = new StepQueue(log, [{ key: "main.tex", occ: 0 }]);
  assert.equal(q.take("equation", { visit: 0, from: 3, to: 3 })?.value, "1");
  assert.deepEqual(q.drop(0, 0).map((s) => `${s.counter} ${s.value}`), ["equation 2", "footnote 1"]);
  // A caption on the fragment's line keeps its step; the next formula takes 3.
  assert.equal(q.take("figure", { visit: 0, from: 4, to: 4 })?.value, "1");
  assert.equal(q.take("equation", { visit: 0, from: 5, to: 5 })?.value, "3");
  assert.deepEqual(q.orphans, []);
});
