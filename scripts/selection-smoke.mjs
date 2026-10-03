// Real Chrome pixels: the active line must not cover a multiline selection.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=resolve('.'), chromeBin=[process.env.CHROME_BIN,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
if(!chromeBin)throw new Error('Chrome is required (CHROME_BIN).');
const work=mkdtempSync(join(tmpdir(),'ll-selection-')),evidence=join(tmpdir(),'latex-live-selection-smoke');mkdirSync(evidence,{recursive:true});
const css=readFileSync('styles.css','utf8'), entry=String.raw`
import {EditorSelection,EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {texEditorExtensions} from './src/editor/texExtensions';
let view;const text=Array.from({length:15},(_,i)=>'row'+(i+1)+'        '+'abcdefghij '.repeat(10)).join('\n');
const rect=r=>({left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height});
window.mount=()=>{view?.destroy();view=new EditorView({parent:document.querySelector('#editor'),state:EditorState.create({doc:text,extensions:texEditorExtensions({text})})});view.focus();};
window.select=async(reverse=false,wrapped=false)=>{document.querySelector('#editor').style.width=wrapped?'250px':'800px';view.requestMeasure();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r))));const a=view.state.doc.line(2).from+5,b=view.state.doc.line(6).from+95;view.dispatch({selection:{anchor:reverse?b:a,head:reverse?a:b},effects:EditorView.scrollIntoView(reverse?a:b,{y:'center'})});view.focus();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));};
window.empty=()=>{view.dispatch({selection:{anchor:view.state.doc.line(6).from+10}});view.focus();};
window.snapshot=()=>{const head=view.state.doc.lineAt(view.state.selection.main.head),point=view.coordsAtPos(head.from+7),other=view.coordsAtPos(view.state.doc.line(head.number>2?head.number-1:head.number+1).from+(head.number>2?88:7)),line=view.contentDOM.querySelector('.cm-activeLine');return{head:head.number,selected:view.dom.classList.contains('ll-has-selection'),activeBackground:getComputedStyle(line).backgroundColor,selectionColor:getComputedStyle(view.dom.querySelector('.cm-selectionBackground')??view.dom).backgroundColor,points:[point,other,...(view.state.selection.main.head>view.state.selection.main.anchor?[view.coordsAtPos(head.from+88)]:[])].map(p=>({x:p.left+3,y:(p.top+p.bottom)/2})),rects:[...view.dom.querySelectorAll('.cm-selectionBackground')].map(e=>rect(e.getBoundingClientRect())),selection:{anchor:view.state.selection.main.anchor,head:view.state.selection.main.head},source:view.state.doc.toString()===text};};
window.readPixels=(data,points)=>new Promise((ok,fail)=>{const image=new Image();image.onload=()=>{const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d');c.drawImage(image,0,0);ok(points.map(p=>[...c.getImageData(Math.floor(p.x),Math.floor(p.y),1,1).data]));};image.onerror=fail;image.src='data:image/png;base64,'+data;});
window.mount();
`;
let server,chrome,ws;const checks=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));const check=(name,pass,detail)=>{checks.push({name,pass,detail});console.log((pass?'ok ':'FAIL ')+name+': '+JSON.stringify(detail));};
try{
 const bundle=await build({stdin:{contents:entry,resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'iife',write:false,logLevel:'warning',plugins:[{name:'no-io',setup(b){b.onResolve({filter:/^(?:node:)?(?:fs|path)$/},a=>({path:a.path,namespace:'no-io'}));b.onLoad({filter:/.*/,namespace:'no-io'},()=>({contents:"module.exports=new Proxy({sep:'/'},{get:(o,k)=>k==='__esModule'?false:k in o?o[k]:()=>{throw new Error('Unexpected IO')}})",loader:'js'}));}}]});
 writeFileSync(join(work,'bundle.js'),bundle.outputFiles[0].contents);writeFileSync(join(work,'index.html'),`<!doctype html><html><head><style>${css}body{margin:20px;--font-text-size:20px;--font-monospace:monospace;--text-normal:#000;--text-selection:rgb(34,170,255);--background-primary-alt:rgb(255,204,0)}#editor{width:800px;height:780px;background:linear-gradient(45deg,#eee,#fff)}.cm-editor{height:100%}.cm-scroller{overflow:auto}</style></head><body><div id="editor" class="ll-editor-content lsp-cm-view"></div><script src="/bundle.js"></script></body></html>`);
 server=createServer((req,res)=>{const file=join(work,req.url==='/bundle.js'?'bundle.js':'index.html');res.setHeader('content-type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(readFileSync(file));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 chrome=spawn(chromeBin,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${join(work,'profile')}`,'--no-first-run','--disable-extensions','about:blank'],{detached:true,stdio:['ignore','ignore','pipe']});
 const url=await new Promise((ok,fail)=>{let output='';const timer=setTimeout(()=>fail(new Error('Chrome timeout')),20000);chrome.stderr.on('data',data=>{output+=data;const m=/DevTools listening on (ws:\/\/\S+)/.exec(output);if(m){clearTimeout(timer);ok(m[1]);}});});
 ws=new WebSocket(url);await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail;});let id=0;const pending=new Map();ws.onmessage=e=>{const r=JSON.parse(e.data),p=pending.get(r.id);if(p){pending.delete(r.id);r.error?p.fail(r.error):p.ok(r.result);}};const send=(method,params={},sessionId)=>new Promise((ok,fail)=>{pending.set(++id,{ok,fail});ws.send(JSON.stringify({id,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});const page=(method,params)=>send(method,params,sessionId),evaluate=async expression=>{const r=await page('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description);return r.result.value;};
 await page('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:1,mobile:false});await page('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});await sleep(200);
 for(const [name,reverse,wrapped] of [['forward',false,false],['reverse',true,false],['wrapped',false,true],['dark',false,false]]){
  if(name==='dark') await evaluate("document.body.classList.add('theme-dark');mount()");
  await evaluate(`select(${reverse},${wrapped})`);await sleep(120);const state=await evaluate('snapshot()'),shot=await page('Page.captureScreenshot',{format:'png'}),pixels=await evaluate(`readPixels(${JSON.stringify(shot.data)},${JSON.stringify(state.points)})`);
  writeFileSync(join(evidence,name+'.png'),Buffer.from(shot.data,'base64'));check(name+' head and interior selection have identical visible pixels',state.selected&&state.activeBackground==='rgba(0, 0, 0, 0)'&&state.source&&pixels.every(p=>p.slice(0,3).join(',')===state.selectionColor.match(/\d+/g).slice(0,3).join(',')),{state,pixels});
 }
 await evaluate('empty()');await sleep(120);const caret=await evaluate('snapshot()');check('empty caret restores the normal active-line background',!caret.selected&&caret.activeBackground==='rgb(255, 204, 0)',caret);
 // Reproduce the former opaque rule in the same state and confirm the head alone is occluded.
 await evaluate(`(async()=>{document.head.appendChild(Object.assign(document.createElement('style'),{textContent:'.ll-editor-content .cm-editor.ll-has-selection .cm-activeLine{background:var(--background-primary-alt)}'}));await select(false,false)})()`);await sleep(120);const before=await evaluate('snapshot()'),shot=await page('Page.captureScreenshot',{format:'png'}),pixels=await evaluate(`readPixels(${JSON.stringify(shot.data)},${JSON.stringify(before.points)})`);writeFileSync(join(evidence,'before.png'),Buffer.from(shot.data,'base64'));check('old styling reproduces the missing selection only at the head line',pixels[0][0]===255&&pixels[0][1]===204&&pixels[1].slice(0,3).join(',')===before.selectionColor.match(/\d+/g).slice(0,3).join(','),pixels);
 writeFileSync(join(evidence,'measurements.json'),JSON.stringify(checks,null,2));
}finally{ws?.close();if(chrome?.exitCode===null){try{process.kill(-chrome.pid,'SIGKILL');}catch{chrome.kill('SIGKILL');}}server?.close();rmSync(work,{recursive:true,force:true});}
console.log(`selection-smoke: ${checks.filter(x=>x.pass).length}/${checks.length} passed; ${evidence}`);process.exitCode=checks.some(x=>!x.pass)?1:0;
