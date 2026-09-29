import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveTexBinDir, workingBiber } from "../src/tex/binaries";
import {
  BuildMode,
  CompileOptions,
  CompileResult,
  Compiler,
  readBibFiles,
} from "../src/tex/compiler";
import { Engine } from "../src/tex/project";
import { forwardSearch, inverseSearch } from "../src/tex/synctex";

// Integration tests against the machine's TeX installation.
const binDir = process.env.TEXBIN ?? resolveTexBinDir("");
const skip = binDir ? false : "no TeX installation found";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-cc-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

interface Harness {
  compiler: Compiler;
  starts: BuildMode[];
  next(): Promise<CompileResult>;
  /** The last result of a request, after any reference-settling pass. */
  final(): Promise<CompileResult>;
}

function harness(root: string, opts: Partial<CompileOptions> = {}): Harness {
  const outDir = mkdtempSync(join(tmpdir(), "latex-live-out-"));
  const results: CompileResult[] = [];
  const waiters: ((r: CompileResult) => void)[] = [];
  const starts: BuildMode[] = [];
  const options: CompileOptions = {
    binDir: binDir!,
    engine: "pdflatex" as Engine,
    outDir,
    preambleCache: false,
    shellEscape: false,
    ...opts,
  };
  const compiler = new Compiler(root, () => options, {
    onStart: (m) => starts.push(m),
    onResult: (r) => {
      const w = waiters.shift();
      if (w) w(r);
      else results.push(r);
    },
    onFailure: (e) => {
      throw e;
    },
  });
  const next = (): Promise<CompileResult> =>
    results.length
      ? Promise.resolve(results.shift()!)
      : new Promise((r) => waiters.push(r));
  const final = async (): Promise<CompileResult> => {
    let r = await next();
    while (r.mode === "fast" && r.passes === 1 && r.log.rerun) r = await next();
    return r;
  };
  return { compiler, starts, next, final };
}

const BODY = [
  "\\documentclass{article}",
  "\\usepackage{amsmath}",
  "\\begin{document}",
  "\\section{Intro}\\label{sec:intro}",
  "See Section~\\ref{sec:intro}.",
  "\\input{chapters/one}",
  "\\end{document}",
  "",
].join("\n");

test("fast compile: PDF, deps, settled references", { skip }, async () => {
  const dir = project({
    "main.tex": BODY,
    "chapters/one.tex": "Chapter text $e^{i\\pi}+1=0$.\n",
  });
  const h = harness(join(dir, "main.tex"));
  h.compiler.request();
  const first = await h.next();
  // The first pass is shown before the reference-settling pass runs.
  assert.equal(first.passes, 1);
  assert.equal(first.pdfWritten, true);
  const r = await h.next();
  assert.equal(r.pdfWritten, true);
  assert.ok(r.pdfData && r.pdfData.length > 1000);
  assert.equal(r.log.diagnostics.filter((d) => d.severity === "error").length, 0);
  // The rerun pass resolved \ref within the same request.
  assert.equal(r.passes, 2);
  assert.ok(!r.log.diagnostics.some((d) => /undefined/.test(d.message)));
  assert.ok(h.compiler.deps.has(join(dir, "chapters", "one.tex")));
  h.compiler.dispose();
});

test("errors in included files map to file and line", { skip }, async () => {
  const dir = project({
    "main.tex": BODY,
    "chapters/one.tex": "fine\n\\undefinedmacro\nmore\n",
  });
  const h = harness(join(dir, "main.tex"));
  h.compiler.request();
  const r = await h.final();
  const err = r.log.diagnostics.find((d) => d.severity === "error");
  assert.ok(err);
  assert.equal(err.file, join(dir, "chapters", "one.tex"));
  assert.equal(err.line, 2);
  assert.match(err.message, /Undefined control sequence/);
  // nonstopmode still produced a PDF to show.
  assert.equal(r.pdfWritten, true);
  h.compiler.dispose();
});

test("requests coalesce while a compile runs", { skip }, async () => {
  const dir = project({ "main.tex": "\\documentclass{article}\\begin{document}x\\end{document}\n" });
  const h = harness(join(dir, "main.tex"));
  for (let i = 0; i < 6; i++) h.compiler.request();
  await h.next();
  await h.next();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.starts.length, 2);
  h.compiler.dispose();
});

test("\\include into a subdirectory works with a private output dir", { skip }, async () => {
  const dir = project({
    "main.tex": "\\documentclass{book}\\begin{document}\\include{parts/a}\\end{document}\n",
    "parts/a.tex": "\\chapter{A} text\n",
  });
  const h = harness(join(dir, "main.tex"));
  h.compiler.request();
  const r = await h.next();
  assert.equal(r.pdfWritten, true, r.rawLog.slice(-800));
  h.compiler.dispose();
});

