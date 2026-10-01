import { createHash } from "crypto";
import { existsSync, promises as fsp } from "fs";
import { basename, delimiter, dirname, extname, join, relative, resolve, sep } from "path";
import { texEnv, texTool, workingBiber } from "./binaries";
import { ParsedLog, parseLog } from "./logParser";
import { Engine, logicalMapper, preambleOf } from "./project";
import { runTex, type TexRunResult } from "./run";
import { stallMessage, STALL_MS } from "./watchdog";

export type BuildMode = "fast" | "full";

export interface CompileOptions {
  binDir: string;
  engine: Engine;
  outDir: string;
  /** Precompile the preamble into a format (pdfLaTeX only). */
  preambleCache: boolean;
  shellEscape: boolean;
  /** Stop a run with no log growth and no CPU use for this long (default 30 s). */
  stallMs?: number;
}

export interface CompileResult {
  mode: BuildMode;
  engine: Engine;
  /** A current PDF was supplied: newly written (possibly with errors), or verified up to date. */
  pdfWritten: boolean;
  /** latexmk verified the existing PDF as up to date without running TeX. */
  pdfReused?: boolean;
  pdfPath: string;
  pdfData: Uint8Array | null;
  log: ParsedLog;
  rawLog: string;
  durationMs: number;
  passes: number;
  usedPreambleCache: boolean;
}

export interface CompilerListener {
  onStart(mode: BuildMode): void;
  onResult(result: CompileResult): void;
  onFailure(error: Error): void;
}

interface FormatCache {
  key: string;
  fmtBase: string;
  /** Project-local files the preamble read, with their mtimes at build. */
  inputs: Map<string, number>;
  state: "building" | "ready" | "failed";
}

/**
 * Compiles one root document into a private output directory. At most one
 * compile runs at a time; requests arriving meanwhile coalesce into a single
 * follow-up run, so a stream of edits never starves the preview.
 */
export class Compiler {
  readonly rootDir: string;
  readonly jobName: string;
  /** Maps physical paths reported by TeX tools to vault (logical) paths. */
  readonly toLogical: (p: string) => string;
  /** Absolute paths the last compile read (from the -recorder .fls file). */
  deps = new Set<string>();

  private pending: BuildMode | null = null;
  private busy = false;
  private disposed = false;
  /** Aborted on dispose: every running TeX tool's process group is killed. */
  private readonly abort = new AbortController();
  private format: FormatCache | null = null;

  constructor(
    readonly root: string,
    private options: () => CompileOptions,
    private listener: CompilerListener,
  ) {
    this.rootDir = dirname(root);
    this.jobName = basename(root, extname(root));
    this.toLogical = logicalMapper(this.rootDir);
  }

  get compiling(): boolean {
    return this.busy;
  }

  pdfPath(): string {
    return join(this.options().outDir, `${this.jobName}.pdf`);
  }

