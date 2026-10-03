// Actual Obsidian pdf.js 5.x in fresh headless Chrome, with a 65-page bilingual native PDF.
// Does not touch a vault or the captured Obsidian window. Native TeX goes through runTex.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, extname } from 'node:path';
const root = resolve('.');
const chromeBin = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p));
if (!chromeBin) throw new Error('Chrome is required (CHROME_BIN).');
const asarPath = process.env.OBSIDIAN_ASAR ?? '/Applications/Obsidian.app/Contents/Resources/obsidian.asar';
if (!existsSync(asarPath)) throw new Error('Actual Obsidian pdf.js is required (OBSIDIAN_ASAR).');
const work = mkdtempSync(join(tmpdir(), 'll-pdf-reading-'));
const evidence = join(tmpdir(), 'latex-live-pdf-reading-smoke'); mkdirSync(evidence, { recursive: true });
let chrome, server, ws;
const results = []; const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'ok' : 'FAIL'} ${name}${detail === undefined ? '' : ': '+JSON.stringify(detail)}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const asar = readFileSync(asarPath), headerLength = asar.readUInt32LE(4), header = JSON.parse(asar.subarray(16, 16 + asar.readUInt32LE(12)).toString()), base = 8 + headerLength;
function asset(path) { let node = header; for (const part of path.split('/')) node = node?.files?.[part]; return node?.offset !== undefined ? asar.subarray(base + Number(node.offset), base + Number(node.offset) + node.size) : null; }
async function connect(url) {
 ws = new WebSocket(url); await new Promise((yes,no) => { ws.onopen=yes;ws.onerror=no; });let seq=0;const pending=new Map();
 ws.onmessage=e=>{const msg=JSON.parse(e.data),p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);msg.error?p.no(new Error(JSON.stringify(msg.error))):p.yes(msg.result);};
 const send=(method,params={},sessionId)=>new Promise((yes,no)=>{pending.set(++seq,{yes,no});ws.send(JSON.stringify({id:seq,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});const{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const page=(method,params)=>send(method,params,sessionId);const evaluate=async expression=>{const r=await page('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};return{page,evaluate,send};
}
const entry = String.raw`
import { PdfRenderer } from './src/preview/pdfRenderer';
import { LatexPreviewView } from './src/preview/previewView';
const p = HTMLElement.prototype;
p.createDiv=function(options={}){const el=this.ownerDocument.createElement('div');el.className=options.cls??'';this.append(el);return el;};
p.createEl=function(tag,options={}){const el=this.ownerDocument.createElement(tag);el.className=options.cls??'';if(options.text!==undefined)el.textContent=options.text;for(const[k,v]of Object.entries(options.attr??{}))el.setAttribute(k,String(v));this.append(el);return el;};
p.createSpan=function(options={}){return this.createEl('span',options);};p.addClass=function(...names){this.classList.add(...names);};p.removeClass=function(...names){this.classList.remove(...names);};p.empty=function(){this.replaceChildren();};
p.toggleClass=function(cls,on){this.classList.toggle(cls,on);};p.setText=function(text){this.textContent=text;};
p.setCssProps=function(props){for(const[property,value]of Object.entries(props))this.style.setProperty(property,value);};
window.activeWindow=window;window.activeDocument=document;window.loaded=0;window.opened=[];window.errors=[];const warn=console.warn.bind(console);console.warn=(...args)=>{if(String(args[0]).startsWith('LaTeX Live:'))window.errors.push(args.map(String).join(' '));warn(...args);};window.addEventListener('error',e=>window.errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));
let renderer;window.mount=async()=>{ renderer = new PdfRenderer(document.querySelector('#preview'),{openExternal:async(url)=>window.opened.push(url),onStatus:s=>document.querySelector('#status').textContent=s.page+' / '+s.pages+' · '+Math.round(s.scale*100)+'%'});window.renderer=renderer;await renderer.load(new Uint8Array(await (await fetch('/fixture.pdf')).arrayBuffer()));};
const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};
window.snapshot=()=>({version:window.pdfVersion,status:renderer.status,canvases:document.querySelectorAll('.ll-page canvas').length,texts:document.querySelectorAll('.ll-pdf-text').length,links:document.querySelectorAll('.ll-pdf-link').length,loaded:window.loaded,opened:window.opened,errors:window.errors,scrollTop:renderer.scrollEl.scrollTop,text:document.querySelector('.ll-pdf-text')?.textContent});
window.firstSpan=()=>{const span=[...document.querySelectorAll('.ll-pdf-text span')].find(x=>x.textContent.includes('Selectable English'));return span?{...rect(span),text:span.textContent}:null;};
window.firstChinese=()=>{const span=[...document.querySelectorAll('.ll-pdf-text span')].find(x=>x.textContent.includes('中文'));return span?{...rect(span),text:span.textContent}:null;};
window.anchor=()=>{const scroll=renderer.scrollEl.getBoundingClientRect(),x=scroll.left+180,y=scroll.top+200;const p=[...document.querySelectorAll('.ll-page')].find(el=>{const r=el.getBoundingClientRect();return y>=r.top&&y<=r.bottom;});const r=p.getBoundingClientRect();return {page:+p.dataset.index,x:(x-r.left)/renderer.status.scale,y:(y-r.top)/renderer.status.scale,clientX:x,clientY:y};};
window.pinch=()=>{const a=window.anchor();for(let i=0;i<10;i++)renderer.scrollEl.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-8,clientX:a.clientX,clientY:a.clientY,cancelable:true}));return a;};
window.linkRect=(href)=>{const a=[...document.querySelectorAll('.ll-pdf-link')].find(x=>href==='internal'?x.getAttribute('href')==='#':x.href.includes(href));return a?rect(a):null;};
window.canvasDensity=()=>{const canvas=document.querySelector('.ll-page canvas');return {dpr:devicePixelRatio,width:canvas?.width,css:canvas?.getBoundingClientRect().width,text:document.querySelector('.ll-pdf-text')?.textContent};};
window.mountPreview=async()=>{
 renderer.destroy();window.previewNotices=[];
 const bytes=new Uint8Array(await(await fetch('/fixture.pdf')).arrayBuffer());
 const plugin={app:{},invertsPaper:()=>false,vaultPath:p=>p,vaultBase:()=>'/vault',
 acquireSession:()=>({engine:'xelatex',compiling:null,failure:null,last:{log:{diagnostics:[]},durationMs:490,pdfWritten:true,engine:'xelatex',mode:'fast'},lastPdf:bytes,onEvent:()=>()=>{},request:()=>{}}),releaseSession:()=>{}};
 window.previewView=new LatexPreviewView({app:plugin.app},plugin);await window.previewView.onOpen();window.previewView.setRoot('/vault/test.tex');
};
window.previewLayout=()=>{
 const root=document.querySelector('#preview'),bar=root.querySelector('.ll-toolbar'),actions=root.querySelector('.ll-actions'),nav=root.querySelector('.ll-pdf-navigation'),canvas=root.querySelector('.ll-page canvas'),page=canvas?.parentElement;
 return {root:rect(root),bar:rect(bar),nav:rect(nav),buttons:[...actions.children].map(rect),display:getComputedStyle(bar).display,actionDisplay:getComputedStyle(actions).display,navDisplay:getComputedStyle(nav).display,
 checkmark:getComputedStyle(root.querySelector('.ll-status'),'::before').content,emptyDisplay:getComputedStyle(root.querySelector('.ll-problems')).display,
 canvas:canvas?{width:canvas.width,css:rect(canvas),page:rect(page),dpr:devicePixelRatio}:null,notices:window.previewNotices};
};
window.__ready=true;
`;
try {
 const runBuild=await build({stdin:{contents:`import{rmSync}from 'fs';import{runTex}from './src/tex/run';import{resolveTexBinDir,texEnv,texTool}from './src/tex/binaries'; const dir=process.argv[2];const bin=resolveTexBinDir('');if(!bin)throw new Error('TeX unavailable');for(let i=0;i<2;i++){rmSync(dir+'/fixture.log',{force:true});const r=await runTex(texTool(bin,'xelatex'),['-interaction=nonstopmode','-halt-on-error','-file-line-error','fixture.tex'],{cwd:dir,env:{...texEnv(bin),max_print_line:'10000'},log:dir+'/fixture.log',timeoutMs:60000});if(r.code!==0)throw new Error(r.output);} `,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
 writeFileSync(join(work,'build.mjs'),runBuild.outputFiles[0].contents);
 const rows=Array.from({length:65},(_,i)=>String.raw`\hypertarget{page${i+1}}{}Selectable English page ${i+1}. 中文复制测试。\par
\href{https://example.com/read}{External link}\quad\hyperlink{page20}{Jump to page twenty}\par
A second paragraph with mathematical notation $a^2+b^2=c^2$.`+(i<64?'\n\\newpage\n':''));
 writeFileSync(join(work,'fixture.tex'),String.raw`\documentclass[fontset=fandol]{ctexart}
\usepackage{hyperref}
\begin{document}
`+rows.join('\n')+'\n\\end{document}\n');
 const run=spawn(process.execPath,[join(work,'build.mjs'),work],{stdio:['ignore','pipe','pipe']});let log='';run.stdout.on('data',d=>log+=d);run.stderr.on('data',d=>log+=d);await new Promise((yes,no)=>run.once('exit',code=>code===0?yes():no(new Error(log))));
 const built=await build({stdin:{contents:entry,resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'iife',target:'es2022',write:false,external:['/lib/pdfjs/*'],plugins:[{name:'host',setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:'host',namespace:'host'}));b.onLoad({filter:/.*/,namespace:'host'},()=>({loader:'js',contents:`export class ItemView{constructor(leaf){this.leaf=leaf;this.app=leaf.app;this.contentEl=document.querySelector('#preview');}getState(){return{};}async setState(){}}export class Modal{}export class Notice{constructor(text){(window.previewNotices??=[]).push(text);}}export function setIcon(el){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','24');svg.setAttribute('height','24');const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M5 12h14M12 5v14');path.setAttribute('stroke','currentColor');svg.append(path);el.append(svg);}
export async function loadPdfJs(){const api=await import('/lib/pdfjs/pdf.min.mjs');api.GlobalWorkerOptions.workerSrc='/lib/pdfjs/pdf.worker.min.mjs';window.pdfVersion=api.version;return {...api,getDocument(src){window.loaded++;return api.getDocument(src);}};}`}));b.onResolve({filter:/^(?:node:)?(?:fs|path|crypto|child_process)$/},a=>({path:a.path,namespace:'noio'}));b.onLoad({filter:/.*/,namespace:'noio'},()=>({loader:'js',contents:'module.exports=new Proxy({},{get:()=>()=>{throw new Error("No Node IO from browser");}})'}));}}]});
 writeFileSync(join(work,'bundle.js'),built.outputFiles[0].contents);
 const css=readFileSync(join(root,'styles.css'),'utf8');
 writeFileSync(join(work,'index.html'),`<!doctype html><meta charset="utf8"><link rel="stylesheet" href="/app.css"><style id="plugin-css">${css}</style><style>body{margin:0}#preview{width:800px;height:700px}#status{height:30px}canvas{user-select:none}</style><body class="theme-light mod-macos"><div id="status"></div><div id="preview" class="view-content ll-preview"></div><script src="/bundle.js"></script>`);
 server=createServer((req,res)=>{const path=decodeURIComponent(new URL(req.url,'http://x').pathname);const data=path==='/app.css'?asset('app.css'):path.startsWith('/lib/pdfjs/')?asset(path.slice(1)):path==='/fixture.pdf'?readFileSync(join(work,'fixture.pdf')):['/index.html','/bundle.js'].includes(path)?readFileSync(join(work,path.slice(1))):null;if(!data){res.writeHead(404).end();return;}res.writeHead(200,{'content-type':{'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.pdf':'application/pdf'}[extname(path)]??'application/octet-stream'}).end(data);});await new Promise(yes=>server.listen(0,'127.0.0.1',yes));
 chrome=spawn(chromeBin,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${join(work,'chrome')}`,'--no-first-run','--disable-extensions','about:blank'],{detached:true,stdio:['ignore','ignore','pipe']});
 const url=await new Promise((yes,no)=>{let log='';const timer=setTimeout(()=>no(new Error('Chrome timeout')),20000);chrome.stderr.on('data',d=>{log+=d;const match=/DevTools listening on (ws:\/\/\S+)/.exec(log);if(match){clearTimeout(timer);yes(match[1]);}});});
 const {page,evaluate,send}=await connect(url);await page('Page.enable');await page('Runtime.enable');await page('Emulation.setDeviceMetricsOverride',{width:1000,height:900,deviceScaleFactor:1,mobile:false});
 const origin=`http://127.0.0.1:${server.address().port}`;await send('Browser.grantPermissions',{origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});await page('Page.navigate',{url:origin+'/index.html'});
 for(let i=0;i<200;i++){if(await evaluate('window.__ready').catch(()=>false))break;await sleep(30);}await evaluate('mount()');await sleep(700);
 let initial=await evaluate('snapshot()');check('host pdf.js 5.x loads 65 pages and bilingual selectable text lazily',/^5\./.test(initial.version)&&initial.status.pages===65&&initial.text?.includes('中文')&&initial.canvases<=3,initial);
 const span=await evaluate('firstSpan()');check('text layer has real font geometry over the native page',span?.width>80&&span.height>5,span);
 if(span){await page('Input.dispatchMouseEvent',{type:'mouseMoved',x:span.x+1,y:span.y+span.height/2});await page('Input.dispatchMouseEvent',{type:'mousePressed',x:span.x+1,y:span.y+span.height/2,button:'left',clickCount:1});await page('Input.dispatchMouseEvent',{type:'mouseMoved',x:span.x+span.width-1,y:span.y+span.height/2,button:'left',buttons:1});await page('Input.dispatchMouseEvent',{type:'mouseReleased',x:span.x+span.width-1,y:span.y+span.height/2,button:'left',clickCount:1});}
 const selected=await evaluate('getSelection().toString()');await page('Input.dispatchKeyEvent',{type:'keyDown',key:'c',code:'KeyC',modifiers:4,commands:['copy']});await page('Input.dispatchKeyEvent',{type:'keyUp',key:'c',code:'KeyC',modifiers:4});const copied=await evaluate('navigator.clipboard.readText()');check('native drag selection copies text to clipboard',selected.includes('Selectable')&&copied===selected,{selected,copied});
 const chinese=await evaluate('firstChinese()');
 if(chinese){await page('Input.dispatchMouseEvent',{type:'mousePressed',x:chinese.x+1,y:chinese.y+chinese.height/2,button:'left',clickCount:1});await page('Input.dispatchMouseEvent',{type:'mouseMoved',x:chinese.x+chinese.width-1,y:chinese.y+chinese.height/2,button:'left',buttons:1});await page('Input.dispatchMouseEvent',{type:'mouseReleased',x:chinese.x+chinese.width-1,y:chinese.y+chinese.height/2,button:'left',clickCount:1});}
 const chineseSelected=await evaluate('getSelection().toString()');await page('Input.dispatchKeyEvent',{type:'keyDown',key:'c',code:'KeyC',modifiers:4,commands:['copy']});await page('Input.dispatchKeyEvent',{type:'keyUp',key:'c',code:'KeyC',modifiers:4});const chineseCopied=await evaluate('navigator.clipboard.readText()');check('Chinese glyph drag copies Unicode text',chineseSelected.includes('中文')&&chineseCopied===chineseSelected,{chineseSelected,chineseCopied});
 const before=await evaluate('pinch()');await sleep(300);const after=await evaluate('anchor()'),zoomed=await evaluate('snapshot()');check('pinch retains the pointed PDF position without reopening',before.page===after.page&&Math.abs(before.x-after.x)<2&&Math.abs(before.y-after.y)<2&&zoomed.loaded===1&&zoomed.status.scale>initial.status.scale,{before,after,loaded:zoomed.loaded});
 const scaledSpan=await evaluate('firstSpan()');check('pinch updates the selectable text geometry with the canvas',Math.abs(scaledSpan.width/span.width-zoomed.status.scale/initial.status.scale)<.03,{before:span.width,after:scaledSpan.width,scale:zoomed.status.scale/initial.status.scale});
 await evaluate('renderer.fitWidth();renderer.goToPage(1);getSelection().removeAllRanges()');await sleep(300);
 const external=await evaluate('linkRect("example.com")');if(external)await page('Input.dispatchMouseEvent',{type:'mousePressed',x:external.x+external.width/2,y:external.y+external.height/2,button:'left',clickCount:1});if(external)await page('Input.dispatchMouseEvent',{type:'mouseReleased',x:external.x+external.width/2,y:external.y+external.height/2,button:'left',clickCount:1});await sleep(80);check('external link click dispatches a safe browser URL',(await evaluate('snapshot()')).opened.includes('https://example.com/read'),external);
 const internal=await evaluate('linkRect("internal")');if(internal)await page('Input.dispatchMouseEvent',{type:'mousePressed',x:internal.x+internal.width/2,y:internal.y+internal.height/2,button:'left',clickCount:1});if(internal)await page('Input.dispatchMouseEvent',{type:'mouseReleased',x:internal.x+internal.width/2,y:internal.y+internal.height/2,button:'left',clickCount:1});await sleep(350);check('named PDF destination navigates to the actual page',(await evaluate('snapshot()')).status.page===20,await evaluate('snapshot()'));
 for(let p=1;p<=65;p+=4){await evaluate(`renderer.goToPage(${p})`);await sleep(70);}await evaluate('renderer.goToPage(65)');await sleep(300);const final=await evaluate('snapshot()');check('page navigation over 65 pages keeps canvas and text layers bounded',final.status.page===65&&final.canvases>0&&final.canvases<=10&&final.texts>0&&final.texts<=10,final);check('native reader produces no uncaught errors',final.errors.length===0,final.errors);
 await evaluate('renderer.goToPage(1)');await sleep(300);const densityBefore=await evaluate('canvasDensity()');
 // Chromium dispatches resolution changes with a window resize; the PDF pane stays 800px.
 await page('Emulation.setDeviceMetricsOverride',{width:1001,height:900,deviceScaleFactor:2,mobile:false});await sleep(350);
 const densityAfter=await evaluate('canvasDensity()');check('display density change redraws pixels at unchanged PDF pane width',densityBefore.dpr===1&&densityAfter.dpr===2&&Math.abs(densityBefore.css-densityAfter.css)<1&&densityAfter.width/densityAfter.css>1.98&&densityAfter.text===densityBefore.text,{before:densityBefore,after:densityAfter});
 const shot=await page('Page.captureScreenshot',{format:'png'});writeFileSync(join(evidence,'pdf-reading.png'),Buffer.from(shot.data,'base64'));
 await evaluate('mountPreview()');await sleep(500);
 for(const theme of ['light','dark'])for(const width of [800,375]){
  await evaluate(`document.body.className='theme-${theme} mod-macos';document.querySelector('#preview').style.width='${width}px';document.querySelector('.ll-scroll').scrollTop=0`);await sleep(350);
  const layout=await evaluate('previewLayout()');check(`preview dock remains horizontal and Retina-sized: ${theme} ${width}px`,layout.display==='flex'&&layout.actionDisplay==='flex'&&layout.navDisplay==='flex'&&layout.buttons.every(button=>Math.abs(button.y-layout.buttons[0].y)<1)&&layout.bar.height<100&&layout.emptyDisplay==='none'&&layout.canvas&&Math.abs(layout.canvas.css.width-layout.canvas.page.width)<1&&layout.canvas.width/layout.canvas.css.width>1.98&&layout.notices.length===0,layout);
 }
 await evaluate('previewView.onClose();document.querySelector("#plugin-css").sheet.disabled=true;document.querySelector("#preview").style.width="800px";mountPreview()');await sleep(500);
 const missing=await evaluate('previewLayout()');check('missing stylesheet reports how to update/restart the plugin',missing.notices.length===1&&missing.notices[0].includes('preview styles are not loaded')&&missing.notices[0].includes('Community plugins'),missing.notices);
 await evaluate('document.querySelector("#plugin-css").sheet.disabled=false;previewView.onClose();mountPreview()');await sleep(500);
 const restored=await evaluate('previewLayout()');check('restoring the released stylesheet fixes layout and Retina canvas',restored.notices.length===0&&restored.display==='flex'&&restored.actionDisplay==='flex'&&restored.navDisplay==='flex'&&restored.emptyDisplay==='none'&&restored.checkmark.includes('✓')&&restored.canvas&&Math.abs(restored.canvas.css.width-restored.canvas.page.width)<1&&restored.canvas.width/restored.canvas.css.width>1.98,restored);
 const recoveredShot=await page('Page.captureScreenshot',{format:'png'});writeFileSync(join(evidence,'styles-recovered.png'),Buffer.from(recoveredShot.data,'base64'));
 await evaluate('previewView.onClose()');check('dispose removes PDF layers',await evaluate('document.querySelectorAll(".ll-page").length===0'));
 writeFileSync(join(evidence,'measurements.json'),JSON.stringify(results,null,2));
} catch(error){check('reader smoke',false,error.stack??String(error));}
finally{ws?.close();if(chrome?.exitCode===null){try{process.kill(-chrome.pid,'SIGKILL');}catch{chrome.kill('SIGKILL');}}server?.close();rmSync(work,{recursive:true,force:true});}
console.log(`pdf-reading-smoke: ${results.filter(x=>x.pass).length}/${results.length} passed; ${evidence}`);process.exitCode=results.some(x=>!x.pass)?1:0;
