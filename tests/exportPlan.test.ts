import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { planExport, inputKey, isFileInput, lineAt, visitNodes, type ExportPlan } from "../src/export/plan";
import { probeSty } from "../src/export/probe";
import { projectDefinitions } from "../src/tex/macros";
import { stripComments } from "../src/tex/project";
import { theoremMap } from "../src/tex/theorems";

// The export's plan (src/export/plan.ts, design 3.2): the file graph, TeX's visit order, the
// fragments and the instrumented copies the probe compiles. Pure: no TeX here.

const FIXTURES = join(process.cwd(), "tests", "fixtures");

function plan(name: string, override: Record<string, string> = {}, mathOk?: (tex: string, display: boolean) => boolean): ExportPlan {
  const root = join(FIXTURES, name, "main.tex");
  const read = (abs: string) => override[abs] ?? readFileSync(abs, "utf8");
  const defs = projectDefinitions(root);
  const sources = defs.files.map((f) => stripComments(read(f)));
  return planExport(root, { defs, theorems: theoremMap(sources), read, mathOk });
}

test("file graph and visit order: \\include'd chapters, nested \\input (main -> appendix -> notation)", () => {
  const p = plan("export-book");
  assert.deepEqual(
    [...p.files.keys()].sort(),
    ["chapters/appendix.tex", "chapters/ch1.tex", "chapters/ch2.tex", "chapters/ch3.tex", "chapters/notation.tex", "figures/tikz-projection.tex", "macros.tex", "main.tex"],
  );
  // The preamble's \input{macros} is parsed (its definitions) but is no body visit.
  assert.deepEqual(
    p.visits.map((v) => `${v.key}#${v.occ}<${v.parent}:${v.parentLine}`),
    [
      "main.tex#0<-1:0",
      "chapters/ch1.tex#0<0:36",
      "chapters/ch2.tex#0<0:37",
      "figures/tikz-projection.tex#0<2:82",
      "chapters/ch3.tex#0<0:38",
      "chapters/appendix.tex#0<0:41",
      "chapters/notation.tex#0<5:5",
    ],
  );
  assert.equal(p.rootKey, "main.tex");
  assert.equal(p.job, "main");
  assert.equal(p.includeOnly, null);
  // The article: a nested \input with its own folder.
  const a = plan("export-article");
  assert.deepEqual(
    a.visits.map((v) => v.key),
    ["main.tex", "sections/intro.tex", "sections/method.tex", "sections/proofs/lemma-proof.tex", "sections/results.tex", "sections/appendix.tex"],
  );
});

test("\\includeonly is honoured; a file read twice is two visits", () => {
  const root = join(FIXTURES, "export-book", "main.tex");
  const only = readFileSync(root, "utf8").replace("% \\includeonly{chapters/ch2}", "\\includeonly{chapters/ch2}");
  const p = plan("export-book", { [root]: only });
  assert.deepEqual(p.includeOnly, ["chapters/ch2"]);
  assert.deepEqual(p.visits.map((v) => v.key), ["main.tex", "chapters/ch2.tex", "figures/tikz-projection.tex"]);
  // Only the visited files get copies (the rest the probe reads from the project).
  assert.deepEqual([...p.copies.keys()].sort(), ["chapters/ch2.tex", "figures/tikz-projection.tex", "main.tex"]);

  const twice = readFileSync(root, "utf8").replace("\\include{chapters/ch3}", "\\include{chapters/ch3}\n\\input{chapters/notation}");
  const t = plan("export-book", { [root]: twice });
  const notation = t.visits.filter((v) => v.key === "chapters/notation.tex");
  assert.deepEqual(notation.map((v) => [v.occ, v.parent === 0]), [[0, true], [1, false]]);
});

test("instrumented copies: the original's lines, and its bytes outside the inserts", () => {
  for (const name of ["export-book", "export-article", "export-homework"]) {
    const p = plan(name);
    for (const [key, copy] of p.copies) {
      const original = p.files.get(key)!.src;
      assert.equal(copy.split("\n").length, original.split("\n").length, `${name}/${key}: line count`);
      const inserts = p.fragments.filter((f) => f.key === key);
      const stripped = copy.replace(/\\(?:begin|end)\{llx(?:frag|block)\}(?:\{\d+\})?/g, "");
      assert.equal(stripped, original, `${name}/${key}: bytes outside the inserts`);
      assert.equal((copy.match(/\\begin\{llx(?:frag|block)\}/g) ?? []).length, inserts.length, `${name}/${key}: one insert pair per fragment`);
      for (const f of inserts) {
        const env = f.kind === "inline" ? "llxfrag" : "llxblock";
        // The insert pair stands on the construct's own lines.
        const at = copy.indexOf(`\\begin{${env}}{${f.id}}`);
        assert.equal(lineAt({ ...p.files.get(key)!, src: copy }, at), lineAt(p.files.get(key)!, f.from), `${key}: fragment ${f.id} line`);
      }
    }
  }
});