  request(mode: BuildMode = "fast"): void {
    if (this.disposed) return;
    this.pending = this.pending === "full" || mode === "full" ? "full" : "fast";
    if (!this.busy) void this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.abort.abort();
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (this.pending && !this.disposed) {
        const mode = this.pending;
        this.pending = null;
        this.listener.onStart(mode);
        try {
          const result =
            mode === "full" ? await this.runFull() : await this.runFast();
          if (!this.disposed) this.listener.onResult(result);
        } catch (err) {
          if (!this.disposed) {
            this.listener.onFailure(
              err instanceof Error ? err : new Error(String(err)),
            );
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async runFast(): Promise<CompileResult> {
    const o = this.options();
    const started = Date.now();
    await this.prepareOutDir(o.outDir);
    const rootText = await fsp.readFile(this.root, "utf8");
    const fmt =
      o.engine === "pdflatex" && o.preambleCache
        ? await this.readyFormat(rootText, o)
        : null;

    let passes = 0;
    let usedFormat = fmt !== null;
    let run = await this.runEngine(o, fmt);
    passes++;
    if (usedFormat && /Fatal format file error|I can't find the format file/.test(
        run.rawLog + run.output,
      )) {
      // A broken format must never cost a preview: disable it and retry.
      if (this.format) {
        this.format.state = "failed";
        await fsp.rm(`${this.format.fmtBase}.json`, { force: true });
      }
      usedFormat = false;
      run = await this.runEngine(o, null);
      passes++;
    }
    // One extra pass settles labels and references when nothing newer
    // waits. Show the first pass meanwhile: on slow documents the second
    // pass would otherwise double the wait for any preview at all.
    if (run.log.rerun && !this.pending && !this.disposed) {
      this.listener.onResult(
        await this.finish("fast", o, run, started, passes, usedFormat),
      );
      this.listener.onStart("fast");
      run = await this.runEngine(o, usedFormat ? fmt : null);
      passes++;
    }
    return this.finish("fast", o, run, started, passes, usedFormat);
  }

  private async runFull(): Promise<CompileResult> {
    const o = this.options();
    const started = Date.now();
    await this.prepareOutDir(o.outDir);
    const flag =
      o.engine === "xelatex" ? "-pdfxe" : o.engine === "lualatex" ? "-pdflua" : "-pdf";
    // latexmk takes biber from PATH (binDir first); point it at one that runs.
    const biber = await workingBiber(o.binDir);
    const args = [
      flag,
      "-interaction=nonstopmode",
      "-file-line-error",
      "-synctex=1",
      "-recorder",
      `-outdir=${o.outDir}`,
      // logreq's generated request ledger reads its old checksum and writes new bookkeeping
      // at the end of a biblatex run. Its active flag alone otherwise causes one extra TeX pass
      // after aux/bbl/out/bcf have converged. The public latexmk hook removes only this job's
      // recorder-confirmed generated ledger, preserving every real XML input and existing hook.
      "-e", logreqDependencyHook(await fsp.realpath(o.outDir), this.jobName),
      ...(o.shellEscape ? ["-shell-escape"] : []),
      ...(biber && biber !== texTool(o.binDir, "biber")
        ? ["-e", `$biber = q{"${biber}" %O %S}`]
        : []),
      basename(this.root),
    ];
    await this.removeLog(o.outDir);
    const executed = await this.exec(
      texTool(o.binDir, "latexmk"),
      args,
      o,
      this.logPath(o.outDir, this.jobName),
    );
    const rawLog = await this.readLog(o.outDir, this.jobName);
    const run = { ...executed, rawLog, log: parseLog(rawLog, this.rootDir) };
    return this.finish("full", o, run, started, 1, false);
  }

  private async finish(
    mode: BuildMode,
    o: CompileOptions,
    run: EngineRun,
    started: number,
    passes: number,
    usedPreambleCache: boolean,
  ): Promise<CompileResult> {
    const pdfPath = join(o.outDir, `${this.jobName}.pdf`);
    let pdfData: Uint8Array | null = null;
    // A successful latexmk no-op has no new log or PDF. Its current invocation must
    // explicitly confirm this root and output; an old log or recent mtime is no authority.
    const unchanged = mode === "full" && !run.rawLog && run.code === 0 &&
      !run.stalled && !run.timedOut &&
      await latexmkUnchanged(run.output, this.root, pdfPath, o.engine);
    let pdfWritten = run.log.pages !== null || unchanged;
    if (pdfWritten) {
      try {
        pdfData = new Uint8Array(await fsp.readFile(pdfPath));
      } catch {
        pdfWritten = false;
      }
    }
    await this.readDeps(o.outDir);
    if (run.stalled) {
      run.log.diagnostics.push({
        severity: "error",
        file: null,
        line: null,
        message: stallMessage(o.engine, o.stallMs ?? STALL_MS),
      });
    } else if (run.timedOut) {
      run.log.diagnostics.push({
        severity: "error",
        file: null,
        line: null,
        message: `${mode === "full" ? "latexmk" : o.engine} exceeded the compilation time limit.`,
      });
    } else if (run.code !== 0 && !run.log.diagnostics.some((d) => d.severity === "error")) {
      run.log.diagnostics.push({
        severity: "error",
        file: null,
        line: null,
        message: outputTail(run.output) || `${mode === "full" ? "latexmk" : o.engine} ${run.code === null ? "was terminated" : `exited with code ${run.code}`}.`,
      });
    } else if (unchanged && !pdfWritten) {
      run.log.diagnostics.push({
        severity: "error",
        file: null,
        line: null,
        message: "latexmk reported an up-to-date PDF, but that PDF could not be read.",
      });
    } else if (!run.rawLog && !unchanged && run.code === 0) {
      // No log at all (engine missing, bad option): surface what it printed.
      run.log.diagnostics.push({
        severity: "error",
        file: null,
        line: null,
        message: outputTail(run.output) || `${mode === "full" ? "latexmk" : o.engine} finished without a TeX log.`,
      });
    }
    return {
      mode,
      engine: o.engine,
      pdfWritten,
      ...(unchanged && pdfWritten ? { pdfReused: true } : {}),
      pdfPath,
      pdfData,
      log: run.log,
      rawLog: run.rawLog || run.output,
      durationMs: Date.now() - started,
      passes,
      usedPreambleCache,
    };
  }

  private async runEngine(
    o: CompileOptions,
    fmtBase: string | null,
  ): Promise<EngineRun> {
    const args = [
      "-interaction=nonstopmode",
      "-file-line-error",
      "-synctex=1",
      "-recorder",
      `-output-directory=${o.outDir}`,
      ...(o.shellEscape ? ["-shell-escape"] : []),
      // By name, found through TEXFORMATS: an absolute -fmt path breaks the
      // -recorder temp file name (pdfTeX prefixes it with the output dir).
      ...(fmtBase ? [`-fmt=${basename(fmtBase)}`] : []),
      basename(this.root),
    ];
    await this.removeLog(o.outDir);
    const executed = await this.exec(
      texTool(o.binDir, o.engine),
      args,
      o,
      this.logPath(o.outDir, this.jobName),
      fmtBase ? { TEXFORMATS: dirname(fmtBase) + delimiter } : {},
    );
    const rawLog = await this.readLog(o.outDir, this.jobName);
    return { ...executed, rawLog, log: parseLog(rawLog, this.rootDir) };
  }

  /** Format path when a current preamble format exists; else build one. */
  private async readyFormat(
    rootText: string,
    o: CompileOptions,
  ): Promise<string | null> {
    const preamble = preambleOf(rootText);
    if (preamble === null || /\s/.test(basename(this.root))) return null;
    const key = formatKey(o.engine, preamble);
    const f = this.format;
    if (f && f.key === key) {
      if (f.state !== "ready") return null;
      if (await inputsUnchanged(f.inputs)) return f.fmtBase;
    }
    void this.buildFormat(key, o);
    return null;
  }

  private async buildFormat(key: string, o: CompileOptions): Promise<void> {
    const fmtJob = `${this.jobName}-preamble`;
    const fmtBase = join(o.outDir, fmtJob);
    const cache: FormatCache = {
      key,
      fmtBase,
      inputs: new Map(),
      state: "building",
    };
    this.format = cache;
    const stamp = `${fmtBase}.json`;
    try {
      // Other runs (fragment compiles) take the format only while its stamp says it is ready.
      await fsp.rm(stamp, { force: true });
      await this.exec(
        texTool(o.binDir, o.engine),
        [
          "-ini",
          "-interaction=nonstopmode",
          "-halt-on-error",
          "-recorder",
          `-output-directory=${o.outDir}`,
          `-jobname=${fmtJob}`,
          `&${o.engine}`,
          "mylatexformat.ltx",
          basename(this.root),
        ],
        o,
        this.logPath(o.outDir, fmtJob),
      );
      if (this.format !== cache) return;
      if (!existsSync(`${fmtBase}.fmt`)) {
        cache.state = "failed";
        return;
      }
      const fls = join(o.outDir, `${fmtJob}.fls`);
      for (const p of await readFls(fls, this.toLogical)) {
        if (resolve(p) === resolve(this.root) || !isInside(p, this.rootDir)) {
          continue;
        }
        try {
          cache.inputs.set(p, (await fsp.stat(p)).mtimeMs);
        } catch {
          // Files that vanished simply invalidate on the next check.
        }
      }
      cache.state = "ready";
      const written: FormatStamp = { key, inputs: [...cache.inputs] };
      await fsp.writeFile(stamp, JSON.stringify(written));
    } catch {
      if (this.format === cache) cache.state = "failed";
    }
  }

  private async prepareOutDir(outDir: string): Promise<void> {
    await fsp.mkdir(outDir, { recursive: true });
    // \include writes aux files into matching subdirectories of outDir.
    let text = "";
    try {
      text = await fsp.readFile(this.root, "utf8");
    } catch {
      return;
    }
    for (const m of text.matchAll(/\\include\s*\{([^}]+)\}/g)) {
      const sub = dirname(m[1].trim());
      if (sub && sub !== "." && !sub.startsWith("..")) {
        await fsp.mkdir(join(outDir, sub), { recursive: true });
      }
    }
  }

  private logPath(outDir: string, job: string): string {
    return join(outDir, `${job}.log`);
  }

  /** A run that dies before writing its log must not report the old one. */
  private async removeLog(outDir: string): Promise<void> {
    await fsp.rm(this.logPath(outDir, this.jobName), { force: true });
  }

  private async readLog(outDir: string, job: string): Promise<string> {
    try {
      return await fsp.readFile(this.logPath(outDir, job), "utf8");
    } catch {
      return "";
    }
  }

  private async readDeps(outDir: string): Promise<void> {
    const inputs = await readFls(
      join(outDir, `${this.jobName}.fls`),
      this.toLogical,
    );
    if (!inputs.length) return;
    const deps = new Set<string>([resolve(this.root)]);
    for (const p of inputs) {
      if (!isInside(p, outDir)) deps.add(resolve(p));
    }
    // What the .fls misses: files only the cached preamble format read (a
    // local .sty), and the bibliography, which TeX itself never opens.
    if (this.format?.state === "ready") {
      for (const p of this.format.inputs.keys()) deps.add(p);
    }
    for (const p of await readBibFiles(outDir, this.jobName, this.rootDir)) {
      deps.add(p);
    }
    this.deps = deps;
  }

  /**
   * Run a TeX tool from the root's folder (runTex: its own process group, the stall watchdog,
   * the timeout) and resolve with its output; `finish` reports a stalled run. Rejects once the
   * compiler is disposed (the run's group is killed).
   */
  private async exec(
    cmd: string,
    args: string[],
    o: CompileOptions,
    log: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<TexRunResult> {
    if (this.disposed) throw new Error("compiler disposed");
    let run: TexRunResult;
    try {
      run = await runTex(cmd, args, {
        cwd: this.rootDir,
        env: { ...texEnv(o.binDir), ...extraEnv },
        log,
        stallMs: o.stallMs,
        signal: this.abort.signal,
      });
    } catch (err) {
      if (this.disposed) throw new Error("compiler disposed");
      throw err;
    }
    if (this.disposed) throw new Error("compiler disposed");
    return run;
  }
}

interface EngineRun extends TexRunResult {
  rawLog: string;
  log: ParsedLog;
}

const outputTail = (output: string): string => output.trim().split(/\r?\n/).slice(-3).join(" ");

/** latexmk's current, successful no-work protocol for precisely this document and PDF. */
async function latexmkUnchanged(output: string, root: string, pdf: string, engine: Engine): Promise<boolean> {
  const lines = output.split(/\r?\n/);
  if (!lines.includes(`Latexmk: Nothing to do for '${basename(root)}'.`)) return false;
  const physicalPdf = await fsp.realpath(pdf).catch(() => resolve(pdf));
  const physicalRoot = await fsp.realpath(root).catch(() => resolve(root));
  // latexmk shortens project-local targets relative to its working directory,
  // even when -outdir is absolute. Keep the same exact root/output authority.
  const relativePdf = relative(dirname(root), pdf);
  const physicalRelativePdf = relative(dirname(physicalRoot), physicalPdf);
  const paths = [resolve(pdf), physicalPdf, relativePdf, physicalRelativePdf,
    "./" + relativePdf, "./" + physicalRelativePdf]
    .map((p) => p.replace(/\\/g, "/"));
  for (const line of lines) {
    const targets = /^Latexmk: All targets \((.*)\) are up-to-date$/.exec(line)?.[1].replace(/\\/g, "/");
    if (!targets) continue;
    // The selected -pdf/-pdflua pipeline has one PDF target; -pdfxe also reports
    // its XDV. Compare complete lists: unquoted spaces in paths are ambiguous,
    // so matching a suffix could mistake another directory for our output.
    if (paths.includes(targets)) return true;
    if (engine === "xelatex" && paths.some((xdv) => paths.some((p) =>
      targets === xdv.slice(0, -4) + ".xdv " + p))) return true;
  }
  return false;
}

/** A public latexmk dependency hook, bounded to this build's generated biblatex request ledger. */
function logreqDependencyHook(outDir: string, job: string): string {
  // This is a Perl argument to spawn, not shell code. Single-quoted Perl strings keep $ and @
  // literal; TeX and Perl both accept forward slashes on Windows.
  const literal = (p: string) => `'${p.replace(/\\/g, "/").replace(/'/g, "\\'")}'`;
  const ledger = literal(join(outDir, `${job}.run.xml`));
  const recorder = literal(join(outDir, `${job}.fls`));
  return `add_hook('after_xlatex_analysis', sub {
    my $ledger = ${ledger};
    my $recorder = ${recorder};
    return unless open(my $rf, '<', $recorder);
    my $fls = do { local $/; <$rf> }; close $rf;
    return unless $fls =~ /^OUTPUT \\Q$ledger\\E\\r?$/m;
    return unless open(my $xf, '<', $ledger);
    my $xml = do { local $/; <$xf> }; close $xf;
    return unless $xml =~ /<!-- logreq request file -->/;
    my @owners = ($xml =~ /<(?:internal|external)\\s+package="([^"]+)"/g);
    return unless @owners && !grep { $_ ne 'biblatex' } @owners;
    rdb_remove_files($rule, $ledger);
    # Public latexmk hooks report success with zero.
    return 0;
  });`;
}

/**
 * Existing .bib files a compile asked for: biblatex's datasources (`.bcf`)
 * and BibTeX's `\bibdata` (`.aux`), relative to the root's folder.
 */
export async function readBibFiles(
  outDir: string,
  job: string,
  rootDir: string,
): Promise<string[]> {
  const read = (ext: string) =>
    fsp.readFile(join(outDir, `${job}.${ext}`), "utf8").catch(() => "");
  const [bcf, aux] = await Promise.all([read("bcf"), read("aux")]);
  const names: string[] = [];
  for (const m of bcf.matchAll(/<bcf:datasource\b[^>]*>([^<]+)<\/bcf:datasource>/g)) {
    names.push(m[1].trim());
  }
  for (const m of aux.matchAll(/\\bibdata\{([^}]*)\}/g)) {
    for (const name of m[1].split(",")) {
      const n = name.trim();
      if (n) names.push(extname(n) ? n : `${n}.bib`);
    }
  }
  const out = new Set<string>();
  for (const n of names) {
    const p = resolve(rootDir, n);
    if (existsSync(p)) out.add(p);
  }
  return [...out];
}

/** INPUT paths recorded in a TeX `.fls` file, absolute. */
export async function readFls(
  flsPath: string,
  toLogical: (p: string) => string = resolve,
): Promise<string[]> {
  let text: string;
  try {
    text = await fsp.readFile(flsPath, "utf8");
  } catch {
    return [];
  }
  let pwd = dirname(flsPath);
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("PWD ")) pwd = line.slice(4);
    else if (line.startsWith("INPUT ")) {
      out.add(toLogical(resolve(pwd, line.slice(6))));
    }
  }
  return [...out];
}

