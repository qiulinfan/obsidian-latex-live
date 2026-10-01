// Actual acmart 2.16, both anonymous and explicitly public: the source keeps identifying
// metadata, but the native flag and native comment environments govern what the export reveals.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { exportHtml } from "../src/export/exporter";
import { readProbeLog } from "../src/export/probeLog";
import { texTool } from "../src/tex/binaries";
import { nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

const skip = !texBin ? "no TeX installation" : spawnSync(texTool(texBin, "kpsewhich"), ["acmart.cls"]).status !== 0 ? "no ACM class" : false;
const gs = spawnSync("gs", ["--version"]).status === 0;
const dirs: string[] = [];
after(() => { removeExportTemps(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const markers = ["PRIVATE_AUTHOR", "PRIVATE_INSTITUTE", "PRIVATE_EMAIL", "PRIVATE_ORCID", "PRIVATE_NOTE", "PRIVATE_ACK", "PRIVATE_SUP"];
// OT1's underscore may be a rule rather than a text glyph; comparison still detects the
// identifying words on the rendered PDF, independently of their font's underscore mapping.
const normalized = (s: string) => s.replace(/[\s_]/g, "");

for (const anonymous of [true, false]) test(`real ACM export: anonymous=${anonymous}, identifiers and excluded environments`, { skip, timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-anonymous-paper-"));
  dirs.push(dir);
  const root = join(dir, "main.tex");
  const src = String.raw`\documentclass[sigconf,anonymous=ANON]{acmart}
\setcopyright{none}
\settopmatter{printacmref=false}
\title{Public anonymous compatibility audit}
\author{PRIVATE\_AUTHOR}
\authornote{PRIVATE\_NOTE}
\affiliation{\institution{PRIVATE\_INSTITUTE}\city{Synthetic Town}\country{United States}}
\email{PRIVATE_EMAIL@example.invalid}
\orcid{PRIVATE_ORCID}
\begin{document}
\begin{abstract}
PUBLIC\_ABSTRACT: an original synthetic abstract.
\end{abstract}
\keywords{PUBLIC\_KEYWORD}
\maketitle
\section{Public results}\label{sec:public}
PUBLIC\_BODY: an original synthetic result.
\begin{equation}\label{eq:public}E=9+8.\end{equation}
\begin{acks}
PRIVATE\_ACK: an original synthetic acknowledgment.
\end{acks}
\begin{anonsuppress}
PRIVATE\_SUP: an original synthetic supplementary statement.
\end{anonsuppress}
\end{document}
`.replace("anonymous=ANON", `anonymous=${anonymous}`);
  writeFileSync(root, src);
  const host = nodeExportHost(root);
  const { html, report } = await exportHtml(root, host, () => undefined, new AbortController().signal);
  const log = readProbeLog(readFileSync(join(host.workDir, "main.llx"), "utf8"));
  assert.equal(log.info.get("title-anonymous"), String(anonymous));
  assert.equal(host.builds, 1);
  const doc = new JSDOM(html).window.document;
  const body = doc.body.textContent!;
  for (const publicMarker of ["PUBLIC_ABSTRACT", "PUBLIC_KEYWORD", "PUBLIC_BODY"]) assert.ok(normalized(body).includes(normalized(publicMarker)), publicMarker);
  assert.equal(doc.querySelector("h1")!.textContent, "Public anonymous compatibility audit");
  assert.match(html, /<mjx-mtable[^>]* side="right"/);
  assert.equal(/class="llx-source/.test(html), false, "excluded comment end lines must survive probe instrumentation");
  if (anonymous) {
    for (const marker of markers) assert.ok(!normalized(html).includes(normalized(marker)), `anonymous HTML leaks ${marker}`);
    assert.equal(doc.querySelectorAll(".llx-paper-author").length, 0);
    assert.equal(doc.querySelectorAll(".llx-paper-affiliation").length, 0);
    assert.equal(log.steps.some((s) => s.counter === "toc" && /Acknowledg/.test(s.value)), false);
  } else {
    for (const marker of markers) assert.ok(normalized(html).includes(normalized(marker)), `public HTML loses ${marker}`);
    assert.equal(doc.querySelectorAll(".llx-paper-author").length, 1);
    assert.equal(doc.querySelector('a[href="mailto:PRIVATE_EMAIL@example.invalid"]') !== null, true);
    assert.ok(log.steps.some((s) => s.counter === "toc" && /Acknowledg/.test(s.value)));
    assert.ok([...doc.querySelectorAll("h2,h3,h4")].some((h) => h.textContent === "Acknowledgments"), "public acknowledgments have their native named heading");
  }
  if (gs) {
    const pdf = join(host.buildDir, "main.pdf");
    const visiblePdf = normalized(execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=txtwrite", "-sOutputFile=-", pdf], { encoding: "utf8" }));
    for (const marker of ["PUBLIC_ABSTRACT", "PUBLIC_KEYWORD", "PUBLIC_BODY"]) assert.ok(visiblePdf.includes(normalized(marker)), marker);
    // ACM prints ORCID as the author's hyperlink, not visible ID text. Check its native PDF
    // link object separately rather than pretending Ghostscript extracts an invisible glyph.
    // pdfTeX compresses annotations inside object streams. Ask the established PDF engine
    // to expose the original link objects rather than searching compressed bytes for text.
    const expandedPdf = join(dir, "annotations.pdf");
    execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.4", "-dCompressPages=false", "-dCompressFonts=false", "-dCompressStreams=false", "-dWriteObjStms=false", "-dWriteXRefStm=false", `-sOutputFile=${expandedPdf}`, pdf]);
    const rawPdf = readFileSync(expandedPdf).toString("latin1");
    for (const marker of markers.filter((m) => m !== "PRIVATE_ORCID")) assert.equal(visiblePdf.includes(normalized(marker)), !anonymous, `${marker}: native PDF visibility`);
    assert.equal(rawPdf.includes("PRIVATE_ORCID"), !anonymous, "native ORCID annotation presence");
  }
  assert.deepEqual(report.items, [], JSON.stringify(report.items));
});
