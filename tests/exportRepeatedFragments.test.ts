import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { emitExport, prepareExport } from "../src/export/exporter";
import { drawingKey, pageDrawing } from "../src/export/fragments";
import { readProbeLog, StepQueue } from "../src/export/probeLog";
import { fixtureCopy, nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

after(removeExportTemps);

test("drawing markers identify a visit explicitly, regardless of physical page order", () => {
  const page = (visit: number) => `<svg><g class='llx-ref' data-id='0' data-visit='${visit}'/></svg>`;
  assert.deepEqual([page(7), page(2)].map(pageDrawing), [{ id: 0, visit: 7 }, { id: 0, visit: 2 }]);
  assert.equal(pageDrawing("<svg><g class='llx-ref' data-id='0'/></svg>"), null, "a missing visit is not a first drawing");
});

test("dropping a repeated fragment is bounded to its opening visit, including nested input steps", () => {
  const log = readProbeLog([
    "llxin{}{piece.tex}{4}", "llxopen{0}", "llxblock{0}{1}",
    "llxstep{equation}{1}{}{piece.tex}{2}",
    "llxin{}{child.tex}{3}", "llxstep{footnote}{1}{}{child.tex}{1}", "llxout{}{child.tex}",
    "llxclose{0}", "llxout{}{piece.tex}",
    "llxin{}{piece.tex}{5}", "llxopen{0}", "llxblock{0}{3}",
    "llxstep{equation}{2}{}{piece.tex}{2}", "llxclose{0}", "llxout{}{piece.tex}",
  ].join("\n"));
  const queue = new StepQueue(log, [{ key: "main.tex", occ: 0 }, { key: "piece.tex", occ: 0 }, { key: "child.tex", occ: 0 }, { key: "piece.tex", occ: 1 }]);
  assert.deepEqual(log.fragments.map((f) => [f.id, f.visit]), [[0, 1], [0, 3]]);
  assert.equal(queue.fragmentKey(0, 1), drawingKey(1, 0));
  assert.equal(queue.fragmentKey(0, 3), drawingKey(3, 0));
  assert.deepEqual(queue.drop(0, 1).map((s) => `${s.counter} ${s.value}`), ["equation 1", "footnote 1"]);
  assert.deepEqual(queue.drop(0, 3).map((s) => `${s.counter} ${s.value}`), ["equation 2"]);
});

test("two inputs of one TikZ source render their own section numbers and isolated font subsets", { skip: !texBin && "no TeX installation found", timeout: 60_000 }, async () => {
  const { dir, root } = fixtureCopy("export-article");
  writeFileSync(root, String.raw`\documentclass{article}
\usepackage{tikz}
\begin{document}
\input{piece}
\input{piece}
\end{document}`);
  writeFileSync(join(dir, "piece.tex"), String.raw`\section{Repeated}
\begin{tikzpicture}
\node{\thesection};
\end{tikzpicture}
\begin{equation}
\begin{tikzpicture}\node{\theequation};\end{tikzpicture}
\end{equation}`);
  const host = nodeExportHost(root);
  const signal = new AbortController().signal;
  const { prepared, math } = await prepareExport(root, host, () => undefined, signal);
  assert.ok(prepared.log);
  assert.equal(prepared.plan.fragments.length, 2, "two static source constructs");
  assert.equal(prepared.fragments.size, 4, "each construct has two explicitly identified runtime drawings");
  const queue = new StepQueue(prepared.log, prepared.plan.visits);
  const visits = prepared.plan.visits.map((v, i) => v.key === "piece.tex" ? i : -1).filter((i) => i >= 0);
  assert.equal(visits.length, 2);
  assert.notEqual(queue.fragmentKey(0, visits[0]), queue.fragmentKey(0, visits[1]));
  for (const v of visits) assert.ok(prepared.fragments.has(queue.fragmentKey(0, v)!));
  const { html, report } = await emitExport(prepared, math, host, () => undefined, signal);
  const document = new JSDOM(html).window.document;
  const svgs = [...document.querySelectorAll("svg.llx-frag")];
  const inline = svgs.filter((s) => !s.parentElement?.classList.contains("llx-frag-block"));
  assert.deepEqual(inline.map((s) => [...s.querySelectorAll("text")].map((t) => t.textContent).join("")), ["1", "2"]);
  const displays = svgs.filter((s) => s.parentElement?.classList.contains("llx-frag-block"));
  assert.equal(displays.length, 2);
  assert.ok(displays[0].textContent!.replace(/\s+/g, "").endsWith("1(1)"));
  assert.ok(displays[1].textContent!.replace(/\s+/g, "").endsWith("2(2)"));
  assert.deepEqual(report.numbers.filter((n) => n.counter === "equation").map((n) => [n.value, n.shown]), [["1", true], ["2", true]]);
  const families = svgs.map((s) => [...s.textContent!.matchAll(/@font-face\{font-family:([^;]+);/g)].map((m) => m[1]));
  assert.ok(families.every((f) => f.length > 0));
  assert.equal(new Set(families.flat()).size, families.flat().length, "the font subsets of every drawing stay isolated");
  const ids = svgs.flatMap((s) => [...s.querySelectorAll("[id]")].map((n) => n.id));
  assert.equal(new Set(ids).size, ids.length, "all drawing element IDs are unique");
  assert.deepEqual(report.items.filter((i) => i.severity !== "info"), []);
});
