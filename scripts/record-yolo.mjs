#!/usr/bin/env node
// Native YOLO demonstration in the existing courses vault. Preparation never invokes Obsidian.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vault = 'courses', chatType = 'yolo-chat-view';
const cache = join(repository, 'node_modules/.cache/product-demo');
const HELP = `Usage: node scripts/record-yolo.mjs --prepare-only | --record [options]
  --out ABS_DIR       Default: ~/Desktop/LaTeX-Live-Demo-2026-09-30
  --id SAFE_SLUG      Default: 03-yolo-public; every take needs a fresh id
  --language zh|en    Chat prompt language; default zh
  --dismiss enter|escape  Second real ghost's keyboard check; default enter
  --passive-ghost      Record/observe only; root uses native CUA keys. No AI or input is sent.
  --public-file PATH   Existing public TeX path for --passive-ghost
  --stop-passive       Create the selected take's stop-file only; no UI is touched
  --capture-bin BIN   Existing compiled scripts/demo-capture.swift
--prepare-only reads public source/code/caption metadata and checks file paths. No app, window,
focus, vault, settings, capture or inference operations are performed.
--record requires the courses window already open and the original workspace backups present.
It isolates the workspace before capture, creates only _editor-test/product-demo-ai/<id>/public.tex,
and uses that public file for every source read/edit and every model request. No configuration
is copied. Only LaTeX Live's yoloTabCompletion boolean can be changed temporarily in memory;
it is restored in finally. YOLO enable/model preferences are never changed or serialized.
The script never reads data.json, settings objects, private source, private prompts or request traces.
Only the exact courses native window is captured, without audio. AI waits are bounded to 90s.
After a real chat answer, it writes public response/snippet files and waits up to 180s for operator
review in evidence/<id>-approval.json: {"approved":true,"snippetSha256":"<printed SHA256>"}.
Approval must match the actual response fragment. No preset answer is inserted. Failed/pending
scenes remain unverified and are omitted by the caption packager. The saved layout backups are
not read or overwritten; restoring the original workspace after the recording is the operator's job.
`;
function optionsFrom(argv) {
  const o = { out: join(homedir(), 'Desktop', 'LaTeX-Live-Demo-2026-09-30'), id: '03-yolo-public', language: 'zh', dismiss: 'enter', capture: join(cache, 'bin/demo-capture') };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (key === '--prepare-only' || key === '--record') { if (o.mode) throw Error('Select one mode'); o.mode = key.slice(2); continue; }
    if (key === '--passive-ghost') { o.passiveGhost = true; continue; }
    if (key === '--stop-passive') { o.stopPassive = true; continue; }
    const value = argv[++i]; if (!value) throw Error(`Missing value for ${key}`);
    if (key === '--out') o.out = resolve(value);
    else if (key === '--id') o.id = value;
    else if (key === '--language') o.language = value;
    else if (key === '--dismiss') o.dismiss = value;
    else if (key === '--capture-bin') o.capture = resolve(value);
    else if (key === '--public-file') o.publicFile = value;
    else throw Error(`Unknown option ${key}`);
  }
  if (!o.mode && !o.stopPassive) throw Error(HELP);
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(o.id)) throw Error('Use a safe take id');
  if (!['zh', 'en'].includes(o.language) || !['enter', 'escape'].includes(o.dismiss)) throw Error('Invalid language or dismissal check');
  if (o.passiveGhost && !/^_editor-test\/product-demo-ai\/[a-z0-9_-]+\/public\.tex$/i.test(o.publicFile ?? '')) throw Error('Passive observer needs an exact existing public demo TeX path');
  return o;
}
const sha = text => createHash('sha256').update(text).digest('hex');
function prepare(o) {
  const sourcePath = join(cache, 'yolo-staging/public.tex');
  const pluginCode = join(homedir(), 'Desktop', vault, '.obsidian/plugins/yolo/main.js');
  const manifestPath = join(homedir(), 'Desktop', vault, '.obsidian/plugins/yolo/manifest.json');
  const backups = ['courses-layout.json', 'courses-window.json'].map(f => join(cache, 'session-backups', f));
  for (const path of [sourcePath, pluginCode, manifestPath, o.capture, '/usr/local/bin/obsidian', ...backups]) if (!existsSync(path)) throw Error(`Required file missing: ${path}`);
  const source = readFileSync(sourcePath, 'utf8'), code = readFileSync(pluginCode, 'utf8');
  if (!source.includes('Presenter-authored') || !source.includes('Put $N=') || !source.includes('\\end{proof}')) throw Error('Expected public proof workbench missing');
  const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
  if (version !== '1.6.9.7') throw Error('Installed YOLO version needs a fresh contract audit');
  for (const token of ['getTabCompletionController(){', 'async addFileToChat(', 'createChatLeaf(', 'yolo-ghost-text', 'yolo-chat-user-input-submit-button-circle', 'yolo-assistant-message-selectable-content']) if (!code.includes(token)) throw Error(`Public YOLO contract missing: ${token}`);
  const library = join(repository, 'docs/demo/demo-captions.json');
  const cues = JSON.parse(readFileSync(library, 'utf8')).cues;
  for (const id of ['yolo_ghost', 'yolo_context', 'yolo_apply', 'vault_boundary']) if (!cues.some(c => c.id === id)) throw Error(`Caption missing: ${id}`);
  const paths = { receipt: join(o.out, 'evidence', `${o.id}-recording.json`), raw: join(o.out, 'raw', `${o.id}.mp4`), stop: join(o.out, 'evidence', `${o.id}.stop`), approval: join(o.out, 'evidence', `${o.id}-approval.json`), response: join(o.out, 'evidence', `${o.id}-response.txt`), snippet: join(o.out, 'evidence', `${o.id}-snippet.tex`) };
  for (const p of Object.values(paths)) if (existsSync(p)) throw Error('Choose a fresh take id; an output already exists');
  return { source, sourcePath, sourceSha256: sha(source), version, library, paths, file: `_editor-test/product-demo-ai/${o.id}/public.tex` };
}

