// Regenerate the synthetic probe logs and raw SVG evidence after probe/plan changes.
// Uses fresh temporary projects and the real installed TeX tools; writes only export-static.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(".");
const cache = join(root, "node_modules", ".cache");
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(join(cache, "regen-export-"));
try {
  const entry = String.raw`
    import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
    import { join } from "node:path";
    import { prepareExport } from "./src/export/exporter";
    import { fixtureCopy, nodeExportHost, removeExportTemps, texBin } from "./tests/support/exportHost";
    async function regenerate() {
    const target = join(process.cwd(), "tests/fixtures/export-static");
    if (!texBin) throw new Error("TeX is required to regenerate export fixtures.");
    try {
      for (const [fixture, name] of [["export-book", "book"], ["export-article", "article"]]) {
        const { root } = fixtureCopy(fixture);
        const host = nodeExportHost(root);
        await prepareExport(root, host, () => {}, new AbortController().signal);
        cpSync(join(host.workDir, "main.llx"), join(target, name + ".llx"));
        console.log("regenerated", name + ".llx");
      }
      for (const engine of ["pdflatex", "xelatex"]) {
        const { root } = fixtureCopy("export-static/fragments");
        const host = nodeExportHost(root, { engine });
        await prepareExport(root, host, () => {}, new AbortController().signal);
        const dir = join(target, "fragments", engine);
        mkdirSync(dir, { recursive: true });
        const pages = readdirSync(join(host.workDir, "frag")).filter(f => /^f\d+\.svg$/.test(f));
        if (!pages.length) throw new Error(engine + " produced no fragment pages.");
        for (const f of readdirSync(dir).filter(f => /^f\d+\.svg$/.test(f))) rmSync(join(dir, f));
        for (const f of pages) cpSync(join(host.workDir, "frag", f), join(dir, f));
        console.log("regenerated", engine, pages.length, "SVG pages");
      }
    } finally { removeExportTemps(); }
    }
    regenerate().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const outfile = join(work, "regen.cjs");
  await build({
    stdin: { contents: entry, resolveDir: root }, outfile,
    bundle: true, platform: "node", format: "cjs", target: "node20",
    external: ["jsdom"], logLevel: "warning",
  });
  const run = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
