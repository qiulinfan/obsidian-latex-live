// Native tag-side state beats source hints, including a class wrapper whose internal switch
// the source-side detector cannot infer. PDF glyph coordinates prove the position, not just a flag.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { emitExport, prepareExport } from "../src/export/exporter";
import { tagSide } from "../src/export/math";
import { planExport } from "../src/export/plan";
import { prepareWorkDir, runProbe } from "../src/export/probe";
import { readProbeLog } from "../src/export/probeLog";
import { projectDefinitions } from "../src/tex/macros";
import { parseLog } from "../src/tex/logParser";
import { stripComments } from "../src/tex/project";
import { theoremMap } from "../src/tex/theorems";
import { texTool } from "../src/tex/binaries";
import { nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

const skip = !texBin ? "no TeX installation" : false;
const gs = spawnSync("gs", ["--version"]).status === 0;
const dirs: string[] = [];
after(() => { removeExportTemps(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

test("planning hint: AMS defaults left, explicit reqno wins, ordinary article defaults right", () => {
  assert.equal(tagSide([String.raw`\documentclass{amsart}`]), "left");
  assert.equal(tagSide([String.raw`\documentclass[reqno]{amsart}`]), "right");
  assert.equal(tagSide([String.raw`\documentclass{article}`]), "right");
  assert.equal(tagSide([String.raw`\documentclass[leqno]{amsart}\usepackage[reqno]{amsmath}`]), "right");
});

for (const c of [
  { cls: "amsart", want: "left" }, { cls: "[reqno]amsart", want: "right" },
  { cls: "article", want: "right" }, { cls: "[leqno]article", want: "left" },
  { cls: "auditwrapper", want: "left" },
] as const) test(`native PDF and HTML tag position: ${c.cls}`, { skip, timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-tag-side-"));
  dirs.push(dir);
  const root = join(dir, "main.tex");
  const [, opts = "", cls] = /^(\[[^\]]*\])?(.*)$/.exec(c.cls)!;
  const source = `\\documentclass${opts}{${cls}}\n\\begin{document}\n\\begin{equation}\\label{eq:one}E=9+8.\\end{equation}\n\\end{document}\n`;
  writeFileSync(root, source);
  if (cls === "auditwrapper") writeFileSync(join(dir, "auditwrapper.cls"), String.raw`\ProvidesClass{auditwrapper}[2026/09/30 Original native-state test wrapper]\LoadClass{amsart}`);
  const host = nodeExportHost(root);
  let hostCalls = 0;
  const environment = host.math;
  host.math = async () => { hostCalls++; return environment(); };
  const signal = new AbortController().signal;
  const { prepared, math } = await prepareExport(root, host, () => undefined, signal);
  assert.equal(prepared.log!.info.get("equation-tag-side"), c.want);
  assert.equal(prepared.tagSide, c.want);
  assert.equal(hostCalls, 1, "native side correction keeps the same DOM and font host");
  if (cls === "auditwrapper") assert.equal(tagSide([source]), "right", "the native record must correct this source-side guess");
  const { html, report } = await emitExport(prepared, math, host, () => undefined, signal);
  assert.match(html, new RegExp(`<mjx-mtable[^>]* side="${c.want}"`));
  assert.deepEqual(report.items, []);
  if (gs) {
    const xml = execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=txtwrite", "-dTextFormat=0", "-sOutputFile=-", join(host.buildDir, "main.pdf")], { encoding: "utf8" });
    const chars = [...xml.matchAll(/<char bbox="([^\"]*)" c="([^\"]*)"/g)].map((m) => ({ box: m[1].split(" ").map(Number), c: m[2] }));
    const equation = chars.find((g) => g.c === "E")!;
    assert.ok(equation, xml);
    const label = chars.find((g) => g.c === "(" && Math.abs(g.box[1] - equation.box[1]) < 2)!;
    assert.ok(label, xml);
    assert.equal(label.box[0] < equation.box[0] ? "left" : "right", c.want, "actual PDF glyph coordinates");
  }
});

const acmSkip = skip || spawnSync(texTool(texBin!, "kpsewhich"), ["acmart.cls"]).status !== 0 ? skip || "no ACM class" : false;
for (const anonymous of [true, false]) test(`ACM native anonymity flag: ${anonymous}`, { skip: acmSkip, timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-acm-anonymous-"));
  dirs.push(dir);
  const root = join(dir, "main.tex");
  writeFileSync(root, `\\documentclass[sigconf${anonymous ? ",anonymous" : ""}]{acmart}\n\\setcopyright{none}\n\\title{Synthetic anonymity probe}\\author{Private Synthetic Author}\\affiliation{\\institution{Private Synthetic Institute}\\country{United States}}\\email{synthetic@example.invalid}\n\\begin{document}\\begin{abstract}Original audit text.\\end{abstract}\\maketitle\\begin{equation}E=9+8.\\end{equation}\\end{document}\n`);
  const host = nodeExportHost(root);
  const signal = new AbortController().signal;
  const built = await host.build(signal);
  assert.equal(built.pdfWritten, true);
  assert.deepEqual(built.log.diagnostics.filter((d) => d.severity === "error"), []);
  const defs = projectDefinitions(root);
  const sources = defs.files.map((f) => stripComments(readFileSync(f, "utf8")));
  const plan = planExport(root, { defs, theorems: theoremMap(sources) });
  await prepareWorkDir(plan, host, signal);
  const probe = await runProbe(plan, host, signal);
  assert.deepEqual(parseLog(probe.log, host.workDir).diagnostics.filter((d) => d.severity === "error"), []);
  const log = readProbeLog(probe.llx!);
  assert.equal(log.info.get("title-anonymous"), String(anonymous));
  assert.equal(log.info.get("equation-tag-side"), "right");
});
