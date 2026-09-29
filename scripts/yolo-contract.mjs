// YOLO contract check: bundles tests/yoloContract.ts and runs it with node:test against
// the REAL YOLO controllers sliced (read-only) from YOLO_MAIN. Run after every YOLO update:
//   YOLO_MAIN=<vault>/.obsidian/plugins/yolo/main.js npm run test:yolo
// Only main.js is read, never YOLO's data.json. Skips when YOLO_MAIN is unset.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const main = process.env.YOLO_MAIN;
if (!main) {
  console.log(
    "test:yolo skipped: YOLO_MAIN is not set. Point it at YOLO's main.js, e.g.\n" +
      "  YOLO_MAIN=<vault>/.obsidian/plugins/yolo/main.js npm run test:yolo",
  );
  process.exit(0);
}
if (!existsSync(main)) {
  console.error(`test:yolo: YOLO_MAIN does not exist: ${main}`);
  process.exit(1);
}
const outdir = resolve("node_modules/.cache/yolo-contract");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: ["tests/yoloContract.ts"],
  outdir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outExtension: { ".js": ".cjs" },
  external: ["jsdom", "obsidian"],
  logLevel: "warning",
});
const res = spawnSync(process.execPath, ["--test", join(outdir, "yoloContract.cjs")], {
  stdio: "inherit",
  env: { ...process.env, YOLO_MAIN: resolve(main) },
});
process.exitCode = res.status ?? 1;
