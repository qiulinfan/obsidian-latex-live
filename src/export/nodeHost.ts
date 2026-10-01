import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import type { MathJaxLike } from "../editor/mathjaxProject";
import { resolveTexBinDir } from "../tex/binaries";
import { Compiler } from "../tex/compiler";
import { abortError } from "../tex/run";
import type { Engine } from "../tex/project";
import { exportDirFor, type ExportHost } from "./exporter";
import type { MathEnv } from "./math";

/** A disposable Node DOM hosting the same MathJax 3.2 bundle as the plugin. */
export interface NodeMathEnv extends MathEnv {
  close(): void;
}

export async function createNodeMathEnv(): Promise<NodeMathEnv> {
  // The bridge is bundled as CommonJS below this repository's node_modules. Resolving from
  // the bundle makes both the font and JS lookup independent of the caller's cwd.
  const mathjax = join(dirname(createRequire(__filename).resolve("mathjax/package.json")), "es5");
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/",
  });
  const window = dom.window as unknown as Window & {
    eval(source: string): unknown;
    MathJax: MathJaxLike;
  };
  try {
    window.eval(`window.MathJax = {
      tex: { inlineMath: [], displayMath: [], processEscapes: false,
        processEnvironments: false, processRefs: false },
      startup: { typeset: false },
      options: { enableMenu: false, renderActions: { assistiveMml: [] },
        safeOptions: { safeProtocols: { http: true, https: true,
          file: false, javascript: false, data: false } } }
    };`);
    const [main, safe] = await Promise.all([
      readFile(join(mathjax, "tex-chtml-full.js"), "utf8"),
      readFile(join(mathjax, "ui", "safe.js"), "utf8"),
    ]);
    window.eval(main + "\n" + safe);
    await window.MathJax.startup?.promise;
    return {
      mj: window.MathJax, document: window.document,
      font: async (name) => new Uint8Array(await readFile(join(mathjax, "output", "chtml", "fonts", "woff-v2", name))),
      close: () => dom.window.close(),
    };
  } catch (error) {
    dom.window.close();
    throw error;
  }
}

/** A headless host using the existing compiler and export pipeline, with all outputs in temp. */
export function createNodeExportHost(root: string, buildDir: string, engine: Engine, math: NodeMathEnv): ExportHost {
  const binDir = resolveTexBinDir(process.env.TEXBIN ?? "");
  if (!binDir) throw new Error("No TeX installation was found; set TEXBIN to its bin directory.");
  return {
    binDir, engine, buildDir, workDir: exportDirFor(buildDir), shellEscape: false,
    math: async () => math,
    idle: () => new Promise((resolve) => setImmediate(resolve)),
    build: (signal) => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortError("The export was cancelled.")); return; }
      const finish = () => {
        signal.removeEventListener("abort", cancel);
        compiler.dispose();
      };
      const cancel = () => { finish(); reject(abortError("The export was cancelled.")); };
      const compiler = new Compiler(root, () => ({
        binDir, engine, outDir: buildDir, preambleCache: false, shellEscape: false,
      }), {
        onStart: () => undefined,
        onResult: (result) => { finish(); resolve(result); },
        onFailure: (error) => { finish(); reject(error); },
      });
      signal.addEventListener("abort", cancel, { once: true });
      compiler.request("full");
    }),
  };
}
