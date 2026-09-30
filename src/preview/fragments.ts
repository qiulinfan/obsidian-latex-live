import { readFileSync } from "fs";
import { dirname, join } from "path";
import { readAuxDefinitions } from "../tex/aux";
import { readyPreambleFormat } from "../tex/compiler";
import { FragmentJob, FragmentOutput, FragmentQueue, bodyStamp, fragmentContext, fragmentResult, preambleParts } from "../tex/fragment";
import { EngineSetting, detectEngine, preambleOf } from "../tex/project";
import { trimToInk } from "./blockCrop";
import type { PdfDoc } from "./pdfRenderer";

// Fragment renders for the render hover (design 4.7, 4.8): TeX the hover could not draw otherwise
// (a formula MathJax rejects, a block without a fresh PDF crop), typeset by the root's own engine
// and preamble (src/tex/fragment.ts) and shown as a paper card. Free of the obsidian module:
// main.ts passes Obsidian's pdf.js in.
//   Jobs    built per request from what the editors hold now (the root's buffer, else its file):
//           the preamble, the engine (the magic comment, the setting, latexmkrc, the packages),
//           pdfLaTeX's preamble format when the root's compile left it ready ("Cache the
//           preamble"), the body's definitions, the labels of the last compile's .aux, and a stamp
//           of the files the fragment reads (bodyStamp: a figure file, an image). They run
//           in `<build folder>/snippets` ($TMPDIR, never the vault), one queue per root (the
//           newest request waits, older waiting ones are dropped).
//   Cards   the fragment's page drawn by pdf.js at the window's devicePixelRatio with PAD_PT
//           around it: a display or a block (a \linewidth wide box) trimmed to its ink and that
//           padding, inline math whole (its box and the tightpage border). White paper cards
//           (`lsp-lp-paper ll-fragment`), inverted as crops are. Drawings are PNG data URLs (hover
//           only, a few at a time), the last DRAWINGS remembered.
//   Life    a root's queue goes (its running TeX killed) when its preview's session does
//           (`release`), every queue on plugin unload (`dispose`). A render takes its queue
//           before its first await, so one released or disposed meanwhile starts no TeX (a
//           disposed queue runs nothing), and none starts after `dispose`.

export interface FragmentHost {
  binDir(): string | null;
  /** The "Default engine" setting (detectEngine decides with the root's text). */
  engineSetting(): EngineSetting;
  /** "Cache the preamble": pdfLaTeX fragments start from the root's format when it is ready. */
  preambleCache(): boolean;
  /** The build folder of a root document ($TMPDIR). */
  outDirFor(root: string): string;
  /** Text of the open LaTeX editors by absolute path (unsaved edits count). */
  buffers(): ReadonlyMap<string, string>;
  /** Obsidian's pdf.js with its assets (pdfRenderer's `openPdf`); the buffer is transferred. */
  openPdf(data: Uint8Array): Promise<PdfDoc>;
  /** Paper cards invert: "Invert preview colors" with a dark theme. */
  inverted(): boolean;
  /** The document canvases and cards are made in (its window's devicePixelRatio). */
  document: Document;
}

/** A drawn fragment: its image and size in CSS pixels. */
interface Drawing {
  url: string;
  width: number;
  height: number;
}

/** A PDF at 100%: CSS pixels per point. */
const CSS_PER_PT = 4 / 3;
/** Padding around a drawing's ink, in points. */
const PAD_PT = 3;
const DRAWINGS = 50;
const ID = "hover";

export class FragmentService {
  private queues = new Map<string, FragmentQueue>();
  private drawings = new Map<string, Drawing>();
  private disposed = false;

  constructor(private readonly host: FragmentHost) {}

