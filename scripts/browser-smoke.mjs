// Browser smoke for the shared live-preview core (src/editor/shared/livePreview.ts): the checks
// jsdom cannot make (it has no layout), in headless Chrome over the DevTools protocol.
//   B1  real ArrowDown/ArrowUp visit every line of \[..\], $$..$$ and align blocks, which
//       reveal, also blocks at the document's end and start; Cmd-ArrowDown/Up, Shift-Cmd-
//       ArrowDown, Cmd-A and Escape with two cursors are never redirected into a block
//   B2  an IME composition next to a revealed formula collapses nothing until it commits
//   B3  a drag selection across widgets keeps the layout still until mouseup, then the
//       selection is kept
//   B4  a document shorter than the pane: every gutter number sits on its line (±1 px) once
//       the widgets' late styles arrived
//   B5  the generated 5,700-line chapter (scripts/gen-perf-fixture.mjs): mount, typing (and,
//       inside a revealed display block, until its preview re-rendered), cursor moves and
//       scrolling within the design's budgets; the mouse held while the prefetch runs and the
//       wheel scrolls leaves the page responsive
// The page bundles the real shared modules (keyArbiter first, live preview in its
// compartment) with a LaTeX-like test language. Formulas render with MathJax 3.2.2 when the
// `mathjax` dev dependency is installed (LaTeX Live, Obsidian's configuration; its glyph CSS
// arrives 100 ms after a batch, like finishRenderMath), else with stand-in elements that grow
// 100 ms after a batch the same way.
// Usage: node scripts/browser-smoke.mjs [B1 B2 ...]   (CHROME_BIN overrides the browser;
// skipped when no Chrome is found). Chrome runs with a throwaway profile in its own process
// group and is killed at the end, as is the local HTTP server.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { latexChapter } from "./gen-perf-fixture.mjs";

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
  console.log("browser-smoke: skipped (no Chrome found; set CHROME_BIN)");
  process.exit(0);
}
const MATHJAX = join(ROOT, "node_modules", "mathjax", "es5");
const useMathJax = existsSync(join(MATHJAX, "tex-chtml-full.js"));
const wanted = new Set(process.argv.slice(2).map((a) => a.toUpperCase()));
const run = (id) => !wanted.size || wanted.has(id);

// Obsidian 1.13.7's MathJax configuration (app.js), as tests/support/mathjax.ts.
const OBSIDIAN_CONFIG =
  'window.MathJax={tex:{inlineMath:[],displayMath:[],processEscapes:!1,processEnvironments:!1,processRefs:!1},startup:{typeset:!1},options:{enableMenu:!1,renderActions:{assistiveMml:[]}}};';

const ENTRY = String.raw`
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers } from "@codemirror/view";
import { keyArbiter } from "./src/editor/shared/keyArbiter";
import { liveInput, livePreview, livePreviewCompartment, renderConstruct, renderStats } from "./src/editor/shared/livePreview";

const MATH = /\\begin\{(align\*?|equation\*?|gather\*?)\}[\s\S]*?\\end\{\1\}|\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$([^$\n]+)\$/g;

const language = {
  scan(doc) {
    const text = doc.toString();
    const out = [];
    for (const m of text.matchAll(MATH)) {
      const from = m.index, to = from + m[0].length;
      const inline = m[4] !== undefined || m[5] !== undefined;
      const src = m[1] ? m[0] : m[2] ?? m[3] ?? m[4] ?? m[5];
      const a = doc.lineAt(from), b = doc.lineAt(to);
      const block = !inline && !text.slice(a.from, from).trim() && !text.slice(to, b.to).trim();
      out.push({ from, to, block, src, display: !inline });
    }
    return out;
  },
  decorate: (c, ctx) => renderConstruct(ctx, c, ctx.request("math", c.src, c.display, c.from)),
};

let styleTimer = 0;
const renderer = {
  epoch: 0,
  render(req) {
    const MJ = window.MathJax;
    if (MJ && MJ.tex2chtml) return { ok: true, node: MJ.tex2chtml(req.src, { display: req.display }) };
    const el = document.createElement(req.display ? "div" : "span");
    el.className = "fake-math" + (req.display ? " is-display" : "");
    el.textContent = req.src.trim().slice(0, 40);
    return { ok: true, node: el };
  },
  // Obsidian's finishRenderMath: the glyph CSS lands 100 ms after the last batch.
  flush() {
    clearTimeout(styleTimer);
    styleTimer = setTimeout(() => {
      const MJ = window.MathJax;
      if (MJ && MJ.chtmlStylesheet) {
        const sheet = MJ.chtmlStylesheet();
        if (!sheet.isConnected) document.head.appendChild(sheet);
      } else document.body.classList.add("fake-ready");
    }, 100);
  },
};

window.__smoke = {
  mount(doc, height = 700) {
    const host = document.getElementById("host");
    host.style.height = height + "px";
    if (window.__view) window.__view.destroy();
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          keyArbiter(),
          EditorState.allowMultipleSelections.of(true),
          history(),
          drawSelection(),
          lineNumbers(),
          EditorView.lineWrapping,
          liveInput(),
          livePreviewCompartment.of(livePreview({ language, renderer })),
          keymap.of([...defaultKeymap, ...historyKeymap]),
        ],
      }),
    });
    window.__view = view;
    return view;
  },
  stats: () => renderStats(window.__view),
  EditorSelection,
};
window.__ready = true;
`;

