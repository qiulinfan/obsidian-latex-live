// PDF crops (design 4.6; src/preview/blockCrop.ts): the pure parts (where a block's text was
// compiled, which lines SyncTeX is asked about, the region its records give) on synthetic
// records, and T-L10..T-L12 on a real XeLaTeX compile of the synthetic elegantbook fixture
// (skipped without xelatex or the Fandol fonts): SyncTeX's records for the fixture's blocks,
// freshness after lines are inserted, and no synctex or xelatex process left after dispose; and
// the sessions' source snapshots on a small pdfLaTeX project.
import "./support/dom";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  CropKind,
  CropRegion,
  CropService,
  CropSession,
  NOTE_CHANGED,
  NOTE_COMPILING,
  NOTE_NOT_COMPILED,
  NOTE_NO_PREVIEW,
  compiledLines,
  cropRegion,
  queryLines,
} from "../src/preview/blockCrop";
import type LatexLivePlugin from "../src/main";
import { CompiledPdf, LatexSession, SessionEvent, outDirFor } from "../src/session";
import { resolveTexBinDir, texEnv, texTool } from "../src/tex/binaries";
import { CompileResult, Compiler } from "../src/tex/compiler";
import { PdfBox, forwardSearchAll, synctexStamp } from "../src/tex/synctex";
import { sleep, waitFor } from "./support/keyMatrix";

const box = (page: number, x: number, y: number, width: number, height: number): PdfBox => ({ page, x, y, width, height });
const bottom = (b: PdfBox) => b.y + b.height;

test("compiledLines: the occurrence nearest to where the text starts now; null for text never compiled", () => {
  const block = "\\begin{align}\n  a &= b\n\\end{align}";
  const source = ["x", block, "y", "z", block, "w"].join("\n");
  // The copies start on lines 2 and 7.
  assert.deepEqual(compiledLines(source, block, 2), { from: 2, to: 4 });
  assert.deepEqual(compiledLines(source, block, 4), { from: 2, to: 4 }, "two lines inserted above it: still the first");
  assert.deepEqual(compiledLines(source, block, 5), { from: 7, to: 9 }, "the nearer one");
  assert.deepEqual(compiledLines(source, block, 90), { from: 7, to: 9 });
  assert.equal(compiledLines(source, block.replace("b", "c"), 2), null, "changed since");
  assert.deepEqual(compiledLines("one line $x$", "$x$", 1), { from: 1, to: 1 });
});

test("queryLines: the lines inside without the \\begin line, the \\end line, and the code lines around", () => {
  const source = ["text before", "", "% a comment", "\\begin{align}", "  a \\\\", "  b", "\\end{align}", "", "text after"].join("\n");
  assert.deepEqual(queryLines(source, 4, 7), { before: 1, begin: 4, inside: [5, 6], end: 7, after: 9 });
  assert.deepEqual(queryLines(source, 1, 1), { before: null, begin: null, inside: [1], end: null, after: 4 }, "one line: itself");
  assert.deepEqual(queryLines(source, 4, 5), { before: 1, begin: 4, inside: [], end: 5, after: 6 }, "two lines, the first only opening");
  const opened = ["x", "\\begin{equation} a = b", "\\end{equation}"].join("\n");
  assert.deepEqual(queryLines(opened, 2, 3), { before: 1, begin: null, inside: [2], end: 3, after: null }, "two lines: both");
  for (const line of ["\\[", "  $$ % display", "\\begin{alignat}{2}\\label{eq:x}", "\\begin{tikzpicture}[scale=2]"]) {
    assert.equal(queryLines(`${line}\nx\ny`, 1, 3).begin, 1, line);
  }
  const long = ["\\begin{tabular}{l}", ...Array.from({ length: 40 }, (_, i) => `r${i} \\\\`), "\\end{tabular}"].join("\n");
  const q = queryLines(long, 1, 42);
  assert.deepEqual(q.inside, [2, 3, 4, 5, 6, 7, 36, 37, 38, 39, 40, 41], "at most 12 inside: the first and last");
  assert.equal(q.after, null);
});

