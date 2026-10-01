// Export smoke (docs/design.md "HTML 导出", S4): the HTML export's checks jsdom cannot make, in
// headless Chrome over the DevTools protocol, on fresh $TMPDIR copies of the synthetic fixtures
// export-book (elegantbook, XeLaTeX), export-article (pdfLaTeX, amsthm) and export-homework.
//   - The build, the plan, the probe and the fragments run in Node (exporter.ts prepareExport with
//     the Node host of tests/support/exportHost.ts; PDF pages through Ghostscript at 2x when it is
//     installed, standing in for Obsidian's pdf.js). The emit runs inside the page (emitExport),
//     with MathJax 3.2.2 loaded as Obsidian loads it (es5/tex-chtml-full.js, ui/safe.js, app.js's
//     configuration) and its fonts fetched from its font folder, so MathJax measures in a real
//     browser as it does in Obsidian.
//   - The exported page is then opened on its own at 1000 px and 375 px, light and dark:
//     E1  every MathJax and TeX fragment font face loads (and document.fonts.check('16px MJXTEX-I'))
//     E2  every mjx-c glyph has a width
//     E3  every theorem box's frame is the probe's colour (light), >= 3:1 against the page (dark)
//     E4  no horizontal overflow (a paragraph whose formulas are wider scrolls, and clips none vertically)
//     E5  inline fragments sit on the text's baseline (±1 px: a zero-height marker after each)
//     E6  dark: all text has contrast >= 4.5 against its background (light: the minimum is shown)
//     E7  no console errors or exceptions
// Screenshots (the page, up to 16,000 px) and the exported pages go to
// $TMPDIR/latex-live-export-smoke/ (kept); everything else is removed at the end.
// Usage: node scripts/export-smoke.mjs [export-book export-article export-homework]
// (CHROME_BIN overrides the browser, TEXBIN the TeX bin folder; skipped without Chrome or TeX).
// PRISM_JS can point to the host's bundled prism.min.js, enabling the code-token integration check.
// Chrome runs with a throwaway profile in its own process group and is killed at the end, as is
// the local HTTP server; TeX runs through runTex (its own process group).
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";

const ROOT = resolve(".");
const CHROME = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((p) => p && existsSync(p));
if (!CHROME) {
  console.log("export-smoke: skipped (no Chrome found; set CHROME_BIN)");
  process.exit(0);
}
const MATHJAX = join(ROOT, "node_modules", "mathjax", "es5");
const PRISM = process.env.PRISM_JS ? resolve(process.env.PRISM_JS) : null;
if (PRISM && !existsSync(PRISM)) throw new Error("PRISM_JS file does not exist: " + PRISM);
const FIXTURES = process.argv.slice(2).length ? process.argv.slice(2) : ["export-book", "export-article", "export-homework"];
const CASES = FIXTURES.map((name) => ({ name, id: isAbsolute(name) ? basename(name) : name.replace(/[\\/]/g, "-") }));
const SHOTS = join(tmpdir(), "latex-live-export-smoke");

// Obsidian 1.13.7's MathJax configuration (app.js), as tests/support/mathjax.ts.
const OBSIDIAN_CONFIG =
  'window.MathJax={tex:{inlineMath:[],displayMath:[],processEscapes:!1,processEnvironments:!1,processRefs:!1},startup:{typeset:!1},options:{enableMenu:!1,menuOptions:{settings:{renderer:"CHTML"}},renderActions:{assistiveMml:[]},safeOptions:{safeProtocols:{http:!0,https:!0,file:!0,javascript:!1,data:!1}}}},window.publish&&delete window.MathJax.options.renderActions,localStorage.removeItem("MathJax-Menu-Settings")';

/** Maps and Sets through JSON (the prepared export crosses from Node into the page). */
const TAGGED = String.raw`
const replacer = (_k, v) => (v instanceof Map ? { $map: [...v] } : v instanceof Set ? { $set: [...v] } : v);
const reviver = (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? ("$map" in v ? new Map(v.$map) : "$set" in v ? new Set(v.$set) : v) : v);
`;

