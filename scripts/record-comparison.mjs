#!/usr/bin/env node
// Record the supplied comparison deck, not Obsidian or a reconstructed Overleaf UI.
// A fresh headed Chrome app window is captured by the existing native SC recorder.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sceneIDs = ['workflow', 'live_source', 'proof_refs', 'pdf_toolchain', 'ai_choices', 'reading_html', 'review_collaboration', 'audience_fit'];
const bundleID = 'com.google.Chrome';
const HELP = `Usage: node scripts/record-comparison.mjs --prepare-only | --record [options]
  --deck ABS_HTML     Default: ~/Desktop/LaTeX-Live-Demo-2026-09-30/comparison-deck.html
  --out ABS_DIR      Artifact root; raw/ and evidence/ are created only when recording
  --id SAFE_SLUG     Default: 04-overleaf-comparison-deck; use a fresh id for every take
  --seconds 9..12    Unaltered native time per page; default 10 seconds
  --chrome ABS_BIN   Official Google Chrome executable
  --capture-bin BIN  Existing compiled scripts/demo-capture.swift executable
  --window-width N  App-window width in screen points; default 1440
  --window-height N App-window height in screen points; default 1000
--prepare-only validates the deck, caption IDs, binaries and plan without launching any app,
querying windows, changing focus or recording. --record must be explicitly selected.
The isolated Chrome profile is removed after its own process group exits. No personal Chrome
tabs or credentials are accessed. ScreenCaptureKit records the selected exact-title window at
1920 output pixels, with no audio. Events use its actual startedAtUnixMs as the time origin.
Output: evidence/<id>-recording.json, compatible with package-demo-videos.mjs. This is a
documented comparison deck, not native product interaction, an Overleaf test or a speed benchmark.
`;
function fail(message) { throw new Error(message); }
function optionsFrom(argv) {
  const base = join(homedir(), 'Desktop', 'LaTeX-Live-Demo-2026-09-30');
  const options = { deck: join(base, 'comparison-deck.html'), output: base, id: '04-overleaf-comparison-deck', seconds: 10, width: 1440, height: 1000,
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', capture: join(repository, 'node_modules/.cache/product-demo/bin/demo-capture') };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (key === '--prepare-only' || key === '--record') {
      if (options.mode) fail('Select exactly one of --prepare-only or --record');
      options.mode = key.slice(2); continue;
    }
    const value = argv[++i]; if (value === undefined) fail(`Missing value for ${key}`);
    if (key === '--deck') options.deck = resolve(value);
    else if (key === '--out') options.output = resolve(value);
    else if (key === '--id') options.id = value;
    else if (key === '--seconds') options.seconds = Number(value);
    else if (key === '--window-width') options.width = Number(value);
    else if (key === '--window-height') options.height = Number(value);
    else if (key === '--chrome') options.chrome = resolve(value);
    else if (key === '--capture-bin') options.capture = resolve(value);
    else fail(`Unknown argument ${key}`);
  }
  if (!options.mode) fail(HELP);
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(options.id)) fail('Recording id must be a safe slug');
  if (!Number.isFinite(options.seconds) || options.seconds < 9 || options.seconds > 12) fail('seconds must be between 9 and 12');
  for (const key of ['width', 'height']) if (!Number.isInteger(options[key]) || options[key] < 600 || options[key] > 2400) fail(`Invalid window ${key}`);
  return options;
}
async function prepare(options) {
  for (const path of [options.deck, options.chrome, options.capture]) if (!existsSync(path)) fail(`Required existing file missing: ${path}`);
  const html = await readFile(options.deck, 'utf8');
  const title = /<title>([^<]+)<\/title>/i.exec(html)?.[1]; if (!title) fail('Deck needs an exact window title');
  const encoded = /const pages=(\[[\s\S]*?\]);let page=/.exec(html)?.[1];
  if (!encoded || !html.includes('window.showPage=')) fail('Deck must expose its JSON pages and window.showPage(n)');
  const pages = JSON.parse(encoded);
  if (JSON.stringify(pages.map(p => p.id)) !== JSON.stringify(sceneIDs)) fail('Deck scene IDs/order differ from the eight documented segments');
  const libraryPath = join(repository, 'docs/demo/comparison-video-captions.json');
  const library = JSON.parse(await readFile(libraryPath, 'utf8'));
  for (const page of pages) {
    const cue = library.segments?.find(c => c.id === page.id); if (!cue) fail(`Missing caption for ${page.id}`);
    for (const field of ['title_zh', 'title_en', 'text_zh', 'text_en']) if (!page[field] || page[field] !== cue[field]) fail(`Deck/caption mismatch: ${page.id}.${field}`);
    if (!Array.isArray(page.sourceURLs) || page.sourceURLs.some(url => !url.startsWith('https://docs.overleaf.com/'))) fail(`Unexpected source link in ${page.id}`);
    if (JSON.stringify(page.sourceURLs) !== JSON.stringify(cue.sourceURLs)) fail(`Deck/caption source mismatch: ${page.id}`);
  }
  return { title, pages, libraryPath, htmlSha256: createHash('sha256').update(html).digest('hex'), fileURL: pathToFileURL(options.deck).href };
}