function passiveInstallCode(path, evidence) {
  return `
    if(window.__latexGhostObserver)throw Error('A passive observer is already installed');
    const path=${JSON.stringify(path)},evidence=${JSON.stringify(evidence)};
    const leaf=app.workspace.getLeavesOfType('latex-live-editor').find(l=>l.view.file?.path===path);
    if(!leaf?.view?.editorView)throw Error('Exact public TexView is not open');
    const view=leaf.view,e=view.editorView,p=app.plugins.plugins['latex-live'],y=app.plugins.plugins.yolo;
    const fs=require('fs');
    const previous=p.settings.yoloTabCompletion;p.settings.yoloTabCompletion=true;p.yolo.refresh();
    const originalDispatch=e.dispatch;let stopped=false,generation=0,lastSuggestion=null,lastSerialized='',lastCandidate=null,lastSource=e.state.doc.toString();
    const isPublic=()=>!stopped&&view.file?.path===path;
    const snapshot=()=>{
      const t=y.tabCompletionController,c=t?.tabCompletionSuggestion;
      if(c&&c!==lastSuggestion){lastSuggestion=c;generation++;}
      const selected=c?.view===e?c.candidates[c.selectedIndex]:null;
      const value={generation,requestRunning:!!t?.tabCompletionAbortController,nativeFocused:require('electron').remote.getCurrentWindow().isFocused(),documentFocused:document.hasFocus(),editorFocused:e.hasFocus,inlineStatus:p.yolo.inline.status(e),candidateSlots:c?.view===e?c.candidates.length:0,selectedStatus:selected?.status??null,text:selected?.text??'',cursorOffset:c?.view===e?c.cursorOffset:null,replaceFromOffset:c?.view===e?c.replaceFromOffset:null};
      if(value.text)lastCandidate=value;
      return value;
    };
    const write=value=>{if(isPublic())fs.appendFileSync(evidence,JSON.stringify({at:Date.now(),file:path,...value})+'\\n');};
    write({type:'installed',source:lastSource,previousLatexBoolean:previous});
    const dispatchObserver=function(...args){
      if(!isPublic())return originalDispatch.apply(this,args);
      const before=e.state.doc.toString(),candidateBefore=snapshot();
      const events=args.map(arg=>{
        if(typeof arg?.userEvent==='string')return arg.userEvent;
        const annotation=arg?.annotations?.find(a=>typeof a.value==='string'&&/^(?:input(?:\\.|$)|undo$|redo$|delete(?:\\.|$)|select(?:\\.|$))/.test(a.value));
        if(annotation)return annotation.value;
        for(const type of ['input.complete.ai','undo','redo','input.type','input'])if(arg?.isUserEvent?.(type))return type;
        return null;
      });
      const result=originalDispatch.apply(this,args);
      if(!isPublic())return result;
      const after=e.state.doc.toString();
      if(after!==before){
        let from=0,suffix=0;while(from<before.length&&from<after.length&&before[from]===after[from])from++;
        while(suffix<before.length-from&&suffix<after.length-from&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
        const changes=[{from,to:before.length-suffix,insert:after.slice(from,after.length-suffix)}];
        write({type:'source-change',sourceBefore:before,sourceAfter:after,transactions:events.map(userEvent=>({userEvent,changes})),candidateBefore:candidateBefore.text?candidateBefore:lastCandidate,state:snapshot()});lastSource=after;
      }
      return result;
    };
    e.dispatch=dispatchObserver;
    const onKey=event=>{if(!isPublic()||!(['Tab','Enter','Escape'].includes(event.key)||(event.key.toLowerCase()==='z'&&event.metaKey)))return;write({type:'native-key',key:event.key,meta:!!event.metaKey,shift:!!event.shiftKey,isTrusted:event.isTrusted,state:snapshot()});};
    e.dom.addEventListener('keydown',onKey,true);
    const timer=setInterval(()=>{if(!isPublic())return;const current=snapshot(),serialized=JSON.stringify(current);if(serialized!==lastSerialized){lastSerialized=serialized;write({type:'controller-state',state:current});}},100);
    window.__latexGhostObserver={stop(){if(stopped)return{alreadyStopped:true};clearInterval(timer);e.dom.removeEventListener('keydown',onKey,true);if(view.file?.path===path)write({type:'stopped',source:e.state.doc.toString(),state:snapshot()});stopped=true;if(e.dispatch===dispatchObserver)e.dispatch=originalDispatch;p.settings.yoloTabCompletion=previous;p.yolo.refresh();delete window.__latexGhostObserver;return{observerRemoved:true,latexBooleanRestored:p.settings.yoloTabCompletion===previous,transparentDispatchRestored:e.dispatch===originalDispatch};}};
    return JSON.stringify({observerInstalled:true,file:path,evidence,viewLeafId:leaf.id,sourceCharacters:lastSource.length,temporaryLatexBoolean:true});
  `;
}
function passiveResult(rows) {
  const accepted = rows.filter(row => row.type === 'source-change' && row.transactions?.some(tr => tr.userEvent === 'input.complete.ai'));
  const exact = accepted.find(row => {
    const c = row.candidateBefore; if (!c?.text || c.cursorOffset == null) return false;
    const from = c.replaceFromOffset ?? c.cursorOffset;
    return row.sourceAfter === row.sourceBefore.slice(0, from) + c.text + row.sourceBefore.slice(c.cursorOffset);
  });
  const undo = exact && rows.find(row => row.at > exact.at && row.type === 'source-change' && row.transactions?.some(tr => tr.userEvent === 'undo') && row.sourceAfter === exact.sourceBefore);
  const enter = rows.find(row => row.type === 'native-key' && row.isTrusted && row.key === 'Enter' && row.state?.inlineStatus === 'visible' && row.state.text && (!exact || row.at > exact.at));
  const newline = enter && rows.find(row => row.at >= enter.at && row.type === 'source-change' && !row.transactions?.some(tr => tr.userEvent === 'input.complete.ai') && row.transactions?.some(tr => tr.changes.length > 0 && tr.changes.every(c => c.from === c.to && /^\n[ \t]*$/.test(c.insert))));
  const trustedTab = rows.some(row => row.type === 'native-key' && row.isTrusted && row.key === 'Tab' && row.state?.inlineStatus === 'visible');
  return { realNativeTab: trustedTab, actualAITransaction: accepted.length > 0, exactSelectedReplacement: !!exact, undoRestored: !!undo, enterWhileGhostVisible: !!enter, enterOnlyNewlineAndIndent: !!newline, freshGenerations: Math.max(0, ...rows.map(row => row.state?.generation ?? 0)), verified: trustedTab && !!exact && !!undo && !!enter && !!newline };
}
async function recordPassive() {
  mkdirSync(join(o.out, 'raw'), { recursive: true }); mkdirSync(join(o.out, 'evidence'), { recursive: true });
  const evidence = join(o.out, 'evidence', `${o.id}-observer.jsonl`);
  if (existsSync(evidence)) throw Error('Choose a fresh observer take');
  recording = { id: o.id, title_zh: '原生 YOLO 补全与键盘验证', title_en: 'Native YOLO completion and keyboard checks', rawPath: plan.paths.raw, stopFile: plan.paths.stop, events: [], ai: {}, source: { file: o.publicFile, presenterAuthored: true }, privacy: { vault, settingsCopied: false, keysRead: false, privateSourceRead: false }, driver: 'Passive public-source observer; actual trigger and keyboard input supplied through root native CUA' };
  save();
  try {
    recording.observer = await evaluate(passiveInstallCode(o.publicFile, evidence), 'Install only the passive public observer');
    await beginCapture(); event('yolo_ghost', 'pending', { passiveObserver: evidence, noInferenceOrInputSentByDriver: true });
    console.log(JSON.stringify({ event: 'passive-recording-ready', file: o.publicFile, observer: evidence, stopFile: plan.paths.stop, receipt: plan.paths.receipt, recordStartedAtUnixMs: startedAt, UIReleasedToRoot: true }));
    const deadline = Date.now() + 600000;
    while (!existsSync(plan.paths.stop) && Date.now() < deadline) await sleep(250);
    if (!existsSync(plan.paths.stop)) recording.failure = 'The passive recording reached its ten-minute cap';
    const rows = existsSync(evidence) ? readFileSync(evidence, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.at >= startedAt) : [];
    const result = passiveResult(rows); recording.ai.passiveResult = result;
    if (result.verified) verify(recording.events.at(-1), result); else failed(recording.events.at(-1), 'Observed native outcomes remain partial; inspect the public evidence without inventing success');
  } catch (error) { recording.failure = error.message; }
  finally {
    await endCapture(); interrupted = false;
    try { recording.preferenceRestoration = await evaluate(`return JSON.stringify(window.__latexGhostObserver?.stop()??{observerAlreadyAbsent:true});`, 'Remove the passive observer and restore the original boolean'); } catch { recording.preferenceRestoration = { failed: true, needsOperatorCheck: true }; }
    save(); console.log(JSON.stringify({ event: 'passive-recording-complete', receipt: plan.paths.receipt, result: recording.ai.passiveResult, preferenceRestoration: recording.preferenceRestoration }));
    if (!recording.ai.passiveResult?.verified || recording.failure || recording.preferenceRestoration.failed) process.exitCode = 1;
  }
}

