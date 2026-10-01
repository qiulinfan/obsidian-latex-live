// Reproducible input into the real, running Obsidian renderer through its official CLI.
// The native window is separately captured with ScreenCaptureKit; this is not a mock UI.
// Usage: node scripts/demo-drive.mjs core|gallery|html|browser|fallback|reverse [artifact-root] [fresh-take-id]
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
const task=process.argv[2]??'core';
const base=resolve(process.argv[3]??join(homedir(),'Desktop','LaTeX-Live-Demo-2026-09-30'));
const vault='LaTeX Live Demo';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const cli=(...args)=>execFileSync('/usr/local/bin/obsidian',[args[0],`vault=${vault}`,...args.slice(1)],{encoding:'utf8',timeout:15000,killSignal:'SIGKILL'}).trim();
const evaluate=async code=>{
 // Developer eval can follow the last active renderer instead of the requested vault.
 // Route explicitly to the named demo window and assert its vault before every operation.
 const inner=`(async()=>{if(app.vault.getName()!==${JSON.stringify(vault)})throw Error('Wrong recording vault');${code}})()`;
 const relay=`(async()=>{const r=require('electron').remote;const w=r.BrowserWindow.getAllWindows().find(w=>w.getTitle().includes(${JSON.stringify(' - '+vault+' - Obsidian')}));if(!w)throw Error('Demo window missing');return await w.webContents.executeJavaScript(${JSON.stringify(inner)});})()`;
 const text=cli('eval',`code=${relay}`);
 const value=text.replace(/^=>\s*/,'');
 if(/^Error:/.test(value))throw Error(value);
 try{return JSON.parse(value);}catch{return value;}
};
const cdp=async(method,params)=>evaluate(`const d=require('electron').remote.getCurrentWindow().webContents.debugger;if(!d.isAttached())d.attach('1.3');await d.sendCommand(${JSON.stringify(method)},${JSON.stringify(params)});return 'input';`);
const read=async code=>evaluate(`return JSON.stringify(${code});`);
const open=async path=>{
 await evaluate(`const f=app.vault.getFileByPath(${JSON.stringify(path)});if(!f)throw Error('Demo file missing');const leaves=app.workspace.getLeavesOfType('latex-live-editor');const leaf=leaves[0]??app.workspace.getLeaf(false);await leaf.openFile(f);app.workspace.setActiveLeaf(leaf,{focus:true});window.demoView=leaf.view;window.demoView.editorView.focus();return 'opened';`);
 await sleep(300);
};
const mode=async live=>{
 await evaluate(`const v=window.demoView,p=app.plugins.plugins['latex-live'];await p.texRender.preload(p.rootFor(v.absolutePath()));if(v.contentEl.classList.contains('is-live-preview')!==${live})v.toggleMode();return 'mode';`);await sleep(350);
};
const cursor=async(find,offset=0)=>{
 await evaluate(`const v=window.demoView,e=v.editorView,s=e.state.doc.toString(),at=s.indexOf(${JSON.stringify(find)});if(at<0)throw Error('Demo cursor target missing');e.dispatch({selection:{anchor:at+${offset}},scrollIntoView:true});e.focus();return 'cursor';`);await sleep(200);
};
const key=async(code,modifiers=[])=>{
 await evaluate(`const r=require('electron').remote,w=r.getCurrentWindow();r.app.focus({steal:true});w.focus();w.webContents.sendInputEvent({type:'keyDown',keyCode:${JSON.stringify(code)},modifiers:${JSON.stringify(modifiers)}});w.webContents.sendInputEvent({type:'keyUp',keyCode:${JSON.stringify(code)},modifiers:${JSON.stringify(modifiers)}});return 'key';`);await sleep(120);
};
const type=async text=>{
 for(const c of text){await evaluate(`require('electron').remote.getCurrentWindow().webContents.sendInputEvent({type:'char',keyCode:${JSON.stringify(c)}});return 'typed';`);await sleep(22);}
};
const input=async text=>{await evaluate(`require('electron').remote.getCurrentWindow().webContents.insertText(${JSON.stringify(text)});return 'inserted';`);await sleep(200);};
const status=()=>read(`({path:window.demoView?.file?.path,live:window.demoView?.contentEl.classList.contains('is-live-preview'),status:document.querySelector('.ll-status')?.textContent,diagnostics:document.querySelector('.ll-problems')?.textContent,source:window.demoView?.editorView?.state.doc.toString()})`);
const hover=async selector=>{
 const point=await read(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Hover target missing');const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
 await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await sleep(700);return point;
};
const click=async(selector,double=false)=>{
 const point=await read(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Click target missing');const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
 await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await sleep(100);
 for(let n=1;n<=(double?2:1);n++){await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:n,...point});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:n,...point});}
 await sleep(350);return point;
};
let recorder,started,recording;
const receipt=join(base,'evidence',`${task}-recording.json`);
function save(){writeFileSync(receipt,JSON.stringify({schema:'latex-live-demo-recordings-v1',outputDir:join(base,'videos'),captionLibraries:[resolve('docs/demo/demo-captions.json'),resolve('docs/demo/comparison-video-captions.json')],input_method:'Official Obsidian CLI / native Electron input events; real application rendering',recordings:[recording]},null,2));}
function mark(id,details={}){const event={id,start_s:(Date.now()-started)/1000,status:'verified',details};recording.events.push(event);save();const brief=Object.fromEntries(Object.entries(details).filter(([key])=>!['source','text','popup'].includes(key)));console.log(JSON.stringify({event:'scene',...event,details:brief}));}
function pending(id,details={}){const event={id,start_s:(Date.now()-started)/1000,status:'pending',details};recording.events.push(event);save();}
async function begin(id,title_zh,title_en,{bundleID='md.obsidian',windowID=null}={}){
 if(!/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(id))throw Error('Unsafe recording id');
 if(existsSync(receipt)){
  const previous=JSON.parse(readFileSync(receipt,'utf8'));
  const old=previous.recordings?.[0]?.id;
  if(old&&old!==id){const archived=join(base,'evidence',`${task}-${old}-recording.json`);if(!existsSync(archived))writeFileSync(archived,JSON.stringify(previous,null,2));}
 }
 const text=execFileSync(resolve('node_modules/.cache/product-demo/bin/demo-capture'),['list',bundleID],{encoding:'utf8'});const metadata=JSON.parse(text.trim());
 const window=metadata.windows.find(w=>w.onScreen&&(windowID!==null?w.id===windowID:w.title.includes(vault)));if(!window)throw Error('Selected recording window is not visible');
 const rawPath=join(base,'raw',`${id}.mp4`),stop=join(base,'evidence',`${id}.stop`);if(existsSync(rawPath)||existsSync(stop))throw Error('Choose a fresh recording id');
 recording={id,title_zh,title_en,rawPath,windowID:window.id,events:[]};
 recorder=spawn(resolve('node_modules/.cache/product-demo/bin/demo-capture'),['record',String(window.id),rawPath,stop,bundleID,'1920'],{stdio:['ignore','pipe','pipe']});recording.stopFile=stop;
 await new Promise((ok,fail)=>{let buffer='';const timer=setTimeout(()=>fail(Error('Recorder start timeout')),15000);recorder.stdout.on('data',d=>{buffer+=d;let line;while((line=buffer.indexOf('\n'))>=0){const raw=buffer.slice(0,line);buffer=buffer.slice(line+1);if(!raw)continue;const m=JSON.parse(raw);if(m.event==='started'){started=m.startedAtUnixMs;recording.capture=m;clearTimeout(timer);save();ok();}else if(m.event==='error'){clearTimeout(timer);fail(Error(m.message));}else if(m.event==='finished'){recording.captureFinished=m;save();}console.log(raw);}});recorder.stderr.on('data',d=>process.stderr.write(d));recorder.once('exit',code=>{if(!started)fail(Error('Recorder failed '+code));});});
}
async function end(){
 recording.events.at(-1).end_s=(Date.now()-started)/1000;save();writeFileSync(recording.stopFile,'');
 await new Promise(ok=>recorder.exitCode!==null?ok():recorder.once('exit',ok));
 console.log(JSON.stringify({event:'completed',receipt}));
}
async function compileWait(max=30000){
 const start=Date.now();for(;;){const s=await read(`(()=>{const p=app.plugins.plugins['latex-live'],v=window.demoView,s=p.sessionFor(p.rootFor(v.absolutePath()));return{compiling:s?.compiling,pdf:s?.last?.pdfWritten,errors:s?.last?.log.diagnostics.filter(d=>d.severity==='error').length,ms:s?.last?.durationMs,status:document.querySelector('.ll-status')?.textContent};})()`);if(!s.compiling&&s.pdf&&s.errors===0&&Date.now()-start>700)return s;if(Date.now()-start>max)throw Error('Compile did not settle '+JSON.stringify(s));await sleep(300);}
}
async function ensurePreview(){
 await evaluate(`const p=app.plugins.plugins['latex-live'];await p.openPreview(window.demoView);app.workspace.setActiveLeaf(window.demoView.leaf,{focus:true});window.demoView.editorView.focus();return 'preview';`);
}
async function pdfWait(max=20000){
 const deadline=Date.now()+max;
 for(;;){
  const state=await read(`({pages:document.querySelectorAll('.ll-page').length,rendered:document.querySelectorAll('.ll-page canvas').length,empty:document.querySelector('.ll-empty')?.textContent,root:app.workspace.getLeavesOfType('latex-live-preview')[0]?.view.root})`);
  if(state.pages>0&&state.rendered>0)return state;
  if(Date.now()>deadline)throw Error('Native PDF canvas missing '+JSON.stringify(state));await sleep(250);
 }
}
async function core(){
 await open('math-notes/chapters/01-limits.tex');await mode(false);await cursor('\\begin{theorem}');
 await evaluate(`await app.plugins.plugins['latex-live'].syncPreviewToCursor(window.demoView,false);return 'synced';`);
 await evaluate(`const p=app.plugins.plugins['latex-live'];p.sessionFor(p.rootFor(window.demoView.absolutePath())).request('full');return 'full build';`);await compileWait();
 await begin(process.argv[4]??'01-writing-reading-verified','写作、阅读与编译','Writing, reading and compilation');
 mark('overview',{...await status(),build_state:'actual native warm full rebuild; not a cold benchmark'});await sleep(10000);
 mark('synctex',{direction:'source-to-PDF'});await cursor('M = \\max');await evaluate(`await app.plugins.plugins['latex-live'].syncPreviewToCursor(window.demoView,false);return 'source to PDF';`);await sleep(6000);
 // A real double-click goes through the preview's inverse-search listener.
 await evaluate(`await app.plugins.plugins['latex-live'].syncPreviewToCursor(window.demoView,false);return 'forward';`);
 const highlight=await read(`(()=>{const el=document.querySelector('.ll-sync-mark');if(!el)return null;const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
 if(highlight){for(let n=1;n<=2;n++){await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:n,...highlight});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:n,...highlight});}await sleep(1200);}
 await mode(true);await cursor('\\chapter');mark('live_mode',await status());await sleep(10000);
 await cursor('Let $s');await sleep(6000);
 await open('math-notes/reading-guide.tex');await mode(true);await cursor('\\section');
 await hover('[data-ll-ref-key="thm:products"]');
 await hover('.ll-theorem-graph');
 let graph=await read(`({visible:!!document.querySelector('.ll-theorem-graph'),nodes:document.querySelectorAll('.ll-theorem-graph-node').length,edges:document.querySelector('.ll-theorem-arrows')?.dataset.edges})`);if(!graph.visible)throw Error('Native graph did not open');
 mark('proof_graph',graph);await sleep(2000);
 const target=await read(`[...document.querySelectorAll('.ll-theorem-graph-node')].find(b=>b.textContent.includes('Bounded'))?.dataset.nodeId`);if(!target)throw Error('Bounded theorem node missing');
 await click(`.ll-theorem-graph-node[data-node-id="${target}"]`);await sleep(700);
 const expanded=await read(`({visible:!!document.querySelector('.ll-theorem-graph'),math:document.querySelectorAll('.ll-theorem-graph-detail mjx-container').length,text:document.querySelector('.ll-theorem-graph')?.textContent.slice(0,800)})`);if(!expanded.visible||!expanded.math)throw Error('Native theorem content did not expand');mark('graph_explore',expanded);await sleep(6000);
 await click(`.ll-theorem-node[data-node-id="${target}"] .ll-theorem-graph-source`);await sleep(2500);
 // Writing examples are presenter authored and isolated from the note author's text.
 await open('math-notes/chapters/05-writing-workbench.tex');await mode(false);
 const initial=String.raw`% !TEX root = ../main.tex
% Presenter-authored writing examples, not part of the original notes.
\chapter{写作工作台 / Writing workbench}
\section{A convergence estimate}
For $x\ne0$, consider the reciprocal square:
\[
 F(x) =${' '}
\]
`;
 await evaluate(`const v=window.demoView,e=v.editorView;e.dispatch({changes:{from:0,to:e.state.doc.length,insert:${JSON.stringify(initial)}},selection:{anchor:${initial.indexOf(' F(x) = ')+8}},scrollIntoView:true});e.focus();return 'draft prepared';`);
 await type('\\fra');await sleep(350);const popup=await read(`document.querySelector('.cm-tooltip-autocomplete')?.textContent`);if(!popup)throw Error('Command completion popup missing');mark('snippets',{popup});await sleep(400);
 await key('Tab');await type('1');await key('Tab');await type('x^2');await key('Escape');
 const fraction=await status();if(!fraction.source.includes('\\frac{1}{x^2}'))throw Error('Snippet insertion failed '+fraction.source);await sleep(4000);
 // Start the new environment after the display's closing delimiter, on an empty line.
 await cursor('\\]',2);await input('\n');await type('\\begin{align}');await key('Enter');await input('a_n &= 1/n');
 const aligned=await status();if(!aligned.source.includes('\\end{align}'))throw Error('Environment Enter did not add closing line');mark('latex_enter',aligned);await sleep(7000);
 await compileWait();mark('edit_compile',await status());await sleep(6500);
 // Render hover in source mode, project-aware and independent of the full TeX process.
 await cursor('\\frac',5);const preview=await evaluate(`const r=require('electron').remote,w=r.getCurrentWindow();r.app.focus({steal:true});w.focus();window.demoView.editorView.focus();await new Promise(ok=>setTimeout(ok,900));return JSON.stringify({visible:!!document.querySelector('.lsp-cursor-preview'),math:document.querySelectorAll('.cm-tooltip mjx-container').length,documentFocus:document.hasFocus(),editorFocus:window.demoView.editorView.hasFocus});`);if(!preview.visible||!preview.math)throw Error('Native cursor preview missing');mark('cursor_preview',preview);await sleep(7000);
 const documentEnd=await read(`window.demoView.editorView.state.doc.length`);await evaluate(`const e=window.demoView.editorView;e.dispatch({selection:{anchor:${documentEnd}},scrollIntoView:true});e.focus();return 'end';`);await input('\n\\DefinitelyUndefinedDemo\n');
 await sleep(3500);const error=await read(`(()=>{const p=app.plugins.plugins['latex-live'],v=window.demoView,s=p.sessionFor(p.rootFor(v.absolutePath()));return{errors:s?.last?.log.diagnostics.filter(d=>d.severity==='error').length,status:document.querySelector('.ll-status')?.textContent};})()`);
 if(!error.errors)throw Error('Expected real TeX diagnostic missing');mark('diagnostics',error);await sleep(7000);await key('z',['meta']);await compileWait();await sleep(5000);
 await open('math-notes/chapters/03-cauchy.tex');await mode(true);await cursor('\\begin{tikzpicture}');await evaluate(`await app.plugins.plugins['latex-live'].syncPreviewToCursor(window.demoView,false);return 'plot source to PDF';`);await sleep(1500);await cursor('\\begin{figure}');await sleep(1000);mark('tex_fallback',await status());await sleep(9000);
 await open('math-notes/chapters/01-limits.tex');await mode(true);await cursor('\\chapter');
 mark('search_history',{input:'Cmd-F / bounded'});await key('f',['meta']);await input('bounded');await sleep(4000);await key('Escape');
 mark('source_credits',{source:'Onion20040508/notes',commit:'248dc5590feeb41b52e2ef0977f9947d00712baf',adaptations:'wrapper, split, labels, reading guide, writing examples'});await sleep(5000);
 await end();
}
async function gallery(){
 const configs=['plos','springer','revtex-aps','revtex-aip','aastex','amsart','llncs','acmart-sigconf','acmart-small','ieee-conference'];
 await open(`templates/${configs[0]}/main.tex`);await mode(false);await ensurePreview();
 await evaluate(`const p=app.plugins.plugins['latex-live'];p.sessionFor(p.rootFor(window.demoView.absolutePath())).request('fast');return 'native warm rebuild';`);await compileWait(60000);await pdfWait();
 await begin(process.argv[4]??'02-template-gallery-native','跨领域论文模板','Cross-disciplinary paper templates');
 for(const config of configs){
  pending('template-transition',{config});
  if(config!==configs[0]){await open(`templates/${config}/main.tex`);await mode(false);await ensurePreview();await evaluate(`const p=app.plugins.plugins['latex-live'];p.sessionFor(p.rootFor(window.demoView.absolutePath())).request('fast');return 'native warm rebuild';`);}
  const build=await compileWait(60000);const pdf=await pdfWait();
  await evaluate(`const el=document.querySelector('.ll-scroll');if(el)el.scrollTo({top:0});return 'first PDF page';`);
  const title=String.raw`\title{`,documentStart=String.raw`\begin{document}`;
  const target=await read(`(()=>{const s=window.demoView.editorView.state.doc.toString();return s.includes(${JSON.stringify(title)})?${JSON.stringify(title)}:${JSON.stringify(documentStart)};})()`);await cursor(target);
  mark('paper_templates',{config,build,pdf,build_state:'native fast rebuild using prepared bibliography and auxiliary files; not a cold benchmark'});await sleep(4000);
  await mode(true);
  const sectionStart=String.raw`\section`;
  const section=await read(`(()=>{const s=window.demoView.editorView.state.doc.toString();return s.includes(${JSON.stringify(sectionStart)})?${JSON.stringify(sectionStart)}:${JSON.stringify(documentStart)};})()`);await cursor(section);await sleep(1000);
  mark('template_gallery',{config,view:'native PDF alongside live source; not HTML',math:await read(`document.querySelectorAll('.ll-editor-content mjx-container').length`)});await sleep(3000);
 }
 await end();
}
async function html(){
 await open('math-notes/chapters/01-limits.tex');await mode(true);await ensurePreview();await cursor('\\chapter');
 await begin(process.argv[4]??'03-html-save-report-native','保存 HTML 与查看报告','Saving HTML and viewing its report');
 pending('export-native-dialog',{proposed:'html/main.html',note:'Operator handles the real native save sheet; no dialog replacement.'});
 await evaluate(`app.workspace.setActiveLeaf(window.demoView.leaf,{focus:true});window.demoView.editorView.focus();if(!app.commands.executeCommandById('latex-live:export-html'))throw Error('Export command unavailable');return 'native export command';`);
 console.log(JSON.stringify({event:'native-dialog-awaiting-operator',receipt}));
 const deadline=Date.now()+180000;
 let done;
 for(;;){
  done=await read(`(()=>{const notices=[...document.querySelectorAll('.notice')].map(e=>e.textContent);return{notices,completed:!!document.querySelector('.notice .ll-export-actions'),failed:notices.find(t=>t.includes('HTML export failed'))};})()`);
  if(done.failed)throw Error(done.failed);
  if(done.completed)break;
  if(Date.now()>deadline)throw Error('HTML export/save dialog did not finish');await sleep(700);
 }
 mark('export_save_report',done);await sleep(4500);
 await click('.notice .ll-export-actions button:last-child');
 const report=await read(`({visible:!!document.querySelector('.ll-export-report'),text:document.querySelector('.ll-export-report')?.textContent})`);if(!report.visible)throw Error('Actual export report missing');
 mark('export_save_report',report);await sleep(10000);
 await key('Escape');await sleep(2500);await end();
}
async function fallback(){
 await open('math-notes/chapters/03-cauchy.tex');await mode(true);await ensurePreview();
 await evaluate(`const p=app.plugins.plugins['latex-live'];p.sessionFor(p.rootFor(window.demoView.absolutePath())).request('fast');return 'native warm rebuild';`);await compileWait();await pdfWait();
 await cursor('\\begin{figure}');await evaluate(`await app.plugins.plugins['latex-live'].syncPreviewToCursor(window.demoView,false);return 'figure PDF';`);await sleep(1200);
 const point=await read(`(()=>{const r=window.demoView.editorView.scrollDOM.getBoundingClientRect();return{x:r.left+r.width*.6,y:r.top+r.height*.6};})()`);
 await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:600});await sleep(1200);
 const shown=await read(`(()=>{const v=window.demoView.contentEl.getBoundingClientRect();return [...window.demoView.contentEl.querySelectorAll('img')].filter(i=>i.naturalWidth).map(i=>{const r=i.getBoundingClientRect();return{width:i.naturalWidth,height:i.naturalHeight,top:r.top,bottom:r.bottom,fullyVisible:r.top>=v.top&&r.bottom<=v.bottom};});})()`);if(!shown.some(i=>i.fullyVisible))throw Error('Native crop not fully visible after real wheel input');
 await begin(process.argv[4]??'01b-centered-tikz-crop-native','查看真实 TeX 图形裁剪','Reading a real TeX figure crop');
 mark('tex_fallback',{source:'math-notes/chapters/03-cauchy.tex',native_wheel_deltaY:600,images:shown});await sleep(12000);
 await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:120});await sleep(6500);await end();
}
async function reverse(){
 // Recording setup only: temporarily pause automatic forward following, without saving settings.
 // This lets the source move away while the target PDF row stays on screen for a real double-click.
 const previousFollow=await read(`app.plugins.plugins['latex-live'].settings.followCursor`);
 try{
  await evaluate(`app.plugins.plugins['latex-live'].settings.followCursor=false;return 'Demo automatic follow temporarily paused';`);
  await open('math-notes/chapters/01-limits.tex');await mode(false);await ensurePreview();
  await evaluate(`const p=app.plugins.plugins['latex-live'];p.sessionFor(p.rootFor(window.demoView.absolutePath())).request('fast');return 'native warm rebuild';`);await compileWait();await pdfWait();
  await cursor('M = \\max');await evaluate(`await app.plugins.plugins['latex-live'].syncPreviewToCursor(window.demoView,false);return 'forward target';`);await sleep(700);
  const target=await evaluate(`const p=app.plugins.plugins['latex-live'],v=window.demoView,pv=app.workspace.getLeavesOfType('latex-live-preview')[0]?.view,el=document.querySelector('.ll-sync-mark');if(!el||!pv?.renderer)throw Error('Native PDF target missing');const r=el.getBoundingClientRect(),point={x:r.left+r.width/2,y:r.top+r.height/2};const pdf=pv.renderer.pointFromEvent({target:document.elementFromPoint(point.x,point.y),clientX:point.x,clientY:point.y});if(!pdf)throw Error('PDF pointer mapping missing');const session=p.sessionFor(p.rootFor(v.absolutePath())),expected=await p.inverseSearch(session,pdf.page,pdf.x,pdf.y);if(!expected||!expected.file.startsWith(app.vault.adapter.getBasePath()+'/'))throw Error('Expected inverse target is outside Demo vault');return JSON.stringify({point,pdf,expected,forwardCursor:v.cursor(),forwardFile:v.absolutePath()});`);
  if(target.expected.line<=1)throw Error('Inverse target does not demonstrate moving away from source');
  await begin(process.argv[4]??'07-synctex-reverse-native','PDF 与源码的实际双向定位','Actual PDF and source navigation');
  mark('synctex_forward',{direction:'source-to-PDF',target,native_warm_rebuild:true});await sleep(4000);
  await cursor('',0);const before=await read(`({file:window.demoView.absolutePath(),cursor:window.demoView.cursor(),head:window.demoView.editorView.state.selection.main.head})`);
  if(before.head!==0||before.cursor.line!==1)throw Error('Source did not move away before inverse search');
  pending('inverse-awaiting-click',{before,expected:target.expected});await sleep(3000);
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...target.point});
  for(let n=1;n<=2;n++){await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:n,...target.point});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:n,...target.point});}
  let after;const deadline=Date.now()+10000;
  for(;;){after=await read(`({file:window.demoView.absolutePath(),cursor:window.demoView.cursor(),head:window.demoView.editorView.state.selection.main.head})`);if(after.file===target.expected.file&&after.cursor.line===target.expected.line&&after.head!==before.head)break;if(Date.now()>deadline)throw Error('Native PDF double-click did not reach expected source '+JSON.stringify({before,after,target}));await sleep(200);}
  mark('synctex_reverse',{direction:'PDF-to-source',input:'native PDF double-click through preview listener',before,after,expected:target.expected,matched_file_and_line:true});await sleep(8500);
  await evaluate(`await app.plugins.plugins['latex-live'].syncPreviewToCursor(window.demoView,false);return 'actual forward return';`);await sleep(600);
  const shown=await read(`({highlight:!!document.querySelector('.ll-sync-mark'),sourceFile:window.demoView.file.path,cursor:window.demoView.cursor()})`);if(!shown.highlight)throw Error('Forward return not visibly highlighted');mark('synctex_forward',shown);await sleep(4500);await end();
 }finally{
  await evaluate(`app.plugins.plugins['latex-live'].settings.followCursor=${JSON.stringify(previousFollow)};return 'Demo automatic follow restored';`);
 }
}
async function browser(){
 const file=join(base,vault,'html','analysis-notes-recorded.html');if(!existsSync(file))throw Error('Recorded HTML save target missing');
 const fileURL=pathToFileURL(file).href;
 const profile=join(base,'browser-profile-'+(process.argv[4]??'04-html-browser-native'));mkdirSync(profile,{recursive:true});
 const capture=resolve('node_modules/.cache/product-demo/bin/demo-capture');
 const inventory=()=>JSON.parse(execFileSync(capture,['list','com.google.Chrome'],{encoding:'utf8'})).windows;
 const before=new Set(inventory().map(w=>w.id));
 const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--user-data-dir='+profile,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-features=Translate,TranslateUI','--window-size=1440,828','--new-window',fileURL],{stdio:'ignore'});
 const portFile=join(profile,'DevToolsActivePort');let port;
 const ready=Date.now()+20000;
 while(Date.now()<ready){if(existsSync(portFile)){port=Number(readFileSync(portFile,'utf8').split('\n')[0]);if(port)break;}await sleep(200);}
 if(!port)throw Error('Isolated Chrome did not expose its owned debugging port');
 let tabs=[];for(;;){tabs=await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json());if(tabs.some(t=>t.url===fileURL))break;if(Date.now()>ready)throw Error('Owned HTML browser tab missing');await sleep(200);}
 const target=tabs.find(t=>t.url===fileURL);const socket=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((ok,fail)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',fail,{once:true});});
 let sequence=0;const requests=new Map();socket.addEventListener('message',event=>{const value=JSON.parse(event.data);if(!value.id)return;const pair=requests.get(value.id);if(!pair)return;requests.delete(value.id);value.error?pair.reject(Error(value.error.message)):pair.resolve(value.result);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;requests.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const inspect=async expression=>{const answer=await send('Runtime.evaluate',{expression,returnByValue:true});if(answer.exceptionDetails)throw Error('Browser inspection failed');return answer.result.value;};
 await send('Page.enable');
 await send('Runtime.evaluate',{expression:'document.fonts.ready',awaitPromise:true});
 const window=await send('Browser.getWindowForTarget',{targetId:target.id});await send('Browser.setWindowBounds',{windowId:window.windowId,bounds:{windowState:'normal'}});await send('Browser.setWindowBounds',{windowId:window.windowId,bounds:{width:1440,height:828}});await sleep(1500);
 const nativeWindow=inventory().find(w=>!before.has(w.id)&&w.onScreen);if(!nativeWindow)throw Error('Fresh isolated browser native window missing');
 await begin(process.argv[4]??'04-html-browser-native','浏览器中的自包含阅读版','Self-contained reading in the browser',{bundleID:'com.google.Chrome',windowID:nativeWindow.id});
 recording.browser={profile,debuggingPort:port,windowID:nativeWindow.id,file,opened_by:'fresh isolated Chrome process; plugin Open button not invoked'};save();
 const content=await inspect(`({title:document.title,math:document.querySelectorAll('mjx-container').length,images:[...document.querySelectorAll('img')].map(i=>({embedded:i.src.startsWith('data:'),complete:i.complete,width:i.naturalWidth})),theorems:document.querySelectorAll('.llx-thm').length,scripts:document.scripts.length,externalAssets:[...document.querySelectorAll('[src],[href]')].map(e=>e.getAttribute('src')??e.getAttribute('href')).filter(v=>v&&!v.startsWith('#')&&!v.startsWith('data:')&&/^https?:/.test(v))})`);
 if(!content.math||content.scripts||content.images.some(i=>!i.complete||!i.width))throw Error('Saved HTML actual browser validation failed '+JSON.stringify(content));
 recording.input_method='Actual fresh headed Chrome; native CDP wheel and pointer input, ScreenCaptureKit window capture. No private user Chrome tabs.';save();
 mark('export_browser',{file,content,display:'real headed Chrome; no reconstructed UI'});await sleep(4000);
 const wheel=async(deltaY)=>{await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:900,y:500,deltaX:0,deltaY});await sleep(900);};
 const center=async selector=>{const top=await inspect(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().top`);if(!Number.isFinite(top))throw Error('Recorded HTML target missing: '+selector);await wheel(top-145);};
 await center('svg');const diagram=await inspect(`(()=>{const r=document.querySelector('svg').getBoundingClientRect();return{top:r.top,bottom:r.bottom,viewport:innerHeight,visible:r.top>=0&&r.bottom<=innerHeight};})()`);if(!diagram.visible)throw Error('SVG not fully visible');mark('export_browser',{file,view:'native inline SVG diagram',diagram});await sleep(5000);
 await center('.llx-listing');const code=await inspect(`(()=>{const e=document.querySelector('.llx-listing'),r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,viewport:innerHeight,visible:r.top>=0&&r.bottom<=innerHeight,tokens:[...e.querySelectorAll('.llx-code-token')].map(t=>({text:t.textContent,role:t.className,color:getComputedStyle(t).color})),caption:e.querySelector('figcaption')?.textContent};})()`);if(!code.visible||!code.tokens.length)throw Error('Actual code listing not fully visible');mark('export_browser',{file,view:'complete presenter Python listing with real Prism tokens',code});await sleep(6000);
 const referenceSelector='a[href="#thm:products"]';await center(referenceSelector);
 const ref=await inspect(`(()=>{const e=document.querySelector(${JSON.stringify(referenceSelector)}),r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,href:e.getAttribute('href'),text:e.textContent};})()`);
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:ref.x,y:ref.y});await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:ref.x,y:ref.y});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:ref.x,y:ref.y});await sleep(900);
 const linked=await inspect(`(()=>{const e=document.getElementById('thm:products'),r=e.getBoundingClientRect();return{hash:location.hash,visible:r.top<innerHeight&&r.bottom>0,title:e.textContent.slice(0,140)};})()`);if(linked.hash!=='#thm:products'||!linked.visible)throw Error('Native reference click did not navigate');mark('export_browser',{file,view:'actual reference anchor navigation',reference:ref,destination:linked});await sleep(5000);
 await center('.llx-toc');mark('export_browser',{file,view:'table of contents and reading structure'});await sleep(5000);await end();socket.close();
 // Leave the isolated public output available; its process/profile never touch user Chrome tabs.
 chrome.unref();
}
try{if(task==='core')await core();else if(task==='gallery')await gallery();else if(task==='html')await html();else if(task==='browser')await browser();else if(task==='fallback')await fallback();else if(task==='reverse')await reverse();else throw Error('Unknown take');}
catch(error){if(recording){recording.failure=error.stack;save();if(recording.stopFile)writeFileSync(recording.stopFile,'');}console.error(error.stack);process.exitCode=1;}
