// Dates come from the TeX run, including each class's actual default, not the host clock.
// These fresh generated documents are built and exported with real TeX; ASCII dates are
// compared with the resulting PDF text. \today also renders in the body without a title.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { exportHtml } from "../src/export/exporter";
import { readProbeLog } from "../src/export/probeLog";
import { texTool } from "../src/tex/binaries";
import { texText } from "../src/tex/texText";
import { nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

const skip = !texBin ? "no TeX installation" : !existsSync(texTool(texBin, "xelatex")) ? "no XeLaTeX" : false;
const gs = spawnSync("gs", ["--version"]).status === 0;
const dirs: string[] = [];
after(() => { removeExportTemps(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const cases = [
  { cls: "[lang=en,device=normal]elegantnote", date: String.raw`\date{\today}`, shown: true },
  { cls: "[lang=en,device=normal]elegantnote", date: "", shown: true },
  { cls: "elegantpaper", date: "", shown: true },
  { cls: "elegantbook", date: "", shown: false },
  { cls: "article", date: "", shown: true },
  { cls: "[lang=en,device=normal]elegantnote", date: String.raw`\date{\today}`, today: "Synthetic Day", shown: true },
  { cls: "[lang=en,device=normal]elegantnote", date: String.raw`\date{}`, today: "Synthetic Day", shown: false },
  { cls: "[fontset=fandol]ctexart", date: String.raw`\date{\today}`, shown: true },
] as const;

const text = (html: string) => html.replace(/<[^>]+>/g, "");
const squeeze = (s: string) => s.replace(/[\s ]/g, "");

for (const [i, c] of cases.entries()) test(`class date ${i + 1}: ${c.cls}, ${c.date || "omitted"}${"today" in c ? ", custom today" : ""}`, { skip, timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-export-date-"));
  dirs.push(dir);
  const root = join(dir, "main.tex");
  const [, options = "", cls] = /^(\[[^\]]*\])?(.*)$/.exec(c.cls)!;
  writeFileSync(root, `\\documentclass${options}{${cls}}\n${"today" in c ? `\\renewcommand{\\today}{${c.today}}\n` : ""}\\title{Synthetic Date}\\author{Author A}\n${c.date}\n\\begin{document}\n\\maketitle\nBody date: \\today.\n\\end{document}\n`);
  const host = nodeExportHost(root);
  const { html, report } = await exportHtml(root, host, () => undefined, new AbortController().signal);
  assert.deepEqual(report.items.filter((x) => x.severity !== "info"), [], JSON.stringify(report.items));
  const log = readProbeLog(readFileSync(join(host.workDir, "main.llx"), "utf8"));
  assert.ok(log.info.has("title-date"), "captured before maketitle clears the class's date");
  const today = texText(log.info.get("today")!);
  const date = texText(log.info.get("title-date")!);
  assert.ok(today, log.info.get("today"));
  const header = /<header class="llx-title">([\s\S]*?)<\/header>/.exec(html)![1];
  if (c.shown) {
    assert.equal(date, today);
    assert.ok(squeeze(text(header)).includes(squeeze(date)), header);
  } else {
    assert.equal(date, "");
    assert.ok(!squeeze(text(header)).includes(squeeze(today)), header);
  }
  assert.ok(squeeze(text(html.split("</header>")[1])).includes(squeeze(`Body date: ${today}.`)));
  if ("today" in c) assert.equal(today, c.today);
  if (gs && cls !== "ctexart") {
    const pdf = execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=txtwrite", "-sOutputFile=-", join(host.buildDir, "main.pdf")], { encoding: "utf8" });
    assert.ok(squeeze(pdf).includes(squeeze(`Body date: ${today}.`)), pdf);
    if (c.shown) assert.ok(squeeze(pdf).split(squeeze(today)).length >= 3, "PDF date appears in both title and body");
  }
});

test("body today without maketitle is captured with a source-defined value", { skip, timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-export-date-"));
  dirs.push(dir);
  const root = join(dir, "main.tex");
  writeFileSync(root, String.raw`\documentclass{article}\renewcommand{\today}{Synthetic Day}\begin{document}Body \today.\end{document}`);
  const host = nodeExportHost(root);
  const { html, report } = await exportHtml(root, host, () => undefined, new AbortController().signal);
  assert.match(html, /Body Synthetic Day\./);
  assert.deepEqual(report.items, []);
});
