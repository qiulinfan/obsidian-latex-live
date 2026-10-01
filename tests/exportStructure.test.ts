import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { emitExport, prepareExport } from "../src/export/exporter";
import { StepQueue } from "../src/export/probeLog";
import { fixtureCopy, nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

// A real-TeX acceptance test for the structural S8 slice. The synthetic file graph has nested
// imports, contextual fallback, a document-style subfile, and space/Unicode filenames.
after(removeExportTemps);

test("structural export: probe visits and native HTML match imported/subfile flow through real TeX", { skip: !texBin && "no TeX installation found", timeout: 90_000 }, async () => {
  const { dir } = fixtureCopy("export-structure");
  const root = join(dir, "main file.tex");
  const host = nodeExportHost(root, { engine: "xelatex" });
  const signal = new AbortController().signal;
  const { prepared, math } = await prepareExport(root, host, () => undefined, signal);
  const { plan, log } = prepared;
  assert.ok(log, "the real probe produced its records");
  const rawLog = readFileSync(join(host.workDir, `${plan.job}.log`), "utf8");
  const errorAt = rawLog.search(/(?:^! |\.tex:\d+:)/m);
  assert.equal(errorAt, -1, rawLog.slice(errorAt, errorAt + 1_000));
  assert.deepEqual(log.visits.slice(1).filter((v) => plan.files.has(v.key)).map((v) => v.key), plan.visits.slice(1).map((v) => v.key), "body-source visits retain order among package/asset reads");
  const queue = new StepQueue(log, plan.visits);
  for (let i = 0; i < plan.visits.length; i++) assert.ok(queue.knows(i), `${plan.visits[i].key}#${plan.visits[i].occ}: probe visit matched`);
  const { html, report } = await emitExport(prepared, math, host, () => undefined, signal);
  const document = new JSDOM(html).window.document;
  const text = document.body.textContent!.replace(/\s+/g, " ");
  for (const prose of ["Local imported detail.", "Nested detail wins", "Parent import fallback.", "Subfile-relative child.", "The default optional heading remains", "Native body with"]) assert.ok(text.includes(prose), prose);
  assert.equal((text.match(/Root fallback\./g) ?? []).length, 2, "a twice-read input remains two occurrences");
  assert.ok([...document.querySelectorAll("b")].some((n) => n.textContent === "Default heading: Imported."));
  assert.ok([...document.querySelectorAll("b")].some((n) => n.textContent === "Nested: Result."));
  assert.equal(document.querySelectorAll("mjx-container").length, 1, "the nested environment's formula is native MathJax");
  assert.equal(document.querySelectorAll("svg").length, 0, "the text environments need no TeX fragments");
  assert.equal(document.querySelectorAll("img").length, 2, "import/subfile-relative images are embedded");
  assert.ok([...document.querySelectorAll("img")].every((img) => img.src.startsWith("data:image/png;base64,")));
  assert.equal(document.querySelector("pre")?.textContent?.trim(), 'print("Imported & <code>")', "the imported listing is loaded before emit");
  assert.ok(prepared.defs.macros.has("nestedmacro"), "the nested-import definition reaches MathJax");
  assert.equal(document.querySelectorAll("mjx-msup").length, 1, "the nested-import macro's superscript is rendered");
  assert.deepEqual(report.items.filter((i) => i.severity !== "info"), [], "no missing-file, numbering or unknown-macro warning");
  assert.doesNotMatch(text, /never read|documentclass|子目录\//, "subfile plumbing is absent from the output");
});

test("absolute project-local inputs/imports use the instrumented source and distinguish identical basenames", { skip: !texBin && "no TeX installation found", timeout: 90_000 }, async () => {
  const { dir } = fixtureCopy("export-structure");
  const root = join(dir, "main file.tex");
  let text = readFileSync(root, "utf8").replace("\\usepackage{graphicx}", "\\usepackage{graphicx,tikz}");
  text = text.replace("\\import{parts one/}{chapter one}", `\\import{${join(dir, "parts one")}/}{chapter one}`);
  text = text.replace("\\input{root only}", `\\input{${dir}/./root only.tex}`);
  text = text.replace("\\end{document}", `\\import{${dir}/parts one/../absolute A/}{detail}\n\\import{${dir}/./absolute B/}{detail}\n\\end{document}`);
  writeFileSync(root, text);
  for (const [name, colour] of [["absolute A", "blue"], ["absolute B", "red"]]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "detail.tex"), `\\section{${name}}\n\\begin{tikzpicture}\n\\draw[${colour}] (0,0) circle (3pt);\n\\end{tikzpicture}\n`);
  }
  const host = nodeExportHost(root, { engine: "xelatex" });
  const signal = new AbortController().signal;
  const { prepared, math } = await prepareExport(root, host, () => undefined, signal);
  assert.ok(prepared.log);
  assert.equal(prepared.plan.sourceAliases.get(`${dir}/parts one/../absolute A/detail.tex`), "absolute A/detail.tex");
  assert.equal(prepared.plan.sourceAliases.get(`${dir}/./absolute B/detail.tex`), "absolute B/detail.tex");
  const queue = new StepQueue(prepared.log, prepared.plan.visits);
  for (let i = 0; i < prepared.plan.visits.length; i++) assert.ok(queue.knows(i), `${prepared.plan.visits[i].key}: absolute probe visit matched; actual keys ${JSON.stringify(prepared.log.visits.map((v) => v.key))}`);
  assert.equal(prepared.plan.fragments.length, 2);
  assert.equal(prepared.fragments.size, 2, "both absolute source files were instrumented and drawn");
  for (const [key, copy] of prepared.plan.copies) {
    assert.equal(copy.replace(/\\(?:begin|end)\{llx(?:frag|block)\}(?:\{\d+\})?/g, ""), prepared.plan.files.get(key)!.src, `${key}: source bytes outside instrumentation remain exact`);
  }
  const { html, report } = await emitExport(prepared, math, host, () => undefined, signal);
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll("svg.llx-frag").length, 2);
  assert.ok(document.body.textContent?.includes("absolute A") && document.body.textContent?.includes("absolute B"));
  assert.deepEqual(report.items.filter((i) => i.severity !== "info"), []);
});
