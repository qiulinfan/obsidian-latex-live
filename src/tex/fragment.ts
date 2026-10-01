import { ChildProcess, spawn } from "child_process";
import { createHash } from "crypto";
import { promises as fsp, readFileSync, statSync } from "fs";
import { delimiter, dirname, join } from "path";
import { texEnv, texTool } from "./binaries";
import { killTree } from "./run";
import { parseLog } from "./logParser";
import { definitionStatements, projectDefinitions } from "./macros";
import { findGraphics, graphicsPaths } from "./graphics";
import { Engine, logicalMapper, preambleFiles, referencedFiles, stripComments } from "./project";
import { groupCpuSeconds, stallMessage, watchStall } from "./watchdog";

// Real-TeX fragment compiles (design 4.7): the render hover's last resort for a formula MathJax
// cannot draw (tikz-cd, \intertext, a macro built on @ internals) and for a block without a fresh
// PDF crop. Free of the obsidian module; tests/fragment.test.ts runs it against real TeX.
//   Source    one file per job in the snippets folder (`<build folder>/snippets`). pdfLaTeX with the
//             preamble format a compile left ready (compiler's readyPreambleFormat) reads a
//             placeholder \documentclass line and \endofdump (the format skips to it), then what
//             the root has after its own \endofdump; otherwise (XeLaTeX, LuaLaTeX, no format) the
//             root's whole preamble. Then the preview package (`active,tightpage,auctex`: one page
//             per fragment, its box in the log), the labels the fragments name, from the last
//             compile's .aux (`\global\@namedef{r@k}{..}`, cleveref's twins too), and after
//             \begin{document} the body's definitions (chapter-local \newcommand; they may
//             redefine) and one preview environment per fragment. A fragment that is not inline
//             ends with an empty line (`\par\hbox{}`): after a display the box preview measures
//             ends at the last line's baseline, cutting its descenders off the page.
//   Output    the PDF (page n is fragment n) and each fragment's box from `Preview: Snippet n
//             ended.(h+dxw)` (sp), with the tightpage border (`Preview: Tightpage`, 0.50001bp).
//             Errors by file and line: those in a fragment's lines are its own, the others
//             (the preamble's) fail a fragment only when it got no box.
//   Runs      in the root's folder (\input and graphics resolve as in the document), in their own
//             process group, killed on abort and on timeout (TIMEOUT_MS: 10 s pdfLaTeX, 20 s the
//             others); the stall watchdog stops a run that neither logs nor computes for
//             STALL_MS (XeLaTeX waiting for a macOS font download). A broken format is retried
//             with the full preamble.
//   Cache     by content hash (the engine, the source, the caller's `stamp`: what the preamble
//             reads besides the root, and what the body reads, bodyStamp: an \input'd figure file,
//             an image): `frag-<hash>.pdf` and `.json` in the snippets folder, the
//             oldest dropped past CACHE_ENTRIES; a run's other files are deleted, also when it is
//             aborted or TeX cannot start. A run that was stopped or wrote no log is not cached.
//   Queue     `FragmentQueue`, one per root: a cached job answers at once; one job runs and one
//             waits, and a newer job replaces the waiting one (which resolves null).

/** TeX typeset in a preview environment: `$x$`, `\begin{align*}..\end{align*}`, a box. */
export interface Fragment {
  readonly id: string;
  readonly body: string;
  /** Inline material (its box keeps its baseline); anything else ends with an empty line. */
  readonly inline?: boolean;
}

export interface FragmentJob {
  engine: Engine;
  binDir: string;
  /** The root document's folder: TeX runs there. */
  cwd: string;
  /** The snippets folder: the runs and the cache (under the root's build folder, in $TMPDIR). */
  outDir: string;
  /** The root's text before \begin{document} (preambleParts). */
  preamble: string;
  /**
   * pdfLaTeX's preamble format when a compile left it ready: its name (`<job>-preamble`), its
   * folder (TEXFORMATS) and what follows the root's own \endofdump before \begin{document}.
   */
  format: { name: string; dir: string; rest: string } | null;
  /** Definitions of the document body, run before the fragments (fragmentContext). */
  definitions: readonly string[];
  /** The last compile's `\newlabel` values by key, braces included (aux's readAuxDefinitions). */
  labels: ReadonlyMap<string, string>;
  fragments: readonly Fragment[];
  /** Changes whenever something the preamble reads does (fragmentContext; the format's mtime). */
  stamp: string;
  /** Default: TIMEOUT_MS of the engine. */
  timeoutMs?: number;
  /** The processes started are added here while they run (tests). */
  children?: Set<ChildProcess>;
}

