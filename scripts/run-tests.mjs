// Bundle each tests/*.test.ts with esbuild and run them with node:test.
// Output goes under node_modules/.cache so externals (jsdom) resolve from
// this repository's node_modules. Pass test file names to run a subset.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const wanted = process.argv.slice(2).map((f) => f.replace(/^tests\//, ""));
const files = readdirSync("tests")
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => !wanted.length || wanted.includes(f));
const outdir = resolve("node_modules/.cache/test-build");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: files.map((f) => join("tests", f)),
  outdir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outExtension: { ".js": ".cjs" },
  external: ["jsdom", "obsidian"],
  logLevel: "warning",
});
const res = spawnSync(
  process.execPath,
  ["--test", ...files.map((f) => join(outdir, f.replace(/\.ts$/, ".cjs")))],
  { stdio: "inherit" },
);
process.exitCode = res.status ?? 1;