// Node: build, plan, probe and fragments of a fresh fixture copy.
const NODE_ENTRY = String.raw`
import { execFileSync, spawnSync } from "node:child_process";
import { prepareExport } from "./src/export/exporter";
import { fixtureCopy, nodeExportHost, removeExportTemps, testPng, texBin } from "./tests/support/exportHost";
${TAGGED}
const gs = spawnSync("gs", ["--version"]).status === 0;

/** PDF pages at 144 dpi through Ghostscript (Obsidian draws them with pdf.js at 2x); a blank page without it. */
async function pdfImages(abs, want) {
  if (!gs) return want(1).map((page) => ({ page, png: testPng(2, 1), width: 419.5, height: 595.3 }));
  const count = Number(execFileSync("gs", ["-q", "-dNODISPLAY", "-dNOSAFER", "-c", "(" + abs + ") (r) file runpdfbegin pdfpagecount = quit"], { encoding: "utf8" }).trim());
  return want(count).map((page) => {
    const png = execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=png16m", "-r144", "-dFirstPage=" + page, "-dLastPage=" + page, "-sOutputFile=-", abs], { maxBuffer: 64 << 20 });
    return { page, png: new Uint8Array(png), width: png.readUInt32BE(16) / 2, height: png.readUInt32BE(20) / 2 };
  });
}

export { removeExportTemps, texBin, gs };

export async function prepare(name) {
  const { root } = fixtureCopy(name);
  const host = nodeExportHost(root);
  host.pdfImages = pdfImages;
  const started = Date.now();
  const { prepared } = await prepareExport(root, host, () => undefined, new AbortController().signal);
  return { json: JSON.stringify(prepared, replacer), ms: Date.now() - started, timings: prepared.timings, colors: Object.fromEntries(prepared.log?.colors ?? []) };
}
`;

// The page: the emit of a prepared export with the page's MathJax.
const PAGE_ENTRY = String.raw`
import { emitExport, exportMath } from "./src/export/exporter";
import { ExportImages } from "./src/export/images";
import { ReportBuilder } from "./src/export/report";
import { prismTokenizer } from "./src/export/listings";
${TAGGED}
window.__emit = async (name) => {
  const p = JSON.parse(await (await fetch("/data/" + name + ".json")).text(), reviver);
  Object.setPrototypeOf(p.images, ExportImages.prototype);
  const report = new ReportBuilder();
  for (const item of p.report.items) report.add(item);
  p.report = report;
  const fonts = "/mathjax/output/chtml/fonts/woff-v2/";
  const env = { mj: window.MathJax, document, font: async (file) => new Uint8Array(await (await fetch(fonts + file)).arrayBuffer()) };
  const started = performance.now();
  const out = await emitExport(p, exportMath(env, p), { idle: () => new Promise((r) => setTimeout(r, 0)), code: window.Prism ? async () => prismTokenizer(window.Prism) : undefined }, () => undefined, new AbortController().signal);
  const codeDoc = new DOMParser().parseFromString(out.html, "text/html");
  const roles = Object.fromEntries(["keyword", "comment", "string"].map(role => [role, codeDoc.querySelectorAll(".llx-code-" + role).length]));
  return { html: out.html, ms: Math.round(performance.now() - started), bytes: out.report.bytes, highlighted: out.report.counts.highlightedListings ?? 0, codeRoles: roles, items: out.report.items.filter((i) => i.severity !== "info") };
};
window.__ready = true;
`;

/** Node modules the emit's imports name but never call in the page: stubs (path: POSIX's few functions it uses). */
const STUBS = {
  name: "node-stubs",
  setup(b) {
    b.onResolve({ filter: /^(?:node:)?(?:fs|fs\/promises|path|child_process|os|crypto|zlib|util|url|events|stream)$/ }, (a) => ({ path: a.path.replace(/^node:/, ""), namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
      loader: "js",
      contents:
        a.path === "path"
          ? `const norm = (p) => { const out = []; for (const s of p.split("/")) { if (s === "..") out.pop(); else if (s && s !== ".") out.push(s); } return (p.startsWith("/") ? "/" : "") + out.join("/"); };
             export const sep = "/", delimiter = ":";
             export const isAbsolute = (p) => p.startsWith("/");
             export const join = (...p) => norm(p.join("/"));
             export const resolve = (...p) => norm(p.reduce((a, x) => (x.startsWith("/") ? x : a + "/" + x), ""));
             export const dirname = (p) => p.replace(/\\/[^/]*$/, "") || "/";
             export const basename = (p, ext) => { const b = p.replace(/^.*\\//, ""); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; };
             export const extname = (p) => /\\.[^./]*$/.exec(p.replace(/^.*\\//, ""))?.[0] ?? "";
             export const relative = (a, b) => (b.startsWith(a + "/") ? b.slice(a.length + 1) : b);
             export default { sep, delimiter, isAbsolute, join, resolve, dirname, basename, extname, relative };`
          : `const stub = new Proxy(function () {}, { get: (_t, k) => (k === "__esModule" ? false : stub), apply: () => stub, construct: () => stub });
             module.exports = stub;`,
    }));
  },
};