/** A fragment's box in points (TeX's height, depth and width), on page `page` of the PDF. */
export interface FragmentBox {
  id: string;
  page: number;
  heightPt: number;
  depthPt: number;
  widthPt: number;
}

export interface FragmentOutput {
  /** The job's content hash (the cache key). */
  hash: string;
  pdf: Uint8Array | null;
  boxes: FragmentBox[];
  /** The tightpage border around each box on its page, in points. */
  borderPt: number;
  /** TeX's errors: a fragment's own (`id`), or the preamble's (null). */
  errors: { id: string | null; message: string }[];
  /** The run started from pdfLaTeX's preamble format. */
  usedFormat: boolean;
  cached: boolean;
  durationMs: number;
}

export const TIMEOUT_MS: Record<Engine, number> = { pdflatex: 10_000, xelatex: 20_000, lualatex: 20_000 };
/** No log growth and no CPU for this long stops a run (the compiler's watchdog waits 30 s). */
export const STALL_MS = 8000;
const CACHE_ENTRIES = 200;
/** preview.sty's \PreviewBorder, 0.50001bp, when the log does not say. */
const BORDER_SP = 32891;
const SP_PER_PT = 65536;
const PREVIEW = "\\usepackage[active,tightpage,auctex]{preview}";
/**
 * \newcommand and \newenvironment may redefine while the body's definitions run: the kernel's
 * definability test passes (\renewcommand restores it from \@@ifdefinable, so that one too).
 */
const REDEFINE_ON =
  "\\makeatletter\\let\\ll@ifdefinable\\@@ifdefinable\\long\\def\\@ifdefinable#1#2{#2}\\let\\@@ifdefinable\\@ifdefinable\\makeatother";
const REDEFINE_OFF = "\\makeatletter\\let\\@ifdefinable\\ll@ifdefinable\\let\\@@ifdefinable\\ll@ifdefinable\\makeatother";

/**
 * A root's text for fragments: everything before its \begin{document} line, and the lines between
 * its own \endofdump and \begin{document} (a format holds only what comes before). Null without
 * \begin{document}.
 */
export function preambleParts(text: string): { preamble: string; rest: string } | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let dump = -1;
  for (let i = 0; i < lines.length; i++) {
    const code = stripComments(lines[i]);
    if (/\\begin\s*\{document\}/.test(code)) {
      return { preamble: lines.slice(0, i).join("\n"), rest: dump < 0 ? "" : lines.slice(dump + 1, i).join("\n") };
    }
    if (dump < 0 && /\\endofdump/.test(code)) dump = i;
  }
  return null;
}

/**
 * What fragments of `root` need besides its preamble: the definitions of its body (its own after
 * \begin{document} and those of the files it reads there, in document order; chapter-local
 * \newcommand), a stamp of the files its preamble reads (its \input chain, local packages and
 * classes) that changes when they do, and the sources' \graphicspath (bodyStamp's images).
 * `buffers`: unsaved editor text by path.
 */
export function fragmentContext(root: string, buffers?: ReadonlyMap<string, string>): { definitions: string[]; stamp: string; graphics: string[] } {
  const files = projectDefinitions(root, buffers).files;
  const preamble = preambleFiles(root);
  const definitions: string[] = [];
  const defined = new Set<string>();
  const stamp: string[] = [];
  const sources: string[] = [];
  for (const file of files) {
    if (/\.(?:sty|cls)$/i.test(file)) {
      stamp.push(`${file}@${mtimeOf(file)}`);
      continue;
    }
    let text = buffers?.get(file) ?? readText(file);
    sources.push(stripComments(text));
    if (preamble.has(file)) {
      stamp.push(`${file}@${mtimeOf(file)}`);
      continue;
    }
    if (file === root) {
      const at = /\\begin\s*\{document\}/.exec(stripComments(text));
      if (!at) continue;
      text = stripComments(text).slice(at.index);
    }
    definitions.push(...definitionStatements(text, defined));
  }
  return { definitions, stamp: stamp.join("\n"), graphics: graphicsPaths(sources) };
}

/** Files deeper than this in a fragment's \input chain are not stamped. */
const MAX_INPUT_DEPTH = 8;

