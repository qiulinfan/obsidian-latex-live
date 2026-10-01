import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { exportHtml, buildFreshness } from "../src/export/exporter";
import { planExport, type ExportPlan } from "../src/export/plan";
import { prepareWorkDir, runProbe } from "../src/export/probe";
import { readProbeLog, StepQueue, tocEntry } from "../src/export/probeLog";
import type { ExportReport } from "../src/export/report";
import { walkTex, type TexNode } from "../src/export/texTree";
import { readAuxLabels } from "../src/tex/aux";
import { texTool } from "../src/tex/binaries";
import { projectDefinitions } from "../src/tex/macros";
import { stripComments } from "../src/tex/project";
import { isAbortError } from "../src/tex/run";
import { ELEGANT_SCHEMES, theoremMap } from "../src/tex/theorems";
import { fixtureCopy, nodeExportHost, removeExportTemps, texBin, type NodeExportHost } from "./support/exportHost";

// The probe pass and the export end to end against real TeX (XeLaTeX for the elegantbook book
// and homework, pdfLaTeX for the article), on fresh $TMPDIR copies of the fixtures. Skipped
// without TeX. Acceptance of design S1: the book's headings are the PDF's contents, no Chinese
// text of the sources is missing from the HTML (fidelity assertion 7), and cancelling during the
// probe leaves no TeX process.

const skip = !texBin ? "no TeX installation found" : !existsSync(texTool(texBin, "xelatex")) ? "no XeLaTeX" : false;

interface Exported {
  root: string;
  host: NodeExportHost;
  plan: ExportPlan;
  html: string;
  report: ExportReport;
}

const exports = new Map<string, Promise<Exported>>();
after(removeExportTemps);

/** The fixture `name` exported once per test file (a fresh copy, a full build first). */
function exported(name: string): Promise<Exported> {
  let p = exports.get(name);
  if (!p) {
    p = (async () => {
      const { root } = fixtureCopy(name);
      const host = nodeExportHost(root);
      const { html, report } = await exportHtml(root, host, () => undefined, new AbortController().signal);
      return { root, host, plan: planOf(root), html, report };
    })();
    exports.set(name, p);
  }
  return p;
}

function planOf(root: string): ExportPlan {
  const defs = projectDefinitions(root);
  return planExport(root, { defs, theorems: theoremMap(defs.files.map((f) => stripComments(readFileSync(f, "utf8")))) });
}

/** The page's text as a reader sees it (tags, style and entities gone). */
function pageText(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/ /g, " ");
}

/** The contents of the build's .toc within tocdepth: `number|title`. */
function pdfContents(buildDir: string, depth: number): string[] {
  const levels: Record<string, number> = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3 };
  const toc = readFileSync(join(buildDir, "main.toc"), "utf8");
  const out: string[] = [];
  for (const line of toc.split("\n")) {
    const m = /^\\contentsline \{(\w+)\}\{(.*)\}\{[^{}]*\}\{[^{}]*\}%$/.exec(line);
    if (!m || (levels[m[1]] ?? 9) > depth) continue;
    const e = tocEntry(m[2]);
    out.push(`${e.number ?? ""}|${e.title}`);
  }
  return out;
}

/** The HTML's contents: `number|title`. */
function htmlContents(html: string): string[] {
  const nav = /<nav class="llx-toc">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  return [...nav.matchAll(/<li[^>]*><a[^>]*>(?:<span class="llx-num">(.*?)<\/span>)?(.*?)<\/a><\/li>/g)].map(
    (m) => `${pageText(m[1] ?? "")}|${pageText(m[2]).trim()}`,
  );
}

/** Commands whose arguments are no prose (keys, files, options). */
const NOT_PROSE = /^(?:label|ref|eqref|pageref|autoref|Autoref|cref|Cref|nameref|input|include|includegraphics|includepdf|url|href|usepackage|begin|end|setcounter|lstset|hypersetup)$/;

/** Every run of Han characters in the body's prose: text nodes, `\text` arguments in math, verbatim. */
function hanRuns(plan: ExportPlan): string[] {
  const runs: string[] = [];
  const han = (s: string) => runs.push(...(s.match(/\p{Script=Han}+/gu) ?? []));
  for (const v of plan.visits) {
    const file = plan.files.get(v.key)!;
    const root = v.key === plan.rootKey;
    const doc = root ? file.nodes.find((n) => n.t === "env" && n.name === "document") : null;
    const nodes: readonly TexNode[] = root ? (doc?.t === "env" ? doc.body : []) : file.nodes;
    walkTex(nodes, (n) => {
      if (n.t === "text") han(n.s);
      else if (n.t === "math") for (const m of file.src.slice(n.srcFrom, n.srcTo).matchAll(/\\text\w*\s*\{([^{}]*)\}/g)) han(m[1]);
      else if (n.t === "verb") han(file.src.slice(n.textFrom, n.textTo));
      else if (n.t === "macro" && (NOT_PROSE.test(n.name) || n.code)) return false;
      else if (n.t === "macro" && /cite/i.test(n.name)) {
        for (const a of n.args.slice(0, -1)) if (a.body) walkTex(a.body, (x) => void (x.t === "text" && han(x.s)));
        return false;
      }
    });
  }
  return runs;
}

