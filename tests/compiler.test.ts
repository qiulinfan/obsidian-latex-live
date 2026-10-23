import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveTexBinDir, workingBiber } from "../src/tex/binaries";
import {
  BuildMode,
  CompileOptions,
  CompileResult,
  Compiler,
  formatKey,
  readBibFiles,
  readyPreambleFormat,
} from "../src/tex/compiler";
import { readLlpos } from "../src/tex/llpos";
import { Engine, preambleOf } from "../src/tex/project";
import { Text } from "@codemirror/state";
import { locateClick } from "../src/editor/reveal";
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
  outDir: string;
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
  return { compiler, outDir, starts, next, final };
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
      "\\begin{tikzpicture}\\draw (0,0) rectangle (1,1);\\end{tikzpicture}",
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
      // Its stamp lets other runs (fragment compiles) take it, for this preamble only.
      const text = readFileSync(join(dir, "main.tex"), "utf8");
      const ready = await readyPreambleFormat(h.outDir, join(dir, "main.tex"), "pdflatex", preambleOf(text)!);
      assert.equal(ready?.name, "main-preamble");
      assert.equal(await readyPreambleFormat(h.outDir, join(dir, "main.tex"), "pdflatex", preambleOf(text)! + "%"), null);
      assert.equal(await readyPreambleFormat(h.outDir, join(dir, "main.tex"), "xelatex", preambleOf(text)!), null);
      // The format holds the position recorder: the run records without it on the command line.
      const pos = readLlpos(r.pdfPath, dir);
      assert.deepEqual(pos?.map((p) => [p.env, p.page, p.file, p.line]), [["tikzpicture", 1, join(dir, "main.tex"), 7]]);
      assert.notEqual(formatKey("pdflatex", preambleOf(text)!), formatKey("pdflatex", preambleOf(text)!, 0), "a new recorder version rebuilds the format");
      break;
    }
    assert.ok(i < 99, "preamble cache never became ready");
    await new Promise((res) => setTimeout(res, 200));
  }
  // Touching a file the preamble reads invalidates the cache.
  await new Promise((res) => setTimeout(res, 20));
  writeFileSync(join(dir, "defs.tex"), "\\newcommand{\\R}{\\mathbf{R}}\n");
  const preamble = preambleOf(readFileSync(join(dir, "main.tex"), "utf8"))!;
  assert.equal(await readyPreambleFormat(h.outDir, join(dir, "main.tex"), "pdflatex", preamble), null, "a preamble input changed");
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

const PICTURES = [
  "\\documentclass{article}",
  "\\usepackage{tikz,tabularx}",
  "\\begin{document}",
  "Text \\begin{tikzpicture}\\draw (0,0) rectangle (2,1);\\end{tikzpicture} text.",
  "",
  "\\begin{tabular}{cc}",
  "a & b\\\\",
  "\\end{tabular}",
  "\\begin{tikzpicture}[overlay]\\draw (0,0) -- (1,1);\\end{tikzpicture}",
  "\\begin{tikzpicture}\\node{\\begin{tabular}{c}x\\end{tabular}};\\end{tikzpicture}",
  "\\newpage",
  "\\begin{tabularx}{\\linewidth}{X}",
  "wide\\\\",
  "\\end{tabularx}",
  "\\end{document}",
  "",
].join("\n");

for (const [engine, name] of [["pdflatex", "main.tex"], ["pdflatex", "my main.tex"], ["xelatex", "main.tex"], ["lualatex", "main.tex"]] as [Engine, string][]) {
  test(`${engine} records the positions of TikZ pictures (root "${name}")`, { skip }, async () => {
    const dir = project({ [name]: PICTURES });
    const h = harness(join(dir, name), { engine });
    h.compiler.request();
    const r = await h.final();
    assert.equal(r.pdfWritten, true, r.rawLog.slice(-800));
    assert.equal(r.pdfPath, join(h.outDir, name.replace(/\.tex$/, ".pdf")), "the job keeps the root's name");
    const pos = readLlpos(r.pdfPath, dir)!;
    // Pictures only (tables are drawn, never cropped: #23); an overlay picture has no size.
    assert.deepEqual(pos.map((p) => [p.env, p.page, p.line]), [["tikzpicture", 1, 4], ["tikzpicture", 1, 9], ["tikzpicture", 1, 10]]);
    assert.ok(pos.every((p) => p.file === join(dir, name)));
    const [pic] = pos;
    // 2 cm by 1 cm plus the line width, in bp; x after "Text " in the text block (1in + margin).
    assert.ok(Math.abs(pic.width - 57.1) < 1 && Math.abs(pic.height - 28.8) < 1, JSON.stringify(pic));
    assert.ok(pic.x > 72 && pic.x < 200 && pic.y > 600, JSON.stringify(pic));
    assert.equal(pos[1].width, 0);
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
  assert.equal(r.pdfPath, join(h.outDir, "main.pdf"));
  // latexmk reads the position recorder first (-usepretex).
  assert.deepEqual(readLlpos(r.pdfPath, dir), []);
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

// Beamer reads a frame's body as a macro argument, so SyncTeX gives every word in it the
// `\end{frame}` line; the click lands on the word only because locateClick searches the whole
// frame, across its blank lines.
test("SyncTeX in a beamer frame names \\end{frame}; the click still lands on the word", { skip }, async () => {
  const slides = [
    "\\begin{frame}{Overview}",
    "  Photocurrent rises",
    "",
    "  Parameterizing the model",
    "",
    "\\end{frame}",
  ];
  const dir = project({
    "main.tex": "\\documentclass{beamer}\n\\begin{document}\n\\input{slides}\n\\end{document}\n",
    "slides.tex": slides.join("\n") + "\n",
  });
  const h = harness(join(dir, "main.tex"));
  h.compiler.request();
  const r = await h.final();
  const file = join(dir, "slides.tex");
  const doc = Text.of(slides);
  for (const [word, line] of [["Photocurrent", 2], ["Parameterizing", 4]] as const) {
    const box = await forwardSearch(binDir!, r.pdfPath, file, line, 0);
    assert.ok(box, `forward search found ${word}`);
    const loc = await inverseSearch(binDir!, r.pdfPath, box.page, box.x + 5, box.y + box.height / 2, dir, h.compiler.toLogical);
    assert.ok(loc);
    assert.equal(loc.file, file);
    assert.equal(loc.line, 6, `SyncTeX names \\end{frame} for ${word}`);
    assert.equal(locateClick(doc, loc.line, { word, before: "", after: "" })?.line, line);
  }
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
  const deadline = Date.now() + 5000;
  while (h.compiler.compiling && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
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