test("cropRegion: records borrowed from the lines around are dropped; a formula spans the text and stops at them", () => {
  const textLine = box(3, 57, 355, 482, 11); // the paragraph line before
  const rows = [box(3, 57, 520, 482, 20), box(3, 57, 541, 482, 20)];
  // The first row line typesets nothing and reports the line before; the \end line has the rows.
  const region = cropRegion("math", { before: [textLine], inside: [[textLine], [rows[0]]], end: rows, after: [box(3, 57, 575, 482, 11)] })!;
  assert.deepEqual([region.page, region.x, region.y, region.width, bottom(region)], [3, 57, 520, 482, 561]);
  assert.equal(region.top, 366, "padding stops at the line before");
  assert.equal(region.bottom, 575, "and at the line after");
  assert.equal(region.continues, false);

  // A narrow formula whose records miss its left side (`A =`): the text line's width.
  const narrow = cropRegion("math", { before: [textLine], inside: [[box(3, 222, 371, 150, 42)]], end: [box(3, 222, 371, 316, 42)], after: [] })!;
  assert.deepEqual([narrow.x, narrow.x + narrow.width], [57, 539]);

  // A float's \end line reports the text after it: dropped.
  const figure = cropRegion("float", {
    before: [textLine],
    inside: [[box(6, 57, 254, 482, 121)]],
    end: [box(6, 57, 394, 482, 11)],
    after: [box(6, 57, 394, 482, 11)],
  })!;
  assert.deepEqual([figure.y, bottom(figure)], [254, 375]);
});

test("cropRegion: a paragraph's last line tagged with a formula's \\begin line is a line before", () => {
  // pdfLaTeX: a paragraph line, then \begin{equation} (17), the formula (18) and \end{equation} (19).
  // The paragraph's first output line is line 16's; its last one ("bleeding.") line 17's.
  const records = {
    before: [box(1, 133.77, 234.45, 343.71, 8.86)],
    inside: [[box(1, 278.13, 256.25, 199.35, 24.67)]],
    end: [box(1, 278.13, 256.25, 199.35, 24.67), box(1, 278.13, 256.25, 54.98, 24.67)],
    after: [],
  };
  const region = cropRegion("math", { ...records, begin: [box(1, 133.77, 246.4, 343.71, 8.86)] })!;
  assert.equal(region.y, 256.25);
  assert.equal(region.top!.toFixed(2), "255.26", "the padding stops below the paragraph's last line");
  assert.equal(cropRegion("math", records)!.top!.toFixed(2), "243.31", "without it: through that line");
});

test("cropRegion: a picture takes its enclosing box, never the paragraph line around it; a tcolorbox its \\end line", () => {
  const paragraphLine = box(1, 134, 138, 344, 52);
  const pictureBox = box(1, 165, 138, 58, 52);
  const cells = box(1, 165, 140, 58, 47);
  // tikz-cd inside a paragraph: its \end line reports the paragraph's line and the picture.
  const inline = cropRegion("picture", { before: [box(1, 134, 128, 344, 10)], inside: [[cells]], end: [paragraphLine, pictureBox, cells], after: [] })!;
  assert.deepEqual([inline.x, inline.width, inline.y, inline.height], [165, 58, 138, 52]);
  assert.equal(inline.top, 138, "the padding stops at the line above");

  // tikz-cd in a display: its cells sit where TeX set them; the picture box holds its ink.
  const displayCells = box(6, 297, 389, 74, 52);
  const display = cropRegion("picture", { before: [box(6, 57, 394, 482, 11)], inside: [[displayCells]], end: [box(6, 260, 389, 109, 79), displayCells], after: [] })!;
  assert.deepEqual([display.x, display.x + display.width, bottom(display)], [260, 371, 468]);

  // A table centred in a line: the whole line (the drawing is trimmed to its ink).
  const table = cropRegion("picture", { before: [], inside: [[box(6, 213, 704, 169, 60)]], end: [box(6, 57, 700, 482, 67)], after: [] })!;
  assert.deepEqual([table.x, table.width], [57, 482]);

  // elegantbook's theorem: the box is its \end line's record; the records inside are ~20 pt low.
  const tcb = cropRegion("box", {
    before: [box(5, 57, 440, 482, 11)],
    inside: [],
    end: [box(5, 57, 474, 482, 79), box(5, 57, 519, 452, 34)],
    after: [box(5, 57, 562, 482, 20)],
  })!;
  assert.deepEqual([tcb.y, bottom(tcb), tcb.top, tcb.bottom], [474, 553, 451, 562]);
});

