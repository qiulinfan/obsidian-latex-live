import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import type { CodeToken, CodeTokenizer } from "../src/export/listings";
import { emitExport, type PreparedExport } from "../src/export/exporter";
import type { ExportMath } from "../src/export/math";
import { readProbeLog } from "../src/export/probeLog";
import { ReportBuilder } from "../src/export/report";
import { emitDoc, removeExportTemps } from "./support/exportHost";

after(removeExportTemps);

test("cancel does not wait for the host's pending syntax module load", { timeout: 2000 }, async () => {
  // Only the loading boundary is reached; no renderer, sources or output writer may run.
  const prepared = {
    plan: { visits: [], files: new Map() },
    log: readProbeLog("llxlisting{Python}{}{}{}{}{}{main.tex}{1}"),
    report: new ReportBuilder(),
  } as unknown as PreparedExport;
  let started!: () => void;
  const loading = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const host = { idle: async () => undefined, code: async () => {
    calls++;
    started();
    return new Promise<CodeTokenizer>(() => {});
  } };
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(emitExport(prepared, {} as ExportMath, host, () => assert.fail("cancelled progress"), cancelled.signal), { name: "AbortError" });
  assert.equal(calls, 0);
  const controller = new AbortController();
  const writing = emitExport(prepared, {} as ExportMath, host, () => undefined, controller.signal);
  await loading;
  controller.abort();
  await assert.rejects(writing, { name: "AbortError" });
  assert.equal(calls, 1);
});

test("listing settings reach inline, block and selected external code without changing text or captions", async () => {
  const calls: string[] = [];
  const tokens = new Map<string, CodeToken[]>([
    ["if (<x>)", [{ type: "keyword", content: "if" }, " (<x>)"]],
    ["def f():\n    # 中文注释\n    return '<&>'", [{ type: "keyword", content: "def" }, " f():\n    ", { type: "comment", content: "# 中文注释" }, "\n    ", { type: "keyword", content: "return" }, " ", { type: "string", content: "'<&>'" }]],
    ["return '<literal>'", [{ type: "keyword", content: "return" }, " ", { type: "string", content: "'<literal>'" }]],
  ]);
  const code: CodeTokenizer = (text, language) => {
    calls.push(language);
    return tokens.get(text) ?? null;
  };
  const out = await emitDoc({
    preamble: String.raw`\usepackage{listings,xcolor}`,
    body: String.raw`Inline: \lstinline[language=C]|if (<x>)|.
\begin{lstlisting}[language=Python,caption={Sample},label={code:sample}]
def f():
    # 中文注释
    return '<&>'
\end{lstlisting}
\lstinputlisting[firstline=2,lastline=2]{snippet.py}`,
    files: { "snippet.py": "ignored\nreturn '<literal>'\nignored\n" },
    llx: [
      "llxinfo{fontsize}{10}",
      "llxname{lstlisting}{Listing}",
      String.raw`llxlisting{C}{}{\color {red}\bfseries }{\color {gray}}{\itshape }{}{main.tex}{4}`,
      "llxstep{lstlisting}{1}{}{main.tex}{5}",
      String.raw`llxlisting{Python}{}{\color {red}\bfseries }{\color {gray}}{\itshape }{}{main.tex}{5}`,
      String.raw`llxlisting{Python}{}{\color {blue}}{}{}{}{main.tex}{10}`,
    ].join("\n"),
    code,
  });
  const doc = new JSDOM(out.body).window.document;
  assert.deepEqual(calls, ["C", "Python", "Python"]);
  assert.deepEqual([...doc.querySelectorAll("code")].map((n) => n.textContent), [...tokens.keys()]);
  assert.match(doc.querySelector("figcaption")!.textContent!, /Listing 1\s*Sample/);
  assert.equal(doc.querySelector("#code\\:sample") !== null, true);
  assert.equal(doc.querySelectorAll("script, x, literal").length, 0);
  assert.equal(doc.querySelectorAll("code .llx-code-keyword").length, 4);
  assert.equal(doc.querySelectorAll('span[style="color:var(--llx-c-red)"]').length, 3);
  assert.equal(doc.querySelectorAll('span[style="color:var(--llx-c-gray)"]').length, 1);
  assert.equal(out.counts.highlightedListings, 3);
  assert.deepEqual(out.report.items, []);
  assert.deepEqual(out.numbers.filter((n) => n.counter === "lstlisting"), [{ counter: "lstlisting", value: "1", shown: true, label: "code:sample" }]);
});
