// Real LNCS 2.26 probe regression: institutename is a stateful typesetter, never a label.
// Every option below is compiled first by the native class, then instrumented without edits to it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { planExport, reparse } from "../src/export/plan";
import { prepareWorkDir, probeSty, runProbe } from "../src/export/probe";
import { readProbeLog } from "../src/export/probeLog";
import { censusTheorems, profileOf, theoremLook } from "../src/export/profiles";
import { readAuxLabels } from "../src/tex/aux";
import { texTool } from "../src/tex/binaries";
import { projectDefinitions } from "../src/tex/macros";
import { parseLog } from "../src/tex/logParser";
import { stripComments } from "../src/tex/project";
import { texText } from "../src/tex/texText";
import { theoremMap } from "../src/tex/theorems";
import { nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

const skip = !texBin ? "no TeX installation" : spawnSync(texTool(texBin, "kpsewhich"), ["llncs.cls"]).status !== 0 ? "no LNCS class" : false;
const gs = spawnSync("gs", ["--version"]).status === 0;
const dirs: string[] = [];
after(() => { removeExportTemps(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

test("optional title name expansions require a verified elegant class even for manual probe config", () => {
  const names = ["figure", "proof", "author", "institute", "date", "version"];
  const general = probeSty({ names, envs: [], colors: [] });
  assert.match(general, /\\def\\llx@names\{figure,proof\}/);
  assert.doesNotMatch(general, /\\llx@expand\\llx@t\{\\versiontext\}/);
  const elegant = probeSty({ names, envs: [], colors: [], titleLabels: "elegantbook" });
  assert.match(elegant, /\\def\\llx@names\{figure,proof,author,institute,date,version\}/);
  const article = probeSty({ names, envs: [], colors: [], titleLabels: "elegantarticle" });
  assert.match(article, /\\def\\llx@names\{figure,proof\}/);
  assert.match(article, /\\llx@expand\\llx@t\{\\versiontext\}/);
});

for (const options of ["", "envcountsame,envcountsect", "envcountreset"]) test(`LNCS native probe: ${options || "independent counters"}, label safety, heads and real numbers`, { skip, timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-paper-probe-"));
  dirs.push(dir);
  const root = join(dir, "main.tex");
  const src = `\\documentclass[${options}]{llncs}\n\\usepackage{hyperref}\n\\title{Synthetic Native Probe}\\author{Author A}\\institute{Synthetic Institute}\n\\spnewtheorem{statement}{Statement}{\\bfseries}{\\itshape}\n\\begin{document}\n\\maketitle\n\\section{One}\n\\begin{theorem}[Energy]\\label{t:one}One.\\end{theorem}\n\\begin{definition}[Graph]\\label{d:one}Two.\\end{definition}\n\\begin{example}[Small]\\label{e:one}Three.\\end{example}\n\\begin{proof}[Sketch]Done.\\end{proof}\n\\begin{statement}[Extra]\\label{s:one}Four.\\end{statement}\n\\section{Two}\n\\begin{theorem}\\label{t:two}Five.\\end{theorem}\n\\begin{definition}\\label{d:two}Six.\\end{definition}\n\\end{document}\n`;
  writeFileSync(root, src);
  const host = nodeExportHost(root);
  const signal = new AbortController().signal;
  const native = await host.build(signal);
  assert.equal(native.pdfWritten, true);
  assert.deepEqual(native.log.diagnostics.filter((d) => d.severity === "error"), []);
  const defs = projectDefinitions(root);
  const map = theoremMap(defs.files.map((f) => stripComments(readFileSync(f, "utf8"))));
  const plan = planExport(root, { defs, theorems: map });
  assert.ok(!plan.probe.names.includes("institute"));
  await prepareWorkDir(plan, host, signal);
  const result = await runProbe(plan, host, signal);
  assert.deepEqual(parseLog(result.log, host.workDir).diagnostics.filter((d) => d.severity === "error"), [], result.log.slice(-3000));
  assert.ok(existsSync(join(host.workDir, "main.llx")));
  const log = readProbeLog(readFileSync(join(host.workDir, "main.llx"), "utf8"));
  assert.equal(log.unreadable, 0);
  assert.equal(log.names.get("theorem"), "Theorem");
  assert.equal(log.names.get("definition"), "Definition");
  assert.ok(!log.names.has("institute"));
  const aux = readAuxLabels(host.buildDir);
  const counters: Record<string, string> = { "t:one": "theorem", "d:one": "definition", "e:one": "example", "s:one": "statement", "t:two": "theorem", "d:two": "definition" };
  for (const counter of Object.values(counters)) assert.ok(log.steps.some((s) => s.counter === counter), counter);
  for (const [key, counter] of Object.entries(counters)) assert.ok(log.steps.some((s) => s.counter === counter && texText(s.value) === texText(aux.get(key)!.number)), `${key}: ${counter} ${aux.get(key)!.number}`);
  const profile = profileOf(src, [src]);
  assert.equal(theoremLook(profile, "theorem", map.get("theorem")!, log.envs.get("theorem")).body, "it");
  assert.equal(theoremLook(profile, "example", map.get("example")!, log.envs.get("example")).head, "italic");
  const proof = map.get("proof")!;
  assert.equal(proof.title, "paren");
  assert.equal(proof.qed, null);
  assert.equal(theoremLook(profile, "proof", proof, log.envs.get("proof")).head, "italic");
  const census = censusTheorems(log.envs, new Map(), log.names);
  assert.equal(census.get("statement")!.counter, "statement");
  const parsed = reparse(plan, log.envs);
  assert.equal(parsed.sig.envs.get("statement"), "o");
  if (gs) {
    const pdf = execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=txtwrite", "-sOutputFile=-", native.pdfPath], { encoding: "utf8" }).replace(/\s+/g, "");
    for (const [key, counter] of Object.entries(counters)) assert.ok(pdf.includes(`${counter[0].toUpperCase()}${counter.slice(1)}${texText(aux.get(key)!.number)}`), key);
    assert.ok(pdf.includes("Proof(Sketch)."));
  }
});