test("cropRegion: what a page shipped out while the block was read is dropped, and a thin first page skipped", () => {
  const before = box(5, 57, 697, 482, 46); // a gather at the bottom of page 5
  const junk = [box(5, 57, 61, 482, 30), box(5, 155, 326, 50, 18), box(5, 57, 800, 482, 4), box(5, 72, 72, 0, 0)];
  const rows = [box(6, 57, 72, 482, 18), box(6, 57, 84, 482, 26)];
  const region = cropRegion("math", { before: [before], inside: [[before], [...junk, ...rows]], end: [...junk, ...rows], after: [] })!;
  assert.deepEqual([region.page, region.y, bottom(region), region.continues], [6, 72, 110, false]);
  // A proof that goes on over a page break: its first page, marked.
  const proof = cropRegion("block", { before: [box(3, 57, 594, 482, 59)], inside: [[box(3, 57, 665, 482, 77)], [box(4, 57, 74, 482, 11)]], end: [box(4, 57, 74, 482, 11)], after: [] })!;
  assert.deepEqual([proof.page, proof.y, proof.continues], [3, 665, true]);
  assert.equal(cropRegion("math", { before: [], inside: [[]], end: [], after: [] }), null);

  // elegantbook's theorem broken over pages 10 and 11 (a synthetic chapter: three paragraphs, then
  // the box): its \end line reports the whole of page 10, the chapter heading, the paragraphs (the
  // line before's records among them) and the running head's rule, besides the box's two parts.
  const paragraph = [299.6, 317.2, 334.8, 352.5, 370.07].map((y) => box(10, 56.69, y, 481.89, 10.67));
  const broken = cropRegion("box", {
    before: paragraph,
    inside: [],
    end: [
      ...paragraph,
      box(10, 56.69, 60.66, 481.89, 0),
      box(10, 227.46, 71.58, 481.89, 28.49),
      box(10, 56.69, 388.71, 481.89, 375.5),
      box(10, 56.69, 799.84, 481.89, 4.06),
      box(11, 56.69, 72, 481.89, 242.51),
    ],
    after: [box(11, 56.69, 327.21, 481.89, 10.55)],
  })!;
  assert.deepEqual([broken.page, broken.y, broken.continues], [10, 388.71, true], "the box's part of page 10, going on");
  assert.equal(broken.top!.toFixed(2), "380.74", "the padding stops at the line before");
});

test("locate: identical blocks each crop from their own occurrence, whichever is asked first", () => {
  const block = "\\begin{equation}\n  E = mc^2\n\\end{equation}";
  const source = ["text", block, "more", "text", "", "again", "", "x", block, "end"].join("\n");
  const compiled: CompiledPdf = { seq: 7, pdfPath: "/p/main.pdf", pdf: new Uint8Array(), source: (f) => (f === "/p/ch.tex" ? source : undefined), synctex: 1 };
  const crops = new CropService({
    session: () => ({ compiling: null, compiled, onEvent: () => () => {} }),
    binDir: () => null,
    openPdf: () => Promise.reject(new Error("unused")),
    inverted: () => false,
    document,
  });
  const lines = (line: number) => {
    const where = crops.locate("/p/main.tex", "/p/ch.tex", block, line, "math");
    return "src" in where ? where.src.split("|").slice(1, 3).join("-") : where.note;
  };
  assert.deepEqual([lines(2), lines(11)], ["2-4", "11-13"]);
  assert.deepEqual([lines(14), lines(4)], ["11-13", "2-4"], "lines inserted above: still the nearest; either order");
  crops.dispose();
});

test("a new compile keeps each identical block's own previous drawing after lines shift", async () => {
  const root = "/p/main.tex", file = "/p/ch.tex";
  const block = "\\begin{align}\n a&=b\\\\\n\\intertext{same}\n c&=d\n\\end{align}";
  const source = ["before", block, "middle", "padding", "padding", "padding", block, "after"].join("\n");
  let compiled: CompiledPdf = { seq: 1, pdfPath: "/p/main.pdf", pdf: new Uint8Array(), source: () => source, synctex: 1 };
  const crops = new CropService({
    session: () => ({ compiling: null, compiled, onEvent: () => () => {} }),
    binDir: () => null,
    openPdf: () => Promise.reject(new Error("unused")),
    inverted: () => false,
    document,
  });
  const locate = (line: number) => {
    const where = crops.locate(root, file, block, line, "math");
    assert.ok("src" in where);
    return where;
  };
  const first = locate(2), second = locate(11);
  // Substitute only completed PDF drawings; locate/render/shown use the real service.
  const cache = crops as unknown as { roots: Map<string, { done: Map<string, { url: string; width: number; height: number; continues: boolean }> }> };
  for (const where of [first, second]) {
    const [, from, to] = where.src.split("|");
    cache.roots.get(root)!.done.set(`math|${from}-${to}|${file}`, { url: `data:,old-${from}`, width: 1, height: 1, continues: false });
    assert.ok((await crops.render(root, where.src)).ok);
  }
  compiled = { ...compiled, seq: 2, source: () => "\n\n" + source };
  assert.equal(locate(4).previous, first.src);
  assert.equal(locate(13).previous, second.src, "the second number cannot temporarily replace the first");
  crops.dispose();
});

