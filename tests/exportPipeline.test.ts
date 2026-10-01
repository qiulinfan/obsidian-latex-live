import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildFreshness, exportHtml } from "../src/export/exporter";
import { planExport } from "../src/export/plan";
import { prepareWorkDir, runProbe } from "../src/export/probe";
import { readProbeLog } from "../src/export/probeLog";
import { projectDefinitions } from "../src/tex/macros";
import { Compiler, type CompileResult } from "../src/tex/compiler";
import { isAbortError } from "../src/tex/run";
import { theoremMap } from "../src/tex/theorems";
import { nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

const temps: string[] = [];
after(() => { removeExportTemps(); for (const p of temps) rmSync(p, { recursive: true, force: true }); });
const dir = () => { const p = mkdtempSync(join(tmpdir(), "latex-live-pipeline-")); temps.push(p); return p; };
const skip = !texBin ? "no TeX installation found" : false;

function planOf(root: string) {
  const defs = projectDefinitions(root);
  return planExport(root, { defs, theorems: theoremMap(defs.files.map((f) => readFileSync(f, "utf8"))) });
}

test("freshness follows a cached preamble's recorder and notices removed dependencies", async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  const build = join(folder, "out");
  mkdirSync(build);
  const pkg = join(folder, "local.sty");
  writeFileSync(root, "\\documentclass{article}\\begin{document}x\\end{document}");
  writeFileSync(pkg, "\\ProvidesPackage{local}");
  const fmt = join(build, "main-preamble.fmt");
  writeFileSync(fmt, "format");
  writeFileSync(join(build, "main.aux"), "\\relax");
  writeFileSync(join(build, "main.fls"), `PWD ${folder}\nINPUT ${root}\nINPUT ${fmt}\n`);
  writeFileSync(join(build, "main-preamble.fls"), `PWD ${folder}\nINPUT ${root}\nINPUT ${pkg}\n`);
  const log = join(build, "main.log");
  writeFileSync(log, "Output written.");
  const before = new Date(Date.now() - 10_000);
  const built = new Date(Date.now() - 5_000);
  utimesSync(root, before, before);
  utimesSync(pkg, before, before);
  utimesSync(log, built, built);
  assert.deepEqual(await buildFreshness(root, build), { fresh: true, reason: "" });
  const changed = new Date();
  utimesSync(pkg, changed, changed);
  assert.deepEqual(await buildFreshness(root, build), { fresh: false, reason: "local.sty changed" });
  rmSync(pkg);
  assert.deepEqual(await buildFreshness(root, build), { fresh: false, reason: "local.sty is missing" });
  // A subsequent full build did not use the old format: its obsolete dependencies cannot
  // invalidate this build forever.
  writeFileSync(join(build, "main.fls"), `PWD ${folder}\nINPUT ${root}\n`);
  assert.deepEqual(await buildFreshness(root, build), { fresh: true, reason: "" });
  rmSync(join(build, "main.fls"));
  assert.deepEqual(await buildFreshness(root, build), { fresh: false, reason: "no dependency record yet" });
});

test("freshness of a real cached-preamble compile includes the local package the format read", { skip, timeout: 60_000 }, async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  const build = join(folder, "out");
  mkdirSync(build);
  const pkg = join(folder, "local.sty");
  writeFileSync(root, "\\documentclass{article}\n\\usepackage{local}\n\\begin{document}\n\\word\n\\end{document}\n");
  writeFileSync(pkg, "\\ProvidesPackage{local}\n\\newcommand\\word{Before}\n");
  const results: CompileResult[] = [];
  const waiters: { resolve(r: CompileResult): void; reject(e: Error): void }[] = [];
  const next = () => results.length ? Promise.resolve(results.shift()!) : new Promise<CompileResult>((resolve, reject) => waiters.push({ resolve, reject }));
  const compiler = new Compiler(root, () => ({ binDir: texBin!, engine: "pdflatex", outDir: build, preambleCache: true, shellEscape: false }), {
    onStart: () => undefined,
    onResult: (r) => { const w = waiters.shift(); if (w) w.resolve(r); else results.push(r); },
    onFailure: (e) => { const w = waiters.shift(); if (w) w.reject(e); },
  });
  try {
    compiler.request("fast");
    assert.ok((await next()).pdfWritten);
    const stamp = join(build, "main-preamble.json");
    for (let i = 0; i < 200 && !existsSync(stamp); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(existsSync(stamp), "the real format finished building");
    compiler.request("fast");
    assert.ok((await next()).pdfWritten);
    const fls = readFileSync(join(build, "main.fls"), "utf8");
    assert.match(fls, /INPUT .*main-preamble\.fmt/);
    assert.ok(!fls.includes("local.sty"), "the cached compile's recorder omits the preamble package");
    assert.deepEqual(await buildFreshness(root, build), { fresh: true, reason: "" });
    const newer = new Date(Date.now() + 1000);
    writeFileSync(pkg, "\\ProvidesPackage{local}\n\\newcommand\\word{After}\n");
    utimesSync(pkg, newer, newer);
    assert.deepEqual(await buildFreshness(root, build), { fresh: false, reason: "local.sty changed" });
  } finally { compiler.dispose(); }
});