/** What a ready preamble format was built for: `<job>-preamble.json` next to the `.fmt`. */
interface FormatStamp {
  key: string;
  /** Project-local files the preamble read, with their mtimes at build. */
  inputs: [string, number][];
}

/** The format cache key of a preamble (preambleOf) for an engine. */
export function formatKey(engine: Engine, preamble: string): string {
  return createHash("sha1").update(engine + "\0" + preamble).digest("hex");
}

/**
 * The preamble format a compile of `root` left in `outDir`, when it is ready for `preamble`
 * (preambleOf of the root's text): its stamp names the key, and the project files it read are
 * unchanged. Its name for `-fmt` (found through `TEXFORMATS=<outDir>:`) and the `.fmt`'s mtime,
 * or null. Fragment compiles use it; a stamp exists only while no build rewrites the format.
 */
export async function readyPreambleFormat(
  outDir: string,
  root: string,
  engine: Engine,
  preamble: string,
): Promise<{ name: string; mtime: number } | null> {
  const name = `${basename(root, extname(root))}-preamble`;
  if (engine !== "pdflatex" || /\s/.test(basename(root))) return null;
  try {
    const stamp = JSON.parse(await fsp.readFile(join(outDir, `${name}.json`), "utf8")) as FormatStamp;
    if (stamp.key !== formatKey(engine, preamble) || !(await inputsUnchanged(new Map(stamp.inputs)))) return null;
    return { name, mtime: (await fsp.stat(join(outDir, `${name}.fmt`))).mtimeMs };
  } catch {
    return null;
  }
}

async function inputsUnchanged(inputs: Map<string, number>): Promise<boolean> {
  for (const [p, mtime] of inputs) {
    try {
      if ((await fsp.stat(p)).mtimeMs !== mtime) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isInside(p: string, dir: string): boolean {
  const a = resolve(p);
  const d = resolve(dir);
  return a === d || a.startsWith(d.endsWith(sep) ? d : d + sep);
}