test("release wakes only its root's first-compile hover; dispose wakes all remaining hovers", async () => {
  const listeners = new Map<string, Set<(e: SessionEvent) => void>>();
  const sessions = new Map<string, CropSession>();
  for (const root of ["/p/a.tex", "/p/b.tex"]) {
    const callbacks = new Set<(e: SessionEvent) => void>();
    listeners.set(root, callbacks);
    sessions.set(root, {
      compiling: "fast", compiled: null,
      onEvent: (cb) => { callbacks.add(cb); return () => callbacks.delete(cb); },
    });
  }
  const crops = new CropService({
    session: (root) => sessions.get(root) ?? null,
    binDir: () => null,
    openPdf: () => Promise.reject(new Error("unused")),
    inverted: () => false,
    document,
  });
  let aDone = false, bDone = false;
  const a = crops.hover("/p/a.tex", "/p/a.tex", "$x$", 1, "math", true).then(() => { aDone = true; });
  const b = crops.hover("/p/b.tex", "/p/b.tex", "$x$", 1, "math", true).then(() => { bDone = true; });
  assert.equal(listeners.get("/p/a.tex")!.size, 1);
  assert.equal(listeners.get("/p/b.tex")!.size, 1);
  sessions.delete("/p/a.tex");
  crops.release("/p/a.tex");
  await a;
  assert.ok(aDone);
  assert.equal(bDone, false);
  assert.equal(listeners.get("/p/a.tex")!.size, 0);
  assert.equal(listeners.get("/p/b.tex")!.size, 1);
  crops.dispose();
  await waitFor(() => bDone, 500);
  await b;
  assert.equal(listeners.get("/p/b.tex")!.size, 0);
  assert.deepEqual(crops.locate("/p/b.tex", "/p/b.tex", "$x$", 1, "math"), { note: NOTE_NO_PREVIEW });
});

// ---- Real TeX ------------------------------------------------------------------------------

const binDir = process.env.TEXBIN ?? resolveTexBinDir("");
function hasFandol(): boolean {
  try {
    return !!execFileSync(texTool(binDir!, "kpsewhich"), ["FandolSong-Regular.otf"], { env: texEnv(binDir!), encoding: "utf8" }).trim();
  } catch {
    return false;
  }
}
const skip = !binDir
  ? "no TeX installation found"
  : !existsSync(texTool(binDir, "xelatex"))
    ? "no xelatex"
    : !hasFandol()
      ? "no Fandol fonts (the fixture is XeLaTeX with ctex's fandol fontset)"
      : false;

/** A compiled copy of the fixture book (XeLaTeX, until its labels settle). */
async function compiledBook() {
  const dir = mkdtempSync(join(tmpdir(), "ll-crop-"));
  const book = join(dir, "book");
  cpSync(resolve("tests/fixtures/elegantbook"), book, { recursive: true });
  const outDir = join(dir, "out");
  mkdirSync(outDir, { recursive: true });
  const root = join(book, "main.tex");
  const results: CompileResult[] = [];
  const compiler = new Compiler(root, () => ({ binDir: binDir!, engine: "xelatex", outDir, preambleCache: false, shellEscape: false }), {
    onStart: () => {},
    onResult: (r) => results.push(r),
    onFailure: (e) => {
      throw e;
    },
  });
  compiler.request("fast");
  await waitFor(() => results.length > 0 && !compiler.compiling, 120_000);
  const result = results[results.length - 1];
  assert.ok(result.pdfWritten && result.pdfData, "the fixture compiles");
  const ch1 = join(book, "chapters/ch1.tex");
  const ch2 = join(book, "chapters/ch2.tex");
  const text = (file: string) => readFileSync(file, "utf8");
  /** The region of lines [from, to] of `file`, as the crop service asks SyncTeX. */
  const regionOf = async (file: string, from: number, to: number, kind: CropKind): Promise<CropRegion | null> => {
    const q = queryLines(text(file), from, to);
    const ask = (line: number | null) => (line === null ? Promise.resolve([]) : forwardSearchAll(binDir!, result.pdfPath, file, line));
    const box = kind === "box" && q.end !== null;
    const [before, begin, end, after, ...inside] = await Promise.all([
      ask(q.before),
      ask(kind === "math" ? q.begin : null),
      ask(q.end),
      ask(q.after),
      ...(box ? [] : q.inside.map(ask)),
    ]);
    return cropRegion(kind, { before, begin, inside, end, after });
  };
  const done = () => {
    compiler.dispose();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, book, root, outDir, compiler, result, ch1, ch2, text, regionOf, done };
}

