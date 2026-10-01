import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { resolveTexBinDir } from "../src/tex/binaries";
import { Compiler, type CompileOptions, type CompileResult } from "../src/tex/compiler";

const unix = process.platform === "win32" ? "executable POSIX fixture" : false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = (result: CompileResult) => result.log.diagnostics.filter((d) => d.severity === "error");
const PDF = "%PDF-1.7\nsynthetic fixture PDF\n%%EOF\n";

function directory(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tool(path: string, source: string): void {
  writeFileSync(path, `#!${process.execPath}\n${source}`);
  chmodSync(path, 0o755);
}

function harness(root: string, options: CompileOptions) {
  const results: CompileResult[] = [];
  const failures: Error[] = [];
  let resolveNext: ((result: CompileResult) => void) | undefined;
  let rejectNext: ((error: Error) => void) | undefined;
  const compiler = new Compiler(root, () => options, {
    onStart: () => undefined,
    onResult: (result) => { results.push(result); resolveNext?.(result); resolveNext = undefined; rejectNext = undefined; },
    onFailure: (error) => { failures.push(error); rejectNext?.(error); resolveNext = undefined; rejectNext = undefined; },
  });
  return {
    compiler, results, failures,
    async build(): Promise<CompileResult> {
      await until(() => !compiler.compiling);
      const next = new Promise<CompileResult>((resolve, reject) => { resolveNext = resolve; rejectNext = reject; });
      compiler.request("full");
      return next;
    },
  };
}

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < ms, "fixture operation settled before its deadline");
    await sleep(10);
  }
}

interface Scenario {
  output?: string;
  log?: string;
  pdf?: string;
  code?: number;
  signal?: boolean;
  hang?: boolean;
}

function fake(t: TestContext, name = "main.tex", engine: CompileOptions["engine"] = "pdflatex") {
  const dir = directory(t, "latex-live-full-noop-");
  const root = join(dir, name);
  writeFileSync(root, "\\documentclass{article}\\begin{document}Fixture.\\end{document}\n");
  const outDir = join(dir, "output with spaces");
  const binDir = join(dir, "bin");
  mkdirSync(outDir); mkdirSync(binDir);
  // A fake version probe avoids running the machine's biber in these lightweight tests.
  tool(join(binDir, "biber"), "console.log('biber version: fixture');\n");
  tool(join(binDir, "latexmk"), String.raw`
const fs = require('node:fs'), path = require('node:path');
const out = process.argv.slice(2).find(a => a.startsWith('-outdir=')).slice(8);
const root = process.argv.at(-1), job = path.basename(root, path.extname(root));
const scenario = JSON.parse(fs.readFileSync('scenario.json', 'utf8'));
fs.appendFileSync('invocations.jsonl', JSON.stringify({logExisted: fs.existsSync(path.join(out, job + '.log')), pid: process.pid}) + '\n');
if (scenario.log !== undefined) fs.writeFileSync(path.join(out, job + '.log'), scenario.log);
if (scenario.pdf !== undefined) fs.writeFileSync(path.join(out, job + '.pdf'), scenario.pdf);
if (scenario.output) fs.writeSync(1, scenario.output);
if (scenario.signal) process.kill(process.pid, 'SIGTERM');
else if (scenario.hang) setInterval(() => {}, 1000);
else process.exit(scenario.code ?? 0);
`);
  const pdf = join(outDir, basename(name, ".tex") + ".pdf");
  writeFileSync(pdf, PDF);
  utimesSync(pdf, new Date("2000-01-01"), new Date("2000-01-01"));
  const h = harness(root, { binDir, outDir, engine, preambleCache: false, shellEscape: false, stallMs: 10_000 });
  t.after(() => h.compiler.dispose());
  const noop = (targets = pdf, document = name) => `Latexmk: Nothing to do for '${document}'.\nLatexmk: All targets (${targets}) are up-to-date\n`;
  const scenario = (s: Scenario) => writeFileSync(join(dir, "scenario.json"), JSON.stringify(s));
  return { ...h, dir, root, outDir, pdf, noop, scenario };
}

