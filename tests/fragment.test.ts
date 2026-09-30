// Fragment compiles (design 4.7; src/tex/fragment.ts): the source a job writes (the format's
// placeholder or the whole preamble, the labels its fragments name, the body's definitions, each
// fragment's lines), the boxes and errors read from its log, the body's definitions of a project,
// and the queue (newest wins, dispose kills) on a fake engine; then T-L13 and T-L14 against real
// TeX (skipped without it): pdfLaTeX from the preamble format a compile left ready, with
// `\eqref` resolved from the .aux; XeLaTeX with the fixture book's whole preamble (skipped
// without xelatex or Fandol); the timeout killing the process group; the cache.
import "./support/dom";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { readAuxDefinitions } from "../src/tex/aux";
import { resolveTexBinDir, texEnv, texTool } from "../src/tex/binaries";
import { CompileResult, Compiler, readyPreambleFormat } from "../src/tex/compiler";
import {
  FragmentJob,
  FragmentQueue,
  bodyStamp,
  compileFragments,
  fragmentContext,
  fragmentResult,
  fragmentSource,
  parseFragmentLog,
  preambleParts,
} from "../src/tex/fragment";
import { preambleOf } from "../src/tex/project";
import { FragmentService } from "../src/preview/fragments";
import { sleep, waitFor } from "./support/keyMatrix";

const job = (over: Partial<FragmentJob> = {}): FragmentJob => ({
  engine: "pdflatex",
  binDir: "/nowhere",
  cwd: "/project",
  outDir: "/project/out/snippets",
  preamble: "\\documentclass{article}\n\\usepackage{amsmath}",
  format: null,
  definitions: [],
  labels: new Map(),
  fragments: [],
  stamp: "",
  ...over,
});

test("preambleParts: everything before \\begin{document}, and what follows the root's own \\endofdump", () => {
  const text = [
    "\\documentclass{article}",
    "\\usepackage{amsmath} % \\begin{document} in a comment",
    "\\endofdump",
    "\\usepackage{fontspec}",
    "\\begin{document}",
    "x",
    "\\end{document}",
  ].join("\r\n");
  assert.deepEqual(preambleParts(text), {
    preamble: "\\documentclass{article}\n\\usepackage{amsmath} % \\begin{document} in a comment\n\\endofdump\n\\usepackage{fontspec}",
    rest: "\\usepackage{fontspec}",
  });
  assert.equal(preambleParts("\\documentclass{article}\n\\begin{document}\n")?.rest, "");
  assert.equal(preambleParts("\\section{A chapter}"), null);
});

