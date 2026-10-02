import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { emitExport, exportHtml, prepareExport } from "../src/export/exporter";
import { drawingKey, markPdfPage, pageDrawing, prepareFragment, type PdfPageMarker } from "../src/export/fragments";
import { planExport } from "../src/export/plan";
import { prepareWorkDir, runDvisvgm, runProbe, type ProbeHost } from "../src/export/probe";
import { readProbeLog, StepQueue } from "../src/export/probeLog";
import { texTool } from "../src/tex/binaries";
import { projectDefinitions } from "../src/tex/macros";
import { isAbortError } from "../src/tex/run";
import { theoremMap } from "../src/tex/theorems";
import { nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

const dirs: string[] = [];
after(() => { removeExportTemps(); dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "latex-live-lua-export-")); dirs.push(d); return d; };
const skip = !texBin ? "no TeX installation found" : !existsSync(texTool(texBin, "dvisvgm")) ? "no dvisvgm" : false;
const signal = () => new AbortController().signal;
const PT_PER_BP = 72.27 / 72;

function planOf(root: string) {
  const defs = projectDefinitions(root);
  return planExport(root, { defs, theorems: theoremMap(defs.files.map((f) => readFileSync(f, "utf8"))) });
}

test("Lua PDF markers recover explicit physical pages and measured baselines; ambiguous geometry stays unclaimed", () => {
  const sp = (bp: number) => Math.round(bp * PT_PER_BP * 65536);
  const marker = (page: number, visit: number): PdfPageMarker => ({ id: 3, visit, page, y: sp(2), width: sp(12), height: sp(9), inline: true });
  const svg = `<svg viewBox="0 0 12 9"><path d="M0 0L12 9" stroke="black"/></svg>`;
  const markers = [marker(7, 2), marker(4, 8)];
  const recovered = markPdfPage(svg, 4, markers)!;
  assert.deepEqual(pageDrawing(recovered), { id: 3, visit: 8 });
  const html = prepareFragment(recovered, "8-3", 10)!;
  const depth = -Number(/vertical-align:([\d.-]+)em/.exec(html)![1]) * 10;
  assert.ok(Math.abs(depth - 2 * PT_PER_BP) < 0.001);
  assert.match(html, /stroke="currentColor"/);
  assert.doesNotMatch(html, /llx-ref|data-y/);
  assert.equal(markPdfPage(svg, 1, markers), null, "an unmarked physical page cannot shift later drawings");
  assert.equal(markPdfPage(svg, 4, [...markers, marker(4, 9)]), null, "two identities on one page are ambiguous");
  assert.equal(markPdfPage(svg.replace("0 0 12 9", "0 -10 12 9"), 4, markers), null, "unexpected converter origin");
  const parsed = readProbeLog(`llxpdf{3}{8}{4}{${sp(2)}}{${sp(12)}}{${sp(9)}}{inline}\nllxpdf{3}{8}{0}{0}{1}{1}{block}`);
  assert.deepEqual(parsed.pdfPages, [marker(4, 8)]);
  assert.equal(parsed.unreadable, 1);
});