// Electron's renderer has Node's process and Buffer; the page gets what the emit uses of them.
const PAGE_BANNER = `globalThis.process ??= { platform: "browser", env: {} };
globalThis.Buffer ??= { from: (u8) => ({ toString: () => { let s = ""; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); } }) };`;

// ---- the checks in the exported page ---------------------------------------------------------------

const CHECKS = String.raw`(async (width) => {
  const faces = [...document.fonts];
  await Promise.all(faces.map((f) => f.load().catch(() => null)));
  await document.fonts.ready;
  const loaded = (re) => { const f = faces.filter((x) => re.test(x.family.replace(/"/g, ""))); return [f.filter((x) => x.status === "loaded").length, f.length]; };
  const fonts = { math: loaded(/^MJX/), frag: loaded(/^llx\d+-/), check: !document.querySelector(".TEX-I") || document.fonts.check("16px MJXTEX-I") };
  // Invisible operators (U+2061-2064: function application, invisible times ...) have no width.
  const zeroNodes = [...document.querySelectorAll("mjx-c")].filter((c) => c.getBoundingClientRect().width === 0 && !/\bmjx-c206[1-4]\b/.test(c.className));
  // CHTML paints horizontal extensions (e.g. overline's U+2013) in an empty zero-width
  // carrier's ::before, scaled horizontally and clipped by its nonzero-width mjx-ext.
  // A missing glyph rule must still fail: require the precise carrier structure, an actual
  // visible pseudo glyph and its native stretch transform, not merely an empty class name.
  const glyphDetail = (c) => {
    const style = getComputedStyle(c), pseudo = getComputedStyle(c, "::before");
    const ext = c.parentElement, stretchy = ext?.parentElement;
    const extWidth = ext?.getBoundingClientRect().width ?? 0;
    const scaleX = pseudo.transform === "none" ? 1 : new DOMMatrixReadOnly(pseudo.transform).a;
    const content = pseudo.content;
    const carrier = c.classList.length === 0 && c.childNodes.length === 0 && c.matches("mjx-stretchy-h > mjx-ext > mjx-c")
      && style.width === "0px" && style.visibility === "visible" && pseudo.display !== "none" && pseudo.visibility === "visible"
      && content !== "none" && content !== "normal" && content !== '""' && content !== "''" && scaleX > 1
      && extWidth > 0 && stretchy?.getBoundingClientRect().width > 0;
    return { carrier, kind: c.className, outer: c.outerHTML, parent: ext?.outerHTML, pseudo: { content, display: pseudo.display, visibility: pseudo.visibility, transform: pseudo.transform, font: pseudo.fontFamily }, extWidth, scaleX };
  };
  const zeroDetails = zeroNodes.map(glyphDetail);
  const zero = zeroDetails.filter((x) => !x.carrier).map((x) => x.kind);
  // Exercise the exception against real CSS: removing its pseudo glyph must reject that
  // carrier, and removing an ordinary glyph's rule must still make E2 fail. Restore before
  // the layout/contrast checks and screenshots. This tests the missing-rule gate itself.
  let guardRegression = null;
  const carrierNode = zeroNodes.find((c) => glyphDetail(c).carrier);
  if (carrierNode && width === 1000) {
    const corrupt = document.createElement("style");
    corrupt.textContent = 'mjx-c[data-llx-e2-corrupt]::before { content: none !important; padding: 0 !important; }';
    const corruptGlyph = (c) => {
      const old = c.getAttribute("data-llx-e2-corrupt");
      c.setAttribute("data-llx-e2-corrupt", ""); document.head.append(corrupt);
      const rejected = c.getBoundingClientRect().width === 0 && !glyphDetail(c).carrier;
      corrupt.remove();
      if (old === null) c.removeAttribute("data-llx-e2-corrupt"); else c.setAttribute("data-llx-e2-corrupt", old);
      return rejected;
    };
    const ordinary = [...document.querySelectorAll("mjx-c[class]")].find((c) => c.classList.length && c.getBoundingClientRect().width > 0);
    guardRegression = { missingExtenderRuleRejected: corruptGlyph(carrierNode), missingOrdinaryGlyphRuleRejected: !!ordinary && corruptGlyph(ordinary) };
  }
  const glyphs = document.querySelectorAll("mjx-c").length;
  const boxes = [...document.querySelectorAll(".llx-box")].map((b) => ({ role: ([...b.classList].find((c) => /^is-/.test(c)) ?? "").slice(3), border: getComputedStyle(b).borderTopColor }));
  // Against the device's width: a mobile viewport widens itself to what overflows.
  const overflow = Math.max(0, document.documentElement.scrollWidth - width);
  const wide = overflow ? [...document.querySelectorAll("main *")].filter((e) => e.getBoundingClientRect().right > width + 0.5 && !e.closest("mjx-container *")).slice(0, 3).map((e) => e.tagName.toLowerCase() + "." + e.className + " " + (e.textContent ?? "").slice(0, 30)) : [];
  const scrolling = [...document.querySelectorAll("p")].filter((p) => getComputedStyle(p).overflowX === "auto");
  const clipped = scrolling.filter((p) => p.scrollHeight > p.clientHeight + 1).map((p) => p.textContent.slice(0, 20));
  const scrolled = scrolling.filter((p) => p.scrollWidth > p.clientWidth + 1).length;
  // Inline fragments: TeX's baseline (the bottom less the depth they are lowered by) against a zero-size marker's.
  const baselines = [];
  for (const svg of document.querySelectorAll("svg.llx-frag[style*='vertical-align']")) {
    const m = document.createElement("span");
    m.style.cssText = "display:inline-block;width:0;height:0";
    svg.after(m);
    const depth = -parseFloat(svg.style.verticalAlign) * parseFloat(getComputedStyle(svg).fontSize);
    baselines.push(+(svg.getBoundingClientRect().bottom - depth - m.getBoundingClientRect().bottom).toFixed(2));
    m.remove();
  }
  // Text contrast: every element with text of its own (math and TeX's pictures aside) against the first background behind it.
  const rgb = (s) => { const m = /^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*([\d.]+))?\)$/.exec(s); return m ? { c: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null; };
  const lum = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const background = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c && c.a > 0) return c.c; } return rgb(getComputedStyle(document.documentElement).backgroundColor)?.c ?? [255, 255, 255]; };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let min = Infinity, unparsed = 0;
  const low = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.data.trim() || !el || seen.has(el) || el.closest("mjx-container, svg, style, script")) continue;
    seen.add(el);
    const fg = rgb(getComputedStyle(el).color);
    if (!fg) { unparsed++; continue; }
    const r = ratio(fg.c, background(el));
    min = Math.min(min, r);
    if (r < 4.5) low.push({ el: el.tagName.toLowerCase() + (el.className ? "." + el.className : ""), text: n.data.trim().slice(0, 20), ratio: +r.toFixed(2), color: getComputedStyle(el).color });
  }
  return { fonts, zero: zero.length, zeroKinds: [...new Set(zero)].slice(0, 5), zeroDetails: zeroDetails.filter((x) => !x.carrier).slice(0, 5), extenders: zeroDetails.filter((x) => x.carrier).slice(0, 5), guardRegression, glyphs, boxes, overflow, wide, clipped, scrolled, baselines, contrast: { min: +min.toFixed(2), low: low.slice(0, 5), lowCount: low.length, unparsed } };
})`;