test("fragmentSource: the format's placeholder or the whole preamble, the labels named, redefining definitions, each fragment's lines", () => {
  const labels = new Map([
    ["eq:a", "{{1}{1}{}{equation.1}{}}"],
    ["eq:a@cref", "{{[equation][1][]1}{[1][1][]1}}"],
    ["eq:b", "{{2}{1}{}{equation.2}{}}"],
  ]);
  const fragments = [
    { id: "one", body: "see \\eqref{eq:a}", inline: true },
    { id: "two", body: "\\begin{align*}\n  a &= b \\\\\n  c &= d\n\\end{align*}" },
  ];
  const full = fragmentSource(job({ labels, fragments, definitions: ["\\newcommand{\\Lip}{L}"] }));
  const lines = full.text.split("\n");
  assert.deepEqual(lines.slice(0, 3), ["\\documentclass{article}", "\\usepackage{amsmath}", "\\usepackage[active,tightpage,auctex]{preview}"]);
  assert.ok(full.text.includes("\\global\\@namedef{r@eq:a}{{1}{1}{}{equation.1}{}}"));
  assert.ok(full.text.includes("\\global\\@namedef{r@eq:a@cref}{{[equation][1][]1}{[1][1][]1}}"), "cleveref's twin too");
  assert.ok(!full.text.includes("r@eq:b"), "only the labels the fragments name");
  const begin = lines.indexOf("\\begin{document}");
  assert.match(lines[begin + 1], /\\def\\@ifdefinable#1#2\{#2\}/, "definitions may redefine");
  assert.equal(lines[begin + 2], "\\newcommand{\\Lip}{L}");
  assert.match(lines[begin + 3], /\\let\\@ifdefinable\\ll@ifdefinable/);
  const one = full.lines.get("one")!;
  const two = full.lines.get("two")!;
  assert.deepEqual([one.from, one.to], [begin + 5, begin + 6]);
  assert.equal(lines[one.from - 1], "\\begin{preview}see \\eqref{eq:a}%");
  assert.deepEqual([two.from, two.to], [one.to + 1, one.to + 5]);
  assert.equal(lines[two.from - 1], "\\begin{preview}\\begin{align*}");
  assert.equal(lines[two.to - 2], "\\end{align*}%");
  assert.equal(lines[two.to - 1], "\\par\\hbox{}\\end{preview}", "a display's last line keeps its depth");
  assert.equal(lines.at(-2), "\\end{document}");

  const dumped = fragmentSource(job({ fragments, format: { name: "main-preamble", dir: "/out", rest: "\\usepackage{fontspec}" } }));
  assert.deepEqual(dumped.text.split("\n").slice(0, 4), ["\\documentclass{article}", "\\endofdump", "\\usepackage{fontspec}", "\\usepackage[active,tightpage,auctex]{preview}"]);
  assert.ok(!dumped.text.includes("amsmath"), "the format holds the preamble");
});

test("parseFragmentLog: boxes from the snippet lines, errors by fragment lines or the preamble's", () => {
  const file = "/project/out/snippets/frag-1.tex";
  const log = [
    "Preview: Fontsize 10pt",
    `${file}:12: Preview: Snippet 1 started.`,
    "<-><->",
    "l.12 \\begin{preview}",
    "Not a real error.",
    "Preview: Tightpage -32891 -32891 32891 32891",
    `${file}:12: Preview: Snippet 1 ended.(598293+179404x12858061).`,
    "l.12 ...",
    "",
    `${file}:13: Preview: Snippet 2 started.`,
    `${file}:14: Undefined control sequence.`,
    "l.14 \\foo",
    "",
    `${file}:15: Preview: Snippet 2 ended.(0+0x0).`,
    "/project/main.tex:3: LaTeX Error: File `nope.sty' not found.",
    "l.3 \\usepackage{nope}",
    "",
  ].join("\n");
  const lines = new Map([
    ["a", { from: 12, to: 12 }],
    ["b", { from: 13, to: 15 }],
  ]);
  const parsed = parseFragmentLog(log, file, "/project", ["a", "b"], lines);
  assert.equal(parsed.boxes.length, 2);
  const a = parsed.boxes[0];
  assert.deepEqual([a.id, a.page], ["a", 1]);
  assert.ok(Math.abs(a.heightPt - 9.129) < 0.01 && Math.abs(a.depthPt - 2.737) < 0.01 && Math.abs(a.widthPt - 196.2) < 0.1);
  assert.ok(Math.abs(parsed.borderPt - 0.5019) < 0.001, "0.50001bp");
  assert.deepEqual(parsed.errors, [
    { id: "b", message: "Undefined control sequence." },
    { id: null, message: "LaTeX Error: File `nope.sty' not found." },
  ]);
  const out = { hash: "h", pdf: new Uint8Array(1), ...parsed, usedFormat: false, cached: false, durationMs: 1 };
  assert.ok("box" in fragmentResult(out, "a"), "the preamble's error fails only a fragment without a box");
  assert.deepEqual(fragmentResult(out, "b"), { error: "Undefined control sequence." });
  assert.deepEqual(fragmentResult({ ...out, errors: [] }, "b"), { error: "TeX typeset nothing for this fragment." });
});

test("fragmentContext: the body's definitions in document order (buffers win); a stamp of what the preamble reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-frag-ctx-"));
  try {
    mkdirSync(join(dir, "chapters"));
    const root = join(dir, "main.tex");
    const chapter = join(dir, "chapters", "one.tex");
    const macros = join(dir, "macros.tex");
    writeFileSync(root, "\\documentclass{article}\n\\input{macros}\n\\usepackage{localpkg}\n\\newcommand{\\pre}{p}\n\\begin{document}\n\\newcommand{\\rootbody}{r}\n\\input{chapters/one}\n\\end{document}\n");
    writeFileSync(macros, "\\newcommand{\\R}{\\mathbf{R}}\n");
    writeFileSync(join(dir, "localpkg.sty"), "\\newcommand{\\pkg}{k}\n");
    writeFileSync(chapter, "\\newcommand{\\Lip}{L}\n$\\Lip$\n");
    const ctx = fragmentContext(root);
    assert.equal(ctx.definitions.length, 2, ctx.definitions.join(" | "));
    assert.match(ctx.definitions[0], /\\rootbody/);
    assert.match(ctx.definitions[1], /\\Lip\}\{L\}/);
    assert.ok(ctx.stamp.includes(macros) && ctx.stamp.includes("localpkg.sty") && !ctx.stamp.includes("one.tex"));
    assert.match(fragmentContext(root, new Map([[chapter, "\\newcommand{\\Lip}{K}\n"]])).definitions[1], /\\Lip\}\{K\}/, "unsaved text");
    utimesSync(macros, new Date(), new Date(Date.now() + 5000));
    assert.notEqual(fragmentContext(root).stamp, ctx.stamp, "a preamble input changed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake pdflatex: sleeps, then writes one snippet's log and a PDF; a body with "slow" waits on a child. */
function fakeEngine(): { bin: string; runs: () => number; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ll-frag-fake-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pdflatex"),
    [
      "#!/bin/sh",
      'for a; do case "$a" in -output-directory=*) out="${a#-output-directory=}";; esac; last="$a"; done',
      'name=$(basename "$last" .tex)',
      'echo run >> "$(dirname "$0")/runs"',
      'if grep -q slow "$last"; then sleep 30 & echo $! > "$(dirname "$0")/child.pid"; wait; fi',
      "sleep 0.3",
      'printf "Preview: Snippet 1 ended.(65536+0x131072).\\n" > "$out/$name.log"',
      'printf "%%PDF-fake" > "$out/$name.pdf"',
    ].join("\n") + "\n",
  );
  chmodSync(join(bin, "pdflatex"), 0o755);
  const runs = () => (existsSync(join(bin, "runs")) ? readFileSync(join(bin, "runs"), "utf8").split("\n").filter(Boolean).length : 0);
  return { bin, runs, dir };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("FragmentQueue: one runs, a newer job replaces the waiting one, the cache answers at once, dispose kills", { skip: process.platform === "win32" && "sh" }, async () => {
  const fake = fakeEngine();
  try {
    const q = new FragmentQueue();
    const at = (body: string) => job({ binDir: fake.bin, cwd: fake.dir, outDir: join(fake.dir, "snippets"), fragments: [{ id: "f", body }] });
    const a = q.run(at("$a$"));
    await sleep(50);
    const b = q.run(at("$b$"));
    await sleep(50);
    const c = q.run(at("$c$"));
    assert.equal(await b, null, "replaced while it waited");
    const [ra, rc] = await Promise.all([a, c]);
    assert.ok(ra && rc && !ra.cached && !rc.cached);
    assert.deepEqual(ra.boxes, [{ id: "f", page: 1, heightPt: 1, depthPt: 0, widthPt: 2 }]);
    assert.equal(fake.runs(), 2, "the replaced job never ran");
    const again = await q.run(at("$a$"));
    assert.ok(again?.cached && again.hash === ra.hash && again.pdf?.length);
    assert.equal(fake.runs(), 2);
    const left = readdirSync(join(fake.dir, "snippets")).sort();
    assert.ok(left.every((f) => /^frag-[0-9a-f]{16}\.(?:json|pdf)$/.test(f)), `only the cache stays: ${left}`);

    const slow = q.run(at("slow"));
    await waitFor(() => existsSync(join(fake.bin, "child.pid")), 5000);
    const pid = Number(readFileSync(join(fake.bin, "child.pid"), "utf8"));
    assert.ok(alive(pid));
    q.dispose();
    assert.equal(await slow, null);
    const tidied = readdirSync(join(fake.dir, "snippets")).sort();
    assert.ok(tidied.every((f) => /^frag-[0-9a-f]{16}\.(?:json|pdf)$/.test(f)), `the aborted run left nothing: ${tidied}`);
    await waitFor(() => !alive(pid), 3000);
    assert.equal(await q.run(at("$d$")), null, "a disposed queue runs nothing");
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("FragmentService: a hover pending when its root is released or the plugin unloads starts no TeX", { skip: process.platform === "win32" && "sh" }, async () => {
  const fake = fakeEngine();
  try {
    const root = join(fake.dir, "main.tex");
    writeFileSync(root, "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n");
    // pdfLaTeX with "Cache the preamble": the render awaits the format check before its queue.
    const service = () =>
      new FragmentService({
        binDir: () => fake.bin,
        engineSetting: () => "auto",
        preambleCache: () => true,
        outDirFor: () => join(fake.dir, "out"),
        buffers: () => new Map(),
        openPdf: () => Promise.reject(new Error("no pdf.js in Node")),
        inverted: () => false,
        document,
      });
    const queues = (s: FragmentService) => (s as unknown as { queues: Map<string, FragmentQueue> }).queues;
    const released = service();
    const a = released.render(root, "$a$", true);
    released.release(root);
    assert.equal(await a, null, "released during the format check");
    const disposed = service();
    const b = disposed.render(root, "$b$", true);
    disposed.dispose();
    assert.equal(await b, null, "disposed during the format check");
    assert.equal(await disposed.render(root, "$c$", true), null, "after dispose (a hover waiting for MathJax)");
    await sleep(500);
    assert.equal(fake.runs(), 0, "no TeX ran");
    assert.equal(queues(disposed).size, 0, "no queue left behind");
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("FragmentService: a fragment whose \\input file or image changed compiles again (bodyStamp)", { skip: process.platform === "win32" && "sh" }, async () => {
  const fake = fakeEngine();
  try {
    const root = join(fake.dir, "main.tex");
    writeFileSync(root, "\\documentclass{article}\n\\usepackage{graphicx}\n\\graphicspath{{img/}}\n\\begin{document}\nx\n\\end{document}\n");
    mkdirSync(join(fake.dir, "figures"));
    mkdirSync(join(fake.dir, "img"));
    const pic = join(fake.dir, "figures", "pic.tex");
    const png = join(fake.dir, "img", "photo.png");
    writeFileSync(pic, "\\includegraphics[width=2cm]{photo} % the image, through \\graphicspath\n");
    writeFileSync(png, "png");
    const stamp = () => bodyStamp("\\begin{center}\\input{figures/pic}\\end{center}", fake.dir, fragmentContext(root).graphics);
    assert.deepEqual(
      stamp().split("\n").map((l) => l.slice(0, l.lastIndexOf("@"))),
      [pic, png],
      "the \\input file, then the image it includes",
    );
    const service = new FragmentService({
      binDir: () => fake.bin,
      engineSetting: () => "auto",
      preambleCache: () => false,
      outDirFor: () => join(fake.dir, "out"),
      buffers: () => new Map(),
      openPdf: () => Promise.reject(new Error("no pdf.js in Node")),
      inverted: () => false,
      document,
    });
    const hover = () => service.render(root, "\\begin{center}\\input{figures/pic}\\end{center}", false).catch(() => null);
    await hover();
    await hover();
    assert.equal(fake.runs(), 1, "the cache answers while nothing changed");
    const later = new Date(Date.now() + 5000);
    utimesSync(pic, later, later);
    await hover();
    assert.equal(fake.runs(), 2, "a changed figure file");
    utimesSync(png, later, new Date(Date.now() + 10_000));
    await hover();
    assert.equal(fake.runs(), 3, "a changed image");
    service.dispose();
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

// ---- Real TeX ------------------------------------------------------------------------------

const binDir = process.env.TEXBIN ?? resolveTexBinDir("");
const noTex = !binDir ? "no TeX installation found" : false;

/** Processes whose command line mentions `text` (pgrep -f). */
function pgrep(text: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", text], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** A small pdfLaTeX project compiled with its preamble cached, and its format ready. */
async function formatProject() {
  const dir = mkdtempSync(join(tmpdir(), "ll-frag-tex-"));
  mkdirSync(join(dir, "chapters"));
  const root = join(dir, "main.tex");
  writeFileSync(
    root,
    [
      "\\documentclass{article}",
      "\\usepackage{amsmath}",
      "\\usepackage{hyperref}",
      "\\usepackage{cleveref}",
      "\\input{macros}",
      "\\begin{document}",
      "\\section{One}\\label{sec:one}",
      "\\begin{equation}\\label{eq:a}",
      "  a = b",
      "\\end{equation}",
      "\\input{chapters/one}",
      "\\end{document}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "macros.tex"), "\\newcommand{\\R}{\\mathbf{R}}\n");
  writeFileSync(join(dir, "chapters", "one.tex"), "\\newcommand{\\Lip}{L}\nIt is $\\Lip$-smooth.\n");
  const outDir = join(dir, "out");
  const results: CompileResult[] = [];
  const compiler = new Compiler(root, () => ({ binDir: binDir!, engine: "pdflatex", outDir, preambleCache: true, shellEscape: false }), {
    onStart: () => {},
    onResult: (r) => results.push(r),
    onFailure: (e) => {
      throw e;
    },
  });
  compiler.request("fast");
  await waitFor(() => results.length > 0 && !compiler.compiling, 60_000);
  const text = readFileSync(root, "utf8");
  // The compile builds the format in the background; its stamp says when it is ready.
  let format: Awaited<ReturnType<typeof readyPreambleFormat>> = null;
  for (const t0 = Date.now(); !(format = await readyPreambleFormat(outDir, root, "pdflatex", preambleOf(text)!)); await sleep(50)) {
    if (Date.now() - t0 > 60_000) throw new Error("the preamble format never became ready");
  }
  const parts = preambleParts(text)!;
  const context = fragmentContext(root);
  const base = (fragments: FragmentJob["fragments"], over: Partial<FragmentJob> = {}): FragmentJob => ({
    engine: "pdflatex",
    binDir: binDir!,
    cwd: dir,
    outDir: join(outDir, "snippets"),
    preamble: parts.preamble,
    format: { name: format!.name, dir: outDir, rest: parts.rest },
    definitions: context.definitions,
    labels: readAuxDefinitions(outDir),
    fragments,
    stamp: `${context.stamp}\n${format!.mtime}`,
    ...over,
  });
  const done = () => {
    compiler.dispose();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, root, outDir, base, done };
}

test("T-L13: pdfLaTeX from the preamble format: four fragments, four pages with their boxes; \\eqref resolves from the .aux", { skip: noTex, timeout: 180_000 }, async () => {
  const p = await formatProject();
  try {
    const fragments = [
      { id: "inline", body: "$\\R^n \\ni x$, see \\eqref{eq:a}", inline: true },
      { id: "align", body: "\\begin{align*}\n  f &= \\Lip x \\tag{1} \\\\\n  \\intertext{and}\n  g &= 2\n\\end{align*}" },
      { id: "table", body: "\\begin{tabular}{ll} a & b \\\\ c & d \\end{tabular}", inline: true },
      { id: "cref", body: "\\cref{eq:a} and \\ref{sec:one}", inline: true },
    ];
    const out = await compileFragments(p.base(fragments));
    assert.equal(out.usedFormat, true);
    assert.deepEqual(out.errors, [], JSON.stringify(out.errors));
    assert.deepEqual(out.boxes.map((b) => [b.id, b.page]), [["inline", 1], ["align", 2], ["table", 3], ["cref", 4]]);
    for (const b of out.boxes) assert.ok(b.widthPt > 0 && b.heightPt > 0, JSON.stringify(b));
    const [inline, align, table] = out.boxes;
    assert.ok(inline.depthPt > 0, "inline math has a depth below its baseline");
    assert.ok(Math.abs(align.widthPt - 345) < 1, `a display is \\linewidth wide: ${align.widthPt}`);
    assert.ok(align.heightPt + align.depthPt > 3 * (inline.heightPt + inline.depthPt), "three lines");
    assert.ok(table.widthPt < 100);
    assert.ok(out.pdf && new TextDecoder().decode(out.pdf.slice(0, 5)) === "%PDF-");
    assert.ok(out.durationMs < 10_000);
    console.log(`T-L13 pdfLaTeX with the format: 4 fragments in ${out.durationMs} ms`);
    // Without the labels the reference prints ?? (in bold), wider than the number.
    const unresolved = await compileFragments(p.base([fragments[0]], { labels: new Map() }));
    assert.ok(unresolved.boxes[0].widthPt > inline.widthPt + 1, `${unresolved.boxes[0].widthPt} vs ${inline.widthPt}`);
    // The full preamble gives the same boxes.
    const full = await compileFragments(p.base(fragments, { format: null }));
    assert.equal(full.usedFormat, false);
    assert.deepEqual(full.boxes, out.boxes);
    assert.deepEqual(pgrep(p.outDir), []);
  } finally {
    p.done();
  }
});

function hasFandol(): boolean {
  try {
    return !!execFileSync(texTool(binDir!, "kpsewhich"), ["FandolSong-Regular.otf"], { env: texEnv(binDir!), encoding: "utf8" }).trim();
  } catch {
    return false;
  }
}
const noXe = noTex || (!existsSync(texTool(binDir!, "xelatex")) ? "no xelatex" : !hasFandol() ? "no Fandol fonts" : false);

test("T-L13: XeLaTeX without a format: the fixture book's whole preamble, a chapter's own macro, within the timeout", { skip: noXe, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-frag-xe-"));
  try {
    const book = join(dir, "book");
    cpSync(resolve("tests/fixtures/elegantbook"), book, { recursive: true });
    const root = join(book, "main.tex");
    const context = fragmentContext(root);
    assert.ok(context.definitions.some((d) => d.includes("\\Lip")), "ch2's \\Lip");
    const out = await compileFragments({
      engine: "xelatex",
      binDir: binDir!,
      cwd: book,
      outDir: join(dir, "out", "snippets"),
      preamble: preambleParts(readFileSync(root, "utf8"))!.preamble,
      format: null,
      definitions: context.definitions,
      labels: new Map(),
      fragments: [
        { id: "box", body: "\\begin{proposition}{半正定}{psd}\n  $\\Lip = \\ceil{\\lambda_{\\max}}$\n\\end{proposition}" },
        { id: "cd", body: "\\begin{equation*}\n  \\begin{tikzcd} V \\arrow[r, \"A\"] & W \\end{tikzcd}\n\\end{equation*}" },
      ],
      stamp: context.stamp,
    });
    assert.deepEqual(out.errors.filter((e) => e.id !== null), [], JSON.stringify(out.errors));
    assert.deepEqual(out.boxes.map((b) => b.id), ["box", "cd"]);
    assert.ok(out.boxes.every((b) => b.widthPt > 300), "a box and a display take the line's width");
    assert.ok(out.durationMs < 20_000);
    console.log(`T-L13 XeLaTeX with the whole preamble: 2 fragments in ${out.durationMs} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-L14: a fragment that never ends is stopped at the timeout with its process group; the cache hits on the same hash", { skip: noTex || (process.platform === "win32" && "pgrep"), timeout: 180_000 }, async () => {
  const p = await formatProject();
  try {
    const children = new Set<ChildProcess>();
    const pids: number[] = [];
    const watch = setInterval(() => {
      for (const c of children) if (c.pid && !pids.includes(c.pid)) pids.push(c.pid);
    }, 10);
    const started = Date.now();
    const loop = await compileFragments(p.base([{ id: "loop", body: "\\loop\\iftrue\\repeat" }], { timeoutMs: 1500, children }));
    clearInterval(watch);
    assert.ok(Date.now() - started < 8000);
    const stopped = fragmentResult(loop, "loop");
    assert.match("error" in stopped ? stopped.error : "", /took longer than 2 s/);
    assert.ok(pids.length === 1, "one TeX process");
    await sleep(200);
    assert.deepEqual(pids.filter(alive), [], "the process group was killed");
    assert.deepEqual(pgrep(p.outDir), []);
    assert.equal(children.size, 0);

    const one = p.base([{ id: "x", body: "$x^2$" }]);
    const first = await compileFragments(one);
    assert.equal(first.cached, false);
    const again = await compileFragments(one);
    assert.equal(again.cached, true);
    assert.deepEqual(again.boxes, first.boxes);
    assert.ok(again.durationMs < 100, `${again.durationMs} ms`);
    const stamped = await compileFragments({ ...one, stamp: `${one.stamp}\nchanged` });
    assert.equal(stamped.cached, false, "a changed preamble input misses");
    const again2 = await compileFragments(p.base([{ id: "loop", body: "\\loop\\iftrue\\repeat" }], { timeoutMs: 1500 }));
    assert.equal(again2.cached, false, "a stopped run is never cached");
  } finally {
    p.done();
  }
});