test("LuaLaTeX exports native luamplib drawings, normal numbered content and repeated visits from its PDF probe", { skip, timeout: 120_000 }, async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  writeFileSync(root, String.raw`\documentclass{article}
\usepackage{amsmath,amsthm,tikz,luamplib,hyperref}
\newtheorem{lemma}{Lemma}[section]
\NewDocumentCommand{\pair}{m o}{\langle #1 \IfValueT{#2}{\mid #2}\rangle}
\title{Native Lua export}\author{Synthetic Author}\date{2026}
\begin{document}
\maketitle
\section{Context}\label{s:context}
\begin{lemma}\label{l:one}A labelled statement.\end{lemma}
References: Section~\ref{s:context}, Lemma~\ref{l:one}.
\begin{equation}\label{e:normal} a+b=c \end{equation}
Inline $\pair{x_1}[y]$ text.
\begin{equation}\label{e:fragment}\pair{z}[w]\end{equation}
\input{piece}
\input{piece}
\end{document}`);
  writeFileSync(join(folder, "piece.tex"), String.raw`\section{Repeated}
\begin{mplibcode}
beginfig(0); fill (0,0)--(13,0)--(3,7)--cycle withcolor (1,0,0); endfig;
\end{mplibcode}
\begin{tikzpicture}\node{\thesection};\end{tikzpicture}
\begin{equation}\begin{tikzpicture}\node{\theequation};\end{tikzpicture}\end{equation}`);
  const host = nodeExportHost(root, { engine: "lualatex" });
  const { prepared, math } = await prepareExport(root, host, () => undefined, signal());
  assert.ok(prepared.log);
  assert.equal(prepared.log.unreadable, 0);
  assert.ok(existsSync(join(host.workDir, "main.pdf")), "native PDF probe output");
  assert.ok(!existsSync(join(host.workDir, "main.dvi")), "Lua drawings never go through DVI");
  const log = prepared.log;
  assert.equal(log.pdfPages.length, 8, "two root formulas and three drawings per repeated input");
  assert.equal(prepared.fragments.size, 8, prepared.report.items.map((i) => i.message).join("\n"));
  assert.equal(new Set(log.pdfPages.map((p) => p.page)).size, log.pdfPages.length);
  const queue = new StepQueue(log, prepared.plan.visits);
  const visits = prepared.plan.visits.flatMap((v, i) => v.key === "piece.tex" ? [i] : []);
  assert.equal(visits.length, 2);
  const drawingIds = prepared.plan.fragments.filter((f) => f.key === "piece.tex").map((f) => f.id);
  for (const v of visits) for (const id of drawingIds) assert.ok(prepared.fragments.has(queue.fragmentKey(id, v)!));
  for (const m of log.pdfPages.filter((p) => p.inline)) {
    const svg = prepared.fragments.get(drawingKey(m.visit, m.id))!;
    const depth = -Number(/vertical-align:([\d.-]+)em/.exec(svg)![1]) * Number(log.info.get("fontsize"));
    assert.ok(Math.abs(depth - m.y / 65536) < 0.002, `page ${m.page}: exact savepos baseline`);
    const box = log.fragments.find((f) => f.id === m.id && f.visit === m.visit)!.box!;
    assert.ok(Math.abs(depth - Math.max(box.dp, 0) - 0.50001 * PT_PER_BP) < 0.01, `page ${m.page}: independent TeX box depth plus preview border`);
  }
  const mplib = prepared.plan.fragments.find((f) => f.what === "mplibcode")!;
  assert.ok(mplib);
  for (const m of log.pdfPages.filter((p) => p.id === mplib.id)) {
    const svg = prepared.fragments.get(drawingKey(m.visit, m.id))!;
    assert.match(svg, /<(?:path|polygon)\b/, "native MetaPost vector path survives PDF conversion");
    assert.match(svg, /(?:#f00|#ff0000|rgb\(100%,0%,0%\))/, "native red drawing remains red");
    assert.ok(m.width / 65536 > 13 && m.height / 65536 > 7, "nonempty native drawing dimensions");
  }
  const { html, report } = await emitExport(prepared, math, host, () => undefined, signal());
  const document = new JSDOM(html).window.document;
  assert.match(document.body.textContent!, /Native Lua export/);
  assert.match(document.body.textContent!, /Synthetic Author/);
  assert.match(document.body.textContent!, /Lemma\s+1\.1/);
  assert.equal(document.querySelector('a[href="#l:one"]')?.textContent, "1.1");
  assert.deepEqual(report.numbers.filter((n) => n.counter === "equation").map((n) => [n.value, n.shown]), [["1", true], ["2", true], ["3", true], ["4", true]]);
  assert.equal(document.querySelectorAll("svg.llx-frag").length, 8);
  assert.equal(document.querySelectorAll("pre.llx-source").length, 0);
  const ids = [...document.querySelectorAll("svg.llx-frag [id]")].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "repeated pages keep independent SVG identities");
  assert.deepEqual(report.items.filter((i) => i.severity !== "info"), []);
});

