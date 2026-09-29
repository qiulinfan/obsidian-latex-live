import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  detectEngine,
  findRoot,
  preambleFiles,
  preambleOf,
  referencedFiles,
} from "../src/tex/project";

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-proj-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test("a file with \\documentclass is its own root", () => {
  const dir = tree({ "a.tex": "\\documentclass{article}\n" });
  assert.equal(findRoot(join(dir, "a.tex"), dir), join(dir, "a.tex"));
});

test("chapters resolve to the document that inputs them", () => {
  const dir = tree({
    "course/main.tex":
      "\\documentclass{book}\n% \\input{chapters/old}\n\\begin{document}\n\\input{chapters/01-intro}\n\\include{chapters/two.tex}\n\\end{document}\n",
    "course/other.tex": "\\documentclass{article}\n\\input{chapters/old}\n",
    "course/chapters/01-intro.tex": "\\chapter{Intro}\n",
    "course/chapters/two.tex": "\\chapter{Two}\n",
    "course/chapters/old.tex": "x\n",
  });
  const main = join(dir, "course", "main.tex");
  assert.equal(findRoot(join(dir, "course/chapters/01-intro.tex"), dir), main);
  assert.equal(findRoot(join(dir, "course/chapters/two.tex"), dir), main);
  // Commented-out inputs do not count.
  assert.equal(
    findRoot(join(dir, "course/chapters/old.tex"), dir),
    join(dir, "course", "other.tex"),
  );
});

test("a nested input without a magic comment resolves through the file that inputs it", () => {
  const dir = tree({
    "book/main.tex": "\\documentclass{book}\n\\begin{document}\n\\include{chapters/appendix}\n\\end{document}\n",
    "book/chapters/appendix.tex": "\\chapter{A}\n\\input{chapters/notation}\n% \\input{chapters/old}\n",
    "book/chapters/notation.tex": "$\\R$\n",
    "book/chapters/old.tex": "x\n",
    "book/chapters/loop.tex": "\\input{chapters/loop}\n",
    // A root that inputs the file directly wins over one that reaches it further down.
    "direct/a.tex": "\\documentclass{article}\n\\input{mid}\n",
    "direct/b.tex": "\\documentclass{article}\n\\input{leaf}\n",
    "direct/mid.tex": "\\input{leaf}\n",
    "direct/leaf.tex": "x\n",
  });
  const main = join(dir, "book", "main.tex");
  assert.equal(findRoot(join(dir, "book/chapters/notation.tex"), dir), main);
  // Commented-out and cyclic inputs do not count.
  const old = join(dir, "book/chapters/old.tex");
  assert.equal(findRoot(old, dir), old);
  const loop = join(dir, "book/chapters/loop.tex");
  assert.equal(findRoot(loop, dir), loop);
  assert.equal(findRoot(join(dir, "direct/leaf.tex"), dir), join(dir, "direct/b.tex"));
});

test("the TeX root magic comment wins", () => {
  const dir = tree({
    "main.tex": "\\documentclass{article}\n",
    "sub/part.tex": "% !TEX root = ../main.tex\n\\section{A}\n",
  });
  assert.equal(findRoot(join(dir, "sub/part.tex"), dir), join(dir, "main.tex"));
});

test("orphans compile on their own", () => {
  const dir = tree({ "notes/frag.tex": "just text\n" });
  const f = join(dir, "notes/frag.tex");
  assert.equal(findRoot(f, dir), f);
});

test("\\import resolves directory and file", () => {
  const refs = referencedFiles("\\subimport{parts/}{intro}\n", "/r");
  assert.deepEqual(refs, ["/r/parts/intro.tex"]);
});

test("engine detection order", () => {
  const dir = tree({});
  assert.equal(detectEngine("\\documentclass{article}", dir, "auto"), "pdflatex");
  assert.equal(
    detectEngine("\\documentclass{article}\n\\usepackage[UTF8]{ctex}\n\\begin{document}", dir, "auto"),
    "xelatex",
  );
  assert.equal(
    detectEngine("\\documentclass{article}\n\\usepackage{fontspec}", dir, "pdflatex"),
    "pdflatex",
  );
  assert.equal(
    detectEngine("% !TEX program = lualatex\n\\documentclass{article}", dir, "xelatex"),
    "lualatex",
  );
  assert.equal(
    detectEngine("\\documentclass{article}\n% \\usepackage{fontspec}\n", dir, "auto"),
    "pdflatex",
  );
  const rc = tree({ latexmkrc: "$pdf_mode = 4; # lualatex\n" });
  assert.equal(detectEngine("\\documentclass{article}", rc, "auto"), "lualatex");
});

