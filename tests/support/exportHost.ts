// A Node host for the HTML export (src/export/exporter.ts): the plugin's Compiler runs the full
// builds (latexmk with a working biber, like a session's "Full build"), the work folder is the
// build folder's `-export` sibling, math is Obsidian's MathJax in jsdom (tests/support/mathjax.ts)
// with the woff files of node_modules/mathjax (byte for byte Obsidian's), and idle() is a macrotask. TeX tests use it on fresh copies of
// the fixture projects in $TMPDIR, never on the fixtures themselves. `emitDoc` runs the emitter
// alone on a synthetic document with a handwritten probe log (no TeX).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { deflateSync } from "node:zlib";
import { refNames, type LatexRefs } from "../../src/editor/latexRefs";
import { readBbl, readBibcites } from "../../src/export/bibliography";
import { emitHtml, type EmitOutput } from "../../src/export/emit";
import { exportDirFor, type ExportHost } from "../../src/export/exporter";
import { drawingKey } from "../../src/export/fragments";
import { ExportImages, type PdfImages } from "../../src/export/images";
import type { CodeTokenizer } from "../../src/export/listings";
import { ExportMath, type MathEnv } from "../../src/export/math";
import { planExport, reparse } from "../../src/export/plan";
import { readProbeLog, StepQueue } from "../../src/export/probeLog";
import { profileOf, type Profile } from "../../src/export/profiles";
import { ReportBuilder } from "../../src/export/report";
import { readAuxLabels } from "../../src/tex/aux";
import { parseBib } from "../../src/tex/bib";
import { resolveTexBinDir } from "../../src/tex/binaries";
import { CompileResult, Compiler } from "../../src/tex/compiler";
import { graphicsPaths } from "../../src/tex/graphics";
import { projectDefinitions } from "../../src/tex/macros";
import { detectEngine, Engine, stripComments } from "../../src/tex/project";
import { theoremMap } from "../../src/tex/theorems";
import { obsidianMathJax } from "./mathjax";

export const texBin = process.env.TEXBIN ?? resolveTexBinDir("");

/** Obsidian's MathJax in jsdom, its fonts read from node_modules/mathjax. */
export async function nodeMathEnv(): Promise<MathEnv> {
  const { window, MathJax } = await obsidianMathJax();
  const fonts = join(process.cwd(), "node_modules", "mathjax", "es5", "output", "chtml", "fonts", "woff-v2");
  return { mj: MathJax, document: window.document, font: async (file) => new Uint8Array(await readFile(join(fonts, file))) };
}

/** The temporary folders the helpers made (removeExportTemps deletes them). */
const temps: string[] = [];

