// Real Chrome hover/click/layout checks for the LaTeX-only proof-reference popup.
// No TeX build: service/index/content are covered by Node integration tests.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

const root = resolve('.');
const chromeBin = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p));
if (!chromeBin) throw new Error('Chrome is required for theorem-graph-smoke (CHROME_BIN can override).');
const work = mkdtempSync(join(tmpdir(), 'll-theorem-smoke-'));
const shots = join(tmpdir(), 'latex-live-theorem-graph-smoke');
mkdirSync(shots, {recursive:true});
const mathjax = join(root, 'node_modules/mathjax/es5');
const entry = String.raw`
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { theoremGraphHover } from './src/editor/theoremGraphView';
import { latexLiveLanguage } from './src/editor/latexLive';
import { liveInput, livePreview, livePreviewCompartment } from './src/editor/shared/livePreview';
import { keyArbiter } from './src/editor/shared/keyArbiter';
import { ProjectMath } from './src/editor/mathjaxProject';
import { refNames } from './src/editor/latexRefs';
import { theoremMap } from './src/tex/theorems';
const text = '使用定理 \\ref{result} 可以完成证明。\n另一个引用 \\ref{base}。\n更多内容。';
const origin = {file:'/synthetic/main.tex',key:'main.tex',visit:0,from:0,to:1,bodyFrom:0,bodyTo:1,line:1,nodes:[]};
const node = (id, title) => ({id,env:'theorem',name:'定理',title,labels:[id],number:id==='base'?'1':'2',statement:origin,proofs:[{...origin,association:'following'}]});
const nodes = new Map([['base',node('base','基础结论')],['result',node('result','推论')],['deep',node('deep','前置引理')]]);
const graph = {nodes,byLabel:new Map([...nodes].map(([id])=>[id,[id]])),edges:[{from:'result',to:'base',key:'base',evidence:origin},{from:'base',to:'deep',key:'deep',evidence:origin},{from:'deep',to:'result',key:'result',evidence:origin}],unresolved:[]};
const labels = new Map([...nodes].map(([id,n])=>[id,{number:n.number,page:'1',title:n.title,anchor:'theorem.'+n.number,kind:'theorem',order:null}]));
const refs = {labels,numbers:new Map([...labels].map(([key,l])=>[key,l.number])),cites:new Map(),names:refNames([]),theorems:theoremMap([]),checkpoints:new Map()};
let math, editor;
let calls = {load:0,render:0,open:0};
const options = {
 hoverTime:120,
 load:async (_view,key,signal)=>{calls.load++; return signal.aborted?null:{graph,selectedId:key,key};},
 renderContent:async (_view,n,signal)=>{
   calls.render++;
   const el = document.createElement('div'); el.className='ll-theorem-graph-content';
   const p=document.createElement('p');p.textContent=n.title+'：对于任意实数，';p.appendChild(math.render('x^2+1\\geq 1',false));el.appendChild(p);
   const proof=document.createElement('p');proof.textContent='证明：由引用的引理可知。';el.appendChild(proof);
   const css=window.MathJax.chtmlStylesheet(); if(!css.isConnected)document.head.appendChild(css);
   return el;
 },
 openSource:()=>calls.open++
};
window.mount = async(live=false,dark=false)=>{
 editor?.destroy();document.getElementById('host').replaceChildren();
 document.body.classList.toggle('theme-dark',dark);
 math=ProjectMath.create(window.MathJax,document,{statements:[],physics:false,unsupported:new Map()});
 const ext=live?livePreview({language:latexLiveLanguage({refs:()=>refs}),renderer:{epoch:0,render:()=>({ok:false,message:'unused'})}}):[];
 editor=new EditorView({parent:document.getElementById('host'),state:EditorState.create({doc:text,selection:{anchor:text.length},extensions:[keyArbiter({}),lineNumbers(),liveInput(),livePreviewCompartment.of(ext),theoremGraphHover(options)]})});
 window.editor=editor;window.calls=calls={load:0,render:0,open:0};
 await new Promise(r=>setTimeout(r,150));return true;
};
window.refPoint = ()=>{
 const chip=document.querySelector('[data-ll-ref-command]');
 if(chip){const r=chip.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};}
 const r=editor.coordsAtPos(text.indexOf('\\ref')+6);return{x:r.left+1,y:(r.top+r.bottom)/2};
};
window.__ready=true;
`;
const css = readFileSync(join(root,'styles.css'),'utf8');
const skin = `:root {--background-primary:#fff;--background-secondary:#f4f4f5;--background-modifier-border:#ccc;--text-normal:#222;--text-muted:#666;--interactive-accent:#566bc0;--text-accent:#566bc0;--font-interface:system-ui;--font-text:system-ui;--radius-s:4px;--radius-m:8px} body{margin:24px;font-family:system-ui;background:var(--background-primary);color:var(--text-normal)}body.theme-dark{--background-primary:#202024;--background-secondary:#29292e;--background-modifier-border:#555;--text-normal:#eee;--text-muted:#aaa;--text-accent:#aabcff}#host{height:560px;max-width:800px}.cm-editor{height:100%;font-size:16px}.cm-content{padding:20px}button{font:inherit;cursor:pointer;color:inherit;background:var(--background-secondary);border:1px solid var(--background-modifier-border)}`;
let chrome, server, ws;
const results=[];
const check=(name,pass,detail)=>{results.push({name,pass,detail});console.log((pass?'ok  ':'FAIL')+' '+name+(detail===undefined?'':': '+JSON.stringify(detail)));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function connect(url){
 ws=new WebSocket(url);await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail;});let seq=0;const pending=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.fail(new Error(JSON.stringify(m.error))):p.ok(m.result);};
 const send=(method,params={},sessionId)=>new Promise((ok,fail)=>{pending.set(++seq,{ok,fail});ws.send(JSON.stringify({id:seq,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const page=(method,params)=>send(method,params,sessionId);
 const evaluate=async expression=>{const r=await page('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
 return {page,evaluate};
}
try {
 const built=await build({stdin:{contents:entry,resolveDir:root,loader:'ts',sourcefile:'theorem-smoke.ts'},bundle:true,platform:'browser',format:'iife',target:'es2022',write:false,logLevel:'warning',plugins:[{name:'no-node-io',setup(b){
   b.onResolve({filter:/^(?:node:)?(?:fs|path)$/},a=>({path:a.path,namespace:'no-io'}));
   b.onLoad({filter:/.*/,namespace:'no-io'},()=>({loader:'js',contents:"module.exports=new Proxy({sep:'/'},{get:(o,k)=>k==='__esModule'?false:k in o?o[k]:()=>{throw new Error('Unexpected Node IO in UI smoke: '+String(k));}})"}));
 }}]});
 writeFileSync(join(work,'bundle.js'),built.outputFiles[0].text);
 writeFileSync(join(work,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><style>${css}${skin}</style><script>window.MathJax={tex:{inlineMath:[],displayMath:[],processEscapes:false,processEnvironments:false,processRefs:false},startup:{typeset:false},options:{enableMenu:false,renderActions:{assistiveMml:[]}}}</script><script src="/mathjax/tex-chtml-full.js"></script></head><body><div class="lsp-cm-view"><div id="host"></div></div><script src="/bundle.js"></script></body></html>`);
 server=createServer((req,res)=>{const path=decodeURIComponent(new URL(req.url,'http://x').pathname);const base=path.startsWith('/mathjax/')?mathjax:work;const file=join(base,path.startsWith('/mathjax/')?path.slice(9):path);if(!file.startsWith(base+sep)||!existsSync(file)){res.writeHead(404).end();return;}res.writeHead(200,{'content-type':({'.js':'text/javascript','.html':'text/html','.woff':'font/woff'})[extname(file)]??'application/octet-stream'}).end(readFileSync(file));});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 chrome=spawn(chromeBin,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${join(work,'profile')}`,'--no-first-run','--disable-extensions','--disable-background-timer-throttling','about:blank'],{detached:true,stdio:['ignore','ignore','pipe']});
 const url=await new Promise((ok,fail)=>{let err='';const timer=setTimeout(()=>fail(new Error('Chrome start timeout: '+err.slice(-200))),20000);chrome.stderr.on('data',d=>{err+=d;const m=/DevTools listening on (ws:\/\/\S+)/.exec(err);if(m){clearTimeout(timer);ok(m[1]);}});chrome.once('exit',()=>fail(new Error('Chrome exited')));});
 const {page,evaluate}=await connect(url);
 await page('Page.enable');await page('Runtime.enable');
 await page('Emulation.setDeviceMetricsOverride',{width:1100,height:800,deviceScaleFactor:1,mobile:false});
 await page('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html`});
 for(let i=0;i<150;i++){if(await evaluate('window.__ready && !!window.MathJax?.tex2chtml').catch(()=>false))break;await sleep(50);}
 const move=async p=>page('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
 const click=async p=>{await move(p);await page('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await page('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});};
 const point=selector=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
 for(const live of [false,true])for(const dark of [false,true]){
  const label=(live?'live':'source')+'-'+(dark?'dark':'light');
  await move({x:1000,y:750});await evaluate(`mount(${live},${dark})`);
  await move(await evaluate('refPoint()'));await sleep(350);
  check(label+' hover opens',await evaluate('!!document.querySelector(".ll-theorem-graph")'));
  const target=await point('.ll-theorem-graph-node[data-node-id="base"]');
  check(label+' one-layer graph',!!target&&await evaluate('document.querySelectorAll(".ll-theorem-graph-node").length===2'));
  if(!target)continue;
  await click(target);await sleep(180);
  check(label+' pointer enters and node expands',await evaluate('!!document.querySelector(".ll-theorem-graph-detail mjx-container")'));
  const sourceButton=await point('.ll-theorem-graph-source');if(sourceButton){await click(sourceButton);check(label+' source jump',await evaluate('calls.open===1'));}
  const shot=await page('Page.captureScreenshot',{format:'png'});writeFileSync(join(shots,label+'.png'),Buffer.from(shot.data,'base64'));
  check(label+' viewport fits',await evaluate('(()=>{const r=document.querySelector(".ll-theorem-graph").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()'));
  await evaluate('editor.dispatch({changes:{from:editor.state.doc.length,insert:" changed"}})');await sleep(80);
  check(label+' edits close stale popup',await evaluate('!document.querySelector(".ll-theorem-graph")'));
 }
 // A real click on the live chip should retain its existing source-edit behavior.
 await move({x:1000,y:750});await evaluate('mount(true,false)');const chip=await evaluate('refPoint()');await click(chip);await sleep(100);
 check('live chip click selects source',await evaluate('(()=>{const s=editor.state.doc.toString(),from=s.indexOf("\\\\ref{result}");return editor.state.selection.main.head>=from && editor.state.selection.main.head<=from+12;})()'),await evaluate('editor.state.selection.main.head'));
 check('live chip click does not consume text',await evaluate('editor.state.doc.toString().includes("\\\\ref{result}")'));
 await move({x:1000,y:750});await evaluate('mount(true,false)');
 const dragStart=await evaluate('(()=>{const r=editor.coordsAtPos(0);return{x:r.left,y:(r.top+r.bottom)/2}})()');
 const dragEnd=await evaluate('(()=>{const r=editor.coordsAtPos(editor.state.doc.length);return{x:r.left,y:(r.top+r.bottom)/2}})()');
 await move(dragStart);await page('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...dragStart});
 const across=await evaluate('refPoint()');await page('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,...across});await sleep(350);
 check('drag across live reference does not open graph',await evaluate('!document.querySelector(".ll-theorem-graph")'));
 await page('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,...dragEnd});await page('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...dragEnd});await sleep(100);
 check('drag retains selection and source text',await evaluate('!editor.state.selection.main.empty && editor.state.doc.toString().includes("\\\\ref{result}")'));
 // Explicit one-level expansion and a cycle never duplicate nodes or loop.
 await move({x:1000,y:750});await evaluate('mount(false,false)');await move(await evaluate('refPoint()'));await sleep(350);
 const expandBase=await point('.ll-theorem-node[data-node-id="base"] .ll-theorem-graph-expand');await click(expandBase);await sleep(100);
 check('explicit next layer adds one node',await evaluate('document.querySelectorAll(".ll-theorem-graph-node").length===3'));
 await evaluate('document.querySelector(".ll-theorem-node[data-node-id=deep]").scrollIntoView({block:"nearest",inline:"nearest"})');await click(await point('.ll-theorem-node[data-node-id="deep"] .ll-theorem-graph-expand'));await sleep(100);
 check('cycle keeps each node once',await evaluate('document.querySelectorAll(".ll-theorem-graph-node").length===3 && document.querySelector(".ll-theorem-graph-notices").textContent.includes("回环")'));
 await page('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:1,mobile:false});
 await move({x:380,y:750});await evaluate('mount(true,true)');await move(await evaluate('refPoint()'));await sleep(350);
 check('narrow viewport keeps popup inside screen',await evaluate('(()=>{const r=document.querySelector(".ll-theorem-graph")?.getBoundingClientRect();return !!r&&r.left>=0&&r.right<=innerWidth;})()'));
 const narrow=await page('Page.captureScreenshot',{format:'png'});writeFileSync(join(shots,'live-dark-narrow.png'),Buffer.from(narrow.data,'base64'));
 await page('Emulation.setDeviceMetricsOverride',{width:1100,height:800,deviceScaleFactor:1,mobile:false});
 // Pending IME must not open a new graph (compositionStarted is stronger than composing).
 await move({x:1000,y:750});await evaluate('mount(false,false);editor.contentDOM.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}))');
 await move(await evaluate('refPoint()'));await sleep(350);
 check('IME suppresses graph open',await evaluate('!document.querySelector(".ll-theorem-graph")'));
 await evaluate('editor.contentDOM.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}))');
} catch(e){check('smoke run',false,e.stack??String(e));}
finally {
 ws?.close();if(chrome?.exitCode===null){try{process.kill(-chrome.pid,'SIGKILL');}catch{chrome.kill('SIGKILL');}}
 server?.close();rmSync(work,{recursive:true,force:true});
}
console.log(`theorem-graph-smoke: ${results.filter(r=>r.pass).length}/${results.length} passed; screenshots ${shots}`);
process.exitCode=results.some(r=>!r.pass)?1:0;