test("classes that load ctex select XeLaTeX without a magic comment", () => {
  const dir = tree({});
  const engine = (preamble: string) =>
    detectEngine(`${preamble}\n\\begin{document}\n`, dir, "auto");
  // elegantbook in Chinese, as the synthetic book fixture starts.
  assert.equal(
    engine("\\PassOptionsToPackage{fontset=fandol}{ctex}\n\\documentclass[lang=cn,11pt,chinese,thmcnt=chapter]{elegantbook}"),
    "xelatex",
  );
  assert.equal(engine("\\documentclass[ lang = cn ]{elegantbook}"), "xelatex");
  assert.equal(engine("\\documentclass[cn,green]{elegantbook}"), "xelatex");
  // elegantbook's `chinese` is a heading scheme (`scheme=chinese`): ctex comes only with lang=cn.
  assert.equal(engine("\\documentclass[chinese]{elegantbook}"), "pdflatex");
  assert.equal(engine("\\documentclass[chinese,chinesefont=founder]{elegantbook}"), "pdflatex");
  assert.equal(engine("\\documentclass[chinese]{elegantpaper}"), "pdflatex");
  assert.equal(
    engine("\\documentclass[\n  lang=cn, % Chinese\n  a4paper,\n]{elegantpaper}"),
    "xelatex",
  );
  // elegantnote is Chinese by default; elegantbook and elegantpaper are English.
  assert.equal(engine("\\documentclass{elegantnote}"), "xelatex");
  assert.equal(engine("\\documentclass[lang=en]{elegantnote}"), "pdflatex");
  assert.equal(engine("\\documentclass[en]{elegantnote}"), "pdflatex");
  assert.equal(engine("\\documentclass{elegantbook}"), "pdflatex");
  assert.equal(engine("\\documentclass[lang=en,green]{elegantbook}"), "pdflatex");
  assert.equal(engine("% \\documentclass[lang=cn]{elegantbook}\n\\documentclass{elegantbook}"), "pdflatex");
  for (const cls of ["ctexart", "ctexbook", "ctexrep", "ctexbeamer"]) {
    assert.equal(engine(`\\documentclass[a4paper]{${cls}}`), "xelatex", cls);
  }
  // Explicit choices still win.
  assert.equal(
    detectEngine("% !TEX program = lualatex\n\\documentclass[lang=cn]{elegantbook}", dir, "auto"),
    "lualatex",
  );
  assert.equal(detectEngine("\\documentclass[lang=cn]{elegantbook}", dir, "pdflatex"), "pdflatex");
});

test("preamble stops at \\begin{document} outside comments", () => {
  const text = "\\documentclass{article}\n% \\begin{document}\n\\usepackage{x}\n\\begin{document}\nbody\n";
  assert.equal(
    preambleOf(text),
    "\\documentclass{article}\n% \\begin{document}\n\\usepackage{x}",
  );
  assert.equal(preambleOf("no document"), null);
});

test("preambleFiles: what the root inputs before \\begin{document}, through nested inputs; never the chapters", () => {
  const dir = tree({
    "main.tex":
      "\\documentclass{book}\n\\input{setup/preamble}\n% \\input{setup/old}\n\\begin{document}\n\\input{chapters/ch1}\n\\end{document}\n",
    "setup/preamble.tex": "\\hypersetup{pdftitle={My $\\alpha$ notes}}\n\\input{setup/boxes}\n",
    "setup/boxes.tex": "\\tcbset{before upper={\\emph{Note:} }}\n",
    "setup/old.tex": "x\n",
    "chapters/ch1.tex": "\\chapter{One} $x$\n",
    "orphan.tex": "\\documentclass{article}\n\\input{setup/boxes}\n",
  });
  assert.deepEqual([...preambleFiles(join(dir, "main.tex"))], [join(dir, "setup/preamble.tex"), join(dir, "setup/boxes.tex")]);
  assert.deepEqual([...preambleFiles(join(dir, "orphan.tex"))], [], "no \\begin{document}: no body to set up");
  assert.deepEqual([...preambleFiles(join(dir, "missing.tex"))], []);
});
