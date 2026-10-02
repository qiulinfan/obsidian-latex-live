// Real Chrome checks for project tools' pointer interaction, layout and CM navigation.
// Source traversal, vault CAS, CRLF and recovery files are separately tested under Node;
// this isolated browser uses a memory edit host and never changes an Obsidian vault.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const chromeBin = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
if (!chromeBin) throw new Error('Chrome is required (CHROME_BIN can override).');
const work = mkdtempSync(join(tmpdir(), 'll-project-operations-smoke-'));
const results = [];
const check = (name, pass, evidence) => { results.push({ name, pass: !!pass, evidence }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${evidence === undefined ? '' : ': ' + JSON.stringify(evidence)}`); if (!pass) throw new Error(name); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
let server, chrome, ws;
try {
  await build({ entryPoints: ['src/tex/projectIndex.ts'], outfile: join(work, 'index.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning' });
  const { readProjectSnapshot } = createRequire(import.meta.url)(join(work, 'index.cjs'));
  const file = join(work, 'main.tex');
  writeFileSync(file, String.raw`\documentclass{article}
\begin{document}
\section{Example}\label{old}
By \ref{old}.\input{child}
\end{document}`);
  writeFileSync(join(work, 'child.tex'), 'Use \\ref{old}.\r\n');
  const snapshot = await readProjectSnapshot(file, new Map());
  const serialized = JSON.stringify(snapshot, (_key, value) => value instanceof Map ? { __map: [...value] } : value instanceof Set ? { __set: [...value] } : value);
  const entry = String.raw`
import {EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {history} from '@codemirror/commands';
import {ProjectSearchModal, ProjectEditPreviewModal, ProjectLabelsModal} from './src/editor/projectOperations';
import {previewLabelRename} from './src/tex/projectEdits';
import {setDocText} from './src/editor/shared/editorKit';
import {modals} from './tests/support/obsidian';
const snapshot=JSON.parse(window.__snapshot,(_key,value)=>value?.__map?new Map(value.__map):value?.__set?new Set(value.__set):value);
const editor=new EditorView({state:EditorState.create({doc:snapshot.files[0].text,extensions:[history(),EditorView.lineWrapping]}),parent:document.getElementById('editor')});
const states=new Map(snapshot.files.map(file=>[file.path,{text:file.text,diskText:file.diskText,writable:true}]));
const evidence={writes:0,navigation:null,backup:null};
const host={app:{},snapshot:async()=>snapshot,navigate:async(match)=>{
 evidence.navigation={from:match.from,to:match.to,line:match.line,column:match.column};
 editor.dispatch({selection:{anchor:match.from,head:match.to},effects:EditorView.scrollIntoView(match.from,{y:'center'})});
},editHost:{read:async(path)=>({...states.get(path)}),write:async(path,expected,text,lineEnding)=>{
 const current=states.get(path);if(current.text!==expected.text||current.diskText!==expected.diskText)throw new Error('stale preview');
 const after={text,diskText:lineEnding==='\r\n'?text.replace(/\n/g,'\r\n'):text,writable:true};states.set(path,after);evidence.writes++;
 if(path===snapshot.root)setDocText(editor,text);return {...after};
}},applied:(receipt,backup)=>{evidence.backup=backup;evidence.receipt=true;}};
function mount(modal){modal.open();modal.modalEl.classList.add('smoke-modal');document.body.append(modal.modalEl);return modal;}
let search=mount(new ProjectSearchModal(host,snapshot));
window.latest=()=>{const modal=modals.at(-1);if(!modal.modalEl.isConnected){modal.modalEl.classList.add('smoke-modal');document.body.append(modal.modalEl);}return modal;};
window.smoke={editor,evidence,states,snapshot,host,search,modals,mount,ProjectLabelsModal,ProjectEditPreviewModal,previewLabelRename};
window.__ready=true;`;
  const built = await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, alias: { obsidian: join(root, 'tests/support/obsidian.ts') }, logLevel: 'warning', plugins: [{ name: 'isolated-node-io', setup(b) {
    b.onResolve({ filter: /^(?:node:)?(?:fs(?:\/promises)?|path|os|crypto|child_process)$/ }, args => ({ path: args.path.replace(/^node:/, ''), namespace: 'smoke-io' }));
    b.onLoad({ filter: /.*/, namespace: 'smoke-io' }, args => ({ loader: 'js', contents: args.path === 'path' ? `module.exports={sep:'/',basename:p=>p.split('/').pop(),dirname:p=>p.slice(0,p.lastIndexOf('/')),join:(...p)=>p.join('/').split('//').join('/'),relative:(from,to)=>to.startsWith(from+'/')?to.slice(from.length+1):to,resolve:(...p)=>p.join('/'),isAbsolute:p=>p.startsWith('/')};` : args.path === 'os' ? `module.exports={tmpdir:()=>'/isolated-browser-recovery'};` : args.path === 'fs/promises' ? `module.exports={mkdtemp:async prefix=>prefix+'browser',writeFile:async(path,text)=>{window.__recovery={path,text};}};` : `module.exports=new Proxy({},{get:(_,key)=>key==='__esModule'?false:()=>{throw Error('Unexpected node IO in browser smoke: '+String(key));}});` }));
  } }] });
  writeFileSync(join(work, 'bundle.js'), built.outputFiles[0].contents);
  writeFileSync(join(work, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${readFileSync(join(root, 'styles.css'), 'utf8')}
body{font:15px/1.5 system-ui;margin:0;background:#f4f4f5;color:#242426;--background-primary:#fff;--background-secondary:#eee;--text-normal:#242426;--text-muted:#666;--interactive-accent:#7057be;--background-modifier-border:#ccc}#editor{height:800px;padding:12px}.smoke-modal{position:fixed;z-index:20;inset:6% 6%;max-height:88vh;overflow:auto;background:white;border:1px solid #aaa;padding:16px;box-sizing:border-box;box-shadow:0 10px 35px #0005}button,input{font:inherit}button{cursor:pointer}.theme-dark{background:#18181c;color:#eee;--background-primary:#242428;--background-secondary:#303034;--text-normal:#eee;--text-muted:#aaa;--background-modifier-border:#666}.theme-dark .smoke-modal{background:#242428}</style></head><body><div id="editor"></div><script>window.process={platform:'darwin',env:{}};window.__snapshot=${JSON.stringify(serialized)};</script><script src="/bundle.js"></script></body></html>`);
  server = createServer((req, res) => { const path = req.url === '/bundle.js' ? join(work, 'bundle.js') : join(work, 'index.html'); res.writeHead(200, { 'content-type': req.url === '/bundle.js' ? 'text/javascript' : 'text/html' }).end(readFileSync(path)); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  chrome = spawn(chromeBin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(work, 'profile')}`, '--no-first-run', '--disable-extensions', 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise((done, fail) => { let output = ''; const timer = setTimeout(() => fail(new Error('Chrome startup timed out: ' + output.slice(-250))), 20000); chrome.stderr.on('data', chunk => { output += chunk; const match = /DevTools listening on (ws:\/\/\S+)/.exec(output); if (match) { clearTimeout(timer); done(match[1]); } }); chrome.once('exit', () => fail(new Error('Chrome exited'))); });
  ws = new WebSocket(url); await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
  let seq = 0; const pending = new Map();
  ws.onmessage = event => { const message = JSON.parse(event.data), request = pending.get(message.id); if (!request) return; pending.delete(message.id); message.error ? request.fail(new Error(JSON.stringify(message.error))) : request.done(message.result); };
  const send = (method, params = {}, sessionId) => new Promise((done, fail) => { pending.set(++seq, { done, fail }); ws.send(JSON.stringify({ id: seq, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const evaluate = async expression => { const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  const click = async label => {
    const point = await evaluate(`(()=>{const modal=latest();const button=[...modal.contentEl.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(label)});if(!button)throw Error('Button missing');button.scrollIntoView({block:'center'});const rect=button.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};})()`);
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(40);
  };
  await page('Page.enable'); await page('Runtime.enable');
  await page('Emulation.setDeviceMetricsOverride', { width: 1000, height: 850, deviceScaleFactor: 1, mobile: false });
  await page('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/index.html` });
  for (let n = 0; n < 100; n++) { if (await evaluate('window.__ready').catch(() => false)) break; await sleep(40); }
  await evaluate(`smoke.search.contentEl.querySelector('input[aria-label="Find"]').value='old';smoke.search.contentEl.querySelector('input[aria-label="Replace with"]').value='new'`);
  await click('Search');
  check('search groups all current project matches by source file', await evaluate('smoke.search.contentEl.querySelectorAll(".ll-project-group").length===2 && smoke.search.contentEl.querySelectorAll(".ll-project-match").length===3'));
  const resultPoint = await evaluate(`(()=>{const el=smoke.search.contentEl.querySelector('.ll-project-match');const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...resultPoint }); await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...resultPoint });
  check('native pointer navigates to exact CodeMirror source range', await evaluate('smoke.evidence.navigation.from===smoke.editor.state.selection.main.from && smoke.editor.state.doc.sliceString(smoke.editor.state.selection.main.from,smoke.editor.state.selection.main.to)==="old"'));
  await click('Preview replacement'); await evaluate('latest()');
  check('replacement preview shows concrete changes before any mutation', await evaluate('smoke.evidence.writes===0 && latest().plan.count===3 && latest().contentEl.textContent.includes("− old\\n+ new")'));
  await click('Apply changes');
  check('pointer Apply updates both project files and retains recovery text', await evaluate('smoke.evidence.writes===2 && smoke.editor.state.doc.toString().includes("label{new}") && JSON.parse(window.__recovery.text).plan.files.length===2'));
  await click('Undo this operation');
  check('pointer Undo restores root source and child CRLF', await evaluate('smoke.editor.state.doc.toString()===smoke.snapshot.files[0].text && [...smoke.states.values()][1].diskText.endsWith("\\r\\n") && [...smoke.states.values()][1].text.includes("ref{old}")'));
  await evaluate('latest().modalEl.remove();latest().close();smoke.search.modalEl.remove();smoke.search.close();smoke.mount(new smoke.ProjectLabelsModal(smoke.host,smoke.snapshot,true,"old"))');
  check('reference UI displays definition and all references', await evaluate('latest().contentEl.querySelectorAll(".ll-project-match").length===3'));
  await evaluate(`latest().contentEl.querySelector('input[aria-label="New label"]').value='renamed'`); await click('Preview rename'); await evaluate('latest()');
  check('label rename previews every definition/reference together', await evaluate('latest().plan.count===3 && latest().plan.files.length===2'));
  await evaluate('smoke.editor.dispatch({changes:{from:0,insert:"% newer edit\\n"}});smoke.states.get(smoke.snapshot.root).text=smoke.editor.state.doc.toString()');
  await click('Apply changes');
  check('stale preview preserves a newer editor change', await evaluate('latest().contentEl.textContent.includes("stale") && smoke.editor.state.doc.toString().startsWith("% newer edit")'));
  await page('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.body.classList.add("theme-dark")');
  const geometry = await evaluate('(()=>{const el=latest().contentEl;return {width:innerWidth,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,client:el.clientWidth,scroll:el.scrollWidth};})()');
  check('dark 375px project modal stays within viewport', geometry.left >= 0 && geometry.right <= geometry.width + 1 && geometry.scroll <= geometry.client + 1, geometry);
} catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
finally { ws?.close(); if (chrome?.exitCode === null) { try { process.kill(-chrome.pid, 'SIGKILL'); } catch { chrome.kill('SIGKILL'); } } server?.close(); rmSync(work, { recursive: true, force: true }); }
console.log(`project-operations-smoke: ${results.filter(result => result.pass).length}/${results.length} passed`);
