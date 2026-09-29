// Obsidian's MathJax in jsdom: the dev dependency mathjax@3.2.2, loaded the way Obsidian 1.13.7
// loads lib/mathjax/tex-chtml-full.js. That file is es5/tex-chtml-full.js followed by
// es5/ui/safe.js; the config below is its `before` hook, copied from app.js. Never bundled
// into the plugin (tests only).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import type { MathJaxLike } from "../../src/editor/mathjaxProject";

const OBSIDIAN_CONFIG =
  'window.MathJax={tex:{inlineMath:[],displayMath:[],processEscapes:!1,processEnvironments:!1,processRefs:!1},startup:{typeset:!1},options:{enableMenu:!1,menuOptions:{settings:{renderer:"CHTML"}},renderActions:{assistiveMml:[]},safeOptions:{safeProtocols:{http:!0,https:!0,file:!0,javascript:!1,data:!1}}}},window.publish&&delete window.MathJax.options.renderActions,localStorage.removeItem("MathJax-Menu-Settings")';

export interface ObsidianMathJax {
  window: Window & typeof globalThis;
  MathJax: MathJaxLike & {
    tex2mml(src: string, options?: { display?: boolean }): string;
    chtmlStylesheet(): HTMLStyleElement;
  };
}

let loaded: Promise<ObsidianMathJax> | null = null;

/** A window with MathJax loaded and started (shared by the tests of a file). */
export function obsidianMathJax(): Promise<ObsidianMathJax> {
  loaded ??= (async () => {
    const dir = join(process.cwd(), "node_modules", "mathjax", "es5");
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
      runScripts: "outside-only",
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const w = dom.window as unknown as ObsidianMathJax["window"] & { eval(src: string): unknown; MathJax: ObsidianMathJax["MathJax"] };
    w.eval(OBSIDIAN_CONFIG);
    w.eval(
      readFileSync(join(dir, "tex-chtml-full.js"), "utf8") +
        "\n// ui/safe.js\n" +
        readFileSync(join(dir, "ui", "safe.js"), "utf8") +
        "\n",
    );
    await w.MathJax.startup!.promise;
    return { window: w, MathJax: w.MathJax };
  })();
  return loaded;
}
