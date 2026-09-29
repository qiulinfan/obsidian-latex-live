import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  detectEngine,
  findRoot,
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

test("preamble stops at \\begin{document} outside comments", () => {
  const text = "\\documentclass{article}\n% \\begin{document}\n\\usepackage{x}\n\\begin{document}\nbody\n";
  assert.equal(
    preambleOf(text),
    "\\documentclass{article}\n% \\begin{document}\n\\usepackage{x}",
  );
  assert.equal(preambleOf("no document"), null);
});