// ---- page, server, browser -----------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "export-smoke-"));
const profile = join(work, "profile");
mkdirSync(join(work, "data"));
mkdirSync(join(work, "out"));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".woff": "font/woff" };

async function bundle(entry, o) {
  const out = await build({ stdin: { contents: entry, resolveDir: ROOT, loader: "ts", sourcefile: "entry.ts" }, bundle: true, write: false, logLevel: "warning", ...o });
  return out.outputFiles[0].text;
}

async function writePage() {
  const js = await bundle(PAGE_ENTRY, { format: "iife", platform: "browser", target: "es2022", plugins: [STUBS], banner: { js: PAGE_BANNER } });
  writeFileSync(join(work, "bundle.js"), js);
  if (PRISM) writeFileSync(join(work, "prism.js"), readFileSync(PRISM));
  writeFileSync(
    join(work, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><script>${OBSIDIAN_CONFIG}</script>` +
      `<script src="/mathjax/tex-chtml-full.js"></script><script src="/mathjax/ui/safe.js"></script>` +
      (PRISM ? `<script>window.Prism={manual:true,disableWorkerMessageHandler:true}</script><script src="/prism.js"></script>` : "") + `</head>` +
      `<body><script src="/bundle.js"></script></body></html>`,
  );
}

/** The Node side, bundled next to node_modules (jsdom resolves from there). */
async function nodeSide() {
  const dir = join(ROOT, "node_modules", ".cache", "export-smoke");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "prepare.cjs");
  writeFileSync(file, await bundle(NODE_ENTRY, { format: "cjs", platform: "node", target: "node20", external: ["jsdom"] }));
  return createRequire(import.meta.url)(file);
}

function serve() {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const base = path.startsWith("/mathjax/") ? MATHJAX : work;
    const file = path.startsWith("/mathjax/") ? join(MATHJAX, path.slice(9)) : join(work, path);
    if (!file.startsWith(base + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

function launch() {
  const chrome = spawn(
    CHROME,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", "--mute-audio", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  const url = new Promise((ok, fail) => {
    let err = "";
    const timer = setTimeout(() => fail(new Error("Chrome did not start: " + err.slice(-400))), 20000);
    chrome.stderr.on("data", (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        ok(m[1]);
      }
    });
    chrome.on("exit", () => fail(new Error("Chrome exited: " + err.slice(-400))));
  });
  return { chrome, url };
}

function kill(chrome) {
  if (!chrome || chrome.exitCode !== null) return Promise.resolve();
  const exited = new Promise((ok) => chrome.once("exit", ok));
  try {
    process.kill(-chrome.pid, "SIGKILL"); // the whole group: renderer and GPU processes too
  } catch {
    chrome.kill("SIGKILL");
  }
  return Promise.race([exited, new Promise((ok) => setTimeout(ok, 3000))]);
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error("DevTools connection failed"));
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") errors.push(msg.params.entry.text);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.fail(new Error(JSON.stringify(msg.error)));
    else p.ok(msg.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      pending.set(++id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const evaluate = async (expression) => {
    const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { ws, page, evaluate, errors };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${id} ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

/** Wait until `expr` is truthy in the page. */
async function until(evaluate, expr, ms = 20000) {
  const t0 = Date.now();
  while (!(await evaluate(expr).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${expr}`);
    await sleep(50);
  }
}

