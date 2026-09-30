import { ChildProcess, spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, promises as fsp } from "fs";
import { basename, delimiter, dirname, extname, join, resolve, sep } from "path";
import { texEnv, texTool, workingBiber } from "./binaries";
import { ParsedLog, parseLog } from "./logParser";
import { Engine, logicalMapper, preambleOf } from "./project";
import { groupCpuSeconds, stallMessage, STALL_MS, watchStall } from "./watchdog";

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
  /** The run produced a PDF (possibly with errors). */
  pdfWritten: boolean;
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

const RUN_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL = 64 * 1024;

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
  private children = new Set<ChildProcess>();
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
    for (const child of this.children) killTree(child);
    this.children.clear();
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
      ...(o.shellEscape ? ["-shell-escape"] : []),
      ...(biber && biber !== texTool(o.binDir, "biber")
        ? ["-e", `$biber = q{"${biber}" %O %S}`]
        : []),
      basename(this.root),
    ];
    await this.removeLog(o.outDir);
    const { output, stalled } = await this.exec(
      texTool(o.binDir, "latexmk"),
      args,
      o,
      this.logPath(o.outDir, this.jobName),
    );
    const rawLog = await this.readLog(o.outDir, this.jobName);
    const run = { rawLog, output, stalled, log: parseLog(rawLog, this.rootDir) };
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
    let pdfWritten = run.log.pages !== null;
    if (!pdfWritten && mode === "full" && existsSync(pdfPath)) {
      // latexmk may skip TeX entirely when nothing changed.
      pdfWritten = (await fsp.stat(pdfPath)).mtimeMs >= started - 1000;
    }
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
    } else if (!run.rawLog && run.output.trim()) {
      // No log at all (engine missing, bad option): surface what it printed.
      run.log.diagnostics.push({
        severity: "error",
        file: null,
        line: null,
        message: run.output.trim().split(/\r?\n/).slice(-3).join(" "),
      });
    }
    return {
      mode,
      engine: o.engine,
      pdfWritten,
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
    const { output, stalled } = await this.exec(
      texTool(o.binDir, o.engine),
      args,
      o,
      this.logPath(o.outDir, this.jobName),
      fmtBase ? { TEXFORMATS: dirname(fmtBase) + delimiter } : {},
    );
    const rawLog = await this.readLog(o.outDir, this.jobName);
    return { rawLog, output, stalled, log: parseLog(rawLog, this.rootDir) };
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
   * Run a TeX tool in its own process group and resolve with its output.
   * The stall watchdog kills a run whose `log` and output stop growing while
   * it uses no CPU (XeLaTeX waiting for a macOS font download never returns)
   * instead of waiting for the 5-minute timeout; `finish` reports it.
   */
  private exec(
    cmd: string,
    args: string[],
    o: CompileOptions,
    log: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<{ output: string; stalled: boolean }> {
    return new Promise((resolvePromise, reject) => {
      if (this.disposed) {
        reject(new Error("compiler disposed"));
        return;
      }
      const child = spawn(cmd, args, {
        cwd: this.rootDir,
        env: { ...texEnv(o.binDir), ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      this.children.add(child);
      let output = "";
      let outputBytes = 0;
      const collect = (chunk: Buffer) => {
        outputBytes += chunk.length;
        output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => killTree(child), RUN_TIMEOUT_MS);
      let stalled = false;
      const stopWatch = watchStall(
        {
          progress: () =>
            fsp.stat(log).then(
              (st) => outputBytes + st.size,
              () => outputBytes,
            ),
          cpu: () =>
            child.pid ? groupCpuSeconds(child.pid) : Promise.resolve(null),
        },
        () => {
          stalled = true;
          killTree(child);
        },
        o.stallMs ?? STALL_MS,
      );
      child.on("error", (err) => {
        clearTimeout(timer);
        stopWatch();
        this.children.delete(child);
        reject(err);
      });
      child.on("close", () => {
        clearTimeout(timer);
        stopWatch();
        this.children.delete(child);
        if (this.disposed) reject(new Error("compiler disposed"));
        else resolvePromise({ output, stalled });
      });
    });
  }
}

interface EngineRun {
  rawLog: string;
  output: string;
  log: ParsedLog;
  /** The stall watchdog stopped the run. */
  stalled: boolean;
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

/** Kill a spawned TeX tool and its children (latexmk runs the engine). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }
}
