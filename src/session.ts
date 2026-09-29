import { createHash } from "crypto";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  BuildMode,
  CompileOptions,
  CompileResult,
  Compiler,
} from "./tex/compiler";
import { TexDiagnostic } from "./tex/logParser";
import { detectEngine, Engine } from "./tex/project";
import type LatexLivePlugin from "./main";

export type SessionEvent = "start" | "result" | "failure";

/** Build output folder of a root document: `$TMPDIR/obsidian-latex-live/<hash>`. */
export function outDirFor(root: string): string {
  const id = createHash("sha1").update(root).digest("hex").slice(0, 12);
  return join(tmpdir(), "obsidian-latex-live", id);
}

/**
 * One root document being previewed: its compiler, the latest result, and
 * the views listening to it. Created by preview views, disposed when the
 * last one lets go.
 */
export class LatexSession {
  readonly compiler: Compiler;
  compiling: BuildMode | null = null;
  last: CompileResult | null = null;
  /** Bytes of the most recent PDF, kept for views opened later. */
  lastPdf: Uint8Array | null = null;
  failure: string | null = null;
  engine: Engine = "pdflatex";
  refs = 0;
  private listeners = new Set<(e: SessionEvent) => void>();

  constructor(
    private plugin: LatexLivePlugin,
    readonly root: string,
  ) {
    this.compiler = new Compiler(root, () => this.options(), {
      onStart: (mode) => {
        this.compiling = mode;
        this.engine = this.detectEngine();
        this.emit("start");
      },
      onResult: (r) => {
        this.compiling = null;
        this.last = r;
        this.failure = null;
        if (r.pdfData) this.lastPdf = r.pdfData;
        this.emit("result");
      },
      onFailure: (err) => {
        this.compiling = null;
        this.failure = err.message;
        this.emit("failure");
      },
    });
  }

  get outDir(): string {
    return outDirFor(this.root);
  }

  request(mode: BuildMode = "fast"): void {
    if (!this.plugin.texBinDir()) {
      this.failure =
        "No TeX installation found. Install MacTeX/TeX Live or set the " +
        "TeX binary directory in the LaTeX Live settings.";
      this.emit("failure");
      return;
    }
    this.compiler.request(mode);
  }

  onEvent(cb: (e: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Diagnostics of the last compile that belong to `file`. */
  diagnosticsFor(file: string): TexDiagnostic[] {
    if (!this.last) return [];
    return this.last.log.diagnostics.filter(
      (d) => (d.file ?? this.root) === file,
    );
  }

  dispose(): void {
    this.compiler.dispose();
    this.listeners.clear();
  }

  private detectEngine(): Engine {
    let text = "";
    try {
      text = readFileSync(this.root, "utf8");
    } catch {
      // A missing root surfaces as a compile error.
    }
    return detectEngine(text, dirname(this.root), this.plugin.settings.engine);
  }

  private options(): CompileOptions {
    const s = this.plugin.settings;
    this.engine = this.detectEngine();
    return {
      binDir: this.plugin.texBinDir() ?? "",
      engine: this.engine,
      outDir: this.outDir,
      preambleCache: s.preambleCache,
      shellEscape: s.shellEscape,
    };
  }

  private emit(e: SessionEvent): void {
    for (const cb of this.listeners) cb(e);
    this.plugin.sessionChanged(this, e);
  }
}
