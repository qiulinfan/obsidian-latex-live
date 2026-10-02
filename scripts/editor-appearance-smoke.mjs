// LaTeX-only appearance geometry in real Chrome with Obsidian's MathJax 3.2.2.
// Uses a fresh profile, real live widgets and official CM tooltip portals; no TeX or vault IO.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

const root = resolve('.');
const chromeBin = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p));
if (!chromeBin) throw new Error('Chrome is required for editor-appearance-smoke (CHROME_BIN can override).');
const work = mkdtempSync(join(tmpdir(), 'll-appearance-smoke-'));
const shots = join(tmpdir(), 'latex-live-editor-appearance-smoke');
mkdirSync(shots, { recursive: true });
const mathjax = join(root, 'node_modules/mathjax/es5');
const css = readFileSync(join(root, 'styles.css'), 'utf8');
const entry = String.raw`
import { Compartment, EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { EditorView, activateHover, lineNumbers, showTooltip } from '@codemirror/view';
import { applyEditorAppearance } from './src/editor/editorAppearance';
import { latexTooltipPortal, refreshLatexTooltipAppearance } from './src/editor/theoremGraphView';
import { latexLiveLanguage } from './src/editor/latexLive';
import { DEFAULT_REF_NAMES } from './src/editor/latexRefs';
import { liveInput, livePreview, livePreviewCompartment } from './src/editor/shared/livePreview';
import { cursorPreview, hoverError, renderHover } from './src/editor/shared/renderHover';
import { keyArbiter } from './src/editor/shared/keyArbiter';
import { ProjectMath } from './src/editor/mathjaxProject';
import { mathAt } from './src/editor/latexScan';

const defaults = { editorFontSize: 0, editorLineHeight: 0, editorFontFamily: '', mathPreviewScale: 1 };
const formula = '\\frac{a+b}{c+d}=\\sqrt{x^2+y^2}';
const liveDoc = 'Source typography: alpha beta gamma delta.\nInline $'+formula+'$ ends.\n\\[\n'+formula+'\n\\]\nA wrapping paragraph repeats alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.\nLast line.';
const sourceDoc = 'Hover $'+formula+'$ here.\nCursor $'+formula+'$ here.\nSource wraps: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi.\nTheorem card anchor.';
const refs = { numbers: new Map(), labels: new Map(), cites: new Map(), names: DEFAULT_REF_NAMES, theorems: new Map(), checkpoints: new Map() };
const appearanceMeasurement = new Compartment();
const appearanceThemes = [EditorView.theme({}), EditorView.theme({})];
const activeTheme = new WeakMap();
let math, live, source;
let beforeStates;
const rendered = (src, display, role) => {
 const node = math.render(src, display); node.dataset.smokeRole = role;
 const sheet = window.MathJax.chtmlStylesheet(); if (!sheet.isConnected) document.head.appendChild(sheet);
 return node;
};
const renderer = { epoch: 0, render(req) { return { ok: true, node: rendered(req.src, req.display, req.display ? 'live-display' : 'live-inline') }; } };
function mountSource(text, card = true) {
 source?.destroy(); document.getElementById('source').replaceChildren();
 const cursor = cursorPreview({ enabled: () => true, target(state) { return mathAt(state.doc, state.selection.main.head); }, render(target) { return rendered(target.src, target.display, 'cursor'); } });
 const hover = renderHover({ enabled: () => true, target: (state, pos) => mathAt(state.doc, pos), render: target => rendered(target.src, target.display, 'hover'), hoverTime: 10 });
 const cardTooltip = { pos: text.length, above: false, create() {
  const dom = document.createElement('div'); dom.className = 'll-theorem-graph';
  const title = dom.appendChild(document.createElement('strong')); title.textContent = 'Theorem card';
  const content = dom.appendChild(document.createElement('div')); content.className = 'll-theorem-graph-content';
  const p = content.appendChild(document.createElement('p')); p.dataset.smokeText = 'card'; p.append('A statement uses ');
  const inline = p.appendChild(document.createElement('span')); inline.className = 'll-theorem-math'; inline.appendChild(rendered(formula, false, 'card-inline'));
  const display = content.appendChild(document.createElement('div')); display.className = 'll-theorem-math'; display.appendChild(rendered(formula, true, 'card-display'));
  const image = content.appendChild(document.createElement('img')); image.dataset.smokeFixed = 'card-image'; image.src = imageURL(); image.width = 120; image.height = 32;
  return { dom };
 } };
 source = new EditorView({ parent: document.getElementById('source'), state: EditorState.create({ doc: text, extensions: [keyArbiter({}), appearanceMeasurement.of(appearanceThemes[0]), history(), latexTooltipPortal(), lineNumbers(), EditorView.lineWrapping, cursor, hover, card ? showTooltip.of(cardTooltip) : []] }) });
 if (card) source.dispatch({ changes: { from: text.length, insert: ' EDIT' }, userEvent: 'input.type' });
 source.focus();
 const second = text.indexOf('$', text.indexOf('\n') + 1);
 source.dispatch({ selection: { anchor: second >= 0 ? second + 3 : text.indexOf('\n') + 2 } });
 activateHover(source, text.indexOf('$') + 3, 1);
}
const imageURL = () => 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><rect width="120" height="32" fill="#80a4b2"/><text x="8" y="21" font-size="14">Fixed image</text></svg>');
function fixedFixtures() {
 const host = document.getElementById('fixed'); host.replaceChildren();
 for (const kind of ['image', 'crop']) {
  const wrapper = host.appendChild(document.createElement('div')); wrapper.className = 'lsp-lp-render lsp-lp-'+kind;
  const image = wrapper.appendChild(document.createElement('img')); image.src = imageURL(); image.width = 120; image.height = 32; image.dataset.smokeFixed = kind;
 }
 const pending = host.appendChild(document.createElement('div')); pending.className = 'lsp-render-hover is-pending';
 const spinner = pending.appendChild(document.createElement('span')); spinner.className = 'lsp-render-hover-spinner'; spinner.dataset.smokeFixed = 'spinner';
 const label = pending.appendChild(document.createElement('span')); label.textContent = 'Rendering…'; label.dataset.smokeFixed = 'pending-text';
 const error = host.appendChild(document.createElement('div')); error.className = 'lsp-render-hover'; const errorBody = hoverError('Formula unavailable', '\\bad'); error.appendChild(errorBody);
 errorBody.querySelector('.lsp-render-hover-message').dataset.smokeFixed = 'error';
}
window.mount = async () => {
 live?.destroy(); source?.destroy(); document.getElementById('live').replaceChildren();
 document.body.classList.remove('narrow');
 for (const id of ['live', 'source', 'fixed']) document.getElementById(id).removeAttribute('style');
 // Exercise the native inline percentage emitted by CHTML for a host output scale.
 window.MathJax.startup.document.outputJax.options.scale = 1.14;
 math = ProjectMath.create(window.MathJax, document, { statements: [], physics: false, unsupported: new Map() });
 live = new EditorView({ parent: document.getElementById('live'), state: EditorState.create({ doc: liveDoc, selection: { anchor: liveDoc.length }, extensions: [keyArbiter({}), appearanceMeasurement.of(appearanceThemes[0]), history(), lineNumbers(), EditorView.lineWrapping, liveInput(), livePreviewCompartment.of(livePreview({ language: latexLiveLanguage({ refs: () => refs }), renderer }))] }) });
 mountSource(sourceDoc); fixedFixtures();
 await new Promise(r => setTimeout(r, 180)); await document.fonts.ready;
 beforeStates = [live.state, source.state];
 return true;
};
window.apply = async settings => {
 // Match TexView's supported CM refresh: two reused themes, toggled only when styles change.
 for (const [id, view] of [['live', live], ['source', source], ['fixed', null]]) {
  if (id === 'live' && document.body.classList.contains('narrow')) continue;
  const host = document.getElementById(id), before = host.style.cssText;
  applyEditorAppearance(host, { ...defaults, ...settings });
  if (view && before !== host.style.cssText) {
   const next = (activeTheme.get(view) ?? 0) ^ 1; activeTheme.set(view, next);
   view.dispatch({ effects: appearanceMeasurement.reconfigure(appearanceThemes[next]) });
  }
 }
 refreshLatexTooltipAppearance(source); live.requestMeasure(); source.requestMeasure();
 await new Promise(r => setTimeout(r, 150));
};
window.undoProof = () => undo(source) && source.state.doc.toString() === sourceDoc;
const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
window.snapshot = () => {
 const maths = {};
 document.querySelectorAll('mjx-container[data-smoke-role]').forEach(root => {
  maths[root.dataset.smokeRole] = { inline: root.style.fontSize, font: getComputedStyle(root).fontSize, wrapperFont: getComputedStyle(root.parentElement).fontSize, glyph: rect(root.querySelector('mjx-math')), root: rect(root) };
 });
 const fixed = {}; document.querySelectorAll('[data-smoke-fixed]').forEach(el => fixed[el.dataset.smokeFixed] = { ...rect(el), layoutWidth: el.offsetWidth, layoutHeight: el.offsetHeight, font: getComputedStyle(el).fontSize });
 const text = document.querySelector('#source .cm-line');
 const lines = [...document.querySelectorAll('#source .cm-line')];
 const gutters = [...document.querySelectorAll('#source .cm-lineNumbers .cm-gutterElement')].filter(el => el.style.visibility !== 'hidden');
 return { maths, fixed, source: { font: getComputedStyle(text).fontSize, family: getComputedStyle(text).fontFamily, height: rect(text).height, lineHeight: getComputedStyle(source.scrollDOM).lineHeight, lines: lines.map(rect), gutterDiff: lines.map((el, i) => rect(el).y - (gutters[i] ? rect(gutters[i]).y : NaN)), gutters: gutters.map(el => ({ ...rect(el), style: el.getAttribute('style') })) }, cardText: { font: getComputedStyle(document.querySelector('[data-smoke-text]')).fontSize }, documentUnchanged: beforeStates[0].doc === live.state.doc && beforeStates[1].doc === source.state.doc && beforeStates[0].selection.eq(live.state.selection) && beforeStates[1].selection.eq(source.state.selection), portals: [...document.querySelectorAll('.ll-tooltip-portal')].map(el => ({ parent: el.parentElement === document.body, size: el.style.getPropertyValue('--font-text-size'), mathSize: el.style.getPropertyValue('--ll-editor-math-font-size'), scale: el.style.getPropertyValue('--ll-math-preview-scale') })) };
};
window.longPopup = async () => {
 live.destroy(); document.body.classList.add('narrow');
 const long = Array.from({ length: 35 }, (_, i) => 'x_{'+i+'}^{2}').join('+');
 math = ProjectMath.create(window.MathJax, document, { statements: ['\\newcommand{\\wideformula}{'+long+'}'], physics: false, unsupported: new Map() });
 mountSource('Cursor\n$\\wideformula$\nend', false);
 await window.apply({ editorFontSize: 40, mathPreviewScale: 2 });
 await document.fonts.ready; await new Promise(r => setTimeout(r, 100));
 const tooltip = document.querySelector('.lsp-cursor-preview'); const body = tooltip.querySelector('.lsp-render-hover');
 body.scrollLeft = 90;
 return { tooltip: rect(tooltip), body: rect(body), scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, scrollLeft: body.scrollLeft, viewport: innerWidth };
};
window.__ready = true;
`;
const skin = `
:root{--font-text-size:16px;--line-height-normal:1.5;--font-ui-small:14px;--font-ui-smaller:12px;--font-interface:system-ui;--font-text:Georgia,serif;--font-monospace:Menlo,monospace;--background-primary:#fff;--background-secondary:#f5f5f7;--background-primary-alt:#f5f5f7;--background-modifier-border:#ccc;--text-normal:#222;--text-muted:#666;--text-faint:#888;--text-error:#b42828;--interactive-accent:#566bc0;--radius-s:4px;--radius-m:8px}
body{margin:20px;font-family:system-ui;background:var(--background-primary);color:var(--text-normal)}
main{display:grid;grid-template-columns:530px 500px;gap:24px}.label{margin:0 0 6px;font-size:14px;font-weight:600}
#live,#source{width:100%;height:520px;border:1px solid #ddd;overflow:hidden;transform:translateZ(0)}.cm-content{padding:12px}
#fixed{display:flex;gap:16px;align-items:start;margin-top:20px}#fixed .lsp-render-hover{max-width:200px}
.ll-theorem-graph{width:440px;min-width:0;box-sizing:border-box}.ll-theorem-graph-content p{margin:6px 0}
body.narrow main{display:block}body.narrow main>section:first-child,body.narrow #fixed{display:none}body.narrow #source{width:270px;height:650px}.cm-tooltip{box-sizing:border-box}
`;
let chrome, server, ws;
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'ok  ' : 'FAIL') + ' ' + name + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const close = (actual, expected, tolerance = .04) => Math.abs(actual - expected) <= tolerance;
async function connect(url) {
 ws = new WebSocket(url); await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
 let seq = 0; const pending = new Map();
 ws.onmessage = e => { const m = JSON.parse(e.data), p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.fail(new Error(JSON.stringify(m.error))) : p.ok(m.result); };
 const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { pending.set(++seq, { ok, fail }); ws.send(JSON.stringify({ id: seq, method, params, sessionId })); });
 const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
 const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
 const page = (method, params) => send(method, params, sessionId);
 const evaluate = async expression => { const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
 return { page, evaluate };
}
try {
 const built = await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts', sourcefile: 'appearance-smoke.ts' }, bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, logLevel: 'warning', plugins: [{ name: 'no-node-io', setup(b) {
  b.onResolve({ filter: /^(?:node:)?(?:fs|path)$/ }, a => ({ path: a.path, namespace: 'no-io' }));
  b.onLoad({ filter: /.*/, namespace: 'no-io' }, () => ({ loader: 'js', contents: "module.exports=new Proxy({sep:'/'},{get:(o,k)=>k==='__esModule'?false:k in o?o[k]:()=>{throw new Error('Unexpected Node IO in appearance smoke: '+String(k));}})" }));
 } }] });
 writeFileSync(join(work, 'bundle.js'), built.outputFiles[0].contents);
 writeFileSync(join(work, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}${skin}</style><script>window.MathJax={tex:{inlineMath:[],displayMath:[],processEscapes:false,processEnvironments:false,processRefs:false},startup:{typeset:false},options:{enableMenu:false,renderActions:{assistiveMml:[]}}}</script><script src="/mathjax/tex-chtml-full.js"></script></head><body><main><section><p class="label">Live preview</p><div id="live" class="ll-editor-content lsp-cm-view"></div></section><section><p class="label">Source, portaled formula previews and theorem card</p><div id="source" class="ll-editor-content lsp-cm-view"></div></section></main><div id="fixed" class="ll-editor-content lsp-cm-view"></div><script src="/bundle.js"></script></body></html>`);
 server = createServer((req, res) => { const path = decodeURIComponent(new URL(req.url, 'http://x').pathname), base = path.startsWith('/mathjax/') ? mathjax : work, file = join(base, path.startsWith('/mathjax/') ? path.slice(9) : path); if (!file.startsWith(base + sep) || !existsSync(file)) { res.writeHead(404).end(); return; } res.writeHead(200, { 'content-type': ({ '.js': 'text/javascript', '.html': 'text/html', '.woff': 'font/woff' })[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file)); });
 await new Promise(ok => server.listen(0, '127.0.0.1', ok));
 chrome = spawn(chromeBin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(work, 'profile')}`, '--no-first-run', '--disable-extensions', '--disable-background-timer-throttling', 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
 const url = await new Promise((ok, fail) => { let err = ''; const timer = setTimeout(() => fail(new Error('Chrome start timeout: ' + err.slice(-200))), 20000); chrome.stderr.on('data', d => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) { clearTimeout(timer); ok(m[1]); } }); chrome.once('exit', () => fail(new Error('Chrome exited'))); });
 const { page, evaluate } = await connect(url);
 await page('Page.enable'); await page('Runtime.enable');
 await page('Emulation.setDeviceMetricsOverride', { width: 1120, height: 880, deviceScaleFactor: 1, mobile: false });
 await page('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/index.html` });
 for (let i = 0; i < 160; i++) { if (await evaluate('window.__ready && !!window.MathJax?.tex2chtml').catch(() => false)) break; await sleep(50); }
 await evaluate('mount()');
 const native = await evaluate('snapshot()');
 const roles = ['live-inline', 'live-display', 'hover', 'cursor', 'card-inline', 'card-display'];
 check('real CHTML live, hover, cursor and theorem math exist', roles.every(role => native.maths[role]), Object.keys(native.maths));
 await evaluate('apply({})'); const defaults = await evaluate('snapshot()');
 check('default appearance preserves original inherited formula geometry', roles.every(role => close(defaults.maths[role].glyph.width, native.maths[role].glyph.width, .5) && close(defaults.maths[role].glyph.height, native.maths[role].glyph.height, .5)));
 check('CHTML original inline percentages remain intact', roles.every(role => native.maths[role].inline.endsWith('%') && defaults.maths[role].inline === native.maths[role].inline), roles.map(role => [role, native.maths[role].inline]));
 await evaluate('apply({editorFontSize:16})'); const baseline = await evaluate('snapshot()');
 await evaluate('apply({editorFontSize:24})'); const fontOnly = await evaluate('snapshot()');
 await evaluate('apply({editorLineHeight:2.1})'); const lineOnly = await evaluate('snapshot()');
 await evaluate('apply({editorFontSize:24,editorLineHeight:1.8,editorFontFamily:"Courier New, monospace",mathPreviewScale:1.5})'); const scaled = await evaluate('snapshot()');
 const ratios = roles.map(role => ({ role, width: scaled.maths[role].glyph.width / baseline.maths[role].glyph.width, height: scaled.maths[role].glyph.height / baseline.maths[role].glyph.height }));
 // Inline MathJax boxes include the browser's font line box, rounded independently.
 check('16px → 24px and 100% → 150% scales actual glyph geometry appropriately', ratios.every(r => close(r.width, 2.25) && close(r.height, 2.25, r.role.endsWith('display') ? .04 : .15)), ratios);
 check('all adjusted formula wrappers use 36px before native CHTML compensation', roles.every(role => scaled.maths[role].wrapperFont === '36px'), roles.map(role => [role, scaled.maths[role].wrapperFont]));
 check('source typography responds in the real scroller', scaled.source.font === '24px' && scaled.source.family.includes('Courier New') && close(Number.parseFloat(scaled.source.lineHeight), 43.2, .2), scaled.source);
 check('font-only, line-height-only and combined reflow keep gutter tops aligned', scaled.source.lines.some((line, i) => line.height > baseline.source.lines[i]?.height) && [fontOnly, lineOnly, scaled].every(s => s.source.gutterDiff.every(d => Math.abs(d) <= 1.5)) && fontOnly.source.font === '24px' && close(Number.parseFloat(lineOnly.source.lineHeight), 33.6, .2), { fontOnly: fontOnly.source.gutterDiff, lineOnly: lineOnly.source.gutterDiff, combined: scaled.source.gutterDiff });
 check('local appearance retains source/selection and external body portals', scaled.documentUnchanged && scaled.portals.every(p => p.parent && p.mathSize === '24px' && p.scale === '1.5'), scaled.portals);
 const image = await page('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, 'scaled-wide.png'), Buffer.from(image.data, 'base64'));
 await evaluate('apply({editorFontSize:24,editorLineHeight:1.8,editorFontFamily:"Courier New, monospace",mathPreviewScale:1})'); const unscaled = await evaluate('snapshot()');
 check('only math changes with the formula scale', roles.every(role => close(scaled.maths[role].glyph.width / unscaled.maths[role].glyph.width, 1.5)) && Object.keys(scaled.fixed).every(key => scaled.fixed[key].layoutWidth === unscaled.fixed[key].layoutWidth && scaled.fixed[key].layoutHeight === unscaled.fixed[key].layoutHeight && scaled.fixed[key].font === unscaled.fixed[key].font) && scaled.cardText.font === unscaled.cardText.font && scaled.source.font === unscaled.source.font, { scaledFixed: scaled.fixed, unscaledFixed: unscaled.fixed, cardFont: scaled.cardText.font });
 await evaluate('apply({})'); const reset = await evaluate('snapshot()');
 const resetCorrect = roles.every(role => close(reset.maths[role].glyph.width, native.maths[role].glyph.width, .5) && reset.maths[role].inline === native.maths[role].inline) && reset.source.font === native.source.font && reset.source.family === native.source.family && reset.source.gutterDiff.every(d => Math.abs(d) <= 1.5) && reset.portals.every(p => p.mathSize === '' && p.scale === '');
 const resetImage = await page('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, 'defaults-wide.png'), Buffer.from(resetImage.data, 'base64'));
 const undoKept = await evaluate('undoProof()');
 check('reset restores inheritance/portal sizes and prior edit still undoes', resetCorrect && undoKept, { portals: reset.portals, gutterDiff: reset.source.gutterDiff, undoKept });
 await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: false });
 const long = await evaluate('longPopup()');
 check('long 200% cursor formula stays within narrow viewport and scrolls horizontally', long.tooltip.x >= 0 && long.tooltip.right <= long.viewport + 1 && long.scrollWidth > long.clientWidth && long.scrollLeft > 0, long);
 const narrowImage = await page('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, 'long-formula-narrow.png'), Buffer.from(narrowImage.data, 'base64'));
 writeFileSync(join(shots, 'measurements.json'), JSON.stringify({ native, defaults, baseline, fontOnly, lineOnly, scaled, unscaled, reset, undoKept, long, results }, null, 2));
} catch (e) { check('smoke run', false, e.stack ?? String(e)); }
finally {
 ws?.close(); if (chrome?.exitCode === null) { try { process.kill(-chrome.pid, 'SIGKILL'); } catch { chrome.kill('SIGKILL'); } }
 server?.close(); rmSync(work, { recursive: true, force: true });
}
console.log(`editor-appearance-smoke: ${results.filter(r => r.pass).length}/${results.length} passed; screenshots ${shots}`);
process.exitCode = results.some(r => !r.pass) ? 1 : 0;