test("T-L10: SyncTeX's records give each block of the compiled fixture its own region", { skip, timeout: 180_000 }, async () => {
  const t = await compiledBook();
  try {
    // ch1: the theorem box (10-15, with its equation), the align (18-21), the \[..\] (24-26).
    const theorem = (await t.regionOf(t.ch1, 10, 15, "box"))!;
    const align = (await t.regionOf(t.ch1, 18, 21, "math"))!;
    const display = (await t.regionOf(t.ch1, 24, 26, "math"))!;
    assert.equal(align.page, theorem.page);
    assert.ok(align.y >= bottom(theorem) - 1, `the align (${align.y}) starts below the theorem box and its equation (${bottom(theorem)})`);
    assert.ok(bottom(align) <= display.y + 1, "and ends above the next display");
    assert.ok(align.height > 15 && align.height < 60, `two rows: ${align.height} pt`);
    assert.ok(theorem.height > align.height, "the box holds its title, its text and its equation");
    // The \begin{align} line typesets nothing: SyncTeX answers with the line before (why it is never asked).
    const begin = await forwardSearchAll(binDir!, t.result.pdfPath, t.ch1, 18);
    assert.deepEqual(begin, await forwardSearchAll(binDir!, t.result.pdfPath, t.ch1, 17));
    // A one-line inline formula (line 7) gives its whole line.
    const line7 = await forwardSearchAll(binDir!, t.result.pdfPath, t.ch1, 7);
    const width = Math.max(...line7.map((b) => b.width));
    assert.ok(width > 300, `the text line: ${width} pt`);

    // ch2: the tikz-cd in equation* (16-21) below its text line (15); the tabular (25-28) in its float (23-30).
    const cd = (await t.regionOf(t.ch2, 16, 21, "math"))!;
    const textLine = await forwardSearchAll(binDir!, t.result.pdfPath, t.ch2, 15);
    assert.ok(cd.top !== undefined && cd.top >= Math.max(...textLine.map(bottom)) - 0.5, "the crop starts below the text line");
    assert.ok(bottom(cd) - Math.max(cd.y, cd.top ?? 0) > 30, "the diagram's two rows");
    const tabular = (await t.regionOf(t.ch2, 25, 28, "picture"))!;
    const table = (await t.regionOf(t.ch2, 23, 30, "float"))!;
    assert.ok(tabular.y >= table.y - 1 && bottom(tabular) <= bottom(table) + 1, "the tabular sits in its float");
    assert.ok(table.height > tabular.height, "the float adds its caption");
  } finally {
    t.done();
  }
});

/** A session for the crop service over a compile of the fixture, `sources` as its snapshot. */
function fakeSession(result: CompileResult, sources: Map<string, string>, seq = 1): CropSession & { compiling: unknown; compiled: CompiledPdf | null } {
  const compiled: CompiledPdf = { seq, pdfPath: result.pdfPath, pdf: result.pdfData!, source: (f) => sources.get(f), synctex: synctexStamp(result.pdfPath) };
  return { compiling: null, compiled, onEvent: () => () => {} };
}

/**
 * Drawings without pdf.js (Node): a crop's region is asked of SyncTeX as usual (kept in
 * `regions` by its compiled lines), and a region draws as a 1x1 image (CropService's private `draw`).
 */
function drawRegions(crops: CropService, regions = new Map<string, CropRegion>()): void {
  const service = crops as unknown as {
    region(r: unknown, file: string, from: number, to: number, kind: CropKind): Promise<CropRegion | null>;
    draw(r: unknown, file: string, from: number, to: number, kind: CropKind): Promise<unknown>;
  };
  service.draw = async (r, file, from, to, kind) => {
    const region = await service.region(r, file, from, to, kind);
    if (region) regions.set(`${from}-${to}`, region);
    return region && { url: `blob:${from}-${to}`, width: 1, height: 1, continues: region.continues };
  };
}