/** Fidelity assertion 7: every Han run of the sources is in the page (CJK spaces normalized). */
function assertNoMissingChinese(plan: ExportPlan, html: string): number {
  const text = pageText(html).replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1");
  const runs = hanRuns(plan);
  const missing = runs.filter((r) => !text.includes(r));
  assert.deepEqual(missing, [], "Han runs of the sources missing from the HTML");
  return runs.length;
}

test("probe: class names, colours, 第一章 and 1.1, attribution to chapters/ch1.tex", { skip, timeout: 180_000 }, async () => {
  const { root } = fixtureCopy("export-book");
  const host = nodeExportHost(root);
  const build = await host.build(new AbortController().signal);
  assert.ok(existsSync(join(host.buildDir, "main.aux")), build.rawLog.slice(-500));
  const plan = planOf(root);
  await prepareWorkDir(plan, host);
  assert.ok(existsSync(join(host.workDir, "chapters", "ch1.aux")), "\\include's .aux copied with its folder");
  const probe = await runProbe(plan, host);
  assert.ok(probe.llx, probe.output.slice(-800));
  assert.equal((probe.log.match(/^! /gm) ?? []).length, 0, "no TeX errors in the probe");
  assert.match(probe.dvi ?? "", /main\.xdv$/);
  const log = readProbeLog(probe.llx!);
  assert.deepEqual(
    ["definition", "theorem", "proposition", "figure", "table", "contents", "proof"].map((n) => log.names.get(n)),
    ["定义", "定理", "命题", "图", "表", "目录", "证明"],
  );
  const [r, g, b] = ELEGANT_SCHEMES.blue[0];
  assert.equal(log.colors.get("main"), `rgb(${r}, ${g}, ${b})`);
  assert.equal(log.colors.get("structurecolor"), "rgb(60, 113, 183)");
  const toc = log.steps.filter((s) => s.counter === "toc").map((s) => tocEntry(s.value).number);
  assert.deepEqual(toc.slice(0, 2), ["第一章", "1.1"]);
  const ch1 = log.visits.findIndex((v) => v.key === "chapters/ch1.tex");
  assert.ok(ch1 > 0);
  const first = log.steps.find((s) => s.counter === "chapter")!;
  assert.deepEqual([log.visits[first.visit].key, first.line], ["chapters/ch1.tex", 1]);
  // The plan's visits and the probe's agree: every construct finds its step.
  const q = new StepQueue(log, plan.visits);
  const planCh1 = plan.visits.findIndex((v) => v.key === "chapters/ch1.tex");
  assert.equal(q.take("tcb@cnt@theorem", { visit: planCh1, from: 46, to: 51 })?.value, "1.1");
  assert.ok(probe.durationMs < 20_000, `${probe.durationMs} ms`);
});