/**
 * A stamp of the files a fragment's body reads (a cache key part): what it `\input`s or
 * `\include`s (and what those read, in turn) and the images of its `\includegraphics`
 * (graphics.ts's lookup from the root's folder `rootDir` and `graphics`, fragmentContext's
 * \graphicspath), with their mtimes. A figure file or an image saved since is compiled again.
 */
export function bodyStamp(body: string, rootDir: string, graphics: readonly string[]): string {
  const stamp: string[] = [];
  const seen = new Set<string>();
  const visit = (text: string, depth: number) => {
    const src = stripComments(text);
    const images = [...src.matchAll(/\\includegraphics\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]+)\}/g)].map((m) => findGraphics(m[1].trim(), rootDir, graphics)?.path);
    for (const file of [...referencedFiles(src, rootDir), ...images]) {
      if (!file || seen.has(file)) continue;
      seen.add(file);
      stamp.push(`${file}@${mtimeOf(file)}`);
      if (/\.tex$/i.test(file) && depth < MAX_INPUT_DEPTH) visit(readText(file), depth + 1);
    }
  };
  visit(body, 0);
  return stamp.join("\n");
}

/** The TeX source of a job and the lines (1-based) each fragment's environment spans. */
export function fragmentSource(job: FragmentJob): { text: string; lines: Map<string, { from: number; to: number }> } {
  const labels: string[] = [];
  for (const [key, value] of job.labels) {
    const base = key.endsWith("@cref") ? key.slice(0, -5) : key;
    if (job.fragments.some((f) => f.body.includes(base))) labels.push(`\\global\\@namedef{r@${key}}${value}`);
  }
  const parts = [
    // The format skips the file up to \endofdump: the class line only starts that scan.
    ...(job.format ? ["\\documentclass{article}", "\\endofdump", job.format.rest] : [job.preamble]),
    PREVIEW,
    ...(labels.length ? ["\\makeatletter", ...labels, "\\makeatother"] : []),
    "\\begin{document}",
    ...(job.definitions.length ? [REDEFINE_ON, ...job.definitions, REDEFINE_OFF] : []),
  ];
  let text = parts.join("\n") + "\n";
  let line = lineCount(text) + 1;
  const lines = new Map<string, { from: number; to: number }>();
  for (const f of job.fragments) {
    // `%` ends a body whose last line has no comment without a space; one that has, gets its line.
    const env = `\\begin{preview}${f.body}%\n${f.inline ? "" : "\\par\\hbox{}"}\\end{preview}\n`;
    const to = line + lineCount(env) - 1;
    lines.set(f.id, { from: line, to });
    text += env;
    line = to + 1;
  }
  return { text: text + "\\end{document}\n", lines };
}

/**
 * Boxes and errors from a fragment run's log (see Output). `file` is the job's .tex file, `ids`
 * the fragments in order (snippet n is fragment n).
 */
