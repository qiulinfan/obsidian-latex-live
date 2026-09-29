import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseLog } from "../src/tex/logParser";

const dir = mkdtempSync(join(tmpdir(), "latex-live-log-"));
mkdirSync(join(dir, "chapters"));
writeFileSync(join(dir, "main.tex"), "");
writeFileSync(join(dir, "chapters", "one.tex"), "");

test("file-line-error errors carry exact file and line", () => {
  const log = [
    "(./main.tex",
    "(./chapters/one.tex",
    "./chapters/one.tex:7: Undefined control sequence.",
    "l.7 \\foo",
    "        ",
    "The control sequence at the end of the top line",
    ")",
    "./main.tex:12: LaTeX Error: Environment bar undefined.",
    "",
    "See the LaTeX manual or LaTeX Companion for explanation.",
    "Type  H <return>  for immediate help.",
    " ...",
    "l.12 \\begin{bar}",
    ")",
  ].join("\n");
  const r = parseLog(log, dir);
  const errors = r.diagnostics.filter((d) => d.severity === "error");
  assert.equal(errors.length, 2);
  assert.deepEqual(errors[0], {
    severity: "error",
    file: join(dir, "chapters", "one.tex"),
    line: 7,
    message: "Undefined control sequence.",
  });
  assert.equal(errors[1].file, join(dir, "main.tex"));
  assert.equal(errors[1].line, 12);
  assert.equal(errors[1].message, "LaTeX Error: Environment bar undefined.");
});

test("package error continuation lines are joined", () => {
  const log = [
    "./main.tex:3: Package fontspec Error: ",
    "(fontspec)                The font \"Foo\" cannot be found;",
    "(fontspec)                this may be but usually is not a fontspec bug.",
    "",
    "For immediate help type H <return>.",
    "l.3 \\setmainfont{Foo}",
  ].join("\n");
  const [d] = parseLog(log, dir).diagnostics;
  assert.equal(d.line, 3);
  assert.match(d.message, /^Package fontspec Error: The font "Foo" cannot be found; this may/);
});

test("warnings attach to the innermost open file", () => {
  const log = [
    "(./main.tex (/usr/share/texmf/tex/latex/base/article.cls",
    "Document Class: article 2024/06/29 v1.4n Standard LaTeX document class",
    ") (./chapters/one.tex",
    "LaTeX Warning: Reference `sec:x' on page 1 undefined on input line 4.",
    "",
    "Package hyperref Warning: Token not allowed in a PDF string (Unicode):",
    "(hyperref)                removing `math shift' on input line 9.",
    "",
    ")",
    "Overfull \\hbox (12.3pt too wide) in paragraph at lines 20--22",
    "LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.",
    "",
    "Output written on main.pdf (3 pages, 12345 bytes).",
  ].join("\n");
  const r = parseLog(log, dir);
  const [ref, hyper, over, labels] = r.diagnostics;
  assert.equal(ref.file, join(dir, "chapters", "one.tex"));
  assert.equal(ref.line, 4);
  assert.equal(hyper.file, join(dir, "chapters", "one.tex"));
  assert.equal(hyper.line, 9);
  assert.match(hyper.message, /hyperref: Token not allowed .* removing `math shift'/);
  assert.equal(over.severity, "info");
  assert.equal(over.file, join(dir, "main.tex"));
  assert.equal(over.line, 20);
  assert.equal(labels.line, null);
  assert.equal(r.rerun, true);
  assert.equal(r.pages, 3);
});

test("bibliography hints and fatal errors", () => {
  const log = [
    "(./main.tex",
    "LaTeX Warning: Citation `knuth' on page 1 undefined on input line 5.",
    "",
    "! Emergency stop.",
    "<*> main.tex",
    "*** (job aborted, no legal \\end found)",
    "",
    "!  ==> Fatal error occurred, no output PDF file produced!",
  ].join("\n");
  const r = parseLog(log, dir);
  assert.equal(r.needsBibliography, true);
  assert.equal(r.pages, null);
  const errors = r.diagnostics.filter((d) => d.severity === "error");
  assert.equal(errors[0].message, "Emergency stop.");
  assert.equal(errors[0].file, join(dir, "main.tex"));
});
