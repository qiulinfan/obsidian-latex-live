import { existsSync, promises as fsp, readFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import { formulaRefs, refNames, type LatexRefs } from "../editor/latexRefs";
import { readAuxLabels } from "../tex/aux";
import { bibFiles, readBib, type BibEntry } from "../tex/bib";
import { readBibFiles, readFls, type CompileResult } from "../tex/compiler";
import { parseLog } from "../tex/logParser";
import type { ProjectMathInput } from "../editor/mathjaxProject";
import { projectDefinitions, type Definitions } from "../tex/macros";
import { type Engine, logicalMapper, stripComments } from "../tex/project";
import { abortError, isAbortError } from "../tex/run";
import { theoremMap, type TheoremMap } from "../tex/theorems";
import { graphicsPaths } from "../tex/graphics";
import { stallMessage } from "../tex/watchdog";
import { readBbl, readBibcites } from "./bibliography";
import { emitHtml, type EmitBib } from "./emit";
import { drawingKey, pageDrawing, prepareFragment } from "./fragments";
import { renderPage } from "./html";
import { bitmapDataUri, ExportImages, type PdfImages } from "./images";
import type { CodeTokenizer } from "./listings";
import { ExportMath, tagSide, type MathEnv } from "./math";
import { planExport, reparse, type ExportPlan } from "./plan";
import { prepareWorkDir, runDvisvgm, runProbe } from "./probe";
import { readProbeLog, StepQueue, type ProbeLog } from "./probeLog";
import { fallbackName, pageCss, profileOf, titleHtml, type Profile } from "./profiles";
import { ReportBuilder, type ExportReport, type ExportStage } from "./report";
import { walkTex } from "./texTree";

// Export orchestration (design 2): freshness of the last build (a full build through the root's
// session when stale), the plan (with the formulas MathJax rejects, through the export's own
// MathJax output), the probe pass, the fragments (dvisvgm over the probe's DVI) and the images
// (PDF pages through the host's pdf.js), the emitter (the build's labels, .bbl and `\bibcite`s,
// the .bib entries) and the page in the class's profile with the math's stylesheet. Two stages:
// `prepareExport` (files and processes) and `emitExport` (the DOM: MathJax measures there), so
// scripts/export-smoke.mjs emits in a real browser what Node prepared. Obsidian-free: the command
// (command.ts) and the tests (tests/support/exportHost.ts) provide the host.

export type { ExportStage } from "./report";

/** What the export needs from its environment. */
export interface ExportHost {
  binDir: string;
  engine: Engine;
  shellEscape: boolean;
  /** The root's build folder (session.ts's outDirFor). */
  buildDir: string;
  /** The export's work folder: exportDirFor(root), a sibling of the build folder. */
  workDir: string;
  /** A full build (latexmk, BibTeX/Biber) of the root into buildDir; rejects when aborted. */
  build(signal: AbortSignal): Promise<CompileResult>;
  /** MathJax and its fonts (Obsidian: loadMathJax and MathJax's fontURL; tests: jsdom and node_modules). */
  math(): Promise<MathEnv>;
  /** PDF pages as PNG (Obsidian's pdf.js); without it PDF images and `\includepdf` pages are report items. */
  pdfImages?: PdfImages;
  /** Existing syntax tokenizer from the host (Obsidian's public loadPrism). */
  code?(): Promise<CodeTokenizer>;
  /** Yield to the UI during the emit. */
  idle(): Promise<void>;
}

export interface ExportProgress {
  stage: ExportStage;
  done?: number;
  total?: number;
  message: string;
}

/** The export's work folder of a build folder: `<build folder>-export`. */
export function exportDirFor(buildDir: string): string {
  return `${buildDir}-export`;
}

const mtime = async (p: string): Promise<number | null> => {
  try {
    return (await fsp.stat(p)).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Whether the build folder holds a build of the current sources (design 3.5). Stale when the
 * .aux, .log or recorder is missing; when the root, a file the last compile read (including a
 * cached preamble's .fls, outside the build folder) or a .bib file is missing or newer than the
 * log; when the sources cite but the .bbl is missing or
 * older than a .bib; and when the log asks for another pass, Biber or BibTeX, or has undefined
 * references, unless latexmk wrote that log (its .fdb_latexmk is as new: a full build ran every
 * pass, and what is still undefined is the document's).
 */
export async function buildFreshness(root: string, buildDir: string): Promise<{ fresh: boolean; reason: string }> {
  const job = root.slice(dirname(root).length + 1).replace(/\.[^.]*$/, "");
  const rootDir = dirname(root);
  const logTime = await mtime(join(buildDir, `${job}.log`));
  if (logTime === null || !existsSync(join(buildDir, `${job}.aux`))) return { fresh: false, reason: "no build yet" };
  const inputs = await readFls(join(buildDir, `${job}.fls`), logicalMapper(rootDir));
  if (!inputs.length) return { fresh: false, reason: "no dependency record yet" };
  // A fast pdfLaTeX build records the cached format, but not the local files that format read.
  // Its recorder file is the compiler's source of those dependencies (the ready stamp is kept
  // beside it). Consult it only when this build actually used that format, so an older cache
  // cannot force a fresh full build to rebuild forever.
  if (inputs.includes(resolve(buildDir, `${job}-preamble.fmt`))) {
    const preambleInputs = await readFls(join(buildDir, `${job}-preamble.fls`), logicalMapper(rootDir));
    if (!preambleInputs.length) return { fresh: false, reason: "no cached preamble dependency record" };
    inputs.push(...preambleInputs);
  }
  const bibs = await readBibFiles(buildDir, job, rootDir);
  const outside = (p: string) => !resolve(p).startsWith(resolve(buildDir) + sep);
  for (const p of [root, ...inputs.filter(outside), ...bibs]) {
    const t = await mtime(p);
    if (t === null) return { fresh: false, reason: `${relative(rootDir, p) || p} is missing` };
    if (t > logTime) return { fresh: false, reason: `${relative(rootDir, p) || p} changed` };
  }
  const aux = await fsp.readFile(join(buildDir, `${job}.aux`), "utf8").catch(() => "");
  const cites = existsSync(join(buildDir, `${job}.bcf`)) || /\\bibdata\{/.test(aux);
  if (cites) {
    const bbl = await mtime(join(buildDir, `${job}.bbl`));
    if (bbl === null) return { fresh: false, reason: "no bibliography yet" };
    for (const b of bibs) if (((await mtime(b)) ?? 0) > bbl) return { fresh: false, reason: `${relative(rootDir, b)} changed` };
  }
  const log = await fsp.readFile(join(buildDir, `${job}.log`), "utf8").catch(() => "");
  const byLatexmk = ((await mtime(join(buildDir, `${job}.fdb_latexmk`))) ?? 0) >= logTime - 1000;
  if (!byLatexmk) {
    if (/Rerun to get|Label\(s\) may have changed|Please rerun LaTeX/.test(log)) return { fresh: false, reason: "the references need another pass" };
    if (/Please \(re\)run (?:Biber|BibTeX)/.test(log)) return { fresh: false, reason: "the bibliography needs Biber/BibTeX" };
    if (/There were undefined (?:references|citations)/.test(log)) return { fresh: false, reason: "undefined references" };
  }
  return { fresh: true, reason: "" };
}

/** The formulas of the plan's visits (the emit's progress). */
function mathCount(plan: ExportPlan): number {
  let n = 0;
  for (const v of plan.visits) {
    const file = plan.files.get(v.key);
    if (file) walkTex(file.nodes, (x) => void (x.t === "math" && n++));
  }
  return n;
}

/** What the stages before the emit prepared: everything the page is made of but its math. */
export interface PreparedExport {
  root: string;
  job: string;
  engine: Engine;
  plan: ExportPlan;
  /** The probe's records; null in aux-only mode. */
  log: ProbeLog | null;
  refs: LatexRefs;
  theorems: TheoremMap;
  defs: Definitions;
  profile: Profile;
  bib: EmitBib;
  /** Prepared SVG by explicit probe-visit + static fragment id (`drawingKey`). */
  fragments: Map<string, string>;
  images: ExportImages;
  report: ReportBuilder;
  timings: ExportReport["timings"];
  /** The math's input and tag side (`exportMath` builds the renderer from them in any window). */
  mathInput: ProjectMathInput;
  tagSide: "left" | "right";
}

/** The export's math renderer on `env`'s MathJax: the project's definitions, references as their texts. */
export function exportMath(env: MathEnv, p: Pick<PreparedExport, "mathInput" | "refs" | "tagSide">): ExportMath {
  return ExportMath.create(env, p.mathInput, { refs: formulaRefs(p.refs), tagSide: p.tagSide });
}

/**
 * Export the document `root` to one HTML page (design 2). Stages report through `onProgress`;
 * aborting `signal` kills a running TeX process group and rejects (isAbortError). The report's
 * `output` and `bytes` and the `write` timing are the caller's to fill in.
 */
export async function exportHtml(
  root: string,
  host: ExportHost,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<{ html: string; report: ExportReport }> {
  const { prepared, math } = await prepareExport(root, host, onProgress, signal);
  return emitExport(prepared, math, host, onProgress, signal);
}

/**
 * The stages before the emit: the build, the plan (its formulas checked with the returned math
 * renderer, whose cache the emit reuses), the probe, the fragments and the images.
 */
export async function prepareExport(
  root: string,
  host: ExportHost,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<{ prepared: PreparedExport; math: ExportMath }> {
  const timings: ExportReport["timings"] = { build: 0, plan: 0, probe: 0, fragments: 0, emit: 0, write: 0 };
  const report = new ReportBuilder();
  const check = () => {
    if (signal.aborted) throw abortError("The export was cancelled.");
  };
  const rootDir = dirname(root);
  check();
  if (host.engine === "lualatex") throw new Error("HTML export currently supports pdfLaTeX and XeLaTeX. LuaLaTeX requires a PDF-mode probe, which is not supported yet.");

  // Build.
  let started = Date.now();
  onProgress({ stage: "build", message: "checking the build" });
  const freshness = await buildFreshness(root, host.buildDir);
  check();
  if (!freshness.fresh) {
    onProgress({ stage: "build", message: `building (latexmk): ${freshness.reason}` });
    const result = await host.build(signal);
    for (const d of result.log.diagnostics.filter((x) => x.severity === "error").slice(0, 20)) {
      report.add({ severity: "warning", kind: "build", message: d.message, file: d.file ?? undefined, line: d.line ?? undefined });
    }
  }
  check();
  const job = root.slice(rootDir.length + 1).replace(/\.[^.]*$/, "");
  if (!existsSync(join(host.buildDir, `${job}.aux`))) {
    const log = await fsp.readFile(join(host.buildDir, `${job}.log`), "utf8").catch(() => "");
    const first = parseLog(log, rootDir).diagnostics.find((d) => d.severity === "error");
    throw new Error(`The build wrote no .aux file${first ? `: ${first.message}` : ""}.`);
  }
  timings.build = Date.now() - started;

  // Plan: the sources, the build's labels and bibliography, the formulas MathJax renders.
  started = Date.now();
  onProgress({ stage: "plan", message: "reading the sources" });
  const defs = projectDefinitions(root);
  const sources = defs.files.map((f) => stripComments(readFileSync(f, "utf8")));
  const theorems = theoremMap(sources);
  const cites = new Map<string, BibEntry>();
  for (const bib of bibFiles(sources, rootDir)) for (const [k, e] of readBib(bib)) if (!cites.has(k)) cites.set(k, e);
  const refs: LatexRefs = {
    labels: readAuxLabels(host.buildDir),
    numbers: new Map(),
    cites,
    names: refNames(sources, theorems),
    theorems,
    checkpoints: new Map(),
  };
  const mathInput: ProjectMathInput = { statements: defs.statements, physics: defs.packages.has("physics"), unsupported: defs.unsupported };
  let side = tagSide(sources);
  const mathEnv = await host.math();
  let math = exportMath(mathEnv, { mathInput, refs, tagSide: side });
  for (const f of math.failed) report.add({ severity: "info", kind: "math", message: `MathJax cannot read the definition ${f.statement.slice(0, 80)}: ${f.message}` });
  check();
  // The formulas the plan asks about, checked (rendered) with the UI getting its turns; the plan
  // then reads the cached answers.
  const checks: [string, boolean][] = [];
  planExport(root, { defs, theorems, mathOk: (tex, display) => (checks.push([tex, display]), true) });
  let last = Date.now();
  for (let i = 0; i < checks.length; i++) {
    math.ok(...checks[i]);
    if (Date.now() - last > 30) {
      onProgress({ stage: "plan", done: i + 1, total: checks.length, message: `checking the formulas ${i + 1}/${checks.length}` });
      await host.idle();
      check();
      last = Date.now();
    }
  }
  let plan = planExport(root, { defs, theorems, mathOk: (tex, display) => math.ok(tex, display) });
  for (const [key, from] of plan.missing) report.add({ severity: "warning", kind: "build", message: `${key}: file not found (named in ${from})` });
  timings.plan = Date.now() - started;
  check();

  // Probe.
  started = Date.now();
  onProgress({ stage: "probe", message: "probe pass" });
  await prepareWorkDir(plan, host, signal);
  const probe = await runProbe(plan, host, signal);
  let log: ProbeLog | null = probe.llx ? readProbeLog(probe.llx) : null;
  if (log && !log.steps.length && !log.names.size) log = null;
  if (probe.stalled || probe.timedOut) {
    report.add({ severity: "error", kind: "probe", message: probe.stalled ? stallMessage(host.engine) : "The probe pass took longer than 5 minutes and was stopped." });
  }
  if (!log) {
    const why = probe.output.trim().split(/\r?\n/).slice(-2).join(" ") || "no .llx file";
    report.add({ severity: "error", kind: "probe", message: `The probe pass failed (${why}): numbers only for labelled items, names from the class tables.` });
  } else {
    const toProject = logicalMapper(host.workDir);
    const src = join(host.workDir, "src");
    const errors = parseLog(probe.log, host.workDir).diagnostics.filter((d) => d.severity === "error");
    for (const d of errors.slice(0, 20)) {
      const file = d.file ? toProject(d.file) : null;
      const rel = file ? relative(src, file) : "";
      const mapped = file && rel && !rel.startsWith("..") ? join(rootDir, rel) : file;
      report.add({ severity: "warning", kind: "probe", message: d.message, file: mapped ?? undefined, line: d.line ?? undefined });
    }
    plan = reparse(plan, log.envs);
  }
  timings.probe = Date.now() - started;
  check();
  const nativeSide = log?.info.get("equation-tag-side");
  if ((nativeSide === "left" || nativeSide === "right") && nativeSide !== side) {
    side = nativeSide;
    // ProjectMath exposes no side setter; only an unexpected native class setting needs a
    // new private renderer. Keep the same definitions, refs, DOM/font host and completed plan
    // classification. Normal AMS/default/explicit cases keep the warmed initial renderer.
    math = exportMath(mathEnv, { mathInput, refs, tagSide: side });
  }

  // Fragments: every page of the probe's DVI through dvisvgm, each named by its marker; then the images.
  started = Date.now();
  const fontPt = Number(log?.info.get("fontsize")) || 10;
  const fragments = new Map<string, string>();
  if (plan.fragments.length && probe.dvi && log) {
    onProgress({ stage: "fragments", message: `TeX fragments (${plan.fragments.length})` });
    try {
      const pages = await runDvisvgm(probe.dvi, host, signal);
      // A picture's image is named as TeX found it, from the root's folder.
      const embed = (file: string) => bitmapDataUri(resolve(rootDir, file));
      for (const svg of pages.svgs) {
        const drawing = pageDrawing(svg);
        const key = drawing && drawingKey(drawing.visit, drawing.id);
        const html = !drawing || !key || fragments.has(key) ? null : prepareFragment(svg, `${drawing.visit}-${drawing.id}`, fontPt, embed);
        if (html && key) fragments.set(key, html);
      }
      if (host.engine === "xelatex" && plan.fragments.some((f) => /\\includegraphics\b/.test(plan.files.get(f.key)?.src.slice(f.from, f.to) ?? ""))) {
        report.add({ severity: "warning", kind: "fragment", message: "images inside TeX fragments are left out with XeLaTeX (dvisvgm cannot read its picture specials)" });
      }
      if (pages.code !== 0 || pages.stalled || pages.timedOut) {
        const why = pages.stalled ? "it stalled" : pages.timedOut ? "it took longer than 2 minutes" : pages.output.trim().split(/\r?\n/).slice(-1)[0] || `exit ${pages.code}`;
        report.add({ severity: "warning", kind: "fragment", message: `dvisvgm did not convert every fragment (${why})` });
      }
    } catch (e) {
      // No dvisvgm in this TeX installation: every fragment shows its source.
      if (isAbortError(e)) throw e;
      report.add({ severity: "error", kind: "fragment", message: `dvisvgm could not run (${e instanceof Error ? e.message : String(e)}): TeX fragments show their source` });
    }
  }
  check();
  onProgress({ stage: "fragments", message: "images" });
  const images = new ExportImages(rootDir, graphicsPaths(sources), host.pdfImages);
  await images.load(plan, signal);
  const bbl = await fsp.readFile(join(host.buildDir, `${job}.bbl`), "utf8").catch(() => null);
  const entries = bbl ? readBbl(bbl) : [];
  const bib: EmitBib = {
    entries: new Map(entries.map((e) => [e.key, e])),
    bbl: entries.length ? null : bbl,
    bibcites: readBibcites([await fsp.readFile(join(host.buildDir, `${job}.aux`), "utf8").catch(() => "")]),
  };
  timings.fragments = Date.now() - started;
  check();

  const rootSrc = plan.files.get(plan.rootKey)?.src ?? "";
  const prepared: PreparedExport = {
    root,
    job,
    engine: host.engine,
    plan,
    log,
    refs,
    theorems,
    defs,
    profile: profileOf(rootSrc, sources),
    bib,
    fragments,
    images,
    report,
    timings,
    mathInput,
    tagSide: side,
  };
  return { prepared, math };
}

/**
 * The emit (design 4): the page of a prepared export in its class's profile, the math rendered by
 * `math` (`exportMath` of the window the page is made in), with the stylesheet of what it shows.
 */
export async function emitExport(
  p: PreparedExport,
  math: ExportMath,
  host: Pick<ExportHost, "idle" | "code">,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<{ html: string; report: ExportReport }> {
  if (signal.aborted) throw abortError("The export was cancelled.");
  const started = Date.now();
  const { plan, log, report } = p;
  onProgress({ stage: "emit", message: "writing the HTML" });
  const formulas = mathCount(plan);
  let code: CodeTokenizer | undefined;
  if (log?.listings.length && host.code) {
    let onAbort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortError("The export was cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { code = await Promise.race([host.code(), cancelled]); }
    catch (err) {
      if (isAbortError(err) || signal.aborted) throw abortError("The export was cancelled.");
      report.add({ severity: "warning", kind: "code", message: `Code highlighter could not be loaded: ${err instanceof Error ? err.message : String(err)}` });
    }
    finally { signal.removeEventListener("abort", onAbort); }
  }
  if (signal.aborted) throw abortError("The export was cancelled.");
  const out = await emitHtml({
    plan,
    log,
    queue: log ? new StepQueue(log, plan.visits) : null,
    refs: p.refs,
    theorems: p.theorems,
    defs: p.defs,
    profile: p.profile,
    math,
    bib: p.bib,
    fragments: p.fragments,
    images: p.images,
    code,
    report,
    idle: () => host.idle(),
    progress: (done) => onProgress({ stage: "emit", done, total: formulas, message: `math ${done}/${formulas}` }),
    signal,
  });
  const name = (key: string) => log?.names.get(key) || fallbackName(p.profile, key);
  const header = out.header ? titleHtml(p.profile, out.header, name) : "";
  const styles = await math.stylesheet(out.body + header + out.footnotes.map((f) => f.html).join(""), signal);
  if (signal.aborted) throw abortError("The export was cancelled.");
  for (const file of styles.missing) report.add({ severity: "error", kind: "math", message: `MathJax font ${file} could not be read: formulas use the reader's fonts` });
  const tocDepth = Number(log?.info.get("tocdepth") ?? "2");
  const html = renderPage({
    lang: p.profile.lang,
    title: out.title || p.job,
    css: pageCss(p.profile, out.colors),
    header,
    toc:
      out.tocTitle !== null
        ? { title: out.tocTitle, entries: out.headings.filter((h) => h.toc && h.level <= tocDepth).map((h) => ({ level: h.level, number: h.number, title: h.title, id: h.id })) }
        : null,
    body: out.body,
    footnotes: out.footnotes,
    mathCss: styles.css,
  });
  const timings = { ...p.timings, emit: Date.now() - started };
  const counts = { ...out.counts, visits: plan.visits.length, files: plan.files.size, planned: plan.fragments.length, mathFontBytes: styles.fontBytes };
  return {
    html,
    report: {
      output: "",
      bytes: new TextEncoder().encode(html).byteLength,
      engine: p.engine,
      profile: p.profile.name,
      timings,
      counts,
      numbers: out.numbers,
      items: report.items,
    },
  };
}