test("fragments: TikZ pictures inline, displays with tikz-cd and unknown environments as blocks", () => {
  const book = plan("export-book");
  assert.deepEqual(
    book.fragments.map((f) => [f.kind, f.what, f.key]),
    [
      ["block", "equation* math with tikzcd", "chapters/ch2.tex"],
      ["inline", "tikzpicture", "figures/tikz-projection.tex"],
    ],
  );
  const article = plan("export-article");
  assert.deepEqual(article.fragments.map((f) => [f.kind, f.what]), [["inline", "tikzpicture"]]);
  assert.equal(article.environmentExpansions.size, 1, "the traditional keypoint environment is native HTML");
  const hw = plan("export-homework");
  assert.deepEqual(hw.fragments.map((f) => [f.kind, f.what]), [["block", "algorithmic"]]);
  // A formula MathJax rejects (S2's mathOk) is a fragment too.
  const rejected = plan("export-article", {}, (tex) => !tex.includes("\\set{"));
  assert.ok(rejected.fragments.some((f) => f.what === "display math MathJax rejects" && f.key === "sections/intro.tex"));
});

test("\\tikz is an inline fragment; an \\input inside a fragment still counts as a visit", () => {
  const root = join(FIXTURES, "export-book", "main.tex");
  const ch1 = join(FIXTURES, "export-book", "chapters", "ch1.tex");
  const text = readFileSync(ch1, "utf8").replace(
    "本章用最少的记号",
    "图标 \\tikz[baseline] \\draw (0,0) circle (1pt); 与 \\begin{mybox}\\input{chapters/notation}\\end{mybox} 本章用最少的记号",
  );
  const p = plan("export-book", { [ch1]: text, [root]: readFileSync(root, "utf8") });
  const inCh1 = p.fragments.filter((f) => f.key === "chapters/ch1.tex");
  assert.deepEqual(inCh1.map((f) => [f.kind, f.what, text.slice(f.from, f.to)]), [
    ["inline", "\\tikz", "\\tikz[baseline] \\draw (0,0) circle (1pt);"],
    ["block", "mybox", "\\begin{mybox}\\input{chapters/notation}\\end{mybox}"],
  ]);
  assert.equal(p.visits[2].key, "chapters/notation.tex");
  assert.equal(p.visits[2].parent, 1);
});

test("probe configuration: names, colours and the environments to classify", () => {
  const p = plan("export-book");
  for (const n of ["contents", "figure", "table", "bib", "theorem", "definition", "proof", "example", "note"]) {
    assert.ok(p.probe.names.includes(n), n);
  }
  assert.ok(p.probe.colors.includes("structurecolor"));
  assert.deepEqual(p.probe.envs.sort(), ["corollary", "definition", "example", "exercise", "lemma", "note", "proof", "proposition", "remark", "solution", "theorem"]);
  const sty = probeSty(p.probe);
  assert.match(sty, /\\def\\llx@names\{contents,listfigure,[^}]*theorem[^}]*\}/);
  assert.match(sty, /\\def\\llx@envs\{[^}]*definition/);
  // The article's own \newenvironment is classified; colours the body names are asked for.
  const intro = join(FIXTURES, "export-article", "sections", "intro.tex");
  const a = plan("export-article", { [intro]: readFileSync(intro, "utf8").replace("Masked reconstruction", "\\textcolor{teal}{Masked} \\color{accent}reconstruction") });
  assert.ok(a.probe.envs.includes("keypoint"));
  assert.ok(a.probe.colors.includes("teal") && a.probe.colors.includes("accent"));
});

