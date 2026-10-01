// Prepare the small synthetic GUI fixture, including its PNG and two-page Chinese PDF.
// Optional argument: a scratch folder inside a vault. Never replaces an existing project.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(".");
const parent = resolve(process.argv[2] ?? tmpdir());
mkdirSync(parent, { recursive: true });
const target = mkdtempSync(join(parent, "latex-live-gui-"));
const cache = join(root, "node_modules/.cache");
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(join(cache, "editor-fixture-"));
try {
  const entry = String.raw`
    import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { resolveTexBinDir, texEnv, texTool } from "./src/tex/binaries";
    import { runTex } from "./src/tex/run";
    async function prepare() {
      const target = process.argv[2], bin = resolveTexBinDir("");
      if (!bin) throw new Error("A local TeX installation is required.");
      cpSync("tests/fixtures/editor-verification", target, { recursive: true });
      cpSync("tests/fixtures/export-book/figures/heatmap.png", join(target, "image.png"));
      const pdf = mkdtempSync(join(tmpdir(), "latex-live-gui-pdf-"));
      try {
        writeFileSync(join(pdf, "sample.tex"), "\\documentclass[fontset=fandol]{ctexart}\n\\begin{document}中文 PDF 图片：第一页。\\newpage 第二页。\\end{document}\n");
        const result = await runTex(texTool(bin, "xelatex"), ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "sample.tex"], {
          cwd: pdf, env: texEnv(bin), log: join(pdf, "sample.log"), timeoutMs: 60000,
        });
        if (result.code !== 0) throw new Error(result.output);
        cpSync(join(pdf, "sample.pdf"), join(target, "sample.pdf"));
      } finally { rmSync(pdf, { recursive: true, force: true }); }
      console.log(target);
    }
    prepare().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const outfile = join(work, "prepare.cjs");
  await build({ stdin: { contents: entry, resolveDir: root }, outfile, bundle: true, platform: "node", format: "cjs", target: "node20", logLevel: "warning" });
  const run = spawnSync(process.execPath, [outfile, target], { stdio: "inherit" });
  process.exitCode = run.status ?? 1;
  if (process.exitCode) rmSync(target, { recursive: true, force: true });
} finally {
  rmSync(work, { recursive: true, force: true });
}