const lifetime = new AbortController();
let signalReceived, chrome, recorder, socket, profile, stopFile, receiptPath, recording, startedAt;
let recordFinished, recordExited, writeQueue = Promise.resolve();
function abortReason() { return lifetime.signal.reason ?? new Error('Recording interrupted'); }
function delay(ms) {
  if (lifetime.signal.aborted) return Promise.reject(abortReason());
  return new Promise((ok, reject) => {
    const stop = () => { clearTimeout(timer); reject(abortReason()); };
    const timer = setTimeout(() => { lifetime.signal.removeEventListener('abort', stop); ok(); }, ms);
    lifetime.signal.addEventListener('abort', stop, { once: true });
  });
}
function save() {
  if (!recording) return Promise.resolve();
  const text = JSON.stringify({ schema: 'latex-live-demo-recordings-v1', outputDir: join(dirname(dirname(receiptPath)), 'videos'),
    captionLibraries: [join(repository, 'docs/demo/comparison-video-captions.json')],
    capture_kind: 'documented_comparison_deck', input_method: 'Own isolated headed Chrome app; actual deck rendering; native selected-window ScreenCaptureKit capture',
    comparison_boundary: 'Source-backed explanatory deck. No actual Overleaf session, reconstructed product UI, matched performance benchmark, speedup or live AI inference.',
    recordings: [recording] }, null, 2);
  writeQueue = writeQueue.then(() => writeFile(receiptPath, text)); return writeQueue;
}
async function requestStop() { if (stopFile) await writeFile(stopFile, ''); }
function interrupted(signal) {
  if (signalReceived) return;
  signalReceived = signal; lifetime.abort(new Error(`Interrupted by ${signal}`));
  requestStop().catch(error => console.error(error.message));
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  if (!recorder) terminateGroup(chrome, 'SIGTERM');
}
const onInterrupt = () => interrupted('SIGINT'), onTerminate = () => interrupted('SIGTERM');
function terminateGroup(child, signal) {
  if (!child?.pid) return;
  // Chrome helpers can outlive the group leader; still address our whole detached group.
  try { process.kill(-child.pid, signal); } catch { if (child.exitCode === null && child.signalCode === null) child.kill(signal); }
}
function exitPromise(child) { return new Promise(resolveExit => child.once('close', (code, signal) => resolveExit({ code, signal }))); }
async function runCaptureList(binary) {
  return new Promise((ok, reject) => {
    const child = spawn(binary, ['list', bundleID], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Native window inventory timed out')); }, 10000);
    const stop = () => { child.kill('SIGTERM'); reject(abortReason()); };
    lifetime.signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error = (error + data).slice(-1000); });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer); lifetime.signal.removeEventListener('abort', stop);
      if (code !== 0) reject(new Error(`Native window inventory failed (${code}): ${error || output}`));
      else { try { ok(JSON.parse(output.trim())); } catch { reject(new Error('Invalid native window inventory response')); } }
    });
  });
}
async function connect(endpoint) {
  socket = new WebSocket(endpoint);
  await new Promise((ok, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned Chrome connection timed out')), 10000);
    const stop = () => { clearTimeout(timer); reject(abortReason()); };
    lifetime.signal.addEventListener('abort', stop, { once: true });
    socket.onopen = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', stop); ok(); };
    socket.onerror = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', stop); reject(new Error('Owned Chrome connection failed')); };
  });
  let sequence = 0; const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), operation = pending.get(message.id); if (!operation) return;
    pending.delete(message.id); clearTimeout(operation.timer);
    message.error ? operation.reject(new Error(JSON.stringify(message.error))) : operation.ok(message.result);
  };
  socket.onclose = () => { for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new Error('Owned Chrome connection closed')); } pending.clear(); };
  const send = (method, params = {}, sessionId) => new Promise((ok, reject) => {
    if (lifetime.signal.aborted) return reject(abortReason());
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { ok, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return send;
}
async function launch(options, deck) {
  profile = await mkdtemp(join(tmpdir(), 'latex-live-comparison-chrome-'));
  chrome = spawn(options.chrome, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    `--window-size=${options.width},${options.height}`, `--app=${deck.fileURL}`], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((ok, reject) => {
    let error = ''; const timer = setTimeout(() => reject(new Error('Owned Chrome did not publish a debugger endpoint')), 20000);
    chrome.stderr.on('data', data => { error = (error + data).slice(-8000); const match = /DevTools listening on (ws:\/\/\S+)/.exec(error); if (match) { clearTimeout(timer); ok(match[1]); } });
    chrome.once('error', error => { clearTimeout(timer); reject(error); }); chrome.once('exit', () => { clearTimeout(timer); reject(new Error('Owned Chrome exited before debugger startup')); });
  });
  const send = await connect(endpoint);
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    const list = await send('Target.getTargets'); target = list.targetInfos.find(t => t.type === 'page' && t.url === deck.fileURL); if (!target) await delay(250);
  }
  if (!target) fail('The isolated Chrome target did not open the exact local deck URL');
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const evaluate = async expression => {
    const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (value.exceptionDetails) fail(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
    return value.result.value;
  };
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
  await send('Page.bringToFront', {}, sessionId);
  const browserWindow = await send('Browser.getWindowForTarget', { targetId: target.targetId });
  await send('Browser.setWindowBounds', { windowId: browserWindow.windowId, bounds: { windowState: 'normal' } });
  await send('Browser.setWindowBounds', { windowId: browserWindow.windowId, bounds: { left: 0, top: 25, width: options.width, height: options.height } });
  await evaluate('document.fonts.ready');
  if (await evaluate('document.title') !== deck.title) fail('Owned local deck title differs from the exact capture title');
  return { evaluate, browserWindow, targetID: target.targetId };
}
async function showAndVerify(evaluate, deck, index) {
  const visible = await evaluate(`(async()=>{const returnedId=window.showPage(${index});await document.fonts.ready;await new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)));const main=document.querySelector('main'),r=main.getBoundingClientRect();return{url:location.href,title:document.title,returnedId,renderedId:pages[page]?.id,count:document.getElementById('count').textContent,title_zh:document.getElementById('title').textContent,title_en:document.getElementById('title-en').textContent,text_zh:document.getElementById('zh').textContent,text_en:document.getElementById('en').textContent,sourceURLs:[...document.querySelectorAll('#sources a')].map(a=>a.href),viewport:{width:innerWidth,height:innerHeight},bounds:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},displayedAtUnixMs:Date.now()}})()`);
  const expected = deck.pages[index];
  if (visible.url !== deck.fileURL || visible.title !== deck.title || visible.returnedId !== expected.id || visible.renderedId !== expected.id || visible.count !== `${index + 1} / ${deck.pages.length}`) fail(`Wrong rendered scene identity: ${expected.id}`);
  for (const field of ['title_zh', 'title_en', 'text_zh', 'text_en']) if (visible[field] !== expected[field]) fail(`Rendered text mismatch: ${expected.id}.${field}`);
  if (JSON.stringify(visible.sourceURLs) !== JSON.stringify(expected.sourceURLs)) fail(`Rendered source links mismatch: ${expected.id}`);
  if (visible.bounds.left < 0 || visible.bounds.top < 0 || visible.bounds.right > visible.viewport.width + 1 || visible.bounds.bottom > visible.viewport.height + 1) fail(`Deck scene extends outside the visible window; choose a fitting window/layout: ${expected.id} ${JSON.stringify({ bounds: visible.bounds, viewport: visible.viewport })}`);
  return visible;
}
async function nativeWindow(options, title) {
  for (let i = 0; i < 30; i++) {
    const metadata = await runCaptureList(options.capture);
    // Do not log or persist unrelated Chrome window titles from this inventory.
    const matches = metadata.windows?.filter(w => w.onScreen && w.title === title) ?? [];
    if (matches.length > 1) fail('Multiple visible Chrome windows have the exact deck title; ownership is ambiguous');
    if (matches.length === 1) return matches[0];
    await delay(300);
  }
  fail('The owned Chrome deck window is not visible with its exact title');
}
async function begin(options, deck, window, cdp) {
  const rawPath = join(options.output, 'raw', `${options.id}.mp4`);
  stopFile = join(options.output, 'evidence', `${options.id}.stop`); receiptPath = join(options.output, 'evidence', `${options.id}-recording.json`);
  for (const path of [rawPath, stopFile, receiptPath]) if (existsSync(path)) fail(`Choose a fresh recording id; path already exists: ${path}`);
  recording = { id: options.id, title_zh: 'LaTeX Live 与 Overleaf：有来源的工作流对比讲解页', title_en: 'LaTeX Live and Overleaf: documented workflow comparison deck',
    rawPath, stopFile, capture_kind: 'documented_comparison_deck', deckPath: options.deck, deckSHA256: deck.htmlSha256, windowID: window.id,
    exactWindowTitle: window.title, chromeBundleID: bundleID, ownedTargetID: cdp.targetID, chromeProcessID: chrome.pid, requestedSecondsPerScene: options.seconds, events: [] };
  await save();
  recorder = spawn(options.capture, ['record', String(window.id), rawPath, stopFile, bundleID, '1920'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  recordExited = exitPromise(recorder);
  await new Promise((ok, reject) => {
    let buffered = ''; const timer = setTimeout(() => reject(new Error('Native recorder start timed out')), 20000);
    recorder.stdout.on('data', data => {
      buffered += data;
      for (;;) {
        const end = buffered.indexOf('\n'); if (end < 0) break;
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1); if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch { clearTimeout(timer); reject(new Error('Invalid native recorder event')); continue; }
        if (event.event === 'started') {
          startedAt = event.startedAtUnixMs;
          if (!Number.isFinite(startedAt) || event.windowID !== window.id || event.bundleID !== bundleID || event.audio !== false || event.width !== 1920) { clearTimeout(timer); reject(new Error('Native capture metadata does not match the selected silent 1920px window')); continue; }
          recording.capture = event; clearTimeout(timer); save().then(ok, reject);
        } else if (event.event === 'finished') { recordFinished = event; recording.captureFinished = event; save().catch(reject); }
        else if (event.event === 'error' || event.error) { clearTimeout(timer); reject(new Error(event.message ?? event.error)); }
        console.log(JSON.stringify({ ...event, capture_kind: 'documented_comparison_deck' }));
      }
    });
    recorder.stderr.on('data', data => process.stderr.write(data)); recorder.once('error', error => { clearTimeout(timer); reject(error); });
    recorder.once('exit', code => { clearTimeout(timer); if (!startedAt) reject(new Error(`Native recorder failed before starting (${code})`)); });
  });
}
async function cleanup() {
  await requestStop().catch(() => {});
  if (recorder && recorder.exitCode === null && recorder.signalCode === null) {
    const done = await Promise.race([recordExited, new Promise(ok => setTimeout(() => ok(null), 10000))]);
    if (!done) { terminateGroup(recorder, 'SIGTERM'); await new Promise(ok => setTimeout(ok, 1000)); terminateGroup(recorder, 'SIGKILL'); }
  }
  socket?.close();
  if (chrome) {
    terminateGroup(chrome, 'SIGTERM'); await new Promise(ok => setTimeout(ok, 300)); terminateGroup(chrome, 'SIGKILL');
  }
  if (profile) await rm(profile, { recursive: true, force: true });
  await writeQueue.catch(() => {});
}
async function main() {
  const options = optionsFrom(process.argv.slice(2)); if (options.help) { console.log(HELP); return; }
  const deck = await prepare(options);
  if (options.mode === 'prepare-only') {
    console.log(JSON.stringify({ event: 'prepared', status: 'prepared_not_recorded', capture_kind: 'documented_comparison_deck', deckPath: options.deck, deckSHA256: deck.htmlSha256, exactWindowTitle: deck.title,
      sceneIDs, secondsPerScene: options.seconds, plannedSceneSeconds: deck.pages.length * options.seconds, outputRoot: options.output, recordingID: options.id, nativeOutputWidth: 1920, audio: false,
      isolation: 'Fresh temporary Chrome profile and own debugger target; exact-title selected native window', validation: 'Static only: no app launch, window query, focus, capture or scene timing' }, null, 2)); return;
  }
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  try {
    await mkdir(join(options.output, 'raw'), { recursive: true }); await mkdir(join(options.output, 'evidence'), { recursive: true });
    const cdp = await launch(options, deck); await showAndVerify(cdp.evaluate, deck, 0);
    const window = await nativeWindow(options, deck.title); await begin(options, deck, window, cdp);
    for (let index = 0; index < deck.pages.length; index++) {
      if (lifetime.signal.aborted) throw abortReason();
      const verified = await showAndVerify(cdp.evaluate, deck, index);
      const start_s = (verified.displayedAtUnixMs - startedAt) / 1000;
      if (start_s < 0) fail('Scene verification predates the actual native capture origin');
      if (recording.events.length) recording.events.at(-1).end_s = start_s;
      const event = { id: deck.pages[index].id, start_s, status: 'verified', details: { capture_kind: 'documented_comparison_deck', verification: 'Exact rendered page ID, count, bilingual title/body, source links and visible bounds', ...verified,
        claim_status: deck.pages[index].claim_status, localEvidence: deck.pages[index].localEvidence, ...(deck.pages[index].boundary ? { boundary: deck.pages[index].boundary } : {}) } };
      recording.events.push(event); await save(); console.log(JSON.stringify({ event: 'scene', ...event }));
      await delay(options.seconds * 1000);
      if (recorder.exitCode !== null || recorder.signalCode !== null) fail('Native recorder exited during the deck');
    }
    recording.events.at(-1).end_s = (Date.now() - startedAt) / 1000; await save(); await requestStop();
    const result = await Promise.race([recordExited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Native recorder did not finish after its stop-file')), 15000); recordExited.finally(() => clearTimeout(timer)); })]);
    if (result.code !== 0 || !recordFinished) fail(`Native recorder did not finish successfully (${result.code ?? result.signal})`);
    recording.completed = true; await save(); console.log(JSON.stringify({ event: 'completed', capture_kind: 'documented_comparison_deck', receiptPath, rawPath: recording.rawPath }));
  } catch (error) {
    if (recording) { recording.completed = false; recording.failure = error.stack ?? String(error); recording.interruptedBy = signalReceived ?? null; await save(); }
    throw error;
  } finally { await cleanup(); process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate); }
}
main().catch(error => { console.error(error.stack ?? String(error)); process.exitCode = signalReceived ? (signalReceived === 'SIGINT' ? 130 : 143) : 1; });