export function removeExportTemps(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A fresh copy of `tests/fixtures/<name>` in $TMPDIR: its root and folder. */
export function fixtureCopy(name: string): { dir: string; root: string } {
  const source = isAbsolute(name) ? name : join(process.cwd(), "tests", "fixtures", name);
  const label = isAbsolute(name) ? basename(name) : name.replace(/[\\/]/g, "-");
  const dir = mkdtempSync(join(tmpdir(), `latex-live-export-${label}-`));
  temps.push(dir);
  cpSync(source, dir, { recursive: true });
  return { dir, root: join(dir, "main.tex") };
}

export interface NodeExportHost extends ExportHost {
  /** Full builds the export asked for. */
  builds: number;
}

/** A host for `root` with its build folder in a fresh temporary folder. */
export function nodeExportHost(root: string, o: { engine?: Engine; stallMs?: number } = {}): NodeExportHost {
  const parent = mkdtempSync(join(tmpdir(), "latex-live-export-build-"));
  temps.push(parent);
  const buildDir = join(parent, "out");
  const engine = o.engine ?? detectEngine(readFileSync(root, "utf8"), join(root, ".."), "auto");
  const host: NodeExportHost = {
    binDir: texBin ?? "",
    engine,
    shellEscape: false,
    buildDir,
    workDir: exportDirFor(buildDir),
    builds: 0,
    build(signal: AbortSignal): Promise<CompileResult> {
      host.builds++;
      return new Promise((resolve, reject) => {
        const compiler = new Compiler(
          root,
          () => ({ binDir: host.binDir, engine, outDir: buildDir, preambleCache: false, shellEscape: false, stallMs: o.stallMs }),
          {
            onStart: () => undefined,
            onResult: (r) => {
              compiler.dispose();
              resolve(r);
            },
            onFailure: (e) => {
              compiler.dispose();
              reject(e);
            },
          },
        );
        signal.addEventListener("abort", () => {
          compiler.dispose();
          reject(new Error("The build was cancelled."));
        });
        compiler.request("full");
      });
    },
    math: nodeMathEnv,
    idle: () => new Promise((r) => setTimeout(r, 0)),
  };
  return host;
}

export interface EmitDoc {
  /** The document class (default article), its options first when it has some (`[lang=cn]elegantbook`), and the preamble. */
  documentclass?: string;
  preamble: string;
  body: string;
  /** The probe's records (handwritten). */
  llx: string;
  /** The build's .aux, .bbl and the .bib's text. */
  aux?: string;
  bbl?: string | null;
  bib?: string;
  /** More project files (path from the root's folder -> contents). */
  files?: Record<string, string | Uint8Array>;
  /** Fragments drawn (plan id -> prepared SVG). */
  fragments?: ReadonlyMap<number, string>;
  pdfImages?: PdfImages;
  code?: CodeTokenizer;
}

/** Emit `main.tex` (the body of a document) with a handwritten probe log and build files, in a temporary folder (`dir`). */
export async function emitDoc(o: EmitDoc): Promise<EmitOutput & { report: ReportBuilder; dir: string; profile: Profile }> {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-export-doc-"));
  temps.push(dir);
  const build = join(dir, "out");
  mkdirSync(build);
  const root = join(dir, "main.tex");
  const [, options = "", cls] = /^(\[[^\]]*\])?(.*)$/.exec(o.documentclass ?? "article")!;
  writeFileSync(root, `\\documentclass${options}{${cls}}\n${o.preamble}\n\\begin{document}\n${o.body}\n\\end{document}\n`);
  for (const [path, data] of Object.entries(o.files ?? {})) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
  writeFileSync(join(build, "main.aux"), o.aux ?? "");
  const defs = projectDefinitions(root);
  const sources = defs.files.map((f) => stripComments(readFileSync(f, "utf8")));
  const theorems = theoremMap(sources);
  const math = ExportMath.create(await nodeMathEnv(), { statements: defs.statements, physics: false, unsupported: defs.unsupported });
  const log = readProbeLog(o.llx);
  // Parsed again with the census's specs, as the exporter does after the probe.
  const plan = reparse(planExport(root, { defs, theorems, mathOk: (tex, display) => math.ok(tex, display) }), log.envs);
  const refs: LatexRefs = { labels: readAuxLabels(build), numbers: new Map(), cites: parseBib(o.bib ?? ""), names: refNames(sources, theorems), theorems, checkpoints: new Map() };
  const entries = o.bbl ? readBbl(o.bbl) : [];
  const images = new ExportImages(dir, graphicsPaths(sources), o.pdfImages);
  await images.load(plan, new AbortController().signal);
  const report = new ReportBuilder();
  const profile = profileOf(readFileSync(root, "utf8"), sources);
  const out = await emitHtml({
    plan,
    log,
    queue: new StepQueue(log, plan.visits),
    refs,
    theorems,
    defs,
    profile,
    math,
    bib: { entries: new Map(entries.map((e) => [e.key, e])), bbl: entries.length ? null : (o.bbl ?? null), bibcites: readBibcites([o.aux ?? ""]) },
    fragments: new Map([...(o.fragments ?? [])].map(([id, svg]) => [drawingKey(0, id), svg])),
    images,
    code: o.code,
    report,
    idle: async () => undefined,
    signal: new AbortController().signal,
  });
  return { ...out, report, dir, profile };
}

/** A PNG of `w`x`h` pixels (one colour), with a pHYs chunk when `dpi` is given. */
export function testPng(w: number, h: number, dpi?: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const phys = Buffer.alloc(9);
  if (dpi) {
    phys.writeUInt32BE(Math.round(dpi / 0.0254), 0);
    phys.writeUInt32BE(Math.round(dpi / 0.0254), 4);
    phys[8] = 1;
  }
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => [60, 113, 183]).flat()])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(dpi ? [chunk("pHYs", phys)] : []),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
