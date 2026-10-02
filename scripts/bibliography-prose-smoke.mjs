// Real TexView/CM and dialogs with fixture host/disk/clipboard adapters. Fresh Chrome
// never touches a vault or recorded window. The benchmark uses real TexView.onEdit.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=resolve('.');
const chromeBin=[process.env.CHROME_BIN,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
if(!chromeBin)throw new Error('Chrome is required (CHROME_BIN).');
const work=mkdtempSync(join(tmpdir(),'ll-bib-prose-')),evidence=join(tmpdir(),'latex-live-bibliography-prose-smoke');mkdirSync(evidence,{recursive:true});
const results=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,pass,detail)=>{results.push({name,pass,detail});console.log((pass?'ok ':'FAIL ')+name+(detail===undefined?'':': '+JSON.stringify(detail)));};
let chrome,server,ws;
async function connect(url){
 ws=new WebSocket(url);await new Promise((yes,no)=>{ws.onopen=yes;ws.onerror=no;});let seq=0;const pending=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.no(new Error(JSON.stringify(m.error))):p.yes(m.result);};
 const send=(method,params={},sessionId)=>new Promise((yes,no)=>{pending.set(++seq,{yes,no});ws.send(JSON.stringify({id:seq,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const page=(method,params)=>send(method,params,sessionId),evaluate=async expression=>{const r=await page('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};return{page,evaluate};
}
const pathShim=String.raw`
const clean=p=>{const out=[];for(const x of p.split('/')){if(!x||x==='.')continue;if(x==='..')out.pop();else out.push(x);}return '/'+out.join('/');};
const resolve=(...parts)=>{let p='/';for(const s of parts){if(String(s).startsWith('/'))p=String(s);else p+='/'+s;}return clean(p);};
const dirname=p=>{p=clean(p);return p.slice(0,p.lastIndexOf('/'))||'/';},basename=(p,ext='')=>{const s=p.split('/').pop();return ext&&s.endsWith(ext)?s.slice(0,-ext.length):s;};
module.exports={sep:'/',resolve,join:(...p)=>resolve(...p),dirname,basename,extname:p=>{const b=basename(p),i=b.lastIndexOf('.');return i>0?b.slice(i):'';},isAbsolute:p=>p.startsWith('/'),relative:(a,b)=>{const x=clean(a).split('/').filter(Boolean),y=clean(b).split('/').filter(Boolean);while(x[0]&&x[0]===y[0]){x.shift();y.shift();}return [...x.map(()=>'..'),...y].join('/');}};window.__path=module.exports;
`;
const fsShim=String.raw`
const key=p=>window.__path.resolve(String(p));const readFileSync=p=>{window.__reads++;const k=key(p);if(!window.__files.has(k))throw new Error('ENOENT '+k);return window.__files.get(k);};
const existsSync=p=>window.__files.has(key(p))||[...window.__files.keys()].some(k=>k.startsWith(key(p)+'/'));
module.exports={readFileSync,existsSync,realpathSync:p=>key(p),statSync:p=>{if(!existsSync(p))throw new Error('ENOENT '+p);return{mtimeMs:window.__versions.get(key(p))??1,isDirectory:()=>!window.__files.has(key(p))};},readdirSync:p=>[...new Set([...window.__files.keys()].filter(k=>k.startsWith(key(p)+'/')).map(k=>k.slice(key(p).length+1).split('/')[0]))],readFile:async p=>readFileSync(p)};
`;
const entry=String.raw`
import {startCompletion,currentCompletions,completionStatus,setSelectedCompletion} from '@codemirror/autocomplete';
import {undo} from '@codemirror/commands';
import {EditorState} from '@codemirror/state';
import {TexView} from './src/editor/texView';
import {Bibliographies} from './src/editor/bibliographies';
import {BibliographyModal} from './src/editor/bibliographyView';
import {TablePasteModal,SpellingModal,clipboardTable} from './src/editor/proseTools';
import {proseWords,tableLatex} from './src/tex/prose';
import {readProjectSnapshot} from './src/tex/projectIndex';
import {Modal,WorkspaceLeaf,TFile,testApp,notices} from './tests/support/obsidian';
import {HistoryCache} from './src/editor/shared/editorKit';
window.__files=new Map();window.__versions=new Map();window.__reads=0;window.__errors=[];
window.addEventListener('error',e=>window.__errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
const bib=Array.from({length:10000},(_,i)=>'@article{key'+i+',author={'+(i===9999?'Grace Hopper':'Ada Lovelace')+'},title={'+(i===9999?'Hidden Compiler Analysis 中文':'Computing paper '+i)+'},year={'+(i===9999?'1952':'2026')+'},doi={10.1000/test'+i+'},abstract={'+(i===9999?'Complete abstract <safe> '+('long-prose-'.repeat(120)):'An abstract')+'},journal={Journal of Computing},url={https://example.com/'+i+'}}').join('\n');
const large='\\bibliography{refs}\n'+Array.from({length:600},(_,i)=>'\\section{Section '+i+'}\n'+('Prose with $x$ and ordinary words.\n').repeat(8)).join('');
const originalMain='\\documentclass{elegantbook}\n\\addbibresource{\n refs.bib\n}\n\\begin{document}\n\\input{chapter}\n\\input{perf}\n\\begin{verbatim}\n\\bibliography{missing-example}\n\\end{verbatim}\n\\iffalse\n\\bibliography{missing-false}\n\\fi\n\\end{document}';
window.__files.set('/fixture/main.tex',originalMain);window.__files.set('/fixture/refs.bib',bib);window.__files.set('/fixture/chapter.tex','Source chapter.');window.__files.set('/fixture/perf.tex',large);
Modal.prototype.open=function(){this.isOpen=true;this.modalEl.className='modal';this.titleEl.className='modal-title';this.contentEl.classList.add('modal-content');document.querySelector('#dialogs').append(this.modalEl);this.onOpen();};
Modal.prototype.close=function(){this.isOpen=false;this.onClose();this.modalEl.remove();};
const app=testApp();let view,modal,manager,entries;const counts={edits:0,renderer:0,graph:0,bib:0};
const buffers=()=>view?.file?new Map([['/fixture/'+view.file.path,view.getCommittedText()]]):new Map();
manager=new Bibliographies(buffers);const originalEdited=manager.edited.bind(manager);manager.edited=(...args)=>{counts.bib++;return originalEdited(...args);};
const plugin={app,settings:{editingMode:'source',hoverRender:false,cursorPreview:false,debounceMs:1000000,followCursor:false,editorFontSize:24,editorLineHeight:1.8,editorFontFamily:'Menlo, monospace',mathPreviewScale:1},histories:new HistoryCache(),bibliographies:manager,
 yolo:{inline:null,extension:()=>[]},texlab:{status:'stopped',triggerCharacters:()=>[],completion:async()=>null,resolve:async x=>x,open:()=>{},close:()=>{},change:()=>counts.edits++},
 theoremGraphs:{invalidate:()=>counts.graph++,subscribe:()=>()=>{},load:async()=>null,content:async()=>document.createElement('div')},texRender:{ready:false,opened:()=>{},edited:()=>counts.renderer++,hoverTarget:()=>null,load:async()=>{}},
 absolutePath:p=>'/fixture/'+p,rootFor:()=>'/fixture/main.tex',diagnosticsFor:()=>[],openPreview:async()=>{},togglePreview:()=>{},syncPreviewToCursor:async()=>{},editorBuffers:buffers,texViews:()=>view?[view]:[],openLocation:async()=>{}};
async function mount(text,path='chapter.tex',hooks=true){modal?.close();modal=null;if(view)await view.onClose();app.vault.files.set(path,text);plugin.bibliographies=hooks?manager:{load:()=>Promise.resolve(entries),edited:()=>{}};view=new TexView(new WorkspaceLeaf(app),plugin);view.requestSave=()=>{};view.file=new TFile(path);view.setViewData(text,true);document.querySelector('#workspace').replaceChildren(view.containerEl);view.editorView.focus();return snapshot();}
function snapshot(){const e=view.editorView;return{text:e.state.doc.toString(),selection:e.state.selection.main.head,committed:view.getCommittedText(),composition:e.compositionStarted,errors:window.__errors,notices:[...notices],counts:{...counts},reads:window.__reads};}
async function citation(query){await mount('\\cite{'+query+'}');const e=view.editorView;e.dispatch({selection:{anchor:e.state.doc.length-1}});startCompletion(e);return true;}
function completions(){return{status:completionStatus(view.editorView.state),labels:currentCompletions(view.editorView.state).map(c=>c.label)};}
function choose(){const e=view.editorView,i=currentCompletions(e.state).findIndex(c=>c.label==='key9999');if(i>=0)e.dispatch({effects:setSelectedCompletion(i)});return i;}
function showBib(){modal?.close();modal=new BibliographyModal(plugin,view,'/fixture/main.tex');modal.open();return true;}
function modalSnapshot(){const m=modal.modalEl,r=m.getBoundingClientRect();return{text:m.textContent,rows:m.querySelectorAll('.ll-bib-result').length,fields:Array.from(m.querySelectorAll('dt')).map(x=>x.textContent),unsafe:m.querySelector('img,script')!==null,width:r.width,right:r.right,window:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,contentWidth:modal.contentEl.clientWidth,contentScroll:modal.contentEl.scrollWidth,font:getComputedStyle(m).fontSize,editorFont:getComputedStyle(view.editorView.contentDOM).fontSize};}
async function table(html='<table><tr><th>Name</th><th>Value</th></tr><tr><td>A &amp; B</td><td>100% $x$</td></tr></table>'){await mount('Table insertion location.');view.editorView.dispatch({selection:{anchor:view.editorView.state.doc.length}});modal=new TablePasteModal(plugin,view,()=>({text:'',html}));modal.open();return modalSnapshot();}
function composing(on){Object.defineProperty(view.editorView,'compositionStarted',{value:on,configurable:true});}
function restoreComposition(){delete view.editorView.compositionStarted;}
function undoText(){undo(view.editorView);return snapshot();}
async function spell(){const src='\\begin{theorem}{Named result}{thm:key}\nMispeling prose with $Mispeling$ and \\ref{mispeling}.\n\\end{theorem}';await mount(src);modal=new SpellingModal(plugin,view,{isWordMisspelled:w=>w==='Mispeling'||w==='thm'||w==='key'||w==='qzxqzxqzx',getWordSuggestions:()=>['Misspelling']});modal.open();return true;}
async function reviewRegressions(){const root='/case/main.tex',old='\\documentclass{article}\n\\addbibresource{\none.bib\n}\n\\begin{document}Prose\\end{document}',fresh=old.replace('one.bib','two.bib');window.__files.set(root,old);window.__files.set('/case/one.bib','@article{one,title={One}}');window.__files.set('/case/two.bib','@article{two,title={Two}}');const local=new Map(),index=new Bibliographies(()=>local);await index.load(root);const s=EditorState.create({doc:old}),at=old.indexOf('one.bib'),tr=s.update({changes:{from:at,to:at+7,insert:'two.bib'}});local.set(root,fresh);index.edited(root,tr.changes,s.doc,tr.newDoc);await index.fileModified(root);const keys=(await index.load(root)).map(c=>c.entry.key);const sig=(await readProjectSnapshot('/fixture/main.tex',new Map())).plan.sig;const words=proseWords('\\begin{theorem}{Title}{thm:key}Prose.\\end{theorem}',sig).map(w=>w.text);return{keys,words,oneRow:clipboardTable('','<table><tr><td>A</td><td>B</td></tr></table>',document),oneColumn:clipboardTable('','<table><tr><td>A</td></tr><tr><td>B</td></tr></table>',document),singleBooktabs:tableLatex([['A','B']],true)};}
async function bench(hooks){await mount(large,'perf.tex',hooks);const e=view.editorView,values=[],reads=window.__reads,before={...counts},cached=manager.load('/fixture/main.tex');for(let i=0;i<120;i++){const at=e.state.doc.line(3500).to,t=performance.now();e.dispatch({changes:{from:at,insert:'x'},userEvent:'input.type'});values.push(performance.now()-t);}values.sort((a,b)=>a-b);return{lines:e.state.doc.lines,chars:e.state.doc.length,p50:values[60],p95:values[114],max:values[119],diskReads:window.__reads-reads,cacheSame:manager.load('/fixture/main.tex')===cached,committed:e.state.doc.toString()===view.getCommittedText(),calls:Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,v-before[k]]))};}
window.smoke={mount,citation,completions,choose,showBib,modalSnapshot,table,composing,restoreComposition,undoText,spell,reviewRegressions,bench,snapshot};
manager.load('/fixture/main.tex').then(async e=>{entries=e;window.__entries=e.length;await mount('Ready.');window.__ready=true;}).catch(e=>window.__errors.push(String(e)));
`;
try{
 const built=await build({stdin:{contents:entry,resolveDir:root,loader:'ts',sourcefile:'bib-prose-smoke.ts'},bundle:true,platform:'browser',format:'iife',target:'es2022',write:false,alias:{obsidian:resolve('tests/support/obsidian.ts')},plugins:[{name:'fixture-io',setup(b){
  b.onResolve({filter:/^(?:node:)?path$/},()=>({path:'path',namespace:'fixture'}));b.onResolve({filter:/^(?:node:)?fs(?:\/promises)?$/},a=>({path:a.path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path==='path'?pathShim:fsShim}));
 }}]});writeFileSync(join(work,'bundle.js'),built.outputFiles[0].contents);
 const css=readFileSync(join(root,'styles.css'),'utf8');
 writeFileSync(join(work,'index.html'),'<!doctype html><html><meta charset="utf8"><style>'+css+'*{box-sizing:border-box}body{margin:0;padding:12px;font-family:system-ui;background:#232631;color:#e8e8e8;--font-text-size:24px;--font-monospace:Menlo,monospace;--text-error:#ef7777;--background-secondary:#303544}#workspace{height:570px}.ll-editor-content,.cm-editor{height:100%}.cm-scroller{overflow:auto}button,input,textarea,select{font:inherit;color:inherit;background:#303544;border:1px solid #65708a;border-radius:4px;padding:5px}button{cursor:pointer}#dialogs:has(.modal){position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0009}.modal{font-size:24px;width:800px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;background:#242936;padding:14px;border:1px solid #65708a;border-radius:8px}.modal-title{font-weight:bold;margin-bottom:12px}.modal-content{min-width:0}.ll-bib-detail pre{font-size:16px}textarea{max-width:100%}.cm-tooltip{color:#ddd;background:#242936}.cm-tooltip-autocomplete{font-size:16px}</style><body class="theme-dark"><div id="workspace"></div><div id="dialogs"></div><script src="/bundle.js"></script></body></html>');
 server=createServer((req,res)=>{const file=req.url==='/bundle.js'?'bundle.js':'index.html';res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':'text/html'}).end(readFileSync(join(work,file)));});await new Promise(yes=>server.listen(0,'127.0.0.1',yes));
 chrome=spawn(chromeBin,['--headless=new','--remote-debugging-port=0','--user-data-dir='+join(work,'chrome'),'--no-first-run','--disable-extensions','--disable-background-timer-throttling','about:blank'],{detached:true,stdio:['ignore','ignore','pipe']});
 const url=await new Promise((yes,no)=>{let log='';const timer=setTimeout(()=>no(new Error('Chrome timeout '+log.slice(-200))),20000);chrome.stderr.on('data',d=>{log+=d;const m=/DevTools listening on (ws:\/\/\S+)/.exec(log);if(m){clearTimeout(timer);yes(m[1]);}});});
 const{page,evaluate}=await connect(url);await page('Page.enable');await page('Runtime.enable');await page('Emulation.setDeviceMetricsOverride',{width:1100,height:900,deviceScaleFactor:1,mobile:false});await page('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/index.html'});
 for(let i=0;i<200;i++){if(await evaluate('window.__ready').catch(()=>false))break;await sleep(25);}
 check('10k entries index while inactive examples are skipped',await evaluate('window.__entries===10000'),await evaluate('window.__errors'));
 const keypress=async key=>{await page('Input.dispatchKeyEvent',{type:'keyDown',key,code:key});await page('Input.dispatchKeyEvent',{type:'keyUp',key,code:key});};
 for(const query of['Grace Hopper','Hidden Compiler','1952','key9999']){
  await evaluate('smoke.citation('+JSON.stringify(query)+')');for(let i=0;i<100;i++){if((await evaluate('smoke.completions()')).status==='active')break;await sleep(20);}await sleep(90);
  const list=await evaluate('smoke.completions()');await evaluate('smoke.choose()');await keypress('Tab');const accepted=await evaluate('smoke.snapshot()');check('CM searches '+query+' and native Tab accepts key9999',list.labels.includes('key9999')&&accepted.text==='\\cite{key9999}',{count:list.labels.length,text:accepted.text});
 }
 await evaluate('smoke.showBib()');await sleep(40);const initial=await evaluate('smoke.modalSnapshot()');check('dialog pages DOM while retaining 10k searchable entries',initial.rows===100&&initial.text.includes('10000 entries'),{rows:initial.rows});
 await evaluate("(()=>{const q=document.querySelector('input[type=search]');q.value='Grace 1952';q.dispatchEvent(new Event('input',{bubbles:true}));})()");await sleep(110);await evaluate("document.querySelector('.ll-bib-result').click()");let detail=await evaluate('smoke.modalSnapshot()');check('complete fields/authored BibTeX are safe text',detail.fields.includes('abstract')&&detail.fields.includes('doi')&&detail.fields.includes('url')&&detail.text.includes('Complete abstract <safe>')&&!detail.unsafe,detail.fields);
 await page('Emulation.setDeviceMetricsOverride',{width:375,height:900,deviceScaleFactor:1,mobile:false});await sleep(60);detail=await evaluate('smoke.modalSnapshot()');check('dark 24px modal fits 375px viewport',detail.width<=351&&detail.right<=375&&!detail.overflow&&detail.contentScroll<=detail.contentWidth+1&&detail.font==='24px',{width:detail.width,scroll:detail.contentScroll,client:detail.contentWidth,font:detail.font});
 let shot=await page('Page.captureScreenshot',{format:'png'});writeFileSync(join(evidence,'bibliography-dark-375.png'),Buffer.from(shot.data,'base64'));await page('Emulation.setDeviceMetricsOverride',{width:1100,height:900,deviceScaleFactor:1,mobile:false});
 await evaluate('smoke.table()');await evaluate("(()=>{const mode=document.querySelector('select[aria-label=\"Table style\"]');mode.value='booktabs';mode.dispatchEvent(new Event('change',{bubbles:true}));})()");const preview=await evaluate("document.querySelector('textarea').value");check('clipboard preview contains escaped booktabs source',preview.includes('\\toprule')&&preview.includes('\\midrule')&&preview.includes('A \\& B')&&preview.includes('100\\% \\$x\\$'),preview);
 await evaluate('smoke.composing(true)');await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Insert table').click()");let held=await evaluate('smoke.snapshot()');check('IME refuses table insertion without editing source',held.text==='Table insertion location.'&&held.notices.some(n=>n.includes('Finish composing')));
 await evaluate('smoke.restoreComposition()');await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Insert table').click()");const inserted=await evaluate('smoke.snapshot()');check('table insertion reaches committed TexView notifier',inserted.text.endsWith(preview)&&inserted.committed===inserted.text&&inserted.counts.edits>0);check('table insertion undoes as one action',(await evaluate('smoke.undoText()')).text==='Table insertion location.');
 await evaluate('smoke.spell()');await sleep(150);const spell=await evaluate('smoke.modalSnapshot()');check('project spelling excludes labels, refs and math',spell.text.includes('1 possible spelling errors'),spell.text);await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Misspelling').click()");const corrected=await evaluate('smoke.snapshot()');check('spelling suggestion changes only prose',corrected.text.includes('Misspelling prose')&&corrected.text.includes('$Mispeling$')&&corrected.text.includes('\\ref{mispeling}'));
 const regressions=await evaluate('smoke.reviewRegressions()');check('multiline path edit invalidates loaded bibliography cache',JSON.stringify(regressions.keys)==='["two"]',regressions.keys);check('project signature excludes theorem identity args',JSON.stringify(regressions.words)==='["Prose"]',regressions.words);check('1xN/Nx1 dimensions persist, single-row booktabs has no midrule',regressions.oneRow?.length===1&&regressions.oneRow[0].length===2&&regressions.oneColumn?.length===2&&regressions.oneColumn[0].length===1&&!regressions.singleBooktabs.includes('\\midrule'));
 const baseline=await evaluate('smoke.bench(false)'),integrated=await evaluate('smoke.bench(true)');check('5400-line real TexView edits retain sub16ms p95, committed text and cache',integrated.lines>=5400&&integrated.p95<16&&integrated.diskReads===0&&integrated.cacheSame&&integrated.committed&&integrated.calls.bib===120&&integrated.calls.edits===120&&integrated.calls.renderer===120,{baseline,integrated});check('no uncaught browser errors',(await evaluate('smoke.snapshot()')).errors.length===0,await evaluate('window.__errors'));
 writeFileSync(join(evidence,'measurements.json'),JSON.stringify(results,null,2));
}catch(error){check('bibliography/prose smoke',false,error.stack??String(error));}
finally{ws?.close();if(chrome?.exitCode===null){try{process.kill(-chrome.pid,'SIGKILL');}catch{chrome.kill('SIGKILL');}}server?.close();rmSync(work,{recursive:true,force:true});}
console.log('bibliography-prose-smoke: '+results.filter(x=>x.pass).length+'/'+results.length+' passed; '+evidence);process.exitCode=results.some(x=>!x.pass)?1:0;