test("preamble cache: built in background, used, and invalidated", { skip }, async () => {
  const dir = project({
    "defs.tex": "\\newcommand{\\R}{\\mathbb{R}}\n",
    "main.tex": [
      "\\documentclass{article}",
      "\\usepackage{amsmath,amssymb,tikz}",
      "\\input{defs}",
      "\\begin{document}",
      "$x \\in \\R$",
      "\\undefinedmacro",
      "\\end{document}",
      "",
    ].join("\n"),
  });
  const h = harness(join(dir, "main.tex"), { preambleCache: true });
  h.compiler.request();
  const first = await h.next();
  assert.equal(first.usedPreambleCache, false);
  // Wait for the background format build.
  for (let i = 0; i < 100; i++) {
    h.compiler.request();
    const r = await h.next();
    if (r.usedPreambleCache) {
      // TeX really loaded the format (not a stale log from an earlier run).
      assert.match(r.rawLog.split("\n")[0], /format=main-preamble/);
      const err = r.log.diagnostics.find((d) => d.severity === "error");
      assert.equal(err?.line, 6, "line numbers survive the skipped preamble");
      assert.equal(r.pdfWritten, true);
      // Only the format read defs.tex, yet editing it must still recompile.
      assert.ok(h.compiler.deps.has(join(dir, "defs.tex")));
      assert.ok(
        r.durationMs < first.durationMs,
        `cached ${r.durationMs}ms vs cold ${first.durationMs}ms`,
      );
      break;
    }
    assert.ok(i < 99, "preamble cache never became ready");
    await new Promise((res) => setTimeout(res, 200));
  }
  // Touching a file the preamble reads invalidates the cache.
  await new Promise((res) => setTimeout(res, 20));
  writeFileSync(join(dir, "defs.tex"), "\\newcommand{\\R}{\\mathbf{R}}\n");
  h.compiler.request();
  assert.equal((await h.next()).usedPreambleCache, false);
  h.compiler.dispose();
});

for (const engine of ["xelatex", "lualatex"] as Engine[]) {
  test(`${engine} compiles`, { skip }, async () => {
    const dir = project({
      "main.tex": "\\documentclass{article}\\usepackage{fontspec}\\begin{document}Unicode: ∑ é\\end{document}\n",
    });
    const h = harness(join(dir, "main.tex"), { engine });
    h.compiler.request();
    const r = await h.next();
    assert.equal(r.pdfWritten, true, r.rawLog.slice(-800));
    h.compiler.dispose();
  });
}

test("full build runs latexmk", { skip }, async () => {
  const dir = project({ "main.tex": BODY, "chapters/one.tex": "x\n" });
  const h = harness(join(dir, "main.tex"));
  h.compiler.request("full");
  const r = await h.next();
  assert.equal(r.mode, "full");
  assert.equal(r.pdfWritten, true, r.rawLog.slice(-800));
  h.compiler.dispose();
});

test("SyncTeX round trip", { skip }, async () => {
  const dir = project({
    "main.tex": BODY,
    "chapters/one.tex": "\n\nA distinctive paragraph on line three.\n",
  });
  const h = harness(join(dir, "main.tex"));
  h.compiler.request();
  const r = await h.final();
  const file = join(dir, "chapters", "one.tex");
  const box = await forwardSearch(binDir!, r.pdfPath, file, 3, 0);
  assert.ok(box, "forward search found a box");
  assert.equal(box.page, 1);
  const loc = await inverseSearch(
    binDir!,
    r.pdfPath,
    box.page,
    box.x + 5,
    box.y + box.height / 2,
    dir,
    h.compiler.toLogical,
  );
  assert.ok(loc);
  assert.equal(loc.file, file);
  assert.equal(loc.line, 3);
  h.compiler.dispose();
});

test("dispose kills a running compile", { skip }, async () => {
  const dir = project({
    "main.tex": "\\documentclass{article}\\usepackage{tikz}\\begin{document}\\foreach\\i in{1,...,4000}{\\tikz\\draw(0,0)--(1,1);}\\end{document}\n",
  });
  const h = harness(join(dir, "main.tex"));
  h.compiler.request();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(h.compiler.compiling, true);
  h.compiler.dispose();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.compiler.compiling, false);
});

test("the bibliography files of a compile come from the .bcf and the .aux", async () => {
  const dir = project({ "refs.bib": "", "more.bib": "", "old.bib": "" });
  const out = project({
    "main.bcf":
      '<bcf:datasource type="file" datatype="bibtex" glob="false">refs.bib</bcf:datasource>\n' +
      '<bcf:datasource type="file" datatype="bibtex" glob="false">gone.bib</bcf:datasource>\n',
    "main.aux": "\\relax\n\\bibdata{more, refs}\n",
  });
  assert.deepEqual(
    (await readBibFiles(out, "main", dir)).sort(),
    [join(dir, "more.bib"), join(dir, "refs.bib")],
  );
  assert.deepEqual(await readBibFiles(dir, "none", dir), []);
});

test("a broken biber in the TeX bin dir is replaced by one that runs", { skip: process.platform === "win32" }, async () => {
  const bin = (script: string) => {
    const d = mkdtempSync(join(tmpdir(), "latex-live-biber-"));
    writeFileSync(join(d, "biber"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(d, "biber"), 0o755);
    return d;
  };
  // MacTeX 2026's universal biber on some Macs: lipo's usage, exit 255.
  const broken = bin('echo "usage: lipo <input_file> <command>" >&2; exit 255');
  const good = bin('echo "biber version: 2.21"');
  const empty = mkdtempSync(join(tmpdir(), "latex-live-biber-"));
  assert.equal(await workingBiber(broken, [empty, good]), join(good, "biber"));
  assert.equal(await workingBiber(good, [broken]), join(good, "biber"));
  assert.equal(await workingBiber(broken, [empty]), null);
});