test("T-L11: a block keeps its compiled lines when lines are inserted above it; a changed one has no crop", { skip, timeout: 180_000 }, async () => {
  const t = await compiledBook();
  try {
    const compiledText = t.text(t.ch1);
    let session: (CropSession & { compiling: unknown }) | null = fakeSession(t.result, new Map([[t.ch1, compiledText]]));
    const crops = new CropService({
      session: () => session,
      binDir: () => binDir,
      openPdf: () => Promise.reject(new Error("no pdf.js in Node")),
      inverted: () => false,
      document,
    });
    const lines = compiledText.split("\n");
    const alignText = lines.slice(17, 21).join("\n");
    // Two lines typed above the align (unsaved: the editor's text), which now starts on line 20.
    const where = crops.locate(t.root, t.ch1, alignText, 20, "math");
    assert.ok("src" in where, JSON.stringify(where));
    const [, from, to] = where.src.split("|");
    assert.deepEqual([Number(from), Number(to)], [18, 21], "the compiled lines");
    assert.equal(where.previous, null);
    // The region of those lines is the align's (its rows, below the theorem box).
    const region = (await t.regionOf(t.ch1, Number(from), Number(to), "math"))!;
    const theorem = (await t.regionOf(t.ch1, 10, 15, "box"))!;
    assert.ok(region.y >= bottom(theorem) - 1);

    const changed = alignText.replace("\\Var(X)", "\\Var(Y)");
    assert.deepEqual(crops.locate(t.root, t.ch1, changed, 20, "math"), { note: NOTE_CHANGED });
    assert.deepEqual(crops.locate(t.root, t.ch2, "\\begin{tabular}", 25, "picture"), { note: NOTE_NOT_COMPILED }, "a file the compile's sources do not know");
    // The align's region is asked for (the drawing needs pdf.js, which fails here quietly).
    assert.equal((await crops.render(t.root, where.src)).ok, false);
    session.compiling = "fast";
    assert.ok("src" in crops.locate(t.root, t.ch1, lines.slice(23, 26).join("\n"), 24, "math"), "a compile running: the last result still crops");
    session = { ...session, compiled: null };
    assert.deepEqual(crops.locate(t.root, t.ch1, alignText, 20, "math"), { note: NOTE_COMPILING }, "no result yet: compiling");
    session = null;
    assert.deepEqual(crops.locate(t.root, t.ch1, alignText, 20, "math"), { note: NOTE_NO_PREVIEW });
    crops.dispose();
  } finally {
    t.done();
  }
});

test("T-L11 a result followed at once by the next pass: blocks crop from it while TeX runs, the last crop shown meanwhile", { skip, timeout: 180_000 }, async () => {
  const t = await compiledBook();
  try {
    const compiledText = t.text(t.ch1);
    const session = fakeSession(t.result, new Map([[t.ch1, compiledText]]));
    const crops = new CropService({
      session: () => session,
      binDir: () => binDir,
      openPdf: () => Promise.reject(new Error("no pdf.js in Node")),
      inverted: () => false,
      document,
    });
    const regions = new Map<string, CropRegion>();
    drawRegions(crops, regions);
    const lines = compiledText.split("\n");
    const align = lines.slice(17, 21).join("\n");
    const display = lines.slice(23, 26).join("\n");
    const first = crops.locate(t.root, t.ch1, align, 18, "math");
    assert.ok("src" in first && (await crops.render(t.root, first.src)).ok, "result 1 draws the align");
    const alignRegion = regions.get("18-21");
    regions.clear();

    // Result 2 lands and pass 2 starts in the same tick (a rerun, or a save queued meanwhile), and
    // TeX really runs: the last result's .synctex.gz stays until the pass ends.
    t.compiler.request("fast");
    await waitFor(() => pgrep(t.outDir).length > 0, 10_000);
    const next = fakeSession(t.result, new Map([[t.ch1, compiledText]]), 2);
    Object.assign(session, { compiled: next.compiled, compiling: "fast" });
    const again = crops.locate(t.root, t.ch1, align, 18, "math");
    assert.ok("src" in again, JSON.stringify(again));
    assert.equal(again.previous, first.src, "the crop drawn for result 1 shows until this one lands");
    const other = crops.locate(t.root, t.ch1, display, 24, "math");
    assert.ok("src" in other && other.previous === null, "a block not drawn before crops too");
    const [a, d] = await Promise.all([crops.render(t.root, again.src), crops.render(t.root, other.src)]);
    assert.ok(a.ok && d.ok, "both land while the compile runs");
    const hovered = await crops.hover(t.root, t.ch1, align, 18, "math", true);
    assert.ok(!("note" in hovered), "the hover shows the crop, not waiting for the pass (C7)");
    assert.ok(t.compiler.compiling && pgrep(t.outDir).length > 0, "XeLaTeX was still running");
    assert.deepEqual(regions.get("18-21"), alignRegion, "result 2's align: SyncTeX read the finished pass");
    assert.ok(regions.get("24-26")!.y >= bottom(alignRegion!) - 1, "the display below it");

    // Once the pass has replaced the .synctex.gz, a query for result 2 fails quietly (its lines
    // may not be that PDF's) instead of cropping the wrong place.
    await waitFor(() => !t.compiler.compiling, 120_000);
    const late = crops.locate(t.root, t.ch1, lines.slice(9, 15).join("\n"), 10, "box");
    assert.ok("src" in late);
    const r = await crops.render(t.root, late.src);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.message, /changed during the query/);
    crops.dispose();
  } finally {
    t.done();
  }
});

