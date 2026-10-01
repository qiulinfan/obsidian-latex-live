// S8 class fidelity, from elegantnote 2.60, elegantpaper 0.12 and ctex 2.5.10:
// fresh synthetic copies -> real full TeX build -> probe -> complete HTML export.
// Numbers are compared with the resulting .aux, names and raw class colours with the probe;
// English title/theorem/caption text is also compared with the PDF's text when gs is present.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { exportHtml } from "../src/export/exporter";
import { readProbeLog } from "../src/export/probeLog";
import { contrast, DARK_BG, parseColor } from "../src/export/profiles";
import { readAuxLabels } from "../src/tex/aux";
import { texTool } from "../src/tex/binaries";
import { texText } from "../src/tex/texText";
import { nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

const skip = !texBin ? "no TeX installation" : !existsSync(texTool(texBin, "xelatex")) ? "no XeLaTeX" : false;
const gs = spawnSync("gs", ["--version"]).status === 0;
const dirs: string[] = [];
after(() => { removeExportTemps(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const cases = [
  { fixture: "note-cn", profile: "elegantnote", lang: "zh-CN", theorem: "定理", example: "例", remark: "评论", note: "注", proof: "证明", caption: "图", version: "版本：", date: "更新：", color: [0, 120, 2] },
  { fixture: "note-en", profile: "elegantnote", lang: "en", theorem: "Theorem", proof: "Proof", caption: "Figure", version: "Version:", date: "Update:", color: [1, 126, 218] },
  { fixture: "paper-cn", profile: "elegantpaper", lang: "zh-CN", theorem: "定理", remark: "评论", note: "注", proof: "证明", caption: "图", version: "版本：", date: "日期：", color: [128, 0, 0] },
  { fixture: "paper-en", profile: "elegantpaper", lang: "en", theorem: "Theorem", proof: "Proof", caption: "Figure", version: "Version:", date: "Date:", color: [128, 0, 0] },
  { fixture: "ctex-book", profile: "ctex", lang: "zh-CN", theorem: "定理", proof: "证明", caption: "图" },
  { fixture: "ctex-plain", profile: "ctex", lang: "zh-CN", theorem: "Theorem", proof: "Proof", caption: "Figure" },
] as const;

function visible(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "").replace(/&(?:nbsp|#160);/g, " ").replace(/&amp;/g, "&");
}
const compact = (s: string) => s.replace(/[\s ]/g, "");

for (const c of cases) test(`class fidelity: ${c.fixture}, its actual names, numbers, styles and title`, { skip, timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-export-class-"));
  dirs.push(dir);
  cpSync(join(process.cwd(), "tests", "fixtures", "export-classes", c.fixture), dir, { recursive: true });
  const root = join(dir, "main.tex");
  const host = nodeExportHost(root);
  const { html, report } = await exportHtml(root, host, () => undefined, new AbortController().signal);
  assert.equal(report.profile, c.profile);
  assert.equal(host.builds, 1);
  assert.deepEqual(report.items.filter((i) => i.severity !== "info"), [], JSON.stringify(report.items));
  assert.match(html, new RegExp(`<html lang="${c.lang}">`));
  const text = visible(html);
  const log = readProbeLog(readFileSync(join(host.workDir, "main.llx"), "utf8"));
  const labels = readAuxLabels(host.buildDir);
  const theorem = labels.get("thm:one")!;
  assert.ok(theorem);
  const theoremHead = new RegExp(`${c.theorem} ${texText(theorem.number).replace(/\./g, "\\.")}.*?Finite|${c.theorem} ${texText(theorem.number).replace(/\./g, "\\.")}.*?有限性`);
  assert.match(text, theoremHead);
  assert.match(html, new RegExp(`<a class="llx-ref" href="#thm:one">${texText(theorem.number).replace(/\./g, "\\.")}</a>`));
  for (const key of ["thm:one", "lem:one", "def:one", "ex:one"]) {
    const aux = labels.get(key);
    if (!aux) continue;
    const head = new RegExp(`id="${key}">[\\s\\S]*?<span class="llx-thm-head">([^<]*)`).exec(html)?.[1];
    assert.ok(head?.includes(texText(aux.number)), `${key}: ${head} vs ${aux.number}`);
  }
  const figure = labels.get("fig:one")!;
  assert.match(text, new RegExp(`${c.caption} ${texText(figure.number).replace(/\./g, "\\.")}`));
  assert.match(text, new RegExp(`${c.proof}\\.`));
  assert.equal(log.names.get("figure"), c.caption);
  assert.equal(log.names.get("proof"), c.proof);
  assert.match(html, /<div class="llx-proof/);
  assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/g, ""), /llx-source|llx-missing|is-missing/);

  if ("version" in c) {
    const header = /<header class="llx-title">([\s\S]*?)<\/header>/.exec(html)![1];
    assert.ok(compact(visible(header)).includes(compact(c.version)), header);
    assert.ok(compact(visible(header)).includes(compact(c.date)), header);
    assert.match(header, /Synthetic Institute|合成学院/);
    assert.doesNotMatch(header, /<dl|作者：|Author:/);
  }
  if ("remark" in c) assert.match(text, new RegExp(c.remark));
  if ("note" in c) assert.match(text, new RegExp(c.note));
  if ("example" in c) assert.match(text, new RegExp(`${c.example} ${texText(labels.get("ex:one")!.number).replace(/\./g, "\\.")}`));
  if (c.profile === "elegantnote") {
    assert.doesNotMatch(html, /llx-thm-head">(?:定理|Theorem) [^<]*\.<\/span>/);
    assert.match(html, /is-ecolor/);
    assert.equal(html.includes("llx-box-title"), false, "note has run-in theorems, not book boxes");
    assert.deepEqual(parseColor(log.colors.get("ecolor")!), c.color);
    assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/g, ""), /llx-qed/);
    const dark = html.slice(html.lastIndexOf("@media (prefers-color-scheme: dark)"), html.indexOf("</style>"));
    const color = /--llx-c-ecolor: (rgb\([^)]*\))/.exec(dark)![1];
    assert.ok(contrast(parseColor(color)!, DARK_BG) >= 4.5);
  } else if (c.profile === "elegantpaper") {
    assert.deepEqual(parseColor(log.colors.get("winered")!), c.color);
    assert.match(html, /--llx-link: var\(--llx-c-winered\)/);
    assert.match(html, /<div class="llx-proof"><p class="llx-cont"><span class="llx-thm-head">/);
    assert.match(html, /<span class="llx-qed">□<\/span>/);
  }
  if (c.fixture === "ctex-book") {
    assert.match(text, /第一章基础/);
    assert.match(text, /附录 A记号/);
    assert.match(html, /display: inline; font-size: inherit;/);
  }
  if (c.fixture === "ctex-plain") {
    assert.match(text, /Contents/);
    assert.match(text, /Abstract/);
    assert.doesNotMatch(text, /目录|摘要|证明/);
  }
  if (gs && c.lang === "en") {
    const pdf = execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=txtwrite", "-sOutputFile=-", join(host.buildDir, "main.pdf")], { encoding: "utf8" });
    for (const text of [`${c.theorem} ${texText(theorem.number)}`, `${c.caption} ${texText(figure.number)}`, c.proof]) assert.ok(compact(pdf).includes(compact(text)), text);
  }
});
