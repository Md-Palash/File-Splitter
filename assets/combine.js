/* File Spliter: Combine mode UI (PDF, Excel/CSV, MP4/MOV). Needs tool.js (FSTool.saveFile) and combine-core.js. Runs in the browser; nothing is uploaded. */
(function(){
'use strict';
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const K=window.CombineCore;
if(!K||!$('#view-combine'))return;

const C={type:null,files:[],busy:false,out:null,seq:0,dragId:null,queue:Promise.resolve(),opts:{mode:'sheets',headers:'first',source:false}};

/* ---------- libraries are loaded the first time they are needed ---------- */
const libs={};
function loadScript(src,failMsg){
  return libs[src]||(libs[src]=new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src=src;s.async=true;s.onload=()=>res();
    s.onerror=()=>{delete libs[src];s.remove();rej(new Error(failMsg));};
    document.head.appendChild(s);
  }));
}
async function pdfLib(){
  if(!window.PDFLib)await loadScript('assets/vendor/pdf-lib.min.js','The PDF engine could not be loaded. Check your connection to this site and try again.');
  return window.PDFLib;
}

async function xlsxLibs(){
  if(!window.JSZip)await loadScript('assets/vendor/jszip.min.js','The Excel engine could not be loaded. Check your connection to this site and try again.');
  if(!window.CombineXlsx)await loadScript('assets/combine-xlsx.js','The Excel engine could not be loaded. Check your connection to this site and try again.');
  return {JSZip:window.JSZip,X:window.CombineXlsx};
}
async function mp4Lib(){
  if(!window.CombineMp4)await loadScript('assets/combine-mp4.js','The video joiner could not be loaded. Check your connection to this site and try again.');
  return window.CombineMp4;
}
const rdr=f=>({name:f.name,size:f.size,read:async(a,l)=>new Uint8Array(await f.file.slice(a,a+l).arrayBuffer())});
const clock=sec=>{sec=Math.round(sec);const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;return (h?h+':'+String(m).padStart(2,'0'):m)+':'+String(s).padStart(2,'0');};
const plural=(n,w)=>n+' '+w+(n===1?'':'s');