test("imports and subfiles: contextual paths, aliases, body-only visits, and literal space/Unicode names", () => {
  const root = join(FIXTURES, "export-structure", "main file.tex");
  const defs = projectDefinitions(root);
  const p = planExport(root, { defs, theorems: theoremMap(defs.files.map((f) => readFileSync(f, "utf8"))) });
  assert.equal(p.rootKey, "main file.tex");
  assert.equal(p.job, "main file");
  assert.deepEqual(p.visits.map((v) => v.key), [
    "main file.tex", "parts one/chapter one.tex", "parts one/detail.tex", "parts one/nested/child.tex",
    "parts one/nested/detail.tex", "parts one/parent only.tex", "root only.tex", "root only.tex",
    "子目录/子文档.tex", "子目录/child notes.tex",
  ]);
  assert.equal(p.missing.size, 0, "the ignored subfile preamble and tail create no missing files");
  assert.equal(p.visits[8].bodyOnly, true);
  assert.ok(visitNodes(p, 8).every((n) => n.t !== "env" || n.name !== "document"));
  const subbody = visitNodes(p, 8).filter(isFileInput);
  assert.equal(subbody.length, 1, "only the body input is visited");
  assert.equal(p.inputTargets.get(`8@${subbody[0].from}`), 9);
  assert.equal(p.environmentExpansions.size, 2, "both optional-default and nested text environments expand");
  assert.equal(p.fragments.length, 0);
  assert.equal(inputKey(p.rootDir, '"子目录/子文档"'), "子目录/子文档.tex");
  assert.equal(inputKey(p.rootDir, "..literal"), "..literal", "a filename beginning with dots stays inside the project");
  assert.equal(inputKey(p.rootDir, "../outside"), null);
  for (const [key, copy] of p.copies) {
    assert.equal(copy, p.files.get(key)!.src, `${key}: native expansions never rewrite the probe source`);
  }
});

test("the same imported file in two contexts resolves each input by its visit, and include aliases obey includeonly", () => {
  const root = join(FIXTURES, "export-structure", "context.tex");
  const contents = new Map([
    [root, "\\documentclass{article}\\includeonly{b/shared}\\begin{document}\\inputfrom{a/}{../shared}\\subincludefrom{b/}{shared}\\import{b/}{../shared}\\end{document}"],
    [join(FIXTURES, "export-structure", "shared.tex"), "Shared \\input{note}"],
    [join(FIXTURES, "export-structure", "a", "note.tex"), "A"],
    [join(FIXTURES, "export-structure", "b", "note.tex"), "B"],
    [join(FIXTURES, "export-structure", "b", "shared.tex"), "Included"],
  ]);
  const defs = { macros: new Map(), colors: new Set<string>(), environments: new Set<string>(), statements: [], unsupported: new Map(), packages: new Set<string>(), files: [root] };
  const p = planExport(root, { defs, theorems: new Map(), read: (abs) => { const s = contents.get(abs); if (s === undefined) throw Error(abs); return s; } });
  assert.deepEqual(p.visits.map((v) => v.key), ["context.tex", "shared.tex", "a/note.tex", "b/shared.tex", "shared.tex", "b/note.tex"]);
  const input = p.files.get("shared.tex")!.nodes.find(isFileInput)!;
  assert.equal(p.inputTargets.get(`1@${input.from}`), 2);
  assert.equal(p.inputTargets.get(`4@${input.from}`), 5);
  assert.equal(p.visits[4].occ, 1);
  assert.equal(p.sourceAliases.get(join(FIXTURES, "export-structure") + "/a/../shared.tex"), "shared.tex");
  assert.equal(p.sourceAliases.get(join(FIXTURES, "export-structure") + "/b/../shared.tex"), "shared.tex");
});

test("environment expansion retains TeX-only constructs, failed math, recursive definitions and external inputs as fragments", () => {
  const root = join(FIXTURES, "export-structure", "bounded.tex");
  const src = "\\documentclass{article}\\newenvironment{plain}[1]{\\textbf{#1}}{\\par}\\newenvironment{recursive}{\\begin{recursive}}{\\end{recursive}}\\begin{document}\\begin{plain}{Title}\\begin{tikzpicture}\\end{tikzpicture}\\end{plain}\\begin{plain}{Title}$bad$\\end{plain}\\begin{recursive}Body\\end{recursive}\\input{../external}\\end{document}";
  const defs = { macros: new Map(), colors: new Set<string>(), environments: new Set<string>(), statements: [], unsupported: new Map(), packages: new Set<string>(), files: [root] };
  const p = planExport(root, { defs, theorems: new Map(), read: (abs) => { if (abs !== root) throw Error(abs); return src; }, mathOk: (tex) => tex !== "bad" });
  assert.equal(p.environmentExpansions.size, 0);
  assert.deepEqual(p.fragments.map((f) => f.what), ["plain", "plain", "recursive"]);
  assert.equal(p.missing.get("../external.tex"), "bounded.tex", "external input is explicitly reportable without copying outside the project");
});