test("preparing an export drops a previous included chapter's aux and generated pages", async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  writeFileSync(root, "\\documentclass{article}\\begin{document}text\\end{document}");
  const host = nodeExportHost(root);
  mkdirSync(join(host.workDir, "chapters"), { recursive: true });
  writeFileSync(join(host.workDir, "chapters", "removed.aux"), "\\newlabel{old}{{99}{1}}");
  writeFileSync(join(host.workDir, "main.dvi"), "old page");
  await prepareWorkDir(planOf(root), host);
  assert.ok(!existsSync(join(host.workDir, "chapters", "removed.aux")));
  assert.ok(!existsSync(join(host.workDir, "main.dvi")));
  assert.ok(existsSync(join(host.workDir, "src", "main.tex")));
});

test("a probe retry that exits before opening files cannot reuse old records or pages", { skip: process.platform === "win32" ? "shell fixture" : false }, async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  writeFileSync(root, "\\documentclass{article}\\begin{document}text\\end{document}");
  const host = nodeExportHost(root);
  const bin = join(folder, "bin");
  mkdirSync(bin);
  const fake = join(bin, "pdflatex");
  writeFileSync(fake, "#!/bin/sh\nexit 2\n");
  chmodSync(fake, 0o755);
  host.binDir = bin;
  host.engine = "pdflatex";
  const plan = planOf(root);
  await prepareWorkDir(plan, host);
  for (const ext of ["llx", "log", "dvi", "xdv"]) writeFileSync(join(host.workDir, `main.${ext}`), "old successful output");
  const result = await runProbe(plan, host);
  assert.deepEqual([result.llx, result.log, result.dvi], [null, "", null]);
});

test("a cancelled export does not ask for a full build", async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  writeFileSync(root, "\\documentclass{article}\\begin{document}text\\end{document}");
  const host = nodeExportHost(root);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(exportHtml(root, host, () => undefined, abort.signal), isAbortError);
  assert.equal(host.builds, 0);
});

test("the first release refuses a LuaLaTeX export before building or probing", async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  writeFileSync(root, "\\documentclass{article}\\begin{document}text\\end{document}");
  const host = nodeExportHost(root, { engine: "lualatex" });
  const message = /LuaLaTeX requires a PDF-mode probe/;
  await assert.rejects(exportHtml(root, host, () => undefined, new AbortController().signal), message);
  assert.equal(host.builds, 0);
  await assert.rejects(runProbe(planOf(root), host), message);
  assert.ok(!existsSync(host.workDir));
});

for (const [cls, opts, version, date] of [
  ["elegantnote", "lang=en", "Version:", "Update:"],
  ["elegantpaper", "lang=en", "Version:", "Date:"],
  ["elegantnote", "lang=cn", "版本：", "更新："],
  ["elegantpaper", "lang=cn", "版本：", "日期："],
] as const) test(`probe captures ${cls} ${opts} title labels without a name suffix`, { skip, timeout: 60_000 }, async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  writeFileSync(root, `\\PassOptionsToPackage{fontset=fandol}{ctex}\n\\documentclass[${opts}]{${cls}}\n\\title{Synthetic}\\version{0.2}\\date{2026-09-30}\n\\begin{document}\\maketitle Text.\\end{document}`);
  const host = nodeExportHost(root, { engine: opts === "lang=cn" ? "xelatex" : "pdflatex" });
  const plan = planOf(root);
  await prepareWorkDir(plan, host);
  const result = await runProbe(plan, host);
  assert.ok(result.llx, result.output);
  assert.ok(!/^! /m.test(result.log), result.log.slice(-1500));
  const names = readProbeLog(result.llx!).names;
  assert.equal(names.get("version")?.trim(), version);
  assert.equal(names.get("date")?.trim(), date);
  // A user's class-label redefinition is authoritative too.
  writeFileSync(root, readFileSync(root, "utf8").replace("\\begin{document}", "\\renewcommand\\versiontext{Revision: }\\renewcommand\\updatetext{Published: }\\begin{document}"));
  const again = planOf(root);
  await prepareWorkDir(again, host);
  const custom = await runProbe(again, host);
  const customNames = readProbeLog(custom.llx!).names;
  assert.equal(customNames.get("version")?.trim(), "Revision:");
  assert.equal(customNames.get("date")?.trim(), "Published:");
});