test("Lua Unicode fonts survive native PDF fragments and Chinese semantic text", { skip, timeout: 120_000 }, async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  writeFileSync(root, String.raw`\documentclass[fontset=fandol]{ctexart}
\usepackage{tikz,amsmath}
\begin{document}
\section{中文标题}\label{s:cn}
中文内容，引用第\ref{s:cn}节。
\begin{tikzpicture}\node{非空，中文};\end{tikzpicture}
\end{document}`);
  const host = nodeExportHost(root, { engine: "lualatex" });
  const { html, report } = await exportHtml(root, host, () => undefined, signal());
  const document = new JSDOM(html).window.document;
  assert.match(document.body.textContent!, /中文标题/);
  assert.match(document.body.textContent!, /中文内容，引用第1节。/);
  const svg = document.querySelector("svg.llx-frag")!;
  assert.ok(svg, report.items.map((i) => i.message).join("\n"));
  if (svg.querySelector("text")) {
    assert.match(svg.textContent!, /非空，中文/, "the native CJK label remains complete");
    assert.match(svg.innerHTML, /@font-face[\s\S]*src:url\(data:/, "the label embeds its original font");
  } else {
    assert.ok(svg.querySelectorAll("path,use").length >= 4, "actual CJK font outlines in the converted native PDF");
  }
  assert.deepEqual(report.items.filter((i) => i.severity !== "info"), []);
});

test("an unmarked native PDF page cannot shift the source association or inline baseline", { skip, timeout: 120_000 }, async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  writeFileSync(root, String.raw`\documentclass{article}\usepackage{tikz}\begin{document}
\begin{preview}An unmarked page.\end{preview}
\tikz[baseline=-2pt]\draw (0,0) rectangle (12pt,9pt);
\tikz[baseline=3pt]\draw (0,0) rectangle (7pt,11pt);
\end{document}`);
  const host = nodeExportHost(root, { engine: "lualatex" });
  const plan = planOf(root);
  // The explicit preview page is runtime material a package can ship independently. Keep it
  // outside the instrumented fragment list, as a package-owned page would be.
  for (const [key, copy] of plan.copies) plan.copies.set(key, copy.replace(/\\begin\{llxblock\}\{\d+\}(\\begin\{preview\}[\s\S]*?\\end\{preview\})\\end\{llxblock\}/, "$1"));
  await prepareWorkDir(plan, host);
  const probe = await runProbe(plan, host, signal());
  assert.ok(probe.pdf, probe.output);
  const log = readProbeLog(probe.llx!);
  assert.deepEqual(log.pdfPages.map((p) => p.page), [2, 3]);
  const pages = await runDvisvgm(probe.pdf!, host, signal());
  assert.equal(pages.code, 0, pages.output);
  const drawings = pages.pages.map((p) => markPdfPage(p.svg, p.page, log.pdfPages));
  assert.equal(drawings[0], null);
  assert.deepEqual(drawings.slice(1).map((svg) => pageDrawing(svg!)), log.pdfPages.map((p) => ({ id: p.id, visit: p.visit })));
  for (let i = 0; i < log.pdfPages.length; i++) {
    const marker = log.pdfPages[i];
    const box = log.fragments.find((f) => f.id === marker.id && f.visit === marker.visit)!.box!;
    const prepared = prepareFragment(drawings[i + 1]!, `${marker.visit}-${marker.id}`, Number(log.info.get("fontsize")))!;
    const depth = -Number(/vertical-align:([\d.-]+)em/.exec(prepared)![1]) * Number(log.info.get("fontsize"));
    assert.ok(Math.abs(depth - Math.max(box.dp, 0) - 0.50001 * PT_PER_BP) < 0.01, `page ${marker.page}: diagram's own measured baseline`);
  }
});

