import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { readFileSync } from "node:fs";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  banner: { js: `/*! LaTeX Live. SPDX-License-Identifier: MIT.\n${readFileSync(new URL("./LICENSE", import.meta.url), "utf8")}\n*/` },
  footer: { js: `/*! DOMPurify. Copyright (c) Cure53 and other contributors. Distributed under the Apache-2.0 license option.\n${readFileSync(new URL("./licenses/DOMPurify-Apache-2.0.txt", import.meta.url), "utf8")}\n*/` },
  legalComments: "eof",
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  platform: "node",
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
