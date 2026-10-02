import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { resolveTexBinDir, texEnv, texTool } from "../src/tex/binaries";
import { Compiler, type BuildMode, type CompileOptions, type CompileResult } from "../src/tex/compiler";
import { forwardSearch, inverseSearch } from "../src/tex/synctex";

// Real LuaLaTeX regressions: synthetic projects, the machine's TeX, no Obsidian host.
const binDir = process.env.TEXBIN ?? resolveTexBinDir("");
const skip = !binDir ? "no TeX installation found"
  : !existsSync(texTool(binDir, "lualatex")) ? "no lualatex" : false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = (r: CompileResult) => r.log.diagnostics.filter((d) => d.severity === "error");

async function until(predicate: () => boolean, timeout = 45_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - started < timeout, "Lua fixture settled before its deadline");
    await sleep(10);
  }
}

function fixture(t: TestContext, files: Record<string, string>, opts: Partial<CompileOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-lua-"));
  const root = join(dir, "lua notes.tex");
  const outDir = join(dir, "build output");
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const options: CompileOptions = {
    binDir: binDir!, engine: "lualatex", outDir, preambleCache: false, shellEscape: false, ...opts,
  };
  const results: (CompileResult | Error)[] = [];
  const waiters: { resolve: (r: CompileResult) => void; reject: (e: Error) => void }[] = [];
  const starts: BuildMode[] = [];
  const accept = (r: CompileResult | Error) => {
    const next = waiters.shift();
    if (!next) results.push(r);
    else if (r instanceof Error) next.reject(r);
    else next.resolve(r);
  };
  const compiler = new Compiler(root, () => options, {
    onStart: (mode) => starts.push(mode), onResult: accept, onFailure: accept,
  });
  t.after(async () => {
    compiler.dispose();
    await until(() => !compiler.compiling, 5000);
    rmSync(dir, { recursive: true, force: true });
  });
  const next = (): Promise<CompileResult> => {
    const r = results.shift();
    return r instanceof Error ? Promise.reject(r)
      : r ? Promise.resolve(r)
        : new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
  const settled = async (): Promise<CompileResult> => {
    let r = await next();
    while (r.mode === "fast" && r.passes === 1 && r.log.rerun) r = await next();
    await until(() => !compiler.compiling);
    return r;
  };
  const build = async (mode: BuildMode = "fast") => {
    await until(() => !compiler.compiling);
    compiler.request(mode);
    return settled();
  };
  return { dir, root, outDir, compiler, starts, next, build };
}

// A native PDF info entry proves which source produced the delivered bytes,
// without needing a separate PDF renderer or a text extraction dependency.
const revision = (name: string) => `\\pdfextension info{ /LLRevision (${name}) }\nRevision ${name}.\n`;
const document = (body: string, preamble = "") => [
  "% !TEX program = lualatex", "\\documentclass{article}", preamble,
  "\\begin{document}", body, "\\end{document}", "",
].join("\n");
function pdfRevision(r: CompileResult, name: string): void {
  assert.equal(r.engine, "lualatex");
  assert.equal(r.pdfWritten, true, r.rawLog.slice(-1500));
  assert.ok(r.pdfData && r.pdfData.length > 1000);
  assert.match(Buffer.from(r.pdfData).toString("latin1"), new RegExp(`/LLRevision\\s*\\(${name}\\)`));
  assert.deepEqual(errors(r), [], r.rawLog.slice(-1500));
}

test("LuaLaTeX fontspec Chinese renders without a pdfLaTeX format; a fatal edit supplies no old PDF", { skip, timeout: 90_000 }, async (t) => {
  let fandol: string;
  try {
    fandol = execFileSync(texTool(binDir!, "kpsewhich"), ["FandolSong-Regular.otf"], {
      env: texEnv(binDir!), encoding: "utf8", timeout: 5000,
    }).trim();
  } catch {
    t.skip("no Fandol fonts");
    return;
  }
  if (!fandol) { t.skip("no Fandol fonts"); return; }
  const source = document(revision("chinese") + "{\\cn 中文实时编译，数学笔记。}\n", [
    "\\usepackage{fontspec}", "\\newfontfamily\\cn{FandolSong-Regular.otf}",
  ].join("\n"));
  const h = fixture(t, { "lua notes.tex": source }, { preambleCache: true });
  const good = await h.build();
  pdfRevision(good, "chinese");
  assert.doesNotMatch(good.rawLog, /Missing character:/);
  assert.equal(good.usedPreambleCache, false);
  assert.deepEqual(readdirSync(h.outDir).filter((name) => /-preamble\./.test(name)), []);

  writeFileSync(h.root, document("\\input{missing-lua-fixture-file}"));
  const failed = await h.build();
  assert.equal(failed.pdfWritten, false, failed.rawLog);
  assert.equal(failed.pdfData, null, "a failed run must not publish the preceding PDF as current");
  assert.ok(errors(failed).length > 0, failed.rawLog);
  assert.equal(failed.usedPreambleCache, false);
  // The session owns retaining good.pdfData; the compiler never returns it as a new result.
  assert.match(Buffer.from(good.pdfData!).toString("latin1"), /\/LLRevision\s*\(chinese\)/);
});

test("LuaLaTeX coalesces edits after reading an input and publishes the newest source", { skip, timeout: 90_000 }, async (t) => {
  const h = fixture(t, {
    "lua notes.tex": document([
      "\\input{revision}",
      // The input has closed before this gate opens. Edits cannot mutate the running pass.
      "\\directlua{local f=assert(io.open('input-read','w')); f:write('ready'); f:close();",
      "repeat local r=io.open('release-run','r'); if r then r:close(); break end until false}",
    ].join("\n")),
    "revision.tex": revision("initial"),
  });
  h.compiler.request();
  await until(() => existsSync(join(h.dir, "input-read")));
  assert.equal(h.compiler.compiling, true, "the first native Lua pass is held at its input boundary");
  for (const name of ["second", "third", "latest"]) {
    writeFileSync(join(h.dir, "revision.tex"), revision(name));
    h.compiler.request();
    h.compiler.request();
  }
  writeFileSync(join(h.dir, "release-run"), "continue\n");
  const initial = await h.next();
  const latest = await h.next();
  await until(() => !h.compiler.compiling);
  pdfRevision(initial, "initial");
  pdfRevision(latest, "latest");
  assert.deepEqual(h.starts, ["fast", "fast"], "six waiting requests become one follow-up compile");
  assert.notDeepEqual(latest.pdfData, initial.pdfData);
  assert.ok(h.compiler.deps.has(join(h.dir, "revision.tex")));
});

test("LuaLaTeX SyncTeX maps both directions through a Unicode input path with spaces", { skip, timeout: 90_000 }, async (t) => {
  const input = "章节/source notes.tex";
  const h = fixture(t, {
    "lua notes.tex": document("\\input{章节/source notes}"),
    [input]: "\n\nA distinctive paragraph on line three.\n",
  });
  const r = await h.build();
  assert.equal(r.pdfWritten, true, r.rawLog);
  assert.deepEqual(errors(r), [], r.rawLog);
  const file = join(h.dir, input);
  const box = await forwardSearch(binDir!, r.pdfPath, file, 3, 0);
  assert.ok(box, "LuaLaTeX wrote usable forward SyncTeX records");
  assert.equal(box.page, 1);
  const loc = await inverseSearch(binDir!, r.pdfPath, box.page, box.x + 5,
    box.y + box.height / 2, h.dir, h.compiler.toLogical);
  assert.deepEqual(loc, { file, line: 3 });
});

test("LuaLaTeX full latexmk settles references, reuses a verified no-op, and rebuilds edited inputs", {
  skip: skip || (!existsSync(texTool(binDir!, "latexmk")) && "no latexmk"), timeout: 120_000,
}, async (t) => {
  const h = fixture(t, {
    "lua notes.tex": document("See Section~\\ref{sec:lua}.\n\\input{chapter}"),
    "chapter.tex": revision("fullinitial") + "\\section{Lua section}\\label{sec:lua}\n",
  });
  const initial = await h.build("full");
  pdfRevision(initial, "fullinitial");
  assert.equal(initial.mode, "full");
  assert.doesNotMatch(initial.rawLog, /Reference .* undefined|Rerun to get cross-references right/);
  assert.match(readFileSync(join(h.outDir, "lua notes.aux"), "utf8"), /\\newlabel\{sec:lua\}\{\{1\}/);
  const stamp = statSync(initial.pdfPath).mtimeMs;
  const noop = await h.build("full");
  assert.equal(noop.pdfReused, true, noop.rawLog);
  assert.deepEqual(noop.pdfData, initial.pdfData);
  assert.equal(statSync(noop.pdfPath).mtimeMs, stamp);
  assert.deepEqual(errors(noop), []);

  writeFileSync(join(h.dir, "chapter.tex"), revision("fulllatest") + "\\section{Updated Lua section}\\label{sec:lua}\n");
  const edited = await h.build("full");
  pdfRevision(edited, "fulllatest");
  assert.notEqual(edited.pdfReused, true);
  assert.notDeepEqual(edited.pdfData, initial.pdfData);
  assert.ok(h.compiler.deps.has(join(h.dir, "chapter.tex")));
});
