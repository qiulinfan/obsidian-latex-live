#!/usr/bin/env node
// Headless JSON protocol. Bundle locally so optional Node dependencies resolve regardless
// of the caller's cwd; project copies and compiler outputs are separately deleted by the bridge.
import { build } from "esbuild";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const controller = new AbortController();
const cancel = () => controller.abort();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
let bundle;
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16 * 1024 * 1024) throw new Error("JSON request exceeds 16 MiB.");
  }
  const request = JSON.parse(input);
  const cache = join(repository, "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  bundle = await mkdtemp(join(cache, "kgdistiller-bridge-"));
  const entry = join(bundle, "bridge.cjs");
  await build({
    entryPoints: [join(repository, "src", "export", "kgdistillerBridge.ts")],
    outfile: entry, bundle: true, platform: "node", format: "cjs", target: "node20",
    packages: "external", logLevel: "silent",
  });
  const { kgdistillerHtml } = createRequire(import.meta.url)(entry);
  const result = await kgdistillerHtml(request, controller.signal);
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(`latex-live kgdistiller export: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  if (bundle) await rm(bundle, { recursive: true, force: true });
}
