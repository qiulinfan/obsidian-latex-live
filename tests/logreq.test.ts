import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildFreshness } from "../src/export/exporter";
import { fixtureCopy, nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

after(removeExportTemps);
const gs = (() => { try { execFileSync("gs", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !texBin ? "no TeX installation found" : !gs ? "no Ghostscript for PDF text assertions" : process.platform === "win32" ? "POSIX tool capture fixture" : false;

/** Capture the native latexmk log while preserving its exit status and the real TeX tools. */
function capture(host: ReturnType<typeof nodeExportHost>, dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["pdflatex", "xelatex", "lualatex", "dvisvgm"]) symlinkSync(join(texBin!, name), join(bin, name));
  const output = join(dir, "latexmk-output.log");
  const latexmk = join(bin, "latexmk");
  writeFileSync(latexmk, `#!/bin/bash\n'${join(texBin!, "latexmk")}' "$@" 2>&1 | /usr/bin/tee '${output}'\nexit "\${PIPESTATUS[0]}"\n`);
  chmodSync(latexmk, 0o755);
  host.binDir = bin;
  return output;
}

const textOf = (file: string) => execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=txtwrite", "-sOutputFile=-", file], { encoding: "utf8" });
const runs = (output: string, rule: string) => [...output.matchAll(/Run number \d+ of rule '([^']+)'/g)].filter((m) => m[1].startsWith(rule)).length;

test("native latexmk converges without the logreq-only pass, preserving XML inputs, Biber and user hooks", { skip, timeout: 90_000 }, async () => {
  const { dir, root } = fixtureCopy("export-article");
  writeFileSync(root, String.raw`\documentclass{article}
\usepackage[backend=biber]{biblatex}
\addbibresource{refs.bib}
\newread\XMLread
\def\XMLvalue<internal package="biblatex" priority="9" active="#1">{#1}
\begin{document}
\section{Intro}\label{sec:intro}
\openin\XMLread=payload.xml
\read\XMLread to\XMLline
\closein\XMLread
Value: \expandafter\XMLvalue\XMLline. Section \ref{sec:intro}. \cite{r}
\printbibliography
\end{document}`);
  const bib = join(dir, "refs.bib");
  writeFileSync(bib, "@book{r,author={Synthetic Author},title={Reference},year={2026},publisher={Example}}\n");
  const payload = join(dir, "payload.xml");
  // A real XML input intentionally resembles logreq's metadata. Extension/content matching
  // would ignore this update; only the exact generated build/job ledger can be excluded.
  const xml = (active: number) => `  <internal package="biblatex" priority="9" active="${active}">\n<value>constant</value>\n</internal>\n`;
  writeFileSync(payload, xml(0));
  writeFileSync(join(dir, ".latexmkrc"), "add_hook('after_xlatex_analysis', sub {open(my $f,'>>','user-hook.txt') or die $!;print $f qq{x\\n};close $f;});\n");
  const host = nodeExportHost(root);
  const output = capture(host, dir);
  const first = await host.build(new AbortController().signal);
  assert.ok(first.pdfWritten, first.rawLog);
  assert.deepEqual(first.log.diagnostics.filter((d) => d.severity === "error"), []);
  const firstLog = readFileSync(output, "utf8");
  assert.equal(runs(firstLog, "pdflatex"), 3, "aux/bbl convergence stays; the fourth metadata-only pass is absent");
  assert.equal(runs(firstLog, "biber "), 1);
  assert.equal(readFileSync(join(dir, "user-hook.txt"), "utf8").trim().split("\n").length, 3, "the user's existing hook still runs for each pass");
  assert.match(textOf(first.pdfPath), /Value:\s*0/);
  assert.ok(readFileSync(join(host.buildDir, "main.fls"), "utf8").includes("INPUT payload.xml"));
  assert.ok(existsSync(join(host.buildDir, "main.run.xml")));
  assert.deepEqual(await buildFreshness(root, host.buildDir), { fresh: true, reason: "" });

  writeFileSync(payload, xml(1));
  const second = await host.build(new AbortController().signal);
  assert.ok(second.pdfWritten);
  assert.equal(runs(readFileSync(output, "utf8"), "pdflatex"), 1, "a real XML mutation still causes TeX to run");
  assert.match(textOf(second.pdfPath), /Value:\s*1/);

  writeFileSync(bib, readFileSync(bib, "utf8").replace("title={Reference}", "title={Revised Reference}"));
  const third = await host.build(new AbortController().signal);
  assert.ok(third.pdfWritten);
  const thirdLog = readFileSync(output, "utf8");
  assert.equal(runs(thirdLog, "biber "), 1, "bibliography dependencies were preserved");
  assert.equal(runs(thirdLog, "pdflatex"), 2, "the updated bbl still gets its required TeX passes");
  assert.match(textOf(third.pdfPath), /Revised Reference/);
  assert.deepEqual(third.log.diagnostics.filter((d) => d.severity === "error"), []);
  assert.equal(readFileSync(join(dir, "user-hook.txt"), "utf8").trim().split("\n").length, 6);
});

test("a logreq ledger containing another package keeps the native dependency behavior", { skip, timeout: 60_000 }, async () => {
  const { dir, root } = fixtureCopy("export-article");
  writeFileSync(root, String.raw`\documentclass{article}
\usepackage[backend=biber]{biblatex}
\addbibresource{refs.bib}
\logrequest[package=synthetic,priority=5,active=0]{\generic{synthetic-tool}}
\begin{document}Text \cite{r}.\printbibliography\end{document}`);
  writeFileSync(join(dir, "refs.bib"), "@book{r,author={Synthetic Author},title={Reference},year={2026},publisher={Example}}\n");
  const host = nodeExportHost(root);
  const output = capture(host, dir);
  const built = await host.build(new AbortController().signal);
  assert.ok(built.pdfWritten, built.rawLog);
  const ledger = readFileSync(join(host.buildDir, "main.run.xml"), "utf8");
  assert.match(ledger, /external package="synthetic"/);
  assert.equal(runs(readFileSync(output, "utf8"), "pdflatex"), 4, "an unrecognized request owner prevents the optimization");
  assert.deepEqual(built.log.diagnostics.filter((d) => d.severity === "error"), []);
});