test("fake full no-op supplies the verified old PDF without reading an old error log", { skip: unix }, async (t) => {
  const h = fake(t, "main paper.tex");
  const log = join(h.outDir, "main paper.log");
  writeFileSync(log, "! Old error must not return.\nOutput written on main paper.pdf (3 pages, 20 bytes).\n");
  const stamp = statSync(h.pdf).mtimeMs;
  h.scenario({ output: h.noop() });
  const result = await h.build();
  assert.equal(result.pdfWritten, true);
  assert.equal(result.pdfReused, true);
  assert.equal(Buffer.from(result.pdfData!).toString(), PDF);
  assert.deepEqual(errors(result), []);
  assert.equal(result.log.pages, null, "a no-op must not invent a fresh TeX page count");
  assert.equal(statSync(h.pdf).mtimeMs, stamp, "the PDF was not rewritten");
  assert.equal(existsSync(log), false, "the stale log was deleted before latexmk ran");
  assert.equal(JSON.parse(readFileSync(join(h.dir, "invocations.jsonl"), "utf8")).logExisted, false);
  assert.match(result.rawLog, /Nothing to do/);
  assert.doesNotMatch(result.rawLog, /Old error|Output written/);
});

test("fake full no-op matches a physical PDF path and one target among XeLaTeX outputs", { skip: unix }, async (t) => {
  const h = fake(t, "main.tex", "xelatex");
  for (const targets of [`${join(realpathSync(h.outDir), "main.xdv")} ${realpathSync(h.pdf)}`, "output with spaces/main.pdf", "./output with spaces/main.pdf"]) {
    h.scenario({ output: h.noop(targets) });
    const result = await h.build();
    assert.equal(result.pdfReused, true);
    assert.deepEqual(errors(result), []);
  }
});

test("fake full build requires both no-op lines for the current root and exact output", { skip: unix }, async (t) => {
  const h = fake(t);
  const messages = [
    h.noop(h.pdf, "another.tex"),
    h.noop(join(h.dir, "wrong", "main.pdf")),
    h.noop("other-output/main.pdf"),
    h.noop("other output with spaces/main.pdf"),
    h.noop("main.pdf"),
    h.noop(h.pdf + ".backup"),
    h.noop(h.pdf).split("\n")[0] + "\n",
    h.noop(h.pdf).split("\n")[1] + "\n",
    "tool: Nothing to do\nAll targets up-to-date\n",
    "",
  ];
  // Make the old PDF very recent too: recency alone cannot certify a successful build.
  utimesSync(h.pdf, new Date(), new Date());
  for (const output of messages) {
    h.scenario({ output });
    const result = await h.build();
    assert.equal(result.pdfWritten, false, output);
    assert.equal(result.pdfReused, undefined);
    assert.equal(result.pdfData, null);
    assert.equal(errors(result).length, 1, output);
  }
});

test("fake full no-op never supplies a missing or unreadable PDF", { skip: unix }, async (t) => {
  const h = fake(t);
  h.scenario({ output: h.noop() });
  rmSync(h.pdf);
  for (const unreadable of [false, true]) {
    if (unreadable) mkdirSync(h.pdf); // readFile rejects a directory on the supported hosts.
    const result = await h.build();
    assert.equal(result.pdfWritten, false);
    assert.equal(result.pdfReused, undefined);
    assert.equal(result.pdfData, null);
    assert.match(errors(result)[0].message, /PDF could not be read/);
  }
});

test("fake full nonzero or signal exits cannot reuse an old PDF despite success-looking stdout", { skip: unix }, async (t) => {
  const h = fake(t);
  for (const scenario of [{ code: 12 }, { signal: true }]) {
    h.scenario({ output: h.noop(), ...scenario });
    const result = await h.build();
    assert.equal(result.pdfWritten, false);
    assert.equal(result.pdfReused, undefined);
    assert.equal(result.pdfData, null);
    assert.equal(errors(result).length, 1);
  }
  h.scenario({ code: 12, log: "This is pdfTeX.\n", output: "Latexmk: early failure\n" });
  assert.match(errors(await h.build())[0].message, /early failure/);
});

test("fake full rebuilt PDF retains fresh-log authority, including errors with a PDF", { skip: unix }, async (t) => {
  const h = fake(t);
  h.scenario({ pdf: PDF + "updated\n", log: "Output written on main.pdf (1 page, 40 bytes).\n" });
  const rebuilt = await h.build();
  assert.equal(rebuilt.pdfWritten, true);
  assert.equal(rebuilt.pdfReused, undefined);
  assert.equal(rebuilt.log.pages, 1);
  assert.deepEqual(errors(rebuilt), []);
  h.scenario({ code: 12, log: "! Undefined control sequence.\nl.3 \\Unknown\nOutput written on main.pdf (1 page, 40 bytes).\n" });
  const error = await h.build();
  assert.equal(error.pdfWritten, true, "nonstopmode's freshly produced PDF is still available with its diagnostics");
  assert.equal(error.pdfReused, undefined);
  assert.match(errors(error)[0].message, /Undefined control sequence/);
});

