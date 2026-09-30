import { createHash } from "crypto";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, sep } from "path";
import {
  BuildMode,
  CompileOptions,
  CompileResult,
  Compiler,
} from "./tex/compiler";
import { TexDiagnostic } from "./tex/logParser";
import { detectEngine, Engine } from "./tex/project";
import { synctexStamp } from "./tex/synctex";
import type LatexLivePlugin from "./main";

export type SessionEvent = "start" | "result" | "failure";

/**
 * A compile's PDF with the text of the editor files it read (design 4.6): PDF crops show a
 * block only while its text is still the one compiled. Every result that wrote a PDF gets one.
 */
export interface CompiledPdf {
  /** Unique across sessions: crops key on it. */
  readonly seq: number;
  readonly pdfPath: string;
  readonly pdf: Uint8Array;
  /**
   * The project files open in editors, as they were on disk when the compile started (LF line
   * breaks), by absolute path: usually one to three files, read in well under a millisecond.
   */
  readonly sources: ReadonlyMap<string, string>;
  /**
   * The mtime of the result's .synctex.gz when it landed (null without one): a later value is a
   * later pass's, whose lines are not this PDF's (crops query SyncTeX while compiles run).
   */
  readonly synctex: number | null;
}

let compiledSeq = 0;

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
  /** The last result that wrote a PDF, with the sources its compile read (crops). */
  compiled: CompiledPdf | null = null;
  /** The open editors' files as the running compile started. */
  private sources = new Map<string, string>();
  private listeners = new Set<(e: SessionEvent) => void>();

  constructor(
    private plugin: LatexLivePlugin,
    readonly root: string,
  ) {
    this.compiler = new Compiler(root, () => this.options(), {
      onStart: (mode) => {
        this.compiling = mode;
        this.engine = this.detectEngine();
        this.sources = this.readSources();
        this.emit("start");
      },
      onResult: (r) => {
        this.compiling = null;
        this.last = r;
        this.failure = null;
        if (r.pdfData) this.lastPdf = r.pdfData;
        if (r.pdfWritten && r.pdfData) {
          this.compiled = { seq: ++compiledSeq, pdfPath: r.pdfPath, pdf: r.pdfData, sources: this.sources, synctex: synctexStamp(r.pdfPath) };
        }
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

  /**
   * The files of this project open in editors, from disk (what the compile reads): the root,
   * the last compile's inputs and files under the root's folder.
   */
  private readSources(): Map<string, string> {
    const out = new Map<string, string>();
    const { deps, rootDir } = this.compiler;
    for (const file of this.plugin.openTexFiles()) {
      if (file !== this.root && !deps.has(file) && !file.startsWith(rootDir + sep)) continue;
      try {
        out.set(file, readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
      } catch {
        // A file that is gone has nothing to crop.
      }
    }
    return out;
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