test("a converter reporting missing native PDF support cannot silently succeed with zero drawings", { skip: !texBin ? "no TeX installation found" : process.platform === "win32" ? "shell converter fixture" : false, timeout: 120_000 }, async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  writeFileSync(root, String.raw`\documentclass{article}\usepackage{tikz}\begin{document}
\tikz\draw (0,0) rectangle (12pt,9pt);
\end{document}`);
  const host = nodeExportHost(root, { engine: "lualatex" });
  const bin = join(folder, "bin");
  mkdirSync(bin);
  const converter = join(bin, "dvisvgm");
  writeFileSync(converter, "#!/bin/sh\necho 'PDF conversion unavailable: mutool not found' >&2\nexit 0\n");
  chmodSync(converter, 0o755);
  const { html, report } = await exportHtml(root, host, (p) => {
    if (p.stage === "fragments" && p.message.startsWith("TeX fragments")) host.binDir = bin;
  }, signal());
  assert.equal(report.counts.fragments, 1, "the source fragment is still accounted for");
  assert.equal(new JSDOM(html).window.document.querySelectorAll("svg.llx-frag").length, 0);
  assert.ok(report.items.some((i) => i.kind === "fragment" && i.severity === "error" && /mutool not found/.test(i.message) && /requires a supported dvisvgm PDF backend/.test(i.message)));
});

test("native PDF conversion finds an installed Homebrew helper under the GUI's minimal PATH", { skip: skip || (process.platform !== "darwin" || !existsSync("/opt/homebrew/bin/mutool") ? "macOS Homebrew helper regression" : false), timeout: 120_000 }, async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  writeFileSync(root, String.raw`\documentclass{article}\usepackage{tikz}\begin{document}
\tikz\draw (0,0) rectangle (12pt,9pt);
\end{document}`);
  const host = nodeExportHost(root, { engine: "lualatex" });
  // node:test isolates this file in its own worker process, and its tests run sequentially.
  // Restore even on failure; the real application implementation never changes process.env.
  const original = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  try {
    const { html, report } = await exportHtml(root, host, () => undefined, signal());
    assert.equal(new JSDOM(html).window.document.querySelectorAll("svg.llx-frag").length, 1);
    assert.deepEqual(report.items.filter((i) => i.severity !== "info"), []);
    assert.equal(process.env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin", "converter extends only its child environment");
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
});

test("canceling a Lua PDF probe and its converter kills each process group, including helpers", { skip: process.platform === "win32" ? "POSIX process groups" : false, timeout: 15_000 }, async () => {
  const folder = dir();
  const root = join(folder, "main.tex");
  writeFileSync(root, "\\documentclass{article}\\begin{document}text\\end{document}");
  const bin = join(folder, "bin");
  mkdirSync(bin);
  const host: ProbeHost = { binDir: bin, engine: "lualatex", shellEscape: false, buildDir: join(folder, "out"), workDir: join(folder, "work") };
  await prepareWorkDir(planOf(root), host);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const tool of ["lualatex", "dvisvgm"]) {
    const executable = join(bin, tool);
    writeFileSync(executable, "#!/bin/sh\nsleep 60 &\necho $! > helper.pid\necho $$ > engine.pid\nwait\n");
    chmodSync(executable, 0o755);
    const controller = new AbortController();
    const run = tool === "lualatex" ? runProbe(planOf(root), host, controller.signal) : runDvisvgm(join(host.workDir, "main.pdf"), host, controller.signal);
    const settled = run.then(() => null, (e: unknown) => e);
    for (let i = 0; i < 100 && !existsSync(join(host.workDir, "helper.pid")); i++) await pause(20);
    const helper = Number(readFileSync(join(host.workDir, "helper.pid"), "utf8"));
    const engine = Number(readFileSync(join(host.workDir, "engine.pid"), "utf8"));
    controller.abort();
    assert.ok(isAbortError(await settled), tool);
    for (let i = 0; i < 40 && (alive(helper) || alive(engine)); i++) await pause(25);
    assert.equal(alive(engine), false, `${tool} engine died`);
    assert.equal(alive(helper), false, `${tool} helper died`);
    rmSync(join(host.workDir, "helper.pid"));
    rmSync(join(host.workDir, "engine.pid"));
  }
});