test("fake full cancellation emits no no-op success and kills its process", { skip: unix, timeout: 10_000 }, async (t) => {
  const h = fake(t);
  h.scenario({ output: h.noop(), hang: true });
  h.compiler.request("full");
  const invocations = join(h.dir, "invocations.jsonl");
  await until(() => existsSync(invocations));
  const pid = JSON.parse(readFileSync(invocations, "utf8")).pid as number;
  h.compiler.dispose();
  await until(() => !h.compiler.compiling);
  assert.deepEqual(h.results, []);
  assert.deepEqual(h.failures, []);
  assert.throws(() => process.kill(pid, 0), "the cancelled process ended");
});

test("fake full watchdog cannot certify success-looking stdout from a stalled tool", { skip: unix, timeout: 10_000 }, async (t) => {
  const h = fake(t);
  const options = (h.compiler as unknown as { options(): CompileOptions }).options;
  const selected = options(); selected.stallMs = 250;
  h.scenario({ output: h.noop(), hang: true });
  const result = await h.build();
  assert.equal(result.pdfWritten, false);
  assert.equal(result.pdfReused, undefined);
  assert.match(errors(result)[0].message, /no progress/);
});

const texBin = process.env.TEXBIN ?? resolveTexBinDir("");
const realSkip = unix || (!texBin ? "no TeX installation found" : false);

/** Observe the actual tools and preserve their statuses; no force/rebuild option is injected. */
function native(t: TestContext, spaces = false, engine: CompileOptions["engine"] = "pdflatex") {
  const base = directory(t, "latex-live-real-full-noop-");
  const dir = spaces ? join(base, "project with spaces") : base;
  if (spaces) mkdirSync(dir);
  const root = join(dir, spaces ? "paper draft.tex" : "main.tex");
  const binDir = join(dir, "bin"), outDir = join(dir, spaces ? "output with spaces" : "out");
  mkdirSync(binDir); mkdirSync(outDir);
  for (const name of ["pdflatex", "xelatex", "lualatex"]) symlinkSync(join(texBin!, name), join(binDir, name));
  tool(join(binDir, "latexmk"), `
const fs = require('node:fs'), cp = require('node:child_process');
const child = cp.spawn(${JSON.stringify(join(texBin!, "latexmk"))}, process.argv.slice(2), {stdio: ['ignore','pipe','pipe']});
fs.writeFileSync('latexmk.pid', String(child.pid));
let output=''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {output += data; process.stdout.write(data)});
child.on('close', code => {fs.writeFileSync('latexmk-output.log', output); process.exit(code ?? 1)});
`);
  const h = harness(root, { binDir, outDir, engine, preambleCache: false, shellEscape: false });
  t.after(() => h.compiler.dispose());
  const source = (body: string) => writeFileSync(root, `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`);
  return { ...h, dir, root, outDir, source, output: () => readFileSync(join(dir, "latexmk-output.log"), "utf8") };
}