export function parseFragmentLog(
  log: string,
  file: string,
  cwd: string,
  ids: readonly string[],
  lines: ReadonlyMap<string, { from: number; to: number }>,
): Pick<FragmentOutput, "boxes" | "borderPt" | "errors"> {
  const boxes: FragmentBox[] = [];
  for (const m of log.matchAll(/Preview: Snippet (\d+) ended\.\((-?\d+)\+(-?\d+)x(-?\d+)\)/g)) {
    const n = Number(m[1]);
    const id = ids[n - 1];
    if (id === undefined) continue;
    const [h, d, w] = [m[2], m[3], m[4]].map((v) => Number(v) / SP_PER_PT);
    boxes.push({ id, page: n, heightPt: h, depthPt: d, widthPt: w });
  }
  const tight = /Preview: Tightpage (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(log);
  const borderPt = (tight ? Math.abs(Number(tight[4])) : BORDER_SP) / SP_PER_PT;
  const errors: FragmentOutput["errors"] = [];
  const toLogical = logicalMapper(dirname(file));
  for (const d of parseLog(log, cwd).diagnostics) {
    if (d.severity !== "error" || d.message.startsWith("Preview: ")) continue;
    let id: string | null = null;
    if (d.file !== null && toLogical(d.file) === file && d.line !== null) {
      for (const [fid, r] of lines) if (d.line >= r.from && d.line <= r.to) id = fid;
    }
    errors.push({ id, message: d.message });
  }
  return { boxes, borderPt, errors };
}

/**
 * A fragment's outcome: its box, or why it has none (its own first error, else the preamble's,
 * else nothing typeset).
 */
export function fragmentResult(out: FragmentOutput, id: string): { box: FragmentBox } | { error: string } {
  const own = out.errors.find((e) => e.id === id);
  const box = out.boxes.find((b) => b.id === id);
  if (!own && out.pdf && box && (box.widthPt > 0 || box.heightPt + box.depthPt > 0)) return { box };
  const error = own ?? out.errors.find((e) => e.id === null);
  return { error: error?.message ?? "TeX typeset nothing for this fragment." };
}

/** The job's output from the cache, or null. */
export async function cachedFragments(job: FragmentJob): Promise<FragmentOutput | null> {
  const started = Date.now();
  const hash = fragmentHash(job, fragmentSource(job).text);
  return readCache(job.outDir, hash, started);
}

/**
 * Compile the job's fragments with the root's engine (see the header), from the cache when it
 * has them. Rejects when `signal` aborts (the run's process group is killed) or TeX cannot
 * start; TeX's own failures are in the output's `errors`.
 */
export async function compileFragments(job: FragmentJob, signal?: AbortSignal): Promise<FragmentOutput> {
  const started = Date.now();
  let source = fragmentSource(job);
  const hash = fragmentHash(job, source.text);
  const hit = await readCache(job.outDir, hash, started);
  if (hit) return hit;
  await fsp.mkdir(job.outDir, { recursive: true });
  const name = `frag-${hash.slice(0, 16)}`;
  let run: TexRun;
  try {
    run = await runTex(job, name, source.text, signal);
    if (job.format && /Fatal format file error|I can't find the format file/.test(run.log + run.output)) {
      job = { ...job, format: null };
      source = fragmentSource(job);
      run = await runTex(job, name, source.text, signal);
    }
  } catch (e) {
    // Aborted, or TeX could not start: nothing of the run stays (its .tex, .log, .pdf).
    await tidy(job.outDir, name, null);
    throw e;
  }
  const ids = job.fragments.map((f) => f.id);
  const parsed = parseFragmentLog(run.log, join(job.outDir, `${name}.tex`), job.cwd, ids, source.lines);
  let pdf: Uint8Array | null = null;
  try {
    if (parsed.boxes.length) pdf = new Uint8Array(await fsp.readFile(join(job.outDir, `${name}.pdf`)));
  } catch {
    // No PDF: every fragment reports its error.
  }
  if (run.stopped) parsed.errors.unshift({ id: null, message: run.stopped });
  else if (!run.log && run.output.trim()) parsed.errors.unshift({ id: null, message: run.output.trim().split(/\r?\n/).slice(-3).join(" ") });
  const out: FragmentOutput = { hash, pdf, ...parsed, usedFormat: !!job.format, cached: false, durationMs: Date.now() - started };
  await tidy(job.outDir, name, !run.stopped && !!run.log ? out : null);
  return out;
}

/** One job per root at a time (see Queue). */
export class FragmentQueue {
  private running: AbortController | null = null;
  private waiting: { job: FragmentJob; resolve: (o: FragmentOutput | null) => void; reject: (e: unknown) => void } | null = null;
  private disposed = false;

  /** The job's output; null when a newer job replaced it or the queue was disposed. */
  async run(job: FragmentJob): Promise<FragmentOutput | null> {
    const hit = await cachedFragments(job);
    if (hit || this.disposed) return hit;
    this.waiting?.resolve(null);
    return new Promise((resolve, reject) => {
      this.waiting = { job, resolve, reject };
      this.pump();
    });
  }

  /** Stop the running compile (its process group is killed) and drop the waiting one. */
  dispose(): void {
    this.disposed = true;
    this.waiting?.resolve(null);
    this.waiting = null;
    this.running?.abort();
  }

  private pump(): void {
    const next = this.waiting;
    if (this.running || !next || this.disposed) return;
    this.waiting = null;
    const controller = new AbortController();
    this.running = controller;
    compileFragments(next.job, controller.signal)
      .then(next.resolve, (e: unknown) => (controller.signal.aborted ? next.resolve(null) : next.reject(e)))
      .finally(() => {
        this.running = null;
        this.pump();
      });
  }
}

function fragmentHash(job: FragmentJob, source: string): string {
  return createHash("sha1").update(`${job.engine}\0${job.stamp}\0${source}`).digest("hex");
}

interface TexRun {
  log: string;
  output: string;
  /** Why the run was stopped (timeout, stall), or null. */
  stopped: string | null;
}

/** Run the engine on `<name>.tex` in its own process group (see Runs). */
async function runTex(job: FragmentJob, name: string, text: string, signal?: AbortSignal): Promise<TexRun> {
  const file = join(job.outDir, `${name}.tex`);
  const log = join(job.outDir, `${name}.log`);
  await fsp.writeFile(file, text);
  await fsp.rm(log, { force: true });
  const args = [
    "-interaction=nonstopmode",
    "-file-line-error",
    `-output-directory=${job.outDir}`,
    // By name, found through TEXFORMATS (see the compiler's runEngine).
    ...(job.format ? [`-fmt=${job.format.name}`] : []),
    file,
  ];
  const timeoutMs = job.timeoutMs ?? TIMEOUT_MS[job.engine];
  const { output, stopped } = await new Promise<{ output: string; stopped: string | null }>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("The fragment compile was cancelled."));
      return;
    }
    const child = spawn(texTool(job.binDir, job.engine), args, {
      cwd: job.cwd,
      env: { ...texEnv(job.binDir), ...(job.format ? { TEXFORMATS: job.format.dir + delimiter } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    job.children?.add(child);
    let out = "";
    let bytes = 0;
    let stopped: string | null = null;
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      out = (out + chunk.toString("utf8")).slice(-16 * 1024);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      stopped = `The fragment compile took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`;
      killTree(child);
    }, timeoutMs);
    const stopWatch = watchStall(
      {
        progress: () => fsp.stat(log).then((st) => bytes + st.size, () => bytes),
        cpu: () => (child.pid ? groupCpuSeconds(child.pid) : Promise.resolve(null)),
      },
      () => {
        stopped = stallMessage(job.engine, STALL_MS);
        killTree(child);
      },
      STALL_MS,
    );
    const abort = () => killTree(child);
    signal?.addEventListener("abort", abort);
    const end = () => {
      clearTimeout(timer);
      stopWatch();
      signal?.removeEventListener("abort", abort);
      job.children?.delete(child);
    };
    child.on("error", (err) => {
      end();
      reject(err);
    });
    child.on("close", () => {
      end();
      if (signal?.aborted) reject(new Error("The fragment compile was cancelled."));
      else resolve({ output: out, stopped });
    });
  });
  let logText = "";
  try {
    logText = await fsp.readFile(log, "utf8");
  } catch {
    // A run that died before writing its log reports its output.
  }
  return { log: logText, output, stopped };
}

