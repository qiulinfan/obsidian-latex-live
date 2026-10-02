// Project outline and semantic folds on real CodeMirror in Chrome. A fresh profile never
// touches the recorded Obsidian window. Includes native gutter clicks and edit-path timing.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const chromeBin = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p));
if (!chromeBin) throw new Error('Chrome is required for outline-folding-smoke (CHROME_BIN can override).');
const work = mkdtempSync(join(tmpdir(), 'll-outline-smoke-'));
const shots = join(tmpdir(), 'latex-live-outline-folding-smoke');
mkdirSync(shots, { recursive: true });
const css = readFileSync(join(root, 'styles.css'), 'utf8');
const entry = String.raw`
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { foldedRanges, unfoldAll } from '@codemirror/language';
import { undo, undoDepth } from '@codemirror/commands';
import { texEditorExtensions } from './src/editor/texExtensions';
import { latexFolding, ensureLatexFoldIndex, foldLatexSection, latexFoldStats } from './src/editor/latexFolding';
import { latexLiveLanguage } from './src/editor/latexLive';
import { livePreview } from './src/editor/shared/livePreview';
import { DEFAULT_REF_NAMES } from './src/editor/latexRefs';
import { theoremMap } from './src/tex/theorems';
import { renderProjectOutline } from './src/editor/projectOutline';
const refs = { numbers:new Map(),labels:new Map(),cites:new Map(),names:DEFAULT_REF_NAMES,checkpoints:new Map(),theorems:theoremMap(['\\usepackage{amsthm}\\newtheorem{theorem}{Theorem}']) };
const renderer = {epoch:0,render(req) {const node=document.createElement(req.display?'div':'span');node.textContent='Rendered '+req.src.trim();node.className='smoke-math';return {ok:true,node};}};
let view;
const fixture='\\section{First section}\n\\begin{theorem}\nStatement uses $x$.\n\\begin{proof}\n\\[\nx=y\n\\]\nProof prose.\n\\end{proof}\n\\end{theorem}\n\\section{Second section}\nVisible conclusion.';
function mount(text=fixture,live=true,folds=true) {
 view?.destroy();document.getElementById('editor').replaceChildren();
 view=new EditorView({parent:document.getElementById('editor'),state:EditorState.create({doc:text,extensions:texEditorExtensions({text,live:live?livePreview({language:latexLiveLanguage({refs:()=>refs}),renderer}):[],extensions:folds?[latexFolding]:[]})})});
 view.focus();ensureLatexFoldIndex(view);return snapshot();
}
function snapshot() {return {text:view.state.doc.toString(),folds:foldedRanges(view.state).size,placeholders:view.dom.querySelectorAll('.cm-foldPlaceholder').length,stats:latexFoldStats(view.state),height:view.contentHeight,lines:Array.from(view.dom.querySelectorAll('.cm-line')).map(el=>el.textContent),selection:view.state.selection.main.head,undo:undoDepth(view.state)};}
function marker() {const el=Array.from(view.dom.querySelectorAll('.cm-foldGutter .cm-gutterElement')).find(el=>el.querySelector('span[title="Fold line"]'));if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}
function proofFold() {unfoldAll(view);view.dispatch({selection:{anchor:view.state.doc.toString().indexOf('\\begin{proof}')}});const ok=foldLatexSection(view);return {ok,...snapshot()};}
function editBurst() {unfoldAll(view);const before=latexFoldStats(view.state).scans;for(let i=0;i<80;i++)view.dispatch({changes:{from:view.state.doc.length,insert:'x'},userEvent:'input.type'});return {before,after:latexFoldStats(view.state).scans,undo:undoDepth(view.state),text:view.state.doc.toString()};}
function undoProof() {undo(view);return view.state.doc.toString()===fixture;}
const large=Array.from({length:600},(_,i)=>'\\section{Section '+i+'}\n'+('Prose with $x$ and more words.\n').repeat(8)).join('');
function bench(folds) {mount(large,false,folds);const before=latexFoldStats(view.state).scans;const values=[];for(let i=0;i<120;i++){const t=performance.now();view.dispatch({changes:{from:25,insert:'x'},userEvent:'input.type'});values.push(performance.now()-t);}values.sort((a,b)=>a-b);return {lines:view.state.doc.lines,chars:view.state.doc.length,p50:values[60],p95:values[114],max:values[119],scans:latexFoldStats(view.state).scans-before};}
const headings=[{id:'0@0',title:'Root chapter',command:'chapter',level:1,starred:false,file:'/project/main.tex',key:'main.tex',visit:0,from:0,to:20,line:3,column:0,children:[{id:'1@2',title:'Included <safe> section',command:'section',level:2,starred:false,file:'/project/chapter.tex',key:'chapter.tex',visit:1,from:2,to:32,line:1,column:2,children:[]}]}];
let nav=[];renderProjectOutline(document.getElementById('outline'),{root:'/project/main.tex',headings,count:2,truncated:false},h=>nav.push({file:h.file,line:h.line,column:h.column}),['Missing input shown explicitly']);
window.smoke={mount,snapshot,marker,proofFold,editBurst,undoProof,bench,nav:()=>nav};window.__ready=true;
`;
const results=[];
const check=(name,pass,detail)=>{results.push({name,pass,detail});console.log((pass?'ok  ':'FAIL')+' '+name+(detail===undefined?'':': '+JSON.stringify(detail)));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let server,chrome,ws;
async function connect(url) {
 ws=new WebSocket(url);await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail;});
 let sequence=0;const pending=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.fail(new Error(JSON.stringify(m.error))):p.ok(m.result);};
 const send=(method,params={},sessionId)=>new Promise((ok,fail)=>{pending.set(++sequence,{ok,fail});ws.send(JSON.stringify({id:sequence,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const page=(method,params)=>send(method,params,sessionId);
 const evaluate=async expression=>{const r=await page('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
 return {page,evaluate};
}
try {
 const built=await build({stdin:{contents:entry,resolveDir:root,loader:'ts',sourcefile:'outline-smoke.ts'},bundle:true,platform:'browser',format:'iife',target:'es2022',write:false,logLevel:'warning',plugins:[{name:'host-stubs',setup(b){
  b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'host'}));
  b.onLoad({filter:/.*/,namespace:'host'},()=>({loader:'js',contents:'export class ItemView {}; export class Notice {};'}));
  b.onResolve({filter:/^(?:node:)?(?:fs|path)$/},a=>({path:a.path,namespace:'no-io'}));
  b.onLoad({filter:/.*/,namespace:'no-io'},()=>({loader:'js',contents:"module.exports=new Proxy({sep:'/'},{get:(o,k)=>k==='__esModule'?false:k in o?o[k]:()=>{throw new Error('Unexpected IO '+String(k));}})"}));
 }}]});
 writeFileSync(join(work,'bundle.js'),built.outputFiles[0].contents);
 writeFileSync(join(work,'index.html'),`<!doctype html><html><meta charset="utf-8"><style>${css}body{font:16px sans-serif;color:#ddd;background:#232631;display:grid;grid-template-columns:260px 1fr;gap:16px;padding:20px}#outline{height:680px;overflow:auto}#editor{height:680px}.cm-editor{height:100%}.cm-scroller{overflow:auto}.smoke-math{background:#343949;padding:3px}.ll-outline-heading{max-width:230px}ul{padding-left:16px}</style><body class="theme-dark"><nav id="outline"></nav><div id="editor" class="ll-editor-content lsp-cm-view"></div><script src="/bundle.js"></script></body></html>`);
 server=createServer((req,res)=>{const file=req.url==='/bundle.js'?'bundle.js':'index.html';res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':'text/html'}).end(readFileSync(join(work,file)));});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 chrome=spawn(chromeBin,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${join(work,'profile')}`,'--no-first-run','--disable-extensions','--disable-background-timer-throttling','about:blank'],{detached:true,stdio:['ignore','ignore','pipe']});
 const url=await new Promise((ok,fail)=>{let err='';const timer=setTimeout(()=>fail(new Error('Chrome start timeout '+err.slice(-200))),20000);chrome.stderr.on('data',d=>{err+=d;const m=/DevTools listening on (ws:\/\/\S+)/.exec(err);if(m){clearTimeout(timer);ok(m[1]);}});chrome.once('exit',()=>fail(new Error('Chrome exited')));});
 const {page,evaluate}=await connect(url);await page('Page.enable');await page('Runtime.enable');await page('Emulation.setDeviceMetricsOverride',{width:1100,height:780,deviceScaleFactor:1,mobile:false});
 await page('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html`});
 for(let i=0;i<100;i++){if(await evaluate('window.__ready').catch(()=>false))break;await sleep(30);}
 const before=await evaluate('smoke.mount()');await sleep(80);
 const point=await evaluate('smoke.marker()');check('semantic marker renders next to section in live mode',!!point,before.stats);
 if(point){await page('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await page('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});}
 await sleep(50);const folded=await evaluate('smoke.snapshot()');
 check('native gutter click folds live theorem/proof/math block without hiding next section',folded.folds===1&&folded.placeholders===1&&folded.height<before.height&&folded.lines.some(s=>s.includes('Second section')),{before:before.height,after:folded.height,lines:folded.lines});
 check('fold leaves document and source cursor intact',folded.text===before.text&&folded.selection===before.selection);
 const proof=await evaluate('smoke.proofFold()');await sleep(50);check('nested proof folds in live wrapper and keeps statement source',proof.ok&&proof.folds===1&&(await evaluate('smoke.snapshot()')).placeholders===1,proof.lines);
 const burst=await evaluate('smoke.editBurst()');check('80 edits cause zero synchronous structure scans',burst.before===burst.after,burst);
 await sleep(460);const refreshed=await evaluate('smoke.snapshot()');check('one idle rebuild refreshes the edited structure',refreshed.stats.scans===burst.after+1,refreshed.stats);
 check('folding and idle work preserve undo history',await evaluate('smoke.undoProof()'));
 const child=await evaluate(`(()=>{const el=document.querySelectorAll('.ll-outline-heading')[1],r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
 await page('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...child});await page('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...child});
 check('native outline click forwards included-file line and column',JSON.stringify(await evaluate('smoke.nav()'))===JSON.stringify([{file:'/project/chapter.tex',line:1,column:2}]));
 const baseline=await evaluate('smoke.bench(false)');const withFolds=await evaluate('smoke.bench(true)');
 check('5400-line source keeps editing inside 16ms p95 with no fold scan',withFolds.p95<16&&withFolds.scans===0,{baseline,withFolds});
 await evaluate('smoke.mount()');await sleep(50);const image=await page('Page.captureScreenshot',{format:'png'});writeFileSync(join(shots,'outline-live-folds.png'),Buffer.from(image.data,'base64'));
 writeFileSync(join(shots,'measurements.json'),JSON.stringify({before,folded,proof,burst,refreshed,baseline,withFolds,results},null,2));
} catch(error){check('smoke run',false,error.stack??String(error));}
finally{ws?.close();if(chrome?.exitCode===null){try{process.kill(-chrome.pid,'SIGKILL');}catch{chrome.kill('SIGKILL');}}server?.close();rmSync(work,{recursive:true,force:true});}
console.log(`outline-folding-smoke: ${results.filter(r=>r.pass).length}/${results.length} passed; screenshots ${shots}`);
process.exitCode=results.some(r=>!r.pass)?1:0;