  /**
   * `body` (TeX for a preview environment: `$..$`, a display environment, a block) typeset with
   * the engine and preamble of `root`: a paper card, TeX's message, or null (no TeX, or a newer
   * request of the root replaced this one before it ran).
   */
  async render(root: string, body: string, inline: boolean): Promise<HTMLElement | { error: string } | null> {
    const binDir = this.host.binDir();
    if (!binDir || this.disposed) return null;
    const buffers = this.host.buffers();
    let text = buffers.get(root);
    if (text === undefined) {
      try {
        text = readFileSync(root, "utf8");
      } catch {
        return { error: `The root document cannot be read: ${root}` };
      }
    }
    const parts = preambleParts(text);
    if (!parts) return { error: "The root document has no \\begin{document}." };
    const engine = detectEngine(text, dirname(root), this.host.engineSetting());
    const outDir = this.host.outDirFor(root);
    const preamble = preambleOf(text);
    // Taken before the format check's await: a release or dispose meanwhile disposes this queue,
    // and a disposed queue starts no TeX.
    let queue = this.queues.get(root);
    if (!queue) this.queues.set(root, (queue = new FragmentQueue()));
    const format =
      engine === "pdflatex" && this.host.preambleCache() && preamble !== null
        ? await readyPreambleFormat(outDir, root, engine, preamble)
        : null;
    const context = fragmentContext(root, buffers);
    const job: FragmentJob = {
      engine,
      binDir,
      cwd: dirname(root),
      outDir: join(outDir, "snippets"),
      preamble: parts.preamble,
      format: format && { name: format.name, dir: outDir, rest: parts.rest },
      definitions: context.definitions,
      labels: readAuxDefinitions(outDir),
      fragments: [{ id: ID, body, inline }],
      stamp: `${context.stamp}\n${format?.mtime ?? ""}\n${bodyStamp(body, dirname(root), context.graphics)}`,
    };
    const out = await queue.run(job);
    if (!out) return null;
    const result = fragmentResult(out, ID);
    if ("error" in result) return result;
    return this.card(await this.draw(out, result.box.page, inline));
  }

  /** The session of `root` went away (its preview closed): its fragment compile stops. */
  release(root: string): void {
    this.queues.get(root)?.dispose();
    this.queues.delete(root);
  }

  /** Plugin unload: every running fragment compile is killed, and none starts any more. */
  dispose(): void {
    this.disposed = true;
    for (const q of this.queues.values()) q.dispose();
    this.queues.clear();
    this.drawings.clear();
  }

  /** The fragment's page drawn (see Cards), remembered by the job's hash. */
  private async draw(out: FragmentOutput, pageNumber: number, inline: boolean): Promise<Drawing> {
    const dpr = this.host.document.defaultView?.devicePixelRatio || 1;
    const key = `${out.hash}|${pageNumber}|${inline ? 1 : 0}|${dpr}`;
    const hit = this.drawings.get(key);
    if (hit) {
      this.drawings.delete(key);
      this.drawings.set(key, hit);
      return hit;
    }
    const doc = await this.host.openPdf(out.pdf!.slice());
    try {
      const page = await doc.getPage(pageNumber);
      const scale = CSS_PER_PT * dpr;
      // The page is the box itself: the padding goes around it.
      const pad = Math.round(PAD_PT * scale);
      const viewport = page.getViewport({ scale, offsetX: pad, offsetY: pad });
      const canvas = this.host.document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width) + 2 * pad);
      canvas.height = Math.max(1, Math.ceil(viewport.height) + 2 * pad);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No canvas to draw the PDF on.");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      const drawn = inline ? canvas : trimToInk(canvas, pad);
      const drawing: Drawing = { url: drawn.toDataURL("image/png"), width: drawn.width / dpr, height: drawn.height / dpr };
      this.drawings.set(key, drawing);
      if (this.drawings.size > DRAWINGS) this.drawings.delete(this.drawings.keys().next().value!);
      return drawing;
    } finally {
      void doc.destroy();
    }
  }

  private card(d: Drawing): HTMLElement {
    const doc = this.host.document;
    const card = doc.createElement("div");
    card.className = this.host.inverted() ? "lsp-lp-paper ll-fragment is-inverted" : "lsp-lp-paper ll-fragment";
    const img = card.appendChild(doc.createElement("img"));
    img.src = d.url;
    img.width = Math.round(d.width);
    img.height = Math.round(d.height);
    img.alt = "";
    return card;
  }
}