/** Open `name`'s exported page at `width` in `scheme`, run the checks, take a screenshot. */
async function inspect(cdp, port, name, colors, width, scheme) {
  const { page, evaluate, errors } = cdp;
  const at = `${name} ${width}px ${scheme}`;
  errors.length = 0;
  await page("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await page("Page.navigate", { url: `http://127.0.0.1:${port}/out/${name}.html` });
  await until(evaluate, "document.readyState === 'complete'");
  await sleep(300);
  const r = await evaluate(`${CHECKS}(${width})`);
  const f = r.fonts;
  check("E1", `${at}: math and fragment fonts load`, f.check && f.math[0] === f.math[1] && f.frag[0] === f.frag[1], f);
  check("E2", `${at}: every glyph has a width or a painted stretch extender`, r.zero === 0 && (!r.guardRegression || Object.values(r.guardRegression).every(Boolean)), { glyphs: r.glyphs, zero: r.zero, kinds: r.zeroKinds, details: r.zeroDetails, extenders: r.extenders, guardRegression: r.guardRegression });
  const frames = r.boxes.map((b) => ({ ...b, want: colors[b.role] }));
  if (scheme === "light") check("E3", `${at}: box frames in the probe's colours`, frames.every((b) => b.border === b.want), frames.length ? frames.map((b) => `${b.role} ${b.border}`).join(", ") : "no boxes");
  else {
    const bg = [27, 27, 29];
    const lum = (c) => { const [x, y, z] = c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * x + 0.7152 * y + 0.0722 * z; };
    const contrast = (s) => { const c = s.match(/\d+/g).slice(0, 3).map(Number); return (lum(c) + 0.05) / (lum(bg) + 0.05); };
    check("E3", `${at}: box frames >= 3:1 against the page`, frames.every((b) => contrast(b.border) >= 3), frames.length ? frames.map((b) => `${b.role} ${b.border}`).join(", ") : "no boxes");
  }
  check("E4", `${at}: no horizontal overflow`, r.overflow === 0 && r.clipped.length === 0, { overflow: r.overflow, wide: r.wide, scrolled: r.scrolled, clipped: r.clipped });
  check("E5", `${at}: inline fragments on the baseline (±1 px)`, r.baselines.every((d) => Math.abs(d) <= 1), r.baselines.join(" ") || "none inline");
  if (scheme === "dark") check("E6", `${at}: text contrast >= 4.5`, r.contrast.lowCount === 0 && r.contrast.unparsed === 0, r.contrast);
  else console.log(`     E6 ${at}: minimum text contrast ${r.contrast.min} (light mode shows the document's own colours)`);
  check("E7", `${at}: no console errors`, errors.length === 0, errors.length ? errors.slice(0, 3) : undefined);
  const { contentSize } = await page("Page.getLayoutMetrics");
  const height = Math.min(Math.ceil(contentSize.height), 16000);
  const shot = await page("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
  writeFileSync(join(SHOTS, `${name}-${width}-${scheme}.png`), Buffer.from(shot.data, "base64"));
}

// ---- main ------------------------------------------------------------------------------------------

let chrome = null;
let server = null;
let ws = null;
let node = null;
const cleanup = async () => {
  try {
    ws?.close();
  } catch {
    // already closed
  }
  await kill(chrome);
  server?.close();
  node?.removeExportTemps();
  rmSync(work, { recursive: true, force: true });
};
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

try {
  node = await nodeSide();
  if (!node.texBin) {
    console.log("export-smoke: skipped (no TeX found; set TEXBIN)");
    await cleanup();
    process.exit(0);
  }
  mkdirSync(SHOTS, { recursive: true });
  const colors = {};
  for (const { name, id } of CASES) {
    const p = await node.prepare(name);
    writeFileSync(join(work, "data", `${id}.json`), p.json);
    colors[id] = p.colors;
    console.log(`export-smoke: ${name} prepared in Node in ${p.ms} ms ${JSON.stringify(p.timings)}`);
  }
  await writePage();
  server = await serve();
  const port = server.address().port;
  const launched = launch();
  chrome = launched.chrome;
  const cdp = await connect(await launched.url);
  ws = cdp.ws;
  await cdp.page("Runtime.enable");
  await cdp.page("Page.enable");
  await cdp.page("Log.enable");
  console.log(`export-smoke: MathJax 3.2.2 in ${CHROME}${node.gs ? "" : " (no Ghostscript: PDF pages are blank stand-ins)"}`);
  for (const { id: name } of CASES) {
    await cdp.page("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.page("Page.navigate", { url: `http://127.0.0.1:${port}/index.html` });
    await until(cdp.evaluate, "window.__ready === true && !!window.MathJax && !!window.MathJax.startup && window.MathJax.startup.promise.then(() => true)");
    cdp.errors.length = 0;
    const out = await cdp.evaluate(`__emit(${JSON.stringify(name)})`);
    check("E0", `${name}: emitted in the page`, out.items.length === 0 && cdp.errors.length === 0, { ms: out.ms, bytes: out.bytes, items: out.items.slice(0, 3), errors: cdp.errors.slice(0, 3) });
    if (PRISM && name === "export-homework") check("E8", `${name}: host Prism highlights Python keywords, comments and strings`, out.highlighted > 0 && Object.values(out.codeRoles).every(n => n > 0), { highlighted: out.highlighted, roles: out.codeRoles });
    writeFileSync(join(work, "out", `${name}.html`), out.html);
    writeFileSync(join(SHOTS, `${name}.html`), out.html);
    for (const width of [1000, 375]) for (const scheme of ["light", "dark"]) await inspect(cdp, port, name, colors[name], width, scheme);
  }
  console.log(`export-smoke: pages and screenshots in ${SHOTS}`);
} catch (e) {
  check("--", "smoke run", false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  await cleanup();
}
const failed = results.filter((r) => !r.pass);
console.log(`export-smoke: ${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