/** A cached output (see Cache), or null. */
async function readCache(outDir: string, hash: string, started: number): Promise<FragmentOutput | null> {
  const base = join(outDir, `frag-${hash.slice(0, 16)}`);
  try {
    const meta = JSON.parse(await fsp.readFile(`${base}.json`, "utf8")) as Pick<FragmentOutput, "hash" | "boxes" | "borderPt" | "errors" | "usedFormat">;
    if (meta.hash !== hash) return null;
    const pdf = meta.boxes.length ? new Uint8Array(await fsp.readFile(`${base}.pdf`)) : null;
    return { ...meta, pdf, cached: true, durationMs: Date.now() - started };
  } catch {
    return null;
  }
}

/**
 * After a run: its files other than the PDF go; `out` (a run that finished) is cached, and the
 * oldest entries past CACHE_ENTRIES are dropped.
 */
async function tidy(outDir: string, name: string, out: FragmentOutput | null): Promise<void> {
  const names = await fsp.readdir(outDir).catch(() => [] as string[]);
  for (const f of names) {
    if (f.startsWith(`${name}.`) && !f.endsWith(".pdf")) await fsp.rm(join(outDir, f), { force: true });
  }
  if (!out) {
    await fsp.rm(join(outDir, `${name}.pdf`), { force: true });
    return;
  }
  const { hash, boxes, borderPt, errors, usedFormat } = out;
  await fsp.writeFile(join(outDir, `${name}.json`), JSON.stringify({ hash, boxes, borderPt, errors, usedFormat }));
  const entries = names.filter((f) => f.endsWith(".json") && f.startsWith("frag-"));
  if (entries.length < CACHE_ENTRIES) return;
  const aged = await Promise.all(
    entries.map(async (f) => ({ f, at: (await fsp.stat(join(outDir, f)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  aged.sort((a, b) => a.at - b.at);
  for (const { f } of aged.slice(0, entries.length - CACHE_ENTRIES + 1)) {
    const base = f.slice(0, -5);
    await fsp.rm(join(outDir, `${base}.json`), { force: true });
    await fsp.rm(join(outDir, `${base}.pdf`), { force: true });
  }
}

function lineCount(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