test("real latexmk full no-op, edited source, deleted PDF, and previous errors have distinct outcomes", { skip: realSkip, timeout: 90_000 }, async (t) => {
  const h = native(t);
  h.source("Before.");
  const initial = await h.build();
  assert.equal(initial.pdfWritten, true, initial.rawLog);
  assert.equal(initial.pdfReused, undefined);
  assert.deepEqual(errors(initial), []);
  const stamp = statSync(initial.pdfPath).mtimeMs;
  const unchanged = await h.build();
  assert.equal(unchanged.pdfWritten, true, unchanged.rawLog);
  assert.equal(unchanged.pdfReused, true);
  assert.deepEqual(errors(unchanged), []);
  assert.deepEqual(unchanged.pdfData, initial.pdfData);
  assert.equal(statSync(initial.pdfPath).mtimeMs, stamp);
  assert.equal(existsSync(join(h.outDir, "main.log")), false);
  assert.match(h.output(), /Nothing to do/);
  assert.doesNotMatch(h.output(), /Run number \d+ of rule/);

  h.source("After a source edit.");
  const edited = await h.build();
  assert.equal(edited.pdfWritten, true, edited.rawLog);
  assert.equal(edited.pdfReused, undefined);
  assert.deepEqual(errors(edited), []);
  assert.notDeepEqual(edited.pdfData, initial.pdfData);
  assert.match(h.output(), /Run number \d+ of rule 'pdflatex'/);

  rmSync(edited.pdfPath);
  const deleted = await h.build();
  assert.equal(deleted.pdfWritten, true, deleted.rawLog);
  assert.equal(deleted.pdfReused, undefined);
  assert.deepEqual(errors(deleted), []);
  assert.match(h.output(), /Run number \d+ of rule 'pdflatex'/);

  h.source("\\UndefinedNoopTestMacro");
  const failed = await h.build();
  assert.equal(failed.pdfReused, undefined);
  assert.ok(errors(failed).some((d) => /Undefined control sequence/.test(d.message)), failed.rawLog);
  const previousFailure = await h.build();
  assert.equal(previousFailure.pdfWritten, false, previousFailure.rawLog);
  assert.equal(previousFailure.pdfReused, undefined);
  assert.ok(errors(previousFailure).length > 0);
  assert.doesNotMatch(previousFailure.rawLog, /Output written on|! Undefined control sequence/);
  assert.equal(existsSync(join(h.outDir, "main.log")), false, "no old error log is restored");

  h.source("Recovered after a source correction.");
  const recovered = await h.build();
  assert.equal(recovered.pdfWritten, true, recovered.rawLog);
  assert.equal(recovered.pdfReused, undefined);
  assert.deepEqual(errors(recovered), []);
});

test("real latexmk cancellation kills a running engine and never emits an old-PDF success", { skip: realSkip, timeout: 30_000 }, async (t) => {
  const h = native(t);
  h.source("Before cancellation.");
  const initial = await h.build();
  assert.equal(initial.pdfWritten, true);
  await until(() => !h.compiler.compiling);
  rmSync(join(h.dir, "latexmk.pid"));
  h.source("\\loop\\iftrue\\repeat");
  h.compiler.request("full");
  await until(() => existsSync(join(h.dir, "latexmk.pid")) && existsSync(join(h.outDir, "main.log")));
  const pid = Number(readFileSync(join(h.dir, "latexmk.pid"), "utf8"));
  h.compiler.dispose();
  await until(() => !h.compiler.compiling);
  assert.equal(h.results.length, 1, "only the initial result was emitted");
  assert.deepEqual(h.failures, []);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test("real latexmk no-op confirms root and output names with spaces without replacing the PDF or its deleted log", { skip: realSkip, timeout: 30_000 }, async (t) => {
  const h = native(t, true);
  h.source("A public document in a project and output directory with spaces.");
  const first = await h.build();
  assert.equal(first.pdfWritten, true, first.rawLog);
  assert.deepEqual(errors(first), []);
  const stamp = statSync(first.pdfPath).mtimeMs;
  const unchanged = await h.build();
  assert.equal(unchanged.pdfWritten, true, unchanged.rawLog);
  assert.equal(unchanged.pdfReused, true);
  assert.deepEqual(errors(unchanged), []);
  assert.deepEqual(unchanged.pdfData, first.pdfData);
  assert.equal(statSync(first.pdfPath).mtimeMs, stamp);
  assert.equal(existsSync(join(h.outDir, "paper draft.log")), false);
  assert.match(h.output(), /Nothing to do for 'paper draft\.tex'/);
  assert.doesNotMatch(h.output(), /Run number \d+ of rule/);
});

test("real XeLaTeX full no-op confirms the native XDV and PDF target list", { skip: realSkip, timeout: 30_000 }, async (t) => {
  const h = native(t, true, "xelatex");
  h.source("A public XeLaTeX document using the native XDV to PDF pipeline.");
  const first = await h.build();
  assert.equal(first.pdfWritten, true, first.rawLog);
  assert.deepEqual(errors(first), []);
  const stamp = statSync(first.pdfPath).mtimeMs;
  const unchanged = await h.build();
  assert.equal(unchanged.pdfWritten, true, unchanged.rawLog);
  assert.equal(unchanged.pdfReused, true);
  assert.deepEqual(errors(unchanged), []);
  assert.deepEqual(unchanged.pdfData, first.pdfData);
  assert.equal(statSync(first.pdfPath).mtimeMs, stamp);
  assert.equal(existsSync(join(h.outDir, "paper draft.log")), false);
  assert.match(h.output(), /All targets \(.*\.xdv .*\.pdf\) are up-to-date/);
  assert.doesNotMatch(h.output(), /Run number \d+ of rule/);
});