test("a SyncTeX query that fails fails its crop, asked again next time (never a region without its records)", { skip: (!binDir && "no TeX installation found") || (process.platform === "win32" && "a shell script stands in for synctex"), timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-synctex-"));
  try {
    const root = join(dir, "main.tex");
    const text = "\\documentclass{article}\n\\begin{document}\nSome text before the display.\n\\[\n  x^2 + y^2 = z^2\n\\]\nSome text after it.\n\\end{document}\n";
    writeFileSync(root, text);
    execFileSync(texTool(binDir!, "pdflatex"), ["-synctex=1", "-interaction=nonstopmode", "main.tex"], { cwd: dir, env: texEnv(binDir!), stdio: "ignore" });
    // A synctex that fails for line 6 (the display's last line) while `fail` exists.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const flag = join(dir, "fail");
    writeFileSync(join(bin, "synctex"), `#!/bin/sh\ncase "$*" in *" 6:0:"*) [ -e "${flag}" ] && exit 3;; esac\nexec "${texTool(binDir!, "synctex")}" "$@"\n`);
    chmodSync(join(bin, "synctex"), 0o755);
    writeFileSync(flag, "");
    const pdfPath = join(dir, "main.pdf");
    const compiled: CompiledPdf = { seq: 1, pdfPath, pdf: new Uint8Array(readFileSync(pdfPath)), source: (f) => (f === root ? text : undefined), synctex: synctexStamp(pdfPath) };
    const crops = new CropService({
      session: () => ({ compiling: null, compiled, onEvent: () => () => {} }),
      binDir: () => bin,
      openPdf: () => Promise.reject(new Error("no pdf.js in Node")),
      inverted: () => false,
      document,
    });
    const regions = new Map<string, CropRegion>();
    drawRegions(crops, regions);
    const where = crops.locate(root, root, "\\[\n  x^2 + y^2 = z^2\n\\]", 4, "math");
    assert.ok("src" in where);
    const failed = await crops.render(root, where.src);
    assert.equal(failed.ok, false);
    assert.match(failed.ok ? "" : failed.message, /SyncTeX did not answer/);
    assert.equal(regions.size, 0, "no region from the records that did come");
    rmSync(flag);
    assert.ok((await crops.render(root, where.src)).ok, "asked again");
    const display = regions.get("4-6")!;
    assert.ok(display.height > 5 && display.height < 30, `the display: ${display.height} pt`);
    crops.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Processes whose command line mentions `text` (pgrep -f). */
function pgrep(text: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", text], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

test("T-L12: no synctex or xelatex process is left after the crop service and the compiler are disposed", { skip: skip || (process.platform === "win32" && "pgrep"), timeout: 180_000 }, async () => {
  const t = await compiledBook();
  try {
    const session = fakeSession(t.result, new Map([[t.ch1, t.text(t.ch1)], [t.ch2, t.text(t.ch2)]]), 2);
    const crops = new CropService({
      session: () => session,
      binDir: () => binDir,
      openPdf: () => Promise.reject(new Error("no pdf.js in Node")),
      inverted: () => false,
      document,
    });
    // A new compile runs while crops query SyncTeX about the last one.
    t.compiler.request("fast");
    await waitFor(() => pgrep(t.outDir).length > 0, 10_000);
    const tex = pgrep(t.outDir);
    const blocks: [string, number, number, CropKind][] = [
      [t.ch1, 18, 21, "math"],
      [t.ch1, 10, 15, "box"],
      [t.ch2, 16, 21, "math"],
      [t.ch2, 25, 28, "picture"],
    ];
    const renders = blocks.map(([file, from, to, kind]) => {
      const text = t.text(file).split("\n").slice(from - 1, to).join("\n");
      const where = crops.locate(t.root, file, text, from, kind);
      assert.ok("src" in where, JSON.stringify(where));
      return crops.render(t.root, where.src);
    });
    const synctex = crops.runningPids;
    assert.ok(synctex.length > 0 && synctex.length <= 4, `at most 4 at once: ${synctex.length}`);
    crops.dispose();
    t.compiler.dispose();
    for (const r of await Promise.all(renders)) assert.equal(r.ok, false, "stopped quietly");
    await sleep(300);
    const left = [...tex, ...synctex].filter(alive);
    assert.deepEqual(left, [], "every recorded process has exited");
    assert.deepEqual(pgrep(t.outDir), [], "nothing runs on the build folder");
  } finally {
    t.done();
  }
});

test("sessions know what each compile read: open project files as it starts, others while unchanged since; on results that write a PDF", { skip: !binDir && "no TeX installation found", timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-snap-"));
  const root = join(dir, "main.tex");
  const chapter = join(dir, "chapters", "one.tex");
  const elsewhere = join(tmpdir(), "ll-snap-other.tex");
  mkdirSync(join(dir, "chapters"));
  writeFileSync(root, "\\documentclass{article}\n\\begin{document}\n\\input{chapters/one}\n\\end{document}\n");
  writeFileSync(chapter, "Hello $x$.\r\nSecond line.\r\n");
  writeFileSync(elsewhere, "not this project");
  // Project files not open in an editor.
  const later = join(dir, "chapters", "later.tex");
  const rewritten = join(dir, "chapters", "rewritten.tex");
  writeFileSync(later, "Later $y$.\n");
  writeFileSync(rewritten, "Before.\n");
  const events: SessionEvent[] = [];
  const plugin = {
    settings: { engine: "auto", preambleCache: false, shellEscape: false },
    texBinDir: () => binDir,
    openTexFiles: () => [root, chapter, elsewhere],
    sessionChanged: (_s: LatexSession, e: SessionEvent) => events.push(e),
  } as unknown as LatexLivePlugin;
  const sessions: LatexSession[] = [];
  try {
    const compile = async () => {
      const s = new LatexSession(plugin, root);
      sessions.push(s);
      s.request("fast");
      await waitFor(() => events.includes("result") && !s.compiling, 30_000);
      events.length = 0;
      return s;
    };
    const s = await compile();
    const c = s.compiled!;
    assert.ok(c.pdf.length > 0 && c.pdfPath.endsWith("main.pdf"));
    assert.equal(c.source(chapter), "Hello $x$.\nSecond line.\n", "LF line breaks, as the editor holds them");
    assert.equal(c.source(elsewhere), undefined, "the project's files, not another folder's");
    // A project file not open at the compile's start is read from disk while unchanged since.
    writeFileSync(rewritten, "After.\n");
    assert.equal(c.source(later), "Later $y$.\n");
    assert.equal(c.source(rewritten), undefined, "written after the compile started: unknown");
    // An open file keeps the text the compile read.
    writeFileSync(chapter, "Saved later.\n");
    assert.equal(c.source(chapter), "Hello $x$.\nSecond line.\n");
    // A later compile: a new snapshot and a new number, unique across sessions too.
    writeFileSync(chapter, "Changed.\n");
    s.request("fast");
    await waitFor(() => events.includes("result") && !s.compiling, 30_000);
    events.length = 0;
    assert.ok(s.compiled!.seq > c.seq);
    assert.equal(s.compiled!.source(chapter), "Changed.\n");
    assert.equal(s.compiled!.source(rewritten), "After.\n", "a new compile knows it again");
    const other = await compile();
    assert.ok(other.compiled!.seq > s.compiled!.seq);
    // A compile that writes no PDF keeps the last one's.
    const last = s.compiled;
    writeFileSync(root, "\\documentclass{article}\n\\begin{document}\n\\end{document}\n");
    s.request("fast");
    await waitFor(() => events.includes("result") && !s.compiling, 30_000);
    assert.equal(s.last!.pdfWritten, false);
    assert.equal(s.compiled, last);
  } finally {
    for (const s of sessions) s.dispose();
    rmSync(outDirFor(root), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { force: true });
  }
});
