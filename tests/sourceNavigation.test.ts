import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import LatexLivePlugin from "../src/main";
import { TexView } from "../src/editor/texView";
import { Compiler, type CompileResult } from "../src/tex/compiler";
import { resolveTexBinDir } from "../src/tex/binaries";
import { forwardSearch, inverseSearch } from "../src/tex/synctex";
import { TFile, normalizePath } from "./support/obsidian";

test("vault paths match Obsidian's NFC keys, including Chinese compatibility characters and the vault root", () => {
  const base = "/vault/课程é", host = { vaultBase: () => base };
  const path = (absolute: string) => LatexLivePlugin.prototype.vaultPath.call(host as LatexLivePlugin, absolute);
  assert.equal(path("/vault/课程e\u0301/章节/证明神 e\u0301.tex"), "章节/证明神 é.tex");
  assert.equal(path(base + "/章节/100%20.tex"), "章节/100%20.tex", "SyncTeX paths are not URLs");
  assert.equal(path(base), null);
  assert.equal(path("/vault/课程é另外/证明.tex"), null);
  assert.equal(path(base + "/../外部/证明.tex"), null);
  assert.equal(path(base + "/folder\\..\\..\\外部.tex"), null, "host separator normalization cannot escape the vault");
});

test("a background tab still deferred is matched by its file and brought to the front, not opened elsewhere", async () => {
  const base = "/vault", file = new TFile("章节/b.tex"), opened: unknown[] = [], calls: string[] = [];
  const loaded = Object.create(TexView.prototype) as TexView;
  Object.defineProperty(loaded, "file", { value: new TFile("章节/a.tex") });
  const view = Object.create(TexView.prototype) as TexView;
  Object.defineProperty(view, "file", { value: file });
  view.revealLine = (line, column) => { opened.push([line, column]); };
  // Obsidian restores background tabs with a placeholder view until they are shown; revealLeaf
  // returns before the real view has loaded its file, loadIfDeferred waits for it.
  const deferred = {
    view: {} as unknown,
    getViewState: () => ({ state: { file: file.path } }),
    loadIfDeferred: async () => { calls.push("load deferred"); deferred.view = view; },
  };
  const other = { view: loaded, getViewState: () => ({ state: { file: "章节/a.tex" } }), openFile: async () => { calls.push("openFile"); }, loadIfDeferred: async () => {} };
  const host = {
    vaultBase: () => base,
    vaultPath: (absolute: string) => LatexLivePlugin.prototype.vaultPath.call(host as unknown as LatexLivePlugin, absolute),
    app: {
      vault: { getAbstractFileByPath: (path: string) => (path === file.path ? file : null) },
      workspace: {
        getLeavesOfType: () => [other, deferred],
        revealLeaf: async (leaf: unknown) => { calls.push(leaf === deferred ? "reveal deferred" : "reveal other"); },
        setActiveLeaf: (leaf: unknown) => { calls.push(leaf === deferred ? "activate deferred" : "activate other"); },
      },
    },
  };
  await LatexLivePlugin.prototype.openLocation.call(host as unknown as LatexLivePlugin, base + "/章节/b.tex", 7, 2);
  assert.deepEqual(calls, ["load deferred", "reveal deferred", "activate deferred"]);
  assert.deepEqual(opened, [[7, 2]]);
});

const binDir = process.env.TEXBIN ?? resolveTexBinDir("");
for (const engine of ["pdflatex", "xelatex", "lualatex"] as const) for (const mode of ["fast", "full"] as const) {
  test(`${engine} ${mode}: Chinese Unicode source paths reach the exact vault file after inverse SyncTeX`, { skip: !binDir && "no TeX installation found", timeout: 90_000 }, async () => {
    const base = mkdtempSync(join(tmpdir(), "ll-chinese-navigation-"));
    const dir = join(base, "中文项目"), input = join(dir, "章节", "证明神 e\u0301.tex"), root = join(dir, "主文件.tex");
    mkdirSync(join(dir, "章节"), { recursive: true });
    const bibliography = mode === "full";
    const preamble = bibliography ? "\\usepackage[backend=biber]{biblatex}\n\\addbibresource{文献/参考资料.bib}\n" : "";
    writeFileSync(root, `\\documentclass{article}\n${preamble}\\begin{document}\n\\${bibliography ? "include" : "input"}{章节/证明神 e\u0301}\n${bibliography ? "\\cite{unicode-reference}\\printbibliography\n" : ""}\\end{document}\n`);
    writeFileSync(input, "\n\nA distinctive paragraph on line three.\n");
    if (bibliography) {
      mkdirSync(join(dir, "文献"));
      writeFileSync(join(dir, "文献", "参考资料.bib"), "@book{unicode-reference, author={Example, Alice}, title={Native Unicode Bibliography}, year={2026}}\n");
    }
    let compiler: Compiler | undefined;
    try {
      const result = await new Promise<CompileResult>((done, fail) => {
        compiler = new Compiler(root, () => ({ binDir: binDir!, engine, outDir: join(dir, "build"), preambleCache: false, shellEscape: false }), { onStart() {}, onResult: done, onFailure: fail });
        compiler.request(mode);
      });
      assert.equal(result.pdfWritten, true, result.rawLog || JSON.stringify(result.log.diagnostics));
      assert.deepEqual(result.log.diagnostics.filter(d => d.severity === "error"), [], result.rawLog);
      if (bibliography) {
        assert.equal(result.log.needsBibliography, false, result.rawLog);
        assert.match(readFileSync(join(dir, "build", "主文件.bbl"), "utf8"), /Native Unicode Bibliography/);
        assert.match(readFileSync(join(dir, "build", "章节", "证明神 e\u0301.aux"), "utf8"), /\\relax/, "the included chapter wrote its exact Unicode aux file");
      }
      const box = await forwardSearch(binDir!, result.pdfPath, input, 3, 0);
      assert.ok(box, "native forward query supplies the inverse point");
      const loc = await inverseSearch(binDir!, result.pdfPath, box.page, box.x + 5, box.y + box.height / 2, dir, compiler!.toLogical);
      assert.ok(loc);
      const key = normalizePath(relative(base, input));
      const file = new TFile(key), lookups: string[] = [], opened: unknown[] = [], focused: unknown[] = [];
      // Exercise the real plugin navigation methods, with Obsidian's exact indexed key.
      const view = Object.create(TexView.prototype) as TexView;
      Object.defineProperty(view, "file", { value: file });
      view.revealLine = (line, column) => { opened.push([line, column]); };
      const leaf = { view, loadIfDeferred: async () => {} };
      const host = {
        vaultBase: () => base,
        vaultPath: (absolute: string) => LatexLivePlugin.prototype.vaultPath.call(host as unknown as LatexLivePlugin, absolute),
        app: { vault: { getAbstractFileByPath: (path: string) => { lookups.push(path); return path === key ? file : null; } }, workspace: { getLeavesOfType: () => [leaf], revealLeaf: async () => {}, setActiveLeaf: (value: unknown) => focused.push(value) } },
      };
      await LatexLivePlugin.prototype.openLocation.call(host as unknown as LatexLivePlugin, loc.file, loc.line);
      assert.deepEqual(lookups, [key]);
      assert.deepEqual(opened, [[3, 0]]);
      assert.deepEqual(focused, [leaf]);
    } finally { compiler?.dispose(); rmSync(base, { recursive: true, force: true }); }
  });
}