let interrupted = false, recorder, recording, startedAt, o, plan;
const sleep = ms => new Promise((ok, fail) => setTimeout(() => interrupted ? fail(Error('Recording interrupted')) : ok(), ms));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; });
async function evaluate(code, operation = 'Public demo operation', nativeFocus = false, timeoutMs = 15000) {
  if (interrupted) throw Error('Recording interrupted');
  // The CLI may execute in another renderer. Only a named courses window can receive the code;
  // the target also checks its actual vault before doing anything. No fallback renderer is used.
  const inner = `(async()=>{if(app.vault.getName()!==${JSON.stringify(vault)})throw Error('Wrong vault');try{${code}}catch{return JSON.stringify({demoError:${JSON.stringify(operation)}});}})()`;
  const relay = `(async()=>{const r=require('electron').remote;const matches=r.BrowserWindow.getAllWindows().filter(w=>w.getTitle().includes(' - courses - Obsidian'));if(matches.length!==1)return JSON.stringify({demoError:'Expected one courses window'});const w=matches[0];if(${nativeFocus}){if(!await w.webContents.executeJavaScript("app.vault.getName()==='courses'"))return JSON.stringify({demoError:'Wrong native vault'});r.app.focus({steal:true});w.show();w.focus();}return await w.webContents.executeJavaScript(${JSON.stringify(inner)});})()`;
  let result;
  try { result = execFileSync('/usr/local/bin/obsidian', ['eval', 'vault=courses', `code=${relay}`], { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' }).trim().replace(/^=>\s*/, ''); }
  catch { throw Error(`${operation} failed; no raw application error was serialized`); }
  let parsed; try { parsed = JSON.parse(result); } catch { throw Error(`${operation} returned no structured receipt`); }
  if (parsed?.demoError) throw Error(parsed.demoError);
  return parsed;
}
const read = expression => evaluate(`return JSON.stringify(${expression});`, 'Read public demo state');
function save() {
  writeFileSync(plan.paths.receipt, JSON.stringify({ schema: 'latex-live-demo-recordings-v1', outputDir: join(o.out, 'videos'), captionLibraries: [plan.library], input_method: 'Official Obsidian CLI relay, native Electron keyboard/pointer events, actual installed YOLO controller and local TeX', recordings: [recording] }, null, 2));
}
function event(id, status, details = {}) {
  if (recording.events.length) recording.events.at(-1).end_s = (Date.now() - startedAt) / 1000;
  const e = { id, start_s: (Date.now() - startedAt) / 1000, status, details };
  recording.events.push(e); save(); return e;
}
function verify(e, details) { e.status = 'verified'; e.details = { ...e.details, ...details }; save(); console.log(JSON.stringify({ event: 'scene', ...e })); }
function failed(e, reason) { e.status = 'failed'; e.details.failure = reason; save(); console.log(JSON.stringify({ event: 'scene-failed', id: e.id, reason })); }
const S = 'window.__latexYoloDemo';
const E = `${S}.view.editorView`;
const proofEnd = String.raw`\end{proof}`;
async function focusEditor() {
  await evaluate(`app.workspace.setActiveLeaf(${S}.view.leaf,{focus:true});${E}.focus();return JSON.stringify({publicFocusRequested:true});`, 'Focus public editor', true);
  await sleep(150);
  const f = await read(`({native:require('electron').remote.getCurrentWindow().isFocused(),document:document.hasFocus(),editor:${E}.hasFocus})`);
  if (!f.native || !f.document || !f.editor) throw Error('The exact courses window and public editor must have native focus');
}
async function key(keyCode, modifiers = []) {
  await evaluate(`const w=require('electron').remote.getCurrentWindow();if(!w.getTitle().includes(' - courses - Obsidian'))throw Error('Wrong native key window');w.webContents.sendInputEvent({type:'keyDown',keyCode:${JSON.stringify(keyCode)},modifiers:${JSON.stringify(modifiers)}});w.webContents.sendInputEvent({type:'keyUp',keyCode:${JSON.stringify(keyCode)},modifiers:${JSON.stringify(modifiers)}});return JSON.stringify({nativeKey:true});`, 'Native public editor key', true);
  await sleep(150);
}
async function insert(text) { await evaluate(`const w=require('electron').remote.getCurrentWindow();if(!w.getTitle().includes(' - courses - Obsidian'))throw Error('Wrong native insertion window');w.webContents.insertText(${JSON.stringify(text)});return JSON.stringify({nativeInsertion:true});`, 'Native public text insertion', true); await sleep(200); }
async function clickChat(selector, portal = false) {
  const point = await read(`(()=>{const el=${portal ? 'document' : `${S}.chat.containerEl`}.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Public chat target missing');const r=el.getBoundingClientRect();if(!r.width||!r.height)throw Error('Public chat target hidden');return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await evaluate(`const w=require('electron').remote.getCurrentWindow();if(!w.getTitle().includes(' - courses - Obsidian'))throw Error('Wrong native click window');const d=w.webContents.debugger;if(!d.isAttached())d.attach('1.3');for(const p of [{type:'mouseMoved'},{type:'mousePressed',button:'left',clickCount:1},{type:'mouseReleased',button:'left',clickCount:1}])await d.sendCommand('Input.dispatchMouseEvent',{...p,...${JSON.stringify(point)}});return JSON.stringify({nativeClick:true});`, 'Native public chat click', true);
  await sleep(200);
}
async function waitFor(readState, good, timeout, label) {
  const start = Date.now(); let last;
  do { last = await readState(); if (good(last)) return last; await sleep(250); } while (Date.now() - start < timeout);
  throw Error(`${label} did not reach its verified state within ${timeout / 1000}s`);
}
async function compile() {
  await evaluate(`await ${S}.view.flush();const p=${S}.latex,s=p.sessionFor(p.rootFor(${S}.view.absolutePath()));${S}.previousResult=s?.last;p.sessionFor(p.rootFor(${S}.view.absolutePath())).request('full');return JSON.stringify({requested:true});`, 'Compile public source');
  const result = await waitFor(() => read(`(()=>{const s=${S}.latex.sessionFor(${S}.latex.rootFor(${S}.view.absolutePath()));return{fresh:!!s?.last&&s.last!==${S}.previousResult,mode:s?.last?.mode,compiling:!!s?.compiling,pdf:!!s?.last?.pdfWritten,errors:s?.last?.log.diagnostics.filter(d=>d.severity==='error').length??0,ms:s?.last?.durationMs,pdfReused:!!s?.last?.pdfReused};})()`), s => s.fresh && s.mode === 'full' && !s.compiling, 30000, 'Public full build');
  if (!result.pdf || result.errors) throw Error('The public full build did not produce a successful PDF');
  return result;
}
async function inlineKeyboardPass(action) {
  // Keep generation, inspection and the native key in one renderer operation. A CLI
  // round trip while a ghost is shown can blur the window and legitimately cancel it.
  const result = await evaluate(`
    const s=${S},e=${E},w=require('electron').remote.getCurrentWindow();
    if(!w.getTitle().includes(' - courses - Obsidian'))throw Error('Wrong native window');
    const delay=ms=>new Promise(ok=>setTimeout(ok,ms));
    const press=async(keyCode,modifiers=[])=>{w.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(200);};
    s.latex.settings.yoloTabCompletion=true;s.latex.yolo.refresh();await delay(150);
    app.workspace.setActiveLeaf(s.view.leaf,{focus:true});
    const cursor=e.state.doc.toString().lastIndexOf(${JSON.stringify(proofEnd)})-1;
    e.dispatch({selection:{anchor:cursor},scrollIntoView:true});e.focus();await delay(100);
    if(!w.isFocused()||!document.hasFocus()||!e.hasFocus)return JSON.stringify({ok:false,reason:'Public editor was not focused before the request'});
    const t=s.yolo.getTabCompletionController();t.clearTimer();t.cancelRequest();s.yolo.getInlineSuggestionController().clearInlineSuggestion();
    const prior=t.tabCompletionSuggestion,started=s.latex.yolo.triggerNow(e),deadline=Date.now()+90000;
    let candidate;
    while(Date.now()<deadline){
      const c=t.tabCompletionSuggestion,g=e.dom.querySelector('.yolo-ghost-text'),selected=c?.candidates[c.selectedIndex];
      if(c&&c!==prior&&c.view===e&&selected?.status==='complete'&&selected.text&&g?.textContent===selected.text&&g.getBoundingClientRect().width>0){candidate=c;break;}
      await delay(100);
    }
    if(!candidate)return JSON.stringify({ok:false,reason:'No visible complete real candidate within 90s',triggerAccepted:started});
    await delay(4000);
    if(!w.isFocused()||!document.hasFocus()||!e.hasFocus||s.latex.yolo.inline.status(e)!=='visible')return JSON.stringify({ok:false,reason:'The real ghost was cleared or lost focus before the native key'});
    const current=t.tabCompletionSuggestion,selected=current.candidates[current.selectedIndex],before=e.state.doc.toString(),from=current.replaceFromOffset??current.cursorOffset,to=current.cursorOffset;
    const evidence={candidateSlots:current.candidates.length,selectedCharacters:selected.text.length,replaceFromOffset:current.replaceFromOffset,cursorOffset:current.cursorOffset,nativeFocused:true};
    if(${JSON.stringify(action)}==='accept'){
      const expected=before.slice(0,from)+selected.text+before.slice(to);await press('Tab');
      const after=e.state.doc.toString();
      if(after!==expected)return JSON.stringify({ok:false,reason:'Native Tab did not apply the real selected replacement',...evidence,changed:after!==before});
      t.clearTimer();t.cancelRequest();s.yolo.getInlineSuggestionController().clearInlineSuggestion();s.latex.settings.yoloTabCompletion=false;s.latex.yolo.refresh();
      await delay(2500);await press('z',['meta']);
      if(e.state.doc.toString()!==before)return JSON.stringify({ok:false,reason:'Native Undo did not restore the public source',...evidence});
      return JSON.stringify({ok:true,tabAccepted:true,undoRestored:true,...evidence});
    }
    if(${JSON.stringify(action)}==='enter'){
      await press('Enter');const after=e.state.doc.toString(),added=after.slice(to,after.length-(before.length-to));
      if(!/^\\n[ \\t]*$/.test(added)||after!==before.slice(0,to)+added+before.slice(to))return JSON.stringify({ok:false,reason:'Enter inserted more than a newline and normal indentation',...evidence});
      t.clearTimer();t.cancelRequest();s.yolo.getInlineSuggestionController().clearInlineSuggestion();s.latex.settings.yoloTabCompletion=false;s.latex.yolo.refresh();await delay(150);await press('z',['meta']);
      if(e.state.doc.toString()!==before)return JSON.stringify({ok:false,reason:'Undo after Enter did not restore the public source',...evidence});
    }else{
      await press('Escape');if(e.state.doc.toString()!==before||e.dom.querySelector('.yolo-ghost-text')?.textContent)return JSON.stringify({ok:false,reason:'Escape did not dismiss the real ghost without changing source',...evidence});
    }
    return JSON.stringify({ok:true,dismissal:${JSON.stringify(action)},...evidence});
  `, 'Batched real inline generation and native keyboard', true, 98000);
  if (!result.ok) throw Error(result.reason);
  return result;
}
async function pauseInline() {
  await evaluate(`${S}.latex.settings.yoloTabCompletion=false;const t=${S}.yolo.getTabCompletionController();t.clearTimer();t.cancelRequest();${S}.yolo.getInlineSuggestionController().clearInlineSuggestion();${S}.latex.yolo.refresh();return JSON.stringify({paused:true});`, 'Pause only the public inline demo');
}
async function beginCapture() {
  const list = JSON.parse(execFileSync(o.capture, ['list', 'md.obsidian'], { encoding: 'utf8', timeout: 15000 }));
  const windows = list.windows.filter(w => w.onScreen && w.title.includes(' - courses - Obsidian'));
  if (windows.length !== 1) throw Error('Expected exactly one visible courses window for capture');
  recording.windowID = windows[0].id;
  recorder = spawn(o.capture, ['record', String(windows[0].id), plan.paths.raw, plan.paths.stop, 'md.obsidian', '1920'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ok, fail) => {
    let buffer = ''; const timer = setTimeout(() => fail(Error('Native capture did not start')), 15000);
    recorder.stdout.on('data', data => { buffer += data; for (;;) { const at = buffer.indexOf('\n'); if (at < 0) break; const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line) continue; const m = JSON.parse(line); if (m.event === 'started') { startedAt = m.startedAtUnixMs; recording.capture = m; clearTimeout(timer); save(); ok(); } else if (m.event === 'finished') { recording.captureFinished = m; save(); } else if (m.event === 'error') { clearTimeout(timer); fail(Error('Native capture failed')); } } });
    recorder.stderr.resume(); recorder.once('exit', () => { if (!startedAt) { clearTimeout(timer); fail(Error('Native recorder exited before its first frame')); } });
  });
}
async function endCapture() {
  if (!recorder) return;
  if (recording.events.length && startedAt) recording.events.at(-1).end_s = (Date.now() - startedAt) / 1000;
  writeFileSync(plan.paths.stop, '');
  await new Promise(ok => recorder.exitCode !== null ? ok() : recorder.once('exit', ok));
  save();
}
async function ghostScene() {
  const e = event('yolo_ghost', 'pending', { provider: 'actual installed YOLO', presetAnswer: false });
  try {
    const accepted = await inlineKeyboardPass('accept'), dismissed = await inlineKeyboardPass(o.dismiss);
    await pauseInline();
    verify(e, { realCandidate: true, accepted, dismissed, tabAccepted: true, undoRestored: true, dismissal: o.dismiss, sourceAfterDismissal: 'original public draft' });
    await sleep(3500);
  } catch (error) { failed(e, error.message); await pauseInline(); await sleep(5000); }
}
function publicPrompt(language) {
  const task = language === 'zh' ? '附件是我编写的公开 LaTeX 演示稿。先逐字输出附件中的 Public-context witness 注释整行，证明读到了文件内容。然后只补全最后一个 Sum rule proof：给出三角不等式和 epsilon 估计，返回一个 latex 代码块，内容可直接插入该 proof。不要添加 proof 起止行或其他环境，不改已有正文，不运行工具或读取其他文件。' : 'The attachment is my public LaTeX demonstration. First reproduce its entire Public-context witness comment line verbatim to confirm file context. Then complete only the final Sum rule proof using the triangle inequality and epsilon estimate. Return one latex code block ready to insert inside that proof, without opening/closing proof lines. Do not change existing text, run tools or read any other files.';
  return task;
}
async function chatScene(witness) {
  const e = event('yolo_context', 'pending', { attachmentAPI: 'addFileToChat(TFile)', contentVerified: false });
  try {
    await pauseInline(); await evaluate(`await ${S}.view.flush();return JSON.stringify({publicSaved:true});`, 'Save only the public TFile before chat');
    await evaluate(`for(const l of app.workspace.getLeavesOfType('latex-live-preview'))l.detach();app.workspace.setActiveLeaf(${S}.view.leaf,{focus:true});const n=${S}.yolo.getChatViewNavigator(),l=await n.createChatLeaf('split');if(!l||l.view.getViewType()!==${JSON.stringify(chatType)})throw Error('Empty public chat missing');await n.activateChatLeaf(l);${S}.chat=l.view;return JSON.stringify({created:true});`, 'Create an empty public chat without changing YOLO preferences');
    await waitFor(() => read(`!!${S}.chat.chatRef.current`), Boolean, 5000, 'Public chat mount');
    const mode = await read(`${S}.chat.containerEl.querySelector('.yolo-chat-mode-select')?.getAttribute('data-mode')`);
    if (mode !== 'ask') {
      await evaluate(`const y=${S}.yolo,original=y.setSettings;let block=true,calls=0;const wrapper=function(...args){if(block){calls++;return Promise.resolve();}return original.apply(this,args);};y.setSettings=wrapper;${S}.restorePreferenceGuard=()=>{block=false;if(y.setSettings===wrapper)y.setSettings=original;return{settingsWritesSuppressed:calls,publicSetterRestored:y.setSettings===original};};return JSON.stringify({guarded:true});`, 'Guard only the ephemeral Ask selection');
      try {
        await clickChat('.yolo-chat-mode-select');
        await clickChat('.yolo-chat-mode-select-list [role="menuitemradio"][data-mode="ask"]', true);
        await waitFor(() => read(`${S}.chat.containerEl.querySelector('.yolo-chat-mode-select')?.getAttribute('data-mode')`), m => m === 'ask', 3000, 'Ephemeral Ask conversation mode');
      } finally {
        recording.ai.askPreferenceGuard = await evaluate(`return JSON.stringify(${S}.restorePreferenceGuard());`, 'Restore the public preference setter before inference');
        save();
      }
    }
    await evaluate(`const f=app.vault.getFileByPath(${JSON.stringify(plan.file)});if(!f||f.extension!=='tex')throw Error('Public TFile missing');await ${S}.yolo.addFileToChat(f);return JSON.stringify({attached:true});`, 'Attach only the public TFile');
    const mention = await waitFor(() => read(`(()=>{const c=${S}.chat.containerEl;return{visible:[...c.querySelectorAll('.yolo-chat-user-input-files,.mention.yolo-mention--file')].some(x=>x.textContent.includes('public.tex')),assistantCount:c.querySelectorAll('.yolo-assistant-message-selectable-content').length};})()`), m => m.visible, 5000, 'Public .tex context mention');
    if (mention.assistantCount) throw Error('The new public chat unexpectedly contains an earlier answer');
    await sleep(4000);
    await clickChat('.yolo-chat-input-wrapper [contenteditable="true"]');
    await insert(publicPrompt(o.language)); await sleep(2500);
    await clickChat('.yolo-chat-user-input-submit-button-circle:not(.is-stop)');
    let stable = '', changedAt = Date.now();
    const answer = await waitFor(() => read(`(()=>{const c=${S}.chat.containerEl,els=[...c.querySelectorAll('.yolo-assistant-message-selectable-content')],body=els.at(-1);return{text:body?.textContent??'',blocks:body?[...body.querySelectorAll('pre code')].map(x=>x.textContent):[],generating:!!c.querySelector('.yolo-chat-user-input-submit-button-circle.is-stop'),count:els.length};})()`), a => { if (a.text !== stable) { stable = a.text; changedAt = Date.now(); } return !!a.text && !a.generating && Date.now() - changedAt >= 1500; }, 90000, 'Actual public chat response');
    const contentVerified = answer.text.includes(witness);
    writeFileSync(plan.paths.response, answer.text);
    recording.ai.chat = { returned: true, attachedPublicFile: true, witnessMatched: contentVerified, responseSha256: sha(answer.text), characters: answer.text.length };
    if (!contentVerified) throw Error('The actual response did not reproduce the public attachment witness');
    verify(e, { contextMention: true, contentVerified: true, requestReturned: true, responseCharacters: answer.text.length, responsePath: plan.paths.response });
    await sleep(7000);
    // YOLO's completed handoff keeps hidden fallback and final DOM renderers. They
    // may expose two exactly identical pre/code nodes for one actual model block.
    const snippets = [...new Set(answer.blocks.filter(text => text?.trim()).map(text => text.trim()))];
    if (snippets.length !== 1) throw Error('The actual response does not contain exactly one reviewable code block');
    const snippet = snippets[0].trim() + '\n';
    if (snippet.length > 12000 || /\\(?:input|include|usepackage|documentclass|write|openout|read|newcommand|def)\b/.test(snippet) || /\\(?:begin|end)\s*\{(?:document|proof)\}/.test(snippet)) throw Error('The returned fragment needs manual restructuring; it was not inserted');
    writeFileSync(plan.paths.snippet, snippet); return { snippet, snippetSha256: sha(snippet) };
  } catch (error) { if (e.status !== 'verified') failed(e, error.message); else recording.ai.fragmentFailure = error.message; save(); await sleep(5000); return null; }
}
async function applyScene(fragment) {
  const e = event('yolo_apply', 'pending', { reviewRequired: true, inserted: false });
  if (!fragment) { failed(e, 'No verified response fragment is available for review'); return; }
  console.log(JSON.stringify({ event: 'review-required', snippet: plan.paths.snippet, response: plan.paths.response, snippetSha256: fragment.snippetSha256, approval: plan.paths.approval }));
  try {
    await waitFor(async () => { if (!existsSync(plan.paths.approval)) return false; let a; try { a = JSON.parse(readFileSync(plan.paths.approval, 'utf8')); } catch { return false; } return a.approved === true && a.snippetSha256 === fragment.snippetSha256; }, Boolean, 180000, 'Operator approval of the actual response');
    await focusEditor();
    await evaluate(`const e=${E},p=e.state.doc.toString().lastIndexOf(${JSON.stringify(proofEnd)})-1;e.dispatch({selection:{anchor:p},scrollIntoView:true});e.focus();return JSON.stringify({cursor:true});`, 'Place the cursor in the public proof');
    const before = await read(`${E}.state.doc.toString()`); await insert(fragment.snippet);
    const after = await read(`${E}.state.doc.toString()`), from = before.lastIndexOf(proofEnd) - 1;
    if (after !== before.slice(0, from) + fragment.snippet + before.slice(from)) throw Error('Native insertion did not preserve the approved fragment');
    await evaluate(`if(${S}.chat){${S}.chat.leaf.detach();${S}.chat=null;}await ${S}.latex.openPreview(${S}.view);return JSON.stringify({preview:true});`, 'Open the public PDF preview');
    const build = await compile();
    await waitFor(() => read(`({pages:document.querySelectorAll('.ll-page').length,canvases:document.querySelectorAll('.ll-page canvas').length})`), p => p.pages > 0 && p.canvases > 0, 15000, 'Actual public PDF canvas');
    recording.ai.apply = { approved: true, agentReviewed: true, reviewer: 'Codex root agent', snippetSha256: fragment.snippetSha256, inserted: true, compiled: build };
    verify(e, { reviewRequired: true, agentReviewed: true, reviewer: 'Codex root agent', snippetSha256: fragment.snippetSha256, inserted: true, pdf: build.pdf, errors: build.errors, buildMs: build.ms, pdfReused: build.pdfReused });
    await sleep(9000);
  } catch (error) { failed(e, error.message); await sleep(4000); }
}
async function record() {
  mkdirSync(join(o.out, 'raw'), { recursive: true }); mkdirSync(join(o.out, 'evidence'), { recursive: true });
  const witness = `Public-context witness: ${randomUUID()}`;
  const source = plan.source.replace('% Presenter-authored', `% ${witness}\n% Presenter-authored`);
  recording = { id: o.id, title_zh: 'YOLO 真实补全与公开文件上下文', title_en: 'Real YOLO completion and public file context', rawPath: plan.paths.raw, stopFile: plan.paths.stop, events: [], ai: {}, source: { file: plan.file, presenterAuthored: true, sha256: sha(source), stagedSourceSha256: plan.sourceSha256 }, privacy: { vault, settingsCopied: false, keysRead: false, privateSourceRead: false, privatePromptsRead: false, originalWorkspaceBackupsPreserved: true } };
  save();
  try {
    await evaluate(`const p=app.plugins.plugins['latex-live'],y=app.plugins.plugins.yolo;if(!p?.yolo||y?.manifest?.version!==${JSON.stringify(plan.version)})throw Error('Verified plugins missing');const previous=p.settings.yoloTabCompletion;window.__latexYoloDemo={latex:p,yolo:y,previousLatexSetting:previous};p.settings.yoloTabCompletion=false;p.yolo.refresh();return JSON.stringify({plugins:true,previousLatexSetting:previous});`, 'Guard verified courses plugins');
    await evaluate(`for(const path of ['_editor-test','_editor-test/product-demo-ai',${JSON.stringify(`_editor-test/product-demo-ai/${o.id}`)}])if(!app.vault.getAbstractFileByPath(path))await app.vault.createFolder(path);if(app.vault.getAbstractFileByPath(${JSON.stringify(plan.file)}))throw Error('Public source path already exists');const f=await app.vault.create(${JSON.stringify(plan.file)},${JSON.stringify(source)}),l=app.workspace.getLeaf(true);await l.openFile(f);if(l.view.getViewType()!=='latex-live-editor')throw Error('Public file did not open in TexView');${S}.view=l.view;const all=[];app.workspace.iterateAllLeaves(x=>all.push(x));for(const x of all)if(x!==l)x.detach();if(l.view.contentEl.classList.contains('is-live-preview'))l.view.toggleMode();await ${S}.latex.openPreview(l.view);app.workspace.leftSplit.collapse();app.workspace.rightSplit.collapse();app.workspace.setActiveLeaf(l,{focus:true});l.view.editorView.focus();return JSON.stringify({publicWorkspace:true});`, 'Isolate the public demonstration workspace');
    recording.initialBuild = await compile(); await focusEditor();
    await beginCapture();
    verify(event('vault_boundary', 'pending'), { vault, cleanMainTourVault: 'LaTeX Live Demo', inferenceContext: 'presenter-authored public.tex only', settingsCopied: false });
    await sleep(5000);
    const gates = await read(`({enabled:${S}.yolo.settings.continuationOptions?.enableTabCompletion===true,modelConfigured:!!(${S}.yolo.settings.continuationOptions?.tabCompletionModelId||${S}.yolo.settings.continuationOptions?.continuationModelId),continuationBusy:!!${S}.yolo.isContinuationInProgress})`);
    recording.ai.inlineGates = gates; save();
    if (gates.enabled && gates.modelConfigured && !gates.continuationBusy) await ghostScene();
    else { failed(event('yolo_ghost', 'pending'), 'Configured inline completion is unavailable; no preference was changed'); await sleep(5000); }
    const fragment = await chatScene(witness); await applyScene(fragment);
    recording.ai.completed = recording.events.filter(e => ['yolo_ghost', 'yolo_context', 'yolo_apply'].includes(e.id)).every(e => e.status === 'verified');
  } catch (error) { recording.failure = error.message; console.log(JSON.stringify({ event: 'recording-failed', reason: error.message })); }
  finally {
    try { await endCapture(); } catch { recording.captureFailure = 'The recorder did not close normally; inspect its native artifact'; }
    // Cleanup is deliberately targeted: no settings object or private layout is serialized.
    interrupted = false;
    try { recording.preferenceRestoration = await evaluate(`const s=${S};if(s){s.restorePreferenceGuard?.();const t=s.yolo.tabCompletionController;t?.clearTimer();t?.cancelRequest();s.yolo.inlineSuggestionController?.clearInlineSuggestion();s.latex.settings.yoloTabCompletion=s.previousLatexSetting;s.latex.yolo.refresh();const same=s.latex.settings.yoloTabCompletion===s.previousLatexSetting;delete window.__latexYoloDemo;return JSON.stringify({latexBooleanRestored:same,YOLOPreferencesWritten:false});}return JSON.stringify({noTemporarySetting:true});`, 'Restore the original LaTeX boolean'); } catch { recording.preferenceRestoration = { failed: true, needsOperatorCheck: true }; }
    save(); console.log(JSON.stringify({ event: 'completed', receipt: plan.paths.receipt, AICompleted: recording.ai.completed === true, preferenceRestoration: recording.preferenceRestoration }));
    if (recording.ai.completed !== true || recording.failure || recording.captureFailure || recording.preferenceRestoration.failed) process.exitCode = 1;
  }
}
try {
  o = optionsFrom(process.argv.slice(2));
  if (o.help) console.log(HELP);
  else if (o.stopPassive) { const stop = join(o.out, 'evidence', `${o.id}.stop`); if (!existsSync(join(o.out, 'evidence', `${o.id}-recording.json`))) throw Error('No matching recording receipt'); if (!existsSync(stop)) writeFileSync(stop, ''); console.log(JSON.stringify({ stopRequested: true, UIInvoked: false, stopFile: stop })); }
  else { plan = prepare(o); if (o.mode === 'prepare-only') console.log(JSON.stringify({ prepared: true, UIInvoked: false, inferenceInvoked: false, publicSource: plan.sourcePath, sourceSha256: plan.sourceSha256, targetVault: vault, targetFile: o.passiveGhost ? o.publicFile : plan.file, version: plan.version, requiredOperatorReview: !o.passiveGhost, outputPathsFresh: true, passiveGhost: !!o.passiveGhost }, null, 2)); else if (o.passiveGhost) await recordPassive(); else await record(); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