test("acceptance: the book's headings are the PDF's contents; no Chinese is missing", { skip, timeout: 180_000 }, async () => {
  const { html, report, plan, host, root } = await exported("export-book");
  assert.equal(host.builds, 1, "a stale build folder gets one full build");
  assert.deepEqual(htmlContents(html), pdfContents(host.buildDir, 1));
  // The body's headings carry the same numbers, in order.
  const body = /<\/nav>([\s\S]*)$/.exec(html)![1];
  const numbers = [...body.matchAll(/<h[2-6][^>]*>(?:<a[^>]*><\/a>)*<span class="llx-num">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(numbers.slice(0, 5), ["第一章", "1.1", "1.2", "1.3", "第二章"]);
  assert.ok(assertNoMissingChinese(plan, html) > 150);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /定理 1\.1 \(全期望公式 Law of total expectation\)/);
  assert.match(html, /<span class="llx-label">\(a\)<\/span>/);
  // Text as TeX sets it: ligatures, a line break between CJK characters gone, a user text macro
  // (\term = \textbf{\emph{#1}}) expanded, \verb raw.
  assert.match(html, /Cauchy–Schwarz 不等式/);
  assert.match(html, /重新出现：条件期望/);
  assert.match(html, /<b><em>概率空间<\/em><\/b>/);
  assert.match(html, /<code>\$x\$<\/code>/);
  assert.deepEqual(report.items.filter((i) => i.severity !== "info"), []);
  assert.equal(report.counts.fragments, 2);
  assert.ok(!/<script/i.test(html));
  // The second export finds the build fresh: no build, the probe and emit only.
  assert.deepEqual(await buildFreshness(root, host.buildDir), { fresh: true, reason: "" });
  const again = await exportHtml(root, host, () => undefined, new AbortController().signal);
  assert.equal(host.builds, 1);
  assert.equal(again.html, html);
});

test("acceptance: homework notes (inputenc + ctex, nofont, listings, algorithm, pdfpages, tocdepth 2)", { skip, timeout: 180_000 }, async () => {
  const { html, report, plan, host } = await exported("export-homework");
  assert.deepEqual(htmlContents(html), pdfContents(host.buildDir, 2));
  assert.deepEqual(htmlContents(html).slice(0, 3), ["第 1 章|第一次作业", "1.1|插入排序", "1.1.1|代码"]);
  assertNoMissingChinese(plan, html);
  assert.match(html, /<span class="llx-caption-label">Listing 1\.1<\/span>插入排序 Insertion sort/);
  assert.match(html, /<code>insertion_sort\(xs\)<\/code>/);
  // elegantbook's enumerate label in structurecolor, as enumitem's robust \color left it in the probe's record.
  assert.match(html, /<span class="llx-label"><span style="color:var\(--llx-c-structurecolor\)">1\.<\/span><\/span>/);
  assert.deepEqual(report.items.filter((i) => i.severity === "error" || i.kind === "probe"), []);
});

test("acceptance: the pdfLaTeX article (amsthm, enumitem, natbib, a local package)", { skip, timeout: 180_000 }, async () => {
  const { html, report, host } = await exported("export-article");
  assert.equal(host.engine, "pdflatex");
  assert.deepEqual(htmlContents(html), []);
  // No \tableofcontents: the section numbers and titles the PDF printed are the .aux's.
  const numbers = [...html.matchAll(/<h2[^>]*><span class="llx-num">([^<]*)<\/span>([^<]*)<\/h2>/g)].map((m) => `${m[1]}|${m[2]}`);
  const sections = [...readAuxLabels(host.buildDir).values()].filter((l) => /^(?:section|appendix)\./.test(l.anchor));
  assert.deepEqual(numbers, sections.map((l) => `${l.number}|${l.title}`));
  assert.equal(numbers.length, 4);
  assert.match(html, /<span class="llx-thm-head">Lemma 2\.2\.<\/span>/);
  assert.match(html, /<span class="llx-label">\(ii\)<\/span>/);
  assert.match(html, /<html lang="en">/);
  assert.deepEqual(report.items.filter((i) => i.severity === "error"), []);
});

test("cancel during the probe: the export rejects and no TeX process is left", { skip: skip || (process.platform === "win32" ? "pgrep" : false), timeout: 180_000 }, async () => {
  // Real exports in other test files may probe concurrently. Give this document a distinct
  // job, and inspect only its engine: a global pgrep for llxprobe mistakes their work for an orphan.
  const { dir, root: original } = fixtureCopy("export-book");
  const job = `llx-cancel-${process.pid}-${Date.now()}`;
  const root = join(dir, `${job}.tex`);
  writeFileSync(root, readFileSync(original));
  const host = nodeExportHost(root);
  const probes = () => {
    try {
      return execFileSync("pgrep", ["-f", `[[:space:]]-jobname=${job}([[:space:]]|$)`], { encoding: "utf8" }).trim();
    } catch {
      return ""; // pgrep exits 1 when nothing matches
    }
  };
  const controller = new AbortController();
  let seen = "";
  let settled = false;
  const running = exportHtml(
    root,
    host,
    (p) => {
      if (p.stage !== "probe") return;
      // Cancel once the probe's XeLaTeX shows up (under a loaded test run that can take seconds).
      void (async () => {
        for (let i = 0; i < 400 && !seen && !settled; i++) {
          await new Promise((r) => setTimeout(r, 25));
          seen = probes();
        }
        controller.abort();
      })();
    },
    controller.signal,
  ).finally(() => (settled = true));
  await assert.rejects(running, (e) => isAbortError(e));
  assert.ok(seen, "the probe's XeLaTeX was running when the export was cancelled");
  for (let i = 0; i < 40 && probes(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(probes(), "", "no process of the probe is left");
});