/* ---------- one entry per kind of file ---------- */
const TYPES={
  pdf:{
    label:'PDF',out:'combined.pdf',accept:'.pdf,application/pdf',maxFile:400e6,maxTotal:800e6,
    async inspect(f){
      const PL=await pdfLib();
      try{f.pages=(await PL.PDFDocument.load(new Uint8Array(await f.file.arrayBuffer()),{updateMetadata:false})).getPageCount();}
      catch(e){throw K.describePdfError(e,f.name);}
    },
    info(f){return f.pages+' page'+(f.pages===1?'':'s');},
    extra(f){
      return '<label class="pr"><span>Pages</span><input type="text" data-range="'+f.id+'" value="'+esc(f.range)+'" placeholder="All" spellcheck="false" autocomplete="off" aria-label="Pages to use from '+esc(f.name)+', for example 1-3,5. Empty means all pages."></label>';
    },
    check(files){
      let total=0;const problems=[];
      for(const f of files){
        const r=K.rangeInfo(f.range,f.pages);
        if(r.ok)total+=r.count;else problems.push({id:f.id,msg:f.name+': '+r.error});
      }
      return {problems,summary:total+' page'+(total===1?'':'s')};
    },
    optsHtml:'<p class="hint first">Every page is copied in the order shown. To use only some pages of a file, type a range such as 1-3,5 in its Pages box. Leave it empty for all pages.</p><p class="hint">Bookmarks, form fields and the original document properties are not carried over. Password-protected PDFs must be unlocked first.</p>',
    async run(files,progress){
      const PL=await pdfLib();
      const inputs=files.map(f=>({name:f.name,range:f.range,read:async()=>new Uint8Array(await f.file.arrayBuffer())}));
      progress(0,'Combining '+files.length+' PDFs…');
      const r=await K.mergePdfs(PL,inputs,(frac,i)=>progress(frac*0.95,'Joined '+(i+1)+' of '+files.length+'…'),()=>sleep(0));
      return {blob:new Blob([r.bytes],{type:'application/pdf'}),message:'Done: '+files.length+' PDFs joined into one with '+r.pages+' page'+(r.pages===1?'':'s')+'. Choose Save to keep it.'};
    }
  },
  excel:{
    label:'Excel',out:'combined.xlsx',accept:'.xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',maxFile:100e6,maxTotal:300e6,
    async inspect(f){
      const L=await xlsxLibs();
      f.sheets=await L.X.readAny(L.JSZip,f.name,new Uint8Array(await f.file.arrayBuffer()));
      f.sheetInfo=L.X.sheetInfo(f.sheets);
    },
    info(f){
      const rows=f.sheetInfo.reduce((a,s)=>a+s.rows,0);
      return plural(f.sheetInfo.length,'sheet')+' · '+plural(rows,'row');
    },
    check(files){
      const o=C.opts;
      if(o.mode==='stack'){
        const rows=files.reduce((a,f)=>{const s=f.sheets.find(x=>x.rows.some(r=>r.length));return a+(s?Math.max(0,s.rows.filter(r=>r.length).length-1):0);},0);
        return {problems:[],summary:'one sheet · '+plural(rows,'row')};
      }
      const n=files.reduce((a,f)=>a+f.sheets.length,0);
      return {problems:[],summary:plural(n,'sheet')};
    },
    optsHtml(){
      const o=C.opts,P=(k,v,t)=>'<button class="pill" data-copt="'+k+'" data-v="'+v+'" aria-pressed="'+(o[k]===v)+'">'+t+'</button>';
      return '<span class="lbl first">How to combine</span><div class="pills" role="group" aria-label="How to combine">'
        +P('mode','sheets','One sheet per file or sheet')+P('mode','stack','Stack rows into one sheet')+'</div>'
        +'<p class="hint">'+(o.mode==='stack'
          ?'Rows from every file go under one header row, matched by column name (ignoring capitals and spaces at the ends). Only the first sheet with data in each file is used.'
          :'Every sheet of every file becomes its own sheet, in the order shown. Sheet names come from the file name and are shortened to 31 characters if needed.')+'</p>'
        +(o.mode==='stack'
          ?'<span class="lbl">Columns</span><div class="pills" role="group" aria-label="Which columns to keep">'+P('headers','first','Keep first file’s columns')+P('headers','union','All columns from all files')+'</div>'
            +'<div class="sw"><span>Add a “Source file” column<small>Shows which file each row came from</small></span><button class="switch" role="switch" data-cswitch="source" aria-checked="'+o.source+'" aria-label="Add a Source file column"></button></div>'
          :'')
        +'<p class="hint">Cell values are kept (text, numbers, true/false; formulas keep their last calculated value). Formatting, colours, column widths, charts, images, merged cells and dates shown as dates are not carried over; dates arrive as plain numbers. Old .xls files and password-protected files must be saved as .xlsx first.</p>';
    },
    async run(files,progress){
      const L=await xlsxLibs();
      progress(0,'Combining '+files.length+' files…');
      const parsed=files.map(f=>({name:f.name,sheets:f.sheets}));
      const r=await L.X.finishMerge(L.JSZip,parsed,C.opts,(fr)=>progress(fr));
      let msg='Done: '+plural(files.length,'file')+' combined into '+plural(r.sheetNames.length,'sheet')+(C.opts.mode==='stack'?' with '+plural(r.rowCount,'row'):'')+'. Formatting is not carried over.';
      if(r.dropped.length)msg+=' Columns not in the first file were left out: '+r.dropped.slice(0,3).map(d=>d.file+' ('+d.cols.slice(0,4).join(', ')+(d.cols.length>4?'…':'')+')').join('; ')+'.';
      return {blob:new Blob([r.bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),message:msg+' Choose Save to keep it.'};
    }
  },
  video:{
    label:'video',out:'combined.mp4',accept:'.mp4,.m4v,.mov,video/mp4,video/quicktime',maxFile:4e9,maxTotal:16e9,
    async inspect(f){
      const ext=(/\.([^.]+)$/.exec(f.name)||[])[1];
      if(!/^(mp4|m4v|mov)$/i.test(ext||''))throw new Error(f.name+' is a '+String(ext||'').toUpperCase()+' file. Only MP4 and MOV videos can be joined here, because other formats would need re-encoding, which this tool does not do.');
      const M=await mp4Lib();
      try{f.meta=await M.inspect(rdr(f));}
      catch(e){throw new Error(e.kind==='unsupported'?e.message:(f.name+' could not be read. It may be damaged or not a real MP4 or MOV file.'));}
    },
    admit(f,files){
      if(!files.length)return '';
      const M=window.CombineMp4;
      const v=M.plan([{name:files[0].name,tracks:files[0].meta.sig},{name:f.name,tracks:f.meta.sig}]);
      return v.strategy==='remux'?'':f.name+' was left out: '+v.reason+' Joining it would need re-encoding, which this tool does not do. It only joins files that match exactly.';
    },
    info(f){return (f.meta.width?f.meta.width+'×'+f.meta.height+' · ':'')+clock(f.meta.seconds)+(f.meta.hasAudio?' · with sound':' · no sound');},
    check(files){
      const t=files.reduce((a,f)=>a+f.meta.seconds,0),sz=files.reduce((a,f)=>a+f.size,0);
      return {problems:[],summary:clock(t)+' · about '+fmtBytes(sz)};
    },
    optsHtml:'<p class="hint first">Files are joined exactly as they are, with no re-encoding, so quality is kept and it is quick, even for large videos. This works when every file has the same codec, size and sound format, as clips from one camera or one export do. A file that does not match is left out with the reason.</p><p class="hint">Chapters, subtitles and the original file details are not carried over. Only MP4 and MOV are supported, and an MP4 cannot be mixed with a MOV.</p>',
    async run(files,progress){
      const M=await mp4Lib();
      progress(0,'Reading '+plural(files.length,'video')+'…');
      const r=await M.merge(files.map(rdr),fr=>progress(fr*0.9));
      progress(0.95,'Writing the joined video…');
      const blob=new Blob(r.parts.map(p=>p.bytes?p.bytes:files[p.src].file.slice(p.start,p.end)),{type:'video/mp4'});
      return {blob,message:'Done: '+plural(files.length,'video')+' joined into one ('+clock(r.seconds)+', '+fmtBytes(blob.size)+') without re-encoding. Choose Save to keep it.'};
    }
  }
};
const supported=()=>Object.keys(TYPES).map(k=>TYPES[k].label).join(', ');

/* ---------- small helpers ---------- */
function note(sel,msg){const n=$(sel);if(!n)return;n.hidden=!msg;n.textContent=msg||'';}
const addNote=m=>note('#cNote',m),probNote=m=>note('#cProb',m);
function stat(msg){const s=$('#cStat');if(s)s.textContent=msg||'';}
function setBar(f){const w=$('#cBarWrap');w.hidden=f==null;if(f!=null)$('#cBar').style.width=Math.round(f*100)+'%';}
const T=()=>TYPES[C.type];

/* ---------- adding files ---------- */
function add(list){
  const files=[...list||[]];
  C.queue=C.queue.then(()=>addNow(files)).catch(()=>{});
  return C.queue;
}
async function addNow(list){
  if(!list.length)return;
  if(C.busy){addNote('Please wait until the current job has finished before adding files.');return;}
  addNote('');probNote('');
  const problems=[];let added=0,dupes=0;
  C.busy=true;renderActions();
  try{
    for(const file of list){
      if(C.files.some(x=>x.name===file.name&&x.size===file.size&&x.lastModified===file.lastModified)){dupes++;continue;}
      const t=K.typeOf(file.name,file.type);
      if(!t){problems.push(file.name+' is not a kind of file Combine can join. Works with '+supported()+' files.');continue;}
      if(C.type&&t!==C.type){problems.push(file.name+' is '+K.labelOf(t)+', but this job holds '+K.labelOf(C.type)+' files. Only one kind per job, so it was left out.');continue;}
      const Ty=TYPES[t];
      if(!Ty){problems.push('Combining '+K.labelOf(t)+' files is not available. Works with '+supported()+' files.');continue;}
      if(!file.size){problems.push(file.name+' is empty.');continue;}
      if(file.size>Ty.maxFile){problems.push(file.name+' is '+fmtBytes(file.size)+', which is too large to combine in the browser (limit '+fmtBytes(Ty.maxFile)+' per file).');continue;}
      if(C.files.reduce((a,x)=>a+x.size,0)+file.size>Ty.maxTotal){problems.push(file.name+' was left out: the files together would pass '+fmtBytes(Ty.maxTotal)+', which is too much for the browser to hold.');continue;}
      const f={id:++C.seq,file,name:file.name,size:file.size,lastModified:file.lastModified,type:t,range:''};
      try{stat('Reading '+file.name+'…');await Ty.inspect(f);}
      catch(e){problems.push(e.message||(file.name+' could not be read.'));continue;}
      if(Ty.admit){const why=Ty.admit(f,C.files);if(why){problems.push(why);continue;}}
      C.type=t;C.files.push(f);added++;
    }
  }finally{
    C.busy=false;C.out=null;stat('');
    if(dupes)problems.push(dupes+' file'+(dupes===1?' was':'s were')+' already in the list.');
    if(problems.length)addNote(problems.slice(0,3).join(' ')+(problems.length>3?' (+'+(problems.length-3)+' more)':''));
    render();
    if(added)stat(added+' file'+(added===1?'':'s')+' added. The top file comes first.');
  }
}

/* ---------- rendering ---------- */
function rowHtml(f,i,n){
  const Ty=T();
  return '<li data-id="'+f.id+'"><span class="grip" aria-hidden="true">⋮⋮</span><span class="pos" aria-hidden="true">'+(i+1)+'</span>'
    +'<span class="nm2"><span class="fn" title="'+esc(f.name)+'">'+esc(f.name)+'</span><small>'+esc(fmtBytes(f.size))+' · '+esc(Ty.info(f))+'</small></span>'
    +(Ty.extra?Ty.extra(f):'')
    +'<span class="cb">'
    +'<button class="pill ghost small" data-mv="-1" data-id="'+f.id+'" aria-label="Move '+esc(f.name)+' up, now number '+(i+1)+' of '+n+'"'+(i===0?' disabled':'')+'>↑</button>'
    +'<button class="pill ghost small" data-mv="1" data-id="'+f.id+'" aria-label="Move '+esc(f.name)+' down, now number '+(i+1)+' of '+n+'"'+(i===n-1?' disabled':'')+'>↓</button>'
    +'<button class="pill ghost small" data-rm="'+f.id+'" aria-label="Remove '+esc(f.name)+'">✕</button></span></li>';
}
function renderList(){
  const el=$('#cList');
  if(!C.files.length){el.innerHTML='<div class="empty"><b>No files yet</b><br>Add two or more files of the same kind to join them.</div>';return;}
  const n=C.files.length;
  el.innerHTML='<ul class="list clist" aria-label="Files in the order they will be joined">'+C.files.map((f,i)=>rowHtml(f,i,n)).join('')+'</ul>';
  markInvalid();
}
function markInvalid(){
  if(!C.type||!T().check)return;
  const bad=new Set(T().check(C.files).problems.map(p=>p.id));
  document.querySelectorAll('#cList input[data-range]').forEach(i=>i.setAttribute('aria-invalid',String(bad.has(+i.dataset.range))));
}
function renderOpts(){
  $('#cOpts').innerHTML=C.type?(typeof T().optsHtml==='function'?T().optsHtml():T().optsHtml):'<p class="hint first">Add files to see the options for their kind.</p>';
}
function renderActions(){
  const n=C.files.length;
  $('#cBuild').disabled=C.busy||n<2;
  $('#cSave').disabled=C.busy||!C.out;
  $('#cClear').disabled=C.busy;$('#cPick').disabled=C.busy;
  let s='Add the files';
  if(n){
    const chk=T().check?T().check(C.files):{problems:[],summary:''};
    s='<b>'+n+'</b> '+T().label+' file'+(n===1?'':'s')+' · '+(chk.problems.length?'check the page ranges':'<b>'+esc(chk.summary)+'</b>');
    if(n<2)s='<b>1</b> '+T().label+' file · add one more';
  }
  $('#cFootSummary').innerHTML=s;
}
function render(){renderList();renderOpts();renderActions();}
function changed(msg){
  C.out=null;probNote('');
  renderList();renderActions();
  if(msg)stat(msg);
}

/* ---------- ordering: buttons, keyboard and drag-and-drop ---------- */
function indexOf(id){return C.files.findIndex(f=>f.id===id);}
function moveBy(id,d){
  const i=indexOf(id),j=i+d;
  if(i<0||j<0||j>=C.files.length)return;
  const f=C.files[i];C.files.splice(i,1);C.files.splice(j,0,f);
  changed('Moved '+f.name+' to position '+(j+1)+' of '+C.files.length+'.');
  focusMove(id,d);
}
function focusMove(id,d){
  let b=document.querySelector('#cList button[data-mv="'+d+'"][data-id="'+id+'"]');
  if(!b||b.disabled)b=document.querySelector('#cList button[data-mv="'+(-d)+'"][data-id="'+id+'"]');
  if(b)b.focus();
}
function moveTo(id,targetId,after){
  const from=indexOf(id);if(from<0||id===targetId)return;
  const f=C.files.splice(from,1)[0];
  let to=indexOf(targetId);if(to<0){C.files.splice(from,0,f);return;}
  if(after)to++;
  C.files.splice(to,0,f);
  changed('Moved '+f.name+' to position '+(indexOf(id)+1)+' of '+C.files.length+'.');
}
function removeFile(id){
  const i=indexOf(id);if(i<0)return;
  const f=C.files.splice(i,1)[0];
  if(!C.files.length)C.type=null;
  addNote('');
  C.out=null;probNote('');render();
  stat('Removed '+f.name+'.');
  const next=document.querySelector('#cList button[data-rm]');(next||$('#cPick')).focus();
}
function clearMarks(){document.querySelectorAll('#cList li').forEach(l=>l.classList.remove('over-top','over-bottom','dragging'));}
const liAt=e=>e.target&&e.target.closest?e.target.closest('#cList li[data-id]'):null;
const isAfter=(li,e)=>{const r=li.getBoundingClientRect();return e.clientY>r.top+r.height/2;};

const list=$('#cList');
list.addEventListener('click',e=>{
  const mv=e.target.closest('[data-mv]'),rm=e.target.closest('[data-rm]');
  if(mv&&!C.busy)moveBy(+mv.dataset.id,+mv.dataset.mv);
  else if(rm&&!C.busy)removeFile(+rm.dataset.rm);
});
list.addEventListener('keydown',e=>{
  const li=e.target.closest&&e.target.closest('li[data-id]');
  if(!li||!e.altKey||(e.key!=='ArrowUp'&&e.key!=='ArrowDown')||C.busy)return;
  e.preventDefault();moveBy(+li.dataset.id,e.key==='ArrowUp'?-1:1);
});
list.addEventListener('input',e=>{
  const inp=e.target.closest('input[data-range]');if(!inp)return;
  const f=C.files[indexOf(+inp.dataset.range)];if(!f)return;
  f.range=inp.value;C.out=null;probNote('');renderActions();markInvalid();
});
/* Rows drag by their body, but not from the page boxes or buttons, so text there stays selectable. */
list.addEventListener('pointerdown',e=>{
  C.dragId=null;
  const li=e.target.closest('li[data-id]');
  if(li)li.draggable=!e.target.closest('input,button,label');
});
list.addEventListener('dragstart',e=>{
  const li=e.target.closest('li[data-id]');if(!li||C.busy){e.preventDefault();return;}
  C.dragId=+li.dataset.id;
  e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',li.dataset.id);
  setTimeout(()=>li.classList.add('dragging'),0);
});
list.addEventListener('dragend',()=>{C.dragId=null;clearMarks();});
/* While a row is being dragged, the page-wide "drop files" handler must not react, so handle it here first. */
['dragenter','dragleave','dragover','drop'].forEach(type=>window.addEventListener(type,e=>{
  if(C.dragId==null)return;
  e.stopPropagation();
  const li=liAt(e);
  if(type==='dragleave')return;
  if(li&&+li.dataset.id!==C.dragId){
    e.preventDefault();e.dataTransfer.dropEffect='move';
    if(type!=='drop'){
      clearMarks();
      const dragging=document.querySelector('#cList li[data-id="'+C.dragId+'"]');if(dragging)dragging.classList.add('dragging');
      li.classList.add(isAfter(li,e)?'over-bottom':'over-top');
    }
  }
  if(type==='drop'){
    e.preventDefault();
    const id=C.dragId;C.dragId=null;clearMarks();
    if(li)moveTo(id,+li.dataset.id,isAfter(li,e));
  }
},true));

/* ---------- combine and save ---------- */
async function build(){
  if(C.busy||!C.type||C.files.length<2)return;
  const chk=T().check?T().check(C.files):{problems:[]};
  if(chk.problems.length){probNote(chk.problems[0].msg);return;}
  C.busy=true;C.out=null;probNote('');renderActions();
  try{
    setBar(0);
    const res=await T().run(C.files,(f,msg)=>{setBar(f);if(msg)stat(msg);});
    C.out={blob:res.blob,name:T().out};
    stat(res.message);
  }catch(err){
    probNote((err&&err.message)||'The files could not be combined.');stat('');
  }finally{
    C.busy=false;setBar(null);renderActions();
  }
}
async function save(){
  if(C.busy||!C.out)return;
  C.busy=true;renderActions();
  try{
    await window.FSTool.saveFile(C.out.name,C.out.blob);
    stat('Saved '+C.out.name+' ('+fmtBytes(C.out.blob.size)+').');
  }catch(e){
    const c=e&&e.code;
    if(c==='declined')stat('Save cancelled.');
    else if(c==='unavailable')probNote('Saving is not available in this view. Open the page from your claude.ai artifacts to save files.');
    else probNote('Could not save '+C.out.name+': '+((e&&e.message)||'unknown error'));
  }finally{C.busy=false;renderActions();}
}

/* ---------- options (Excel) ---------- */
$('#cOpts').addEventListener('click',e=>{
  if(C.busy)return;
  const p=e.target.closest('[data-copt]'),sw=e.target.closest('[data-cswitch]');
  if(p){C.opts[p.dataset.copt]=p.dataset.v;}
  else if(sw){C.opts[sw.dataset.cswitch]=!C.opts[sw.dataset.cswitch];}
  else return;
  C.out=null;probNote('');renderOpts();renderActions();
  const again=p?$('#cOpts [data-copt="'+p.dataset.copt+'"][data-v="'+p.dataset.v+'"]'):$('#cOpts [data-cswitch="'+sw.dataset.cswitch+'"]');
  if(again)again.focus();
});

/* ---------- wiring ---------- */
$('#cIn').accept=Object.keys(TYPES).map(k=>TYPES[k].accept).join(',');
$('#cPick').onclick=()=>$('#cIn').click();
$('#cIn').onchange=e=>{add(e.target.files);e.target.value='';};
$('#cClear').onclick=()=>{if(C.busy)return;C.files=[];C.type=null;C.out=null;addNote('');probNote('');stat('');render();};
$('#cBuild').onclick=build;
$('#cSave').onclick=save;
$('#cSupport').textContent='Works with '+supported()+' files.';
window.FSCombine={add,state:C};
render();
})();