const PAGE_CSS = `
html, body { margin: 0; background: #fff; color: #222; }
body { --font-text: Georgia, serif; --font-monospace: Menlo, monospace; --interactive-accent: #7b6cd9; --text-error: #d33; }
#host { width: 900px; border: 1px solid #ccc; }
#host .cm-editor { height: 100%; }
#host .cm-scroller { font-family: var(--font-monospace); font-size: 15px; line-height: 1.5; }
.fake-math.is-display { display: inline-block; height: 24px; }
.fake-ready .fake-math.is-display { height: 58px; }
`;

// ---- page, server, browser -------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "live-smoke-"));
const profile = join(work, "profile");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff": "font/woff" };

async function writePage() {
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: "ts", sourcefile: "smoke-entry.ts" },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "warning",
  });
  writeFileSync(join(work, "bundle.js"), out.outputFiles[0].text);
  const css = readFileSync(join(ROOT, "src/editor/shared/editor.css"), "utf8");
  const mathjax = useMathJax
    ? `<script>${OBSIDIAN_CONFIG}</script><script src="/mathjax/tex-chtml-full.js"></script>`
    : "";
  writeFileSync(
    join(work, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}${PAGE_CSS}</style>${mathjax}</head>` +
      `<body><div class="lsp-cm-view"><div id="host"></div></div><script src="/bundle.js"></script></body></html>`,
  );
}

function serve() {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.startsWith("/mathjax/") ? join(MATHJAX, path.slice(9)) : join(work, path);
    const base = path.startsWith("/mathjax/") ? MATHJAX : work;
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
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "about:blank",
    ],
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
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
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
  return { ws, page, evaluate };
}

// ---- the checks ---------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${id} ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

const KEYS = { ArrowDown: [40, "ArrowDown"], ArrowUp: [38, "ArrowUp"], Escape: [27, "Escape"], a: [65, "KeyA"] };
/** A key press; modifiers: 4 Meta (Cmd), 8 Shift. */
async function press(page, key, modifiers = 0) {
  const [code, name] = KEYS[key];
  const base = { key, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
  await page("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await page("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** Mount `doc` and wait until every construct rendered and the late styles landed. */
async function mount(evaluate, doc, height = 700) {
  await evaluate(`__smoke.mount(${JSON.stringify(doc)}, ${height}), true`);
  await evaluate(`new Promise((ok) => { const t0 = Date.now(); (function wait() {
    if (!__smoke.stats().pending || Date.now() - t0 > 5000) ok(); else setTimeout(wait, 20); })(); })`);
  await evaluate("document.fonts.ready.then(() => true)");
  await sleep(400);
}

const CURSOR = `(() => { const v = __view, h = v.state.selection.main.head, l = v.state.doc.lineAt(h);
  return { line: l.number, ch: h - l.from,
    blocks: v.contentDOM.querySelectorAll(".lsp-lp-render.is-block:not(.is-below)").length,
    below: v.contentDOM.querySelectorAll(".lsp-lp-render.is-below").length }; })()`;

const B1_DOC = [
  "Intro with $x$ inline.",
  "\\[",
  "a^2 + b^2 = c^2",
  "\\]",
  "Between the blocks.",
  "$$",
  "\\sum_{i=1}^n i = \\frac{n(n+1)}{2}",
  "$$",
  "More text.",
  "\\begin{align}",
  "a &= b + c \\\\",
  "d &= e",
  "\\end{align}",
  "The end.",
].join("\n");

async function b1({ page, evaluate }) {
  await mount(evaluate, B1_DOC);
  await evaluate("__view.focus(), __view.dispatch({ selection: { anchor: 0 } }), true");
  await sleep(100);
  const start = await evaluate(CURSOR);
  const down = [];
  for (let i = 0; i < 13; i++) {
    await press(page, "ArrowDown");
    await sleep(50);
    down.push(await evaluate(CURSOR));
  }
  const lines = down.map((c) => c.line);
  check("B1", "ArrowDown visits every line", lines.join() === [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].join(), lines.join(" "));
  const inBlocks = down.filter((c) => [2, 3, 4, 6, 7, 8, 10, 11, 12, 13].includes(c.line));
  check(
    "B1",
    "a block the cursor is in shows its source with the rendering below",
    start.blocks === 3 && inBlocks.every((c) => c.blocks === 2 && c.below === 1),
    { start: start.blocks, inBlocks: inBlocks.map((c) => `${c.line}:${c.blocks}/${c.below}`).join(" ") },
  );
  const up = [];
  for (let i = 0; i < 13; i++) {
    await press(page, "ArrowUp");
    await sleep(50);
    up.push((await evaluate(CURSOR)).line);
  }
  check("B1", "ArrowUp visits every line", up.join() === [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].join(), up.join(" "));
  await press(page, "ArrowDown", 4); // Meta: Cmd-ArrowDown
  await sleep(50);
  const end = await evaluate("__view.state.selection.main.head === __view.state.doc.length");
  check("B1", "Cmd-ArrowDown reaches the document's end", end);

  // Blocks at the document's edges: a line move lands inside them (at the end or start).
  const lineOf = "__view.state.doc.lineAt(__view.state.selection.main.head).number";
  const walk = async (doc, line, key) => {
    await mount(evaluate, doc);
    await evaluate(`__view.focus(), __view.dispatch({ selection: { anchor: __view.state.doc.line(${line}).from + 3 } }), true`);
    await sleep(100);
    const lines = [];
    for (let i = 0; i < 4; i++) {
      await press(page, key);
      await sleep(50);
      lines.push(await evaluate(lineOf));
    }
    return lines.join(" ");
  };
  const intoEnd = await walk(["Text above.", "$$", "a^2 + b^2", "= c^2", "$$"].join("\n"), 1, "ArrowDown");
  check("B1", "ArrowDown into a block at the document's end visits every line", intoEnd === "2 3 4 5", intoEnd);
  const intoStart = await walk(["$$", "a^2 + b^2", "= c^2", "$$", "Text below."].join("\n"), 5, "ArrowUp");
  check("B1", "ArrowUp into a block at the document's start visits every line", intoStart === "4 3 2 1", intoStart);

  // Jumps that are not line moves, on a document whose last line follows a block.
  await mount(evaluate, ["Intro text.", "The last sentence before the formula:", "$$", "E = mc^2", "$$", "The end."].join("\n"));
  const sel = "JSON.stringify(__view.state.selection.ranges.map((r) => [r.anchor, r.head]))";
  const from = async (anchor, key, modifiers) => {
    await evaluate(`__view.focus(), __view.dispatch({ selection: ${anchor} }), true`);
    await sleep(80);
    await press(page, key, modifiers);
    await sleep(80);
    return JSON.parse(await evaluate(sel));
  };
  const len = await evaluate("__view.state.doc.length");
  const line2 = await evaluate("__view.state.doc.line(2).from + 3");
  const last = await evaluate("__view.state.doc.line(6).from");
  const all = await from(`{ anchor: ${line2} }`, "a", 4);
  check("B1", "Cmd-A selects the whole document", JSON.stringify(all) === JSON.stringify([[0, len]]), all);
  const toEnd = await from(`{ anchor: ${line2} }`, "ArrowDown", 4 | 8);
  check("B1", "Shift-Cmd-ArrowDown selects to the document's end", JSON.stringify(toEnd) === JSON.stringify([[line2, len]]), toEnd);
  // The main cursor (the second, on the last line) stays; the first sat right above the block.
  const escape = await from(`__smoke.EditorSelection.create([__smoke.EditorSelection.cursor(${line2}), __smoke.EditorSelection.cursor(${last})], 1)`, "Escape");
  check("B1", "Escape with two cursors keeps the main one", JSON.stringify(escape) === JSON.stringify([[last, last]]), escape);
  // A block between the first and the last line.
  await mount(evaluate, ["Intro text.", "$$", "a^2 + b^2", "$$", "The end."].join("\n"));
  const end2 = await evaluate("__view.state.doc.length");
  const docEnd = await from("{ anchor: 3 }", "ArrowDown", 4);
  const docStart = await from(`{ anchor: ${end2} }`, "ArrowUp", 4);
  check("B1", "Cmd-ArrowDown/Up reach the end and the start", docEnd[0][1] === end2 && docStart[0][1] === 0, { docEnd, docStart });
}

async function b2({ page, evaluate }) {
  await mount(evaluate, B1_DOC);
  // Right after `$x$` (touching it: revealed).
  await evaluate("__view.focus(), __view.dispatch({ selection: { anchor: 14 } }), true");
  await sleep(100);
  const count = () => evaluate(`__view.contentDOM.querySelectorAll(".lsp-lp-render:not(.is-below)").length`);
  const before = await count();
  const during = [];
  for (const text of ["c", "ce", "ces", "cesh", "ceshi"]) {
    await page("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await sleep(60);
    during.push(await count());
  }
  await page("Input.insertText", { text: "测试" });
  await sleep(150);
  const line = await evaluate("__view.state.doc.line(1).text");
  const after = await count();
  check("B2", "nothing collapses while composing", during.every((n) => n === before), { before, during });
  check("B2", "the committed text is right and the formula collapses after it", line === "Intro with $x$测试 inline." && after === before + 1, { line, after });
}

async function b3({ page, evaluate }) {
  await mount(evaluate, B1_DOC);
  await evaluate("__view.focus(), __view.dispatch({ selection: { anchor: __view.state.doc.length } }), true");
  await sleep(100);
  const at = (expr) =>
    evaluate(`(() => { const v = __view, c = v.coordsAtPos(${expr}); return { x: Math.round(c.left + 1), y: Math.round((c.top + c.bottom) / 2) }; })()`);
  const from = await at("3");
  const to = await at("__view.state.doc.line(14).from + 4");
  // The document's height (the height map; the content element is at least the pane's).
  const height = () => evaluate("__view.contentHeight");
  const h0 = await height();
  await page("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  const heights = [];
  for (let i = 1; i <= 8; i++) {
    const y = from.y + ((to.y - from.y) * i) / 8;
    const x = from.x + ((to.x - from.x) * i) / 8;
    await page("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(40);
    heights.push(Math.round(await height()));
  }
  await page("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(150);
  const sel = await evaluate("(({ anchor, head }) => ({ anchor, head, line: __view.state.doc.lineAt(head).number }))(__view.state.selection.main)");
  check("B3", "the layout stays still during the drag", heights.every((h) => h === Math.round(h0)), { h0: Math.round(h0), heights });
  check("B3", "the selection is kept after mouseup", sel.anchor === 3 && sel.line === 14 && sel.head > sel.anchor, sel);
}

/** 37 lines: display blocks (lines 3-5, 12-14, ...) and inline fractions between text. */
function b4Doc() {
  const out = [];
  while (out.length < 37) {
    const n = out.length + 1;
    if (n % 9 === 3 && n + 2 <= 37) out.push("$$", `\\int_0^{${n}} f(x)\\,dx = \\frac{a_{${n}}}{b}`, "$$");
    else if (n % 9 === 7) out.push(`Line ${n} with $\\frac{x_${n}}{y}$ inline.`);
    else out.push(`Line ${n} of plain text.`);
  }
  return out.join("\n");
}

async function b4({ evaluate }) {
  await mount(evaluate, b4Doc(), 1200); // shorter than the pane
  await sleep(300);
  const drift = await evaluate(`(() => {
    const v = __view;
    const gutter = new Map();
    for (const el of v.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement")) {
      if (/^\\d+$/.test(el.textContent)) gutter.set(+el.textContent, el.getBoundingClientRect().top);
    }
    const rows = [];
    for (const el of v.contentDOM.children) {
      if (!el.classList.contains("cm-line") && !el.classList.contains("lsp-lp-render")) continue;
      const n = v.state.doc.lineAt(v.lineBlockAt(v.posAtDOM(el)).from).number;
      if (gutter.has(n)) rows.push([n, Math.round(el.getBoundingClientRect().top - gutter.get(n))]);
    }
    return { lines: v.state.doc.lines, rows: rows.length, worst: Math.max(...rows.map((r) => Math.abs(r[1]))), off: rows.filter((r) => Math.abs(r[1]) > 1) };
  })()`);
  check("B4", "gutter numbers sit on their lines (±1 px)", drift.rows >= 25 && drift.worst <= 1, drift);
}

async function b5({ page, evaluate }) {
  // gen-perf-fixture's chapter: line 3 has inline formulas, lines 4-6 an equation, 12 is prose.
  const doc = latexChapter(5700);
  const perf = await evaluate(`(async () => {
    const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2); };
    // A macrotask without timer clamping: everything the keystroke queued (renders, refreshes) ran.
    const settled = () => new Promise((ok) => { const c = new MessageChannel(); c.port1.onmessage = () => ok(); c.port2.postMessage(0); });
    const t0 = performance.now();
    const v = __smoke.mount(${JSON.stringify(doc)}, 700);
    v.contentDOM.offsetHeight;
    await Promise.resolve();
    v.contentDOM.offsetHeight;
    const mountMs = performance.now() - t0;
    await new Promise((ok) => { const s = Date.now(); (function w() { if (!__smoke.stats().pending || Date.now() - s > 20000) ok(); else setTimeout(w, 50); })(); });
    v.focus();
    await new Promise((r) => setTimeout(r, 100));
    const typeAt = async (at, n) => {
      const dispatch = [], total = [];
      v.dispatch({ selection: { anchor: at } });
      for (let k = 0; k < n; k++) {
        const t = performance.now();
        v.dispatch({ changes: { from: at + k, insert: "a" }, selection: { anchor: at + k + 1 }, userEvent: "input.type" });
        v.contentDOM.offsetHeight;
        dispatch.push(performance.now() - t);
        await settled();
        v.contentDOM.offsetHeight;
        total.push(performance.now() - t);
      }
      return { dispatch, total };
    };
    const prose = await typeAt(v.state.doc.line(12).from + 10, 40);
    // Inside the equation's formula (revealed): every keystroke re-renders its preview below.
    const inBlock = await typeAt(v.state.doc.line(5).from + 8, 40);
    const cursor = [];
    for (let n = 1; n <= 60; n++) {
      const t = performance.now();
      v.dispatch({ selection: { anchor: v.state.doc.line(n).from } });
      v.contentDOM.offsetHeight;
      cursor.push(performance.now() - t);
    }
    const frames = [];
    const page = v.scrollDOM.clientHeight;
    await new Promise((ok) => {
      let last = 0, steps = 0;
      const tick = (ts) => {
        if (last) frames.push(ts - last);
        last = ts;
        if (steps++ >= 80) return ok();
        v.scrollDOM.scrollTop += page / 4; // 20 pages in 80 frames
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const s = __smoke.stats();
    return { lines: v.state.doc.lines, mountMs: +mountMs.toFixed(1), typingP95: q(prose.dispatch, 0.95),
      blockTypingP95: q(inBlock.dispatch, 0.95), blockSettledP50: q(inBlock.total, 0.5), blockSettledP95: q(inBlock.total, 0.95),
      cursorP50: q(cursor, 0.5), scrollFrameP90: q(frames, 0.9), renders: s.renders, buildP95: s.buildP95 };
  })()`);
  check("B5", "mount <= 60 ms", perf.mountMs <= 60, perf.mountMs);
  check("B5", "typing p95 <= 12 ms", perf.typingP95 <= 12 && perf.blockTypingP95 <= 12, { prose: perf.typingP95, inBlock: perf.blockTypingP95 });
  check("B5", "typing in a revealed display block settles within a frame (p95 <= 16 ms)", perf.blockSettledP95 <= 16, perf.blockSettledP95);
  check("B5", "cursor move p50 <= 1 ms", perf.cursorP50 <= 1, perf.cursorP50);
  check("B5", "20-page scroll frame p90 <= 20 ms", perf.scrollFrameP90 <= 20, perf.scrollFrameP90);
  console.log("     B5", JSON.stringify(perf));

  // The mouse goes down right after a mount, while most renders still wait for the idle
  // prefetch, and the wheel scrolls with the button held: the page must keep answering.
  // (Formulas of their own: none of them is in the cache yet.)
  const timed = (p, ms) => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);
  await evaluate(`__smoke.mount(${JSON.stringify(latexChapter(3000, 1001))}, 700), true`);
  const pressed = { x: 300, y: 200, button: "left", buttons: 1, clickCount: 1 };
  let alive = await timed(page("Input.dispatchMouseEvent", { type: "mousePressed", ...pressed }), 4000);
  for (let k = 0; alive && k < 6; k++) {
    alive = await timed(page("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 200, deltaX: 0, deltaY: 1500, buttons: 1 }), 4000);
    await sleep(30);
  }
  if (alive) {
    await sleep(500);
    alive = await timed(evaluate("1 + 1"), 4000);
  }
  check("B5", "the mouse held during the prefetch while the wheel scrolls: the page responds", alive);
  if (alive) await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...pressed, buttons: 0 });
}

// ---- main ------------------------------------------------------------------------------------------

let chrome = null;
let server = null;
let ws = null;
const cleanup = async () => {
  try {
    ws?.close();
  } catch {
    // already closed
  }
  await kill(chrome);
  server?.close();
  rmSync(work, { recursive: true, force: true });
};
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

try {
  await writePage();
  server = await serve();
  const launched = launch();
  chrome = launched.chrome;
  const cdp = await connect(await launched.url);
  ws = cdp.ws;
  await cdp.page("Runtime.enable");
  await cdp.page("Page.enable");
  await cdp.page("Emulation.setDeviceMetricsOverride", { width: 1000, height: 1300, deviceScaleFactor: 1, mobile: false });
  await cdp.page("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/index.html` });
  for (let i = 0; i < 200 && !(await cdp.evaluate("window.__ready === true && (!window.MathJax || !!window.MathJax.tex2chtml)").catch(() => false)); i++) {
    await sleep(50);
  }
  console.log(`browser-smoke: ${useMathJax ? "MathJax 3.2.2" : "stand-in renderer"}, ${CHROME}`);
  if (run("B1")) await b1(cdp);
  if (run("B2")) await b2(cdp);
  if (run("B3")) await b3(cdp);
  if (run("B4")) await b4(cdp);
  if (run("B5")) await b5(cdp);
} catch (e) {
  check("--", "smoke run", false, e instanceof Error ? e.message : String(e));
} finally {
  await cleanup();
}
const failed = results.filter((r) => !r.pass);
console.log(`browser-smoke: ${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
