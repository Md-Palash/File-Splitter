/* File Spliter: split and rejoin logic. Needs core.js. Everything runs in the browser. */
(function(){
'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const UNIT={KB:1e3,MB:1e6,GB:1e9};
const S={items:[],sources:[],sample:false,base:'files',skipped:[],origItems:null,plan:null,busy:false,open:new Set(),
  cfg:{value:25,unit:'MB',output:'zip',sort:'name',mode:'size',count:50,fit:false,compress:'keep',split:true,manifest:true,pattern:'{name}-part-{n}-of-{total}'},
  opt:{on:false,fmt:'webp',q:82,max:0}};
const limitBytes=()=>Math.max(1,Math.min(3.9e9,(+S.cfg.value||1)*UNIT[S.cfg.unit]));
const openDrawer=k=>window.openDrawer(k);
function note(msg,kind){const n=$('#note');if(!msg){n.hidden=true;return;}n.hidden=false;n.className='note'+(kind?' '+kind:'');n.textContent=msg;}
function srcNote(msg){const n=$('#srcNote');n.hidden=!msg;n.textContent=msg||'';}
function toast(msg){if(window.showToast)window.showToast(msg);}
function applyWidths(root){root.querySelectorAll('[data-w]').forEach(i=>{i.style.width=i.dataset.w+'%';});}
document.addEventListener('click',e=>{const o=e.target.closest('[data-open]');if(o)openDrawer(o.dataset.open);});
/* ---------- intake ---------- */
const SKIP=/(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/;
async function collectDrop(dt){
  const ents=[...(dt.items||[])].map(i=>i.webkitGetAsEntry&&i.webkitGetAsEntry()).filter(Boolean);
  if(!ents.length)return [...dt.files].map(f=>({file:f,path:f.name}));
  const out=[];
  async function walk(en,prefix){
    if(en.isFile){await new Promise(res=>en.file(f=>{out.push({file:f,path:prefix+f.name});res();},()=>res()));}
    else{const r=en.createReader();let b;do{b=await new Promise((res,rej)=>r.readEntries(res,rej));for(const c of b)await walk(c,prefix+en.name+'/');}while(b.length);}
  }
  for(const en of ents)await walk(en,'');
  return out;
}
function uniquePath(path,used){
  if(!used.has(path)){used.add(path);return path;}
  const m=/^(.*?)(\.[^./]+)?$/.exec(path);let i=2,p;
  do{p=`${m[1]} (${i++})${m[2]||''}`;}while(used.has(p));
  used.add(p);return p;
}
async function addFiles(list){
  srcNote('');
  if(!list.length)return;
  if(S.sample){S.items=[];S.sample=false;S.base='files';}
  for(const {file,path} of list)if(!S.sources.some(x=>x.file.name===file.name&&x.file.size===file.size&&x.file.lastModified===file.lastModified))S.sources.push({file,path});
  S.origItems=null;$('#optStat').textContent='';
  const used=new Set(S.items.map(i=>i.path));
  let zips=0,loose=0,lastZip='';
  const problems=[];
  for(const {file,path} of list){
    if(/\.zip$/i.test(file.name)){
      try{
        const ens=await readZip(file);
        let n=0;
        for(const en of ens){
          if(en.dir)continue;
          if(SKIP.test(en.name)){S.skipped.push(en.name);continue;}
          if(en.flags&1){problems.push(`${file.name}: "${en.name}" is password-protected and was skipped.`);continue;}
          if(en.method!==0&&en.method!==8){problems.push(`${file.name}: "${en.name}" uses a compression type this tool cannot read.`);continue;}
          S.items.push(mkItem('zip',{file,entry:en,path:uniquePath(en.name,used),size:en.size,packed:en.comp,time:en.time,date:en.date}));n++;
        }
        zips++;lastZip=file.name.replace(/\.zip$/i,'');
        continue;
      }catch(err){problems.push(`${file.name}: ${err.message} It was added as a normal file.`);}
    }
    if(SKIP.test(path)){S.skipped.push(path);continue;}
    const d=dosFromMs(file.lastModified);
    S.items.push(mkItem('file',{blob:file,path:uniquePath(path,used),size:file.size,packed:file.size,time:d.time,date:d.date}));loose++;
  }
  if(zips===1&&!loose&&S.items.every(i=>i.kind==='zip'))S.base=lastZip||'files';
  else if(zips||loose)S.base='files';
  if(problems.length)srcNote(problems.slice(0,3).join(' ')+(problems.length>3?` (+${problems.length-3} more)`:''));
  replan();openDrawer('split');
}
function makeSample(){
  const items=[];let s=2463534242;
  for(let i=1;i<=120;i++){
    s^=s<<13;s^=s>>>17;s^=s<<5;
    const size=Math.floor(120e3+((s>>>0)/4294967296)*880e3);
    const u=new Uint32Array(Math.ceil(size/4));
    for(let k=0;k<u.length;k++){s^=s<<13;s^=s>>>17;s^=s<<5;u[k]=s;}
    const bytes=new Uint8Array(u.buffer,0,size);bytes.set([137,80,78,71,13,10,26,10]);
    const name=`sample/frame-${pad(i,3)}.png`,d=dosFromMs(Date.now());
    items.push(mkItem('file',{blob:new Blob([bytes],{type:'image/png'}),path:name,size,packed:size,time:d.time,date:d.date}));
  }
  return items;
}

/* ---------- planning view ---------- */
let rp=0;
function replan(){
  cancelAnimationFrame(rp);
  rp=requestAnimationFrame(()=>{
    S.plan=S.cfg.output==='raw'
      ?planRaw(S.sources.map(x=>({name:x.file.name,size:x.file.size})),limitBytes())
      :planParts(S.items,{limit:limitBytes(),mode:S.cfg.mode,count:S.cfg.count,fit:S.cfg.fit,split:S.cfg.split,manifest:S.cfg.manifest,pattern:S.cfg.pattern,base:S.base,sort:S.cfg.sort});
    renderStats();renderPlan();
  });
}
function renderStats(){
  const raw=S.cfg.output==='raw';
  const src=raw?S.sources.map(x=>({size:x.file.size,packed:x.file.size})):S.items;
  const orig=src.reduce((a,i)=>a+i.size,0),pack=src.reduce((a,i)=>a+i.packed,0);
  $('#stFiles').textContent=src.length.toLocaleString();
  $('#stOrig').textContent=fmtBytes(orig);
  $('#stPackLbl').textContent=raw?'Pieces':'In zip';
  $('#stPack').textContent=raw?(S.plan?S.plan.parts.length.toLocaleString():'0'):fmtBytes(pack);
  $('#sampleBanner').hidden=!S.sample;
  $('#patHint').textContent=S.plan&&S.plan.parts.length&&!S.plan.raw?'First part: '+S.plan.parts[0].filename:'Tokens: {name}  {n}  {total}';
}
const MAXCARDS=150,SEQMAX=48;
function partCard(p,lim,tot){
  const pct=Math.min(100,Math.round(p.bytes/lim*100));
  const built=!!p.blob,w=String(tot).length;
  const status=p.error?`<span class="tag bad">Failed</span>`:p.saved?`<span class="tag good">Saved</span>`:built?(p.over?`<span class="tag bad">Over limit</span>`:p.ok?`<span class="tag good">Ready</span>`:`<span class="tag bad">Check failed</span>`):(p.over?`<span class="tag bad">Over limit</span>`:`<span class="tag">Estimate</span>`);
  const save=`<div class="pills"><button class="pill" data-save="${p.n}" ${built&&p.ok?'':'disabled'}>${p.saved?'Save again':'Save'}</button></div>`;
  if(p.raw){
    const many=S.plan.sources.length>1;
    return `<article class="part" id="part-${p.n}">
    <div class="top2"><span class="no">${many?esc(p.srcName)+' · ':''}Piece ${pad(p.piece,String(p.pieces).length)} <i>of ${p.pieces}</i></span><span class="sz">${fmtBytes(p.bytes)}</span></div>
    <div class="fillbar"><i data-w="${pct}"></i></div>
    <div class="meta"><span>bytes ${p.start.toLocaleString()} to ${Math.max(p.start,p.end-1).toLocaleString()}</span>${status}</div>
    <div class="nm">${esc(p.filename)}</div>${save}</article>`;
  }
  const open=S.open.has(p.n);
  const rows=open?p.items.slice(0,300).map(it=>`<li><span>${esc(it.path)}</span><span>${fmtBytes(it.packed)}</span></li>`).join('')+(p.items.length>300?`<li><span>+${p.items.length-300} more</span><span></span></li>`:''):'';
  const rng=p.items.length>1?`<div class="rng" title="First and last file in this part">${esc(base(p.items[0].path))} → ${esc(base(p.items[p.items.length-1].path))}</div>`:'';
  return `<article class="part" id="part-${p.n}">
    <div class="top2"><span class="no">Part ${pad(p.n,w)} <i>of ${tot}</i></span><span class="sz">${fmtBytes(built?p.blob.size:p.bytes)}</span></div>
    <div class="fillbar ${p.over?'over':''}"><i data-w="${pct}"></i></div>
    <div class="meta"><span>${p.items.length.toLocaleString()} file${p.items.length===1?'':'s'}${p.group?' · '+esc(p.group):''}</span>${status}</div>
    <div class="nm">${esc(p.filename)}</div>${rng}
    <details data-n="${p.n}" ${open?'open':''}><summary>Show files</summary><ul class="files">${rows}</ul></details>${save}
  </article>`;
}
const base=path=>path.slice(path.lastIndexOf('/')+1);
function renderPlan(){
  const el=$('#plan'),P=S.plan,raw=S.cfg.output==='raw';
  if(!P||(!raw&&!S.items.length)||(raw&&!S.sources.length)){
    el.innerHTML=`<div class="empty"><b>No files yet</b><br>${raw&&S.sample?'Raw pieces need a real file. Add one with Add zip or files.':'Add a zip, images or a folder to see how it will be split.'}</div>`;
    $('#buildBtn').disabled=true;$('#saveAllBtn').disabled=true;$('#footSummary').textContent='Add files to begin';return;
  }
  const lim=limitBytes(),built=P.parts.length&&P.parts.every(p=>p.blob&&p.ok);
  const sum=P.parts.reduce((a,p)=>a+(p.blob?p.blob.size:p.bytes),0);
  $('#buildBtn').disabled=S.busy||!P.parts.length;
  $('#buildBtn').textContent=built?'Rebuild parts':raw?'Create pieces':'Create parts';
  $('#saveAllBtn').disabled=S.busy||!built;
  const tot=P.parts.length,unit=raw?'piece':'part';
  const nFiles=raw?S.sources.length:S.items.length;
  const chips=`<div class="chips"><span class="chip">${tot} ${unit}${tot===1?'':'s'}</span><span class="chip">${nFiles.toLocaleString()} file${nFiles===1?'':'s'}</span><span class="chip">${built?'':'about '}${fmtBytes(sum)} total</span>${S.cfg.mode==='count'&&!raw?'':`<span class="chip">limit ${fmtBytes(lim)}</span>`}${tot?`<button class="pill ghost small" data-order="1">Order list (.txt)</button>`:''}</div>`;
  const seq=tot>1?`<div class="seq" aria-label="Order of ${unit}s">${P.parts.slice(0,SEQMAX).map(p=>`<button class="dot ${p.saved?'saved':p.blob&&p.ok?'built':''}" data-goto="${p.n}" title="${esc(p.filename)}">${p.n}</button>`).join('')}${tot>SEQMAX?`<span class="more">+${tot-SEQMAX}</span>`:''}</div><p class="hint seqhint">Send or store them in this order. Each name carries its number, so they also sort correctly in any folder.</p>`:'';
  const warns=P.warnings.length?`<ul class="warns">${P.warnings.slice(0,6).map(w=>`<li>${esc(w)}</li>`).join('')}${P.warnings.length>6?`<li>+${P.warnings.length-6} more notes</li>`:''}</ul>`:'';
  $('#footSummary').innerHTML=`<b>${tot}</b> ${unit}${tot===1?'':'s'} · ${built?'':'about '}<b>${fmtBytes(sum)}</b>`;
  const ref=raw?lim:S.cfg.mode==='count'?Math.max(...P.parts.map(x=>x.bytes)):lim;
  el.innerHTML=chips+seq+warns+`<div class="parts">${P.parts.slice(0,MAXCARDS).map(p=>partCard(p,ref,tot)).join('')}</div>`+(tot>MAXCARDS?`<p class="hint">Showing the first ${MAXCARDS} of ${tot}. Save all still saves every one, in order.</p>`:'');
  applyWidths(el);
}
$('#plan').addEventListener('toggle',e=>{
  const d=e.target;if(!d.matches||!d.matches('details[data-n]'))return;
  const n=+d.dataset.n,p=S.plan&&S.plan.parts[n-1];if(!p)return;
  if(d.open){S.open.add(n);const ul=d.querySelector('ul');if(!ul.children.length)ul.innerHTML=p.items.slice(0,300).map(it=>`<li><span>${esc(it.path)}</span><span>${fmtBytes(it.packed)}</span></li>`).join('')+(p.items.length>300?`<li><span>+${p.items.length-300} more</span><span></span></li>`:'');}
  else S.open.delete(n);
},true);

/* ---------- controls ---------- */
function syncControls(){
  const c=S.cfg;
  $$('[data-key]').forEach(g=>{
    const k=g.dataset.key,cur=k==='optfmt'?S.opt.fmt:k==='optmax'?String(S.opt.max):String(c[k]);
    g.querySelectorAll('.pill').forEach(b=>b.setAttribute('aria-pressed',b.dataset.v===cur));
  });
  $$('[data-preset]').forEach(b=>b.setAttribute('aria-pressed',c.unit==='MB'&&+c.value===+b.dataset.preset));
  $$('[data-sw]').forEach(b=>{const k=b.dataset.sw;b.setAttribute('aria-checked',String(k==='opt'?S.opt.on:c[k]));});
  const raw=c.output==='raw';
  $('#zipOnly').hidden=raw;
  $('#outHint').textContent=raw?'Cuts each file into plain pieces named file.001, file.002 … Nothing is zipped, so any file type works. Join them with Rejoin here, or with copy /b (Windows) or cat (Mac, Linux).':'Packs your files into zip parts. Every part opens on its own.';
  $$('[data-mb]').forEach(b=>{const on=c.unit==='MB'?+c.value===+b.dataset.mb:(c.unit==='GB'&&+c.value*1000===+b.dataset.mb);b.setAttribute('aria-pressed',on);});
  const f=$$('[data-mb]').find(b=>b.getAttribute('aria-pressed')==='true');
  $('#limitHint').textContent=f?f.dataset.hint+' Limits change, so check your service.':'Services change their limits, so check yours. Sizes are decimal (1 MB = 1,000,000 bytes) to stay safely under.';
  $('#countRow').hidden=c.mode!=='count';
  $('#optBody').hidden=!S.opt.on;
  const hints={size:'Fills each part up to the size limit.',count:'Puts the same number of files in each part.',type:'Keeps each file type (png, jpg, …) in its own parts, then fills them by size.',folder:'Keeps each top-level folder in its own parts, then fills them by size.'};
  $('#modeHint').textContent=hints[c.mode];
}
document.addEventListener('click',e=>{
  const g=e.target.closest('[data-key] .pill');
  if(g){
    const k=g.parentElement.dataset.key,v=g.dataset.v;
    if(k==='optfmt')S.opt.fmt=v;
    else if(k==='optmax')S.opt.max=+v;
    else if(k==='fit')S.cfg.fit=v==='true';
    else S.cfg[k]=v;
    if(k==='unit')S.cfg.unit=v;
    syncControls();if(!k.startsWith('opt'))replan();return;
  }
  const fb=e.target.closest('[data-mb]');
  if(fb){const mb=+fb.dataset.mb;if(mb>=1000){S.cfg.value=mb/1000;S.cfg.unit='GB';}else{S.cfg.value=mb;S.cfg.unit='MB';}$('#limitVal').value=S.cfg.value;syncControls();replan();return;}
  const go=e.target.closest('[data-goto]');
  if(go){const c=document.getElementById('part-'+go.dataset.goto);if(c)c.scrollIntoView({behavior:'smooth',block:'center'});return;}
  if(e.target.closest('[data-order]')){saveOrderList();return;}
  const pr=e.target.closest('[data-preset]');
  if(pr){S.cfg.value=+pr.dataset.preset;S.cfg.unit='MB';$('#limitVal').value=S.cfg.value;syncControls();replan();return;}
  const sw=e.target.closest('[data-sw]');
  if(sw){const k=sw.dataset.sw;if(k==='opt')S.opt.on=!S.opt.on;else S.cfg[k]=!S.cfg[k];syncControls();if(k!=='opt')replan();return;}
  const sv=e.target.closest('[data-save]');
  if(sv){const p=S.plan.parts[+sv.dataset.save-1];if(p&&p.blob)savePart(p,true);return;}
});
$('#limitVal').addEventListener('input',e=>{const v=parseFloat(e.target.value);if(v>0){S.cfg.value=v;syncControls();replan();}});
$('#countVal').addEventListener('input',e=>{const v=parseInt(e.target.value,10);if(v>0){S.cfg.count=v;replan();}});
$('#pattern').addEventListener('input',e=>{S.cfg.pattern=e.target.value;replan();});
$('#optQ').addEventListener('input',e=>{S.opt.q=+e.target.value;$('#qVal').textContent=e.target.value;});
$('#pickFiles').onclick=()=>$('#fileIn').click();
$('#pickDir').onclick=()=>$('#dirIn').click();
$('#fileIn').onchange=e=>{addFiles([...e.target.files].map(f=>({file:f,path:f.name})));e.target.value='';};
$('#dirIn').onchange=e=>{addFiles([...e.target.files].map(f=>({file:f,path:f.webkitRelativePath||f.name})));e.target.value='';};
$('#clearAll').onclick=()=>{S.items=[];S.sources=[];S.sample=false;S.skipped=[];S.origItems=null;S.base='files';srcNote('');note('');replan();};

/* drag and drop for both views */
let dragDepth=0;
addEventListener('dragenter',e=>{e.preventDefault();dragDepth++;document.body.classList.add('dragging');});
addEventListener('dragleave',e=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)document.body.classList.remove('dragging');});
addEventListener('dragover',e=>e.preventDefault());
addEventListener('drop',async e=>{
  e.preventDefault();dragDepth=0;document.body.classList.remove('dragging');
  const list=await collectDrop(e.dataTransfer);
  if(window.FSView==='join'&&$('#drawerBackdrop').classList.contains('open'))jAdd(list.map(x=>x.file));else addFiles(list);
});


$('#qSample').onclick=()=>{
  S.items=makeSample();S.sources=[];S.sample=true;S.base='sample';S.origItems=null;srcNote('');replan();openDrawer('split');
};

/* ---------- build and save ---------- */
function setBar(id,wrap,f){$(wrap).hidden=f==null;if(f!=null)$(id).style.width=Math.round(f*100)+'%';}
async function createParts(){
  const P=S.plan;if(S.busy||!P||!P.parts.length)return;
  S.busy=true;note('');
  for(const p of P.parts){delete p.blob;delete p.ok;delete p.saved;}
  renderPlan();
  if(P.raw){
    try{
      for(let i=0;i<P.sources.length;i++){
        const f=S.sources[i].file;let done=0;
        note(`Reading ${f.name} to record its checksum…`);
        P.sources[i].crc=await crcOfBlob(f,n=>{done+=n;setBar('#buildBar','#buildBarWrap',(i+done/Math.max(1,f.size))/P.sources.length);});
      }
      P.parts.forEach(p=>{p.blob=S.sources[p.src].file.slice(p.start,p.end);p.ok=true;});
      note(`All ${P.parts.length} pieces are ready. Save them one by one or choose Save all. The order list lets Rejoin check them automatically.`,'good');
    }catch(err){note('Could not read the file: '+err.message,'bad');}
    finally{S.busy=false;setBar('#buildBar','#buildBarWrap',null);renderPlan();}
    return;
  }
  const o={compress:S.cfg.compress,manifest:S.cfg.manifest};
  try{
    for(let i=0;i<P.parts.length;i++){
      const part=P.parts[i];let k=0;
      note(`Building part ${i+1} of ${P.parts.length}…`);
      setBar('#buildBar','#buildBarWrap',i/P.parts.length);
      const blob=await buildPart(P,part,o,async()=>{if(++k%12===0)await sleep(0);});
      const ens=await readZip(blob);
      part.ok=ens.length===part.items.length+(o.manifest?1:0);
      part.blob=blob;
      if(S.cfg.mode!=='count'&&blob.size>limitBytes())part.over=true;
      renderPlan();
    }
    const bad=P.parts.filter(p=>!p.ok||p.over).length;
    note(bad?`Built ${P.parts.length} parts, but ${bad} need attention (see the red tags).`:`All ${P.parts.length} parts are ready. Save them one by one or choose Save all.`,bad?'bad':'good');
  }catch(err){
    note('Could not build the parts: '+err.message,'bad');
  }finally{
    for(const it of S.items)delete it._unc;
    S.busy=false;setBar('#buildBar','#buildBarWrap',null);renderPlan();
  }
}
let DL;
async function getDL(){
  if(DL!==undefined)return DL;
  try{DL=(window.claude&&window.claude.use)?await window.claude.use('downloads'):null;}catch(e){DL=null;}
  return DL;
}
async function saveFile(filename,blob){
  const dl=await getDL();
  if(dl)return dl.save({filename,data:blob});
  if(window.claude){const e=new Error('Saving is not available in this view.');e.code='unavailable';throw e;}
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  return {status:'saved'};
}
async function savePart(p,single){
  for(let attempt=0;attempt<3;attempt++){
    try{await saveFile(p.filename,p.blob);p.saved=true;if(single)note(`Saved ${p.filename}.`,'good');renderPlan();return 'saved';}
    catch(e){
      const c=e&&e.code;
      if(c==='rate_limited'){await sleep(1500);continue;}
      if(c==='declined'){if(single)note('Save cancelled.');return 'declined';}
      if(c==='unavailable'){note('Saving is not available in this view. Open the page from your claude.ai artifacts to save files.','bad');return 'unavailable';}
      note('Could not save '+p.filename+': '+((e&&e.message)||'unknown error'),'bad');return 'failed';
    }
  }
  return 'failed';
}
async function saveAll(){
  const P=S.plan;if(!P||S.busy)return;S.busy=true;renderPlan();
  try{
    for(let i=0;i<P.parts.length;i++){
      const p=P.parts[i];if(!p.blob||!p.ok)continue;
      note(`Saving part ${i+1} of ${P.parts.length}. Confirm each save when asked.`);
      setBar('#buildBar','#buildBarWrap',i/P.parts.length);
      const r=await savePart(p,false);
      if(r==='declined'){note(`Stopped before part ${i+1}. Choose Save on the parts you still need.`);break;}
      if(r!=='saved')break;
      if(!DL)await sleep(600);
      if(i===P.parts.length-1){
        try{await saveFile(orderListName(P),new Blob([orderListText(P)],{type:'text/plain'}));note('All parts saved, plus the order list.','good');}
        catch(e){note('All parts saved.','good');}
      }
    }
  }finally{S.busy=false;setBar('#buildBar','#buildBarWrap',null);renderPlan();}
}
function orderListName(P){return (P.raw?(P.sources.length===1?P.sources[0].name:'files'):S.base)+(P.raw?'-pieces.txt':'-order-list.txt');}
function orderListText(P){
  const tot=P.parts.length,w=String(tot).length,L=[];
  L.push('FILE SPLITER · ORDER LIST','');
  if(P.raw){
    L.push(`Pieces: ${tot}   Largest piece: ${fmtBytes(Math.max(...P.parts.map(p=>p.bytes)))}`,'','Keep every piece. Put them back in this order:','');
    for(const p of P.parts)L.push(`  ${pad(p.n,w)} of ${tot}   ${p.filename}   ${fmtBytes(p.bytes)}`);
    L.push('','How to put the file back together','  1. Open File Spliter, choose Rejoin, add every piece (add this .txt too so they are checked).','  2. Or on your computer, in the folder that holds the pieces:');
    for(const x of P.sources){
      L.push(`       Windows (Command Prompt):  copy /b "${x.name}.*" "${x.name}"`,`       Mac or Linux (Terminal):   cat "${x.name}".* > "${x.name}"`);
    }
    L.push('');
    for(const x of P.sources)L.push(`#FS name=${encodeURIComponent(x.name)} size=${x.size} ${x.crc==null?'':'crc32='+hex(x.crc)+' '}pieces=${x.pieces} piece=${P.parts.find(p=>p.src===P.sources.indexOf(x)).bytes}`);
  }else{
    L.push(`Archive: ${P.base}`,`Parts: ${tot}   Files: ${S.items.length}`,'','Send or store the parts in this order:','');
    for(const p of P.parts){
      const a=base(p.items[0].path),z=base(p.items[p.items.length-1].path);
      L.push(`  ${pad(p.n,w)} of ${tot}   ${p.filename}   ${fmtBytes(p.blob?p.blob.size:p.bytes)}   ${p.items.length} file${p.items.length===1?'':'s'}${p.items.length>1?`   ${a} to ${z}`:`   ${a}`}`);
    }
    L.push('','How to put it back together','  1. Open File Spliter and choose Rejoin.','  2. Add every part zip, in any order.','  3. Choose Merge parts. Missing parts are flagged first.');
  }
  return L.join('\n')+'\n';
}
async function saveOrderList(){
  const P=S.plan;if(!P||!P.parts.length)return;
  try{await saveFile(orderListName(P),new Blob([orderListText(P)],{type:'text/plain'}));note('Saved the order list.','good');}
  catch(e){note(e&&e.code==='declined'?'Save cancelled.':'Could not save the order list: '+((e&&e.message)||'error'),'bad');}
}
$('#buildBtn').onclick=createParts;
$('#saveAllBtn').onclick=saveAll;

/* ---------- image conversion ---------- */
async function convertBlob(blob,o){
  const bmp=await createImageBitmap(blob);
  let w=bmp.width,h=bmp.height;
  if(o.max>0&&Math.max(w,h)>o.max){const k=o.max/Math.max(w,h);w=Math.max(1,Math.round(w*k));h=Math.max(1,Math.round(h*k));}
  const c=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(w,h):Object.assign(document.createElement('canvas'),{width:w,height:h});
  const g=c.getContext('2d');
  if(o.fmt==='jpeg'){g.fillStyle='#fff';g.fillRect(0,0,w,h);}
  g.drawImage(bmp,0,0,w,h);if(bmp.close)bmp.close();
  const mime={webp:'image/webp',jpeg:'image/jpeg',png:'image/png'}[o.fmt];
  const out=c.convertToBlob?await c.convertToBlob({type:mime,quality:o.q/100}):await new Promise(r=>c.toBlob(r,mime,o.q/100));
  return out&&out.type===mime?out:null;
}
async function runOptimize(){
  if(S.busy)return;
  const src=S.origItems||S.items;
  const imgs=src.filter(it=>/^(png|jpe?g|webp)$/.test(it.ext));
  if(!imgs.length){$('#optStat').textContent='There are no PNG, JPG or WebP images to convert.';return;}
  S.busy=true;renderPlan();
  const o={...S.opt};if(!S.origItems)S.origItems=S.items.slice();
  const extOf={webp:'webp',jpeg:'jpg',png:'png'}[o.fmt];
  const used=new Set(src.filter(i=>!imgs.includes(i)).map(i=>i.path));
  const next=[];let before=0,after=0,changed=0,failed=0,done=0;
  try{
    for(const it of src){
      if(!imgs.includes(it)){next.push(it);continue;}
      before+=it.packed;let kept=it;
      try{
        const out=await convertBlob(await getUncompressed(it),o);
        if(out&&out.size<it.packed){
          const path=uniquePath(it.path.replace(/\.[^./]+$/,'')+'.'+extOf,used);
          kept=mkItem('blob',{blob:out,path,size:out.size,packed:out.size,time:it.time,date:it.date});changed++;
        }else{used.add(it.path);}
      }catch(e){failed++;used.add(it.path);}
      after+=kept.packed;next.push(kept);
      if(++done%4===0){setBar('#optBar','#optBarWrap',done/imgs.length);await sleep(0);}
    }
    S.items=next;
    $('#optStat').textContent=`Converted ${changed} of ${imgs.length} images${failed?` (${failed} could not be read)`:''}. ${fmtBytes(before)} became ${fmtBytes(after)}${before?` (${Math.round((1-after/before)*100)}% smaller)`:''}.`;
  }finally{S.busy=false;setBar('#optBar','#optBarWrap',null);replan();}
}
$('#optRun').onclick=runOptimize;
$('#optReset').onclick=()=>{if(!S.origItems)return;S.items=S.origItems;S.origItems=null;$('#optStat').textContent='Original images restored.';replan();};

/* ---------- rejoin ---------- */
const J={srcs:[],raw:[],lists:[],busy:false};
const CHUNK=/^(.*)\.part(\d{3,})$/;
function jnote(m){const n=$('#jNote');n.hidden=!m;n.textContent=m||'';}
async function jAdd(files){
  jnote('');const errs=[];
  for(const f of files){
    const dup=x=>x.name===f.name&&x.size===f.size;
    if(J.srcs.some(x=>dup(x.file))||J.raw.some(dup))continue;
    if(/\.txt$/i.test(f.name)){
      if(f.size>2e6){errs.push(`${f.name}: too large to be an order list.`);continue;}
      const meta=parseOrderList(await f.text());
      if(meta.length)J.lists.push(...meta);else errs.push(`${f.name} is not a File Spliter order list, so it was ignored.`);
      continue;
    }
    if(RAWPIECE.test(f.name)&&!/\.zip$/i.test(f.name)){J.raw.push(f);continue;}
    try{
      const ens=await readZip(f),me=ens.find(e=>e.name===MANIFEST);let man=null;
      if(me){try{const raw=await entryRaw(f,me);man=JSON.parse(await (me.method===8?await inflateBlob(raw):raw).text());}catch(e){}}
      J.srcs.push({file:f,entries:ens.filter(e=>!e.dir&&e.name!==MANIFEST),manifest:man});
    }catch(err){errs.push(`${f.name}: ${err.message}`);}
  }
  if(errs.length)jnote(errs.join(' '));
  renderJoin();
}
function analyzeRaw(){
  const groups=groupRaw(J.raw.map(f=>({name:f.name,size:f.size,file:f}))),problems=[],ok=[];
  for(const g of groups){
    const meta=J.lists.find(m=>m.name===g.base)||null;
    if(!meta&&g.count===1&&g.max>1){problems.push(`${g.base}.${String(g.max).padStart(3,'0')} does not look like a piece of a split file.`);g.skip=true;continue;}
    g.meta=meta;
    const want=meta&&meta.pieces?meta.pieces:g.max;
    const miss=[];for(let i=1;i<=want&&miss.length<50;i++)if(!g.pieces.has(i))miss.push(i);
    if(miss.length)problems.push(`${g.base} is missing piece${miss.length>1?'s':''} ${miss.slice(0,12).join(', ')}${miss.length>12?'…':''} of ${want}.`);
    if(g.odd.length)problems.push(`${g.base}: pieces ${g.odd.slice(0,6).join(', ')} are a different size from the first. They may be damaged or from another split.`);
    if(meta&&meta.size&&!miss.length&&g.size!==meta.size)problems.push(`${g.base}: the pieces add up to ${fmtBytes(g.size)}, but the original was ${fmtBytes(meta.size)}.`);
    g.complete=!miss.length;
  }
  return {groups:groups.filter(g=>!g.skip),problems};
}
function analyze(){
  const mans=J.srcs.map(s=>s.manifest).filter(Boolean);
  const total=mans.reduce((a,m)=>Math.max(a,m.totalParts||0),0);
  const have=new Set(mans.map(m=>m.part));
  const missingParts=[];for(let i=1;i<=total;i++)if(!have.has(i))missingParts.push(i);
  const chunkNames=new Set();
  for(const m of mans)for(const f of m.files||[])if(f.chunk)chunkNames.add(f.name);
  const plain=[],series=new Map(),seen=new Set(),problems=[];
  for(const s of J.srcs)for(const en of s.entries){
    const m=CHUNK.exec(en.name);
    if(m&&(chunkNames.size?chunkNames.has(m[1]):true)){
      if(!series.has(m[1]))series.set(m[1],new Map());
      series.get(m[1]).set(+m[2],{s,en});
    }else if(!seen.has(en.name)){seen.add(en.name);plain.push({s,en});}
  }
  const expected=new Map();
  for(const m of mans)for(const f of m.files||[])if(f.chunk)expected.set(f.name,+f.chunk.split('/')[1]);
  for(const [name,map] of series){
    const n=expected.get(name)||Math.max(...map.keys());
    const miss=[];for(let i=1;i<=n;i++)if(!map.has(i))miss.push(i);
    if(miss.length)problems.push(`${name} is missing piece${miss.length>1?'s':''} ${miss.join(', ')} of ${n}.`);
  }
  if(missingParts.length)problems.push(`Missing part${missingParts.length>1?'s':''} ${missingParts.join(', ')} of ${total}.`);
  const R=analyzeRaw();
  return {mans,total,have,missingParts,plain,series,problems:problems.concat(R.problems),raw:R.groups,archive:(mans[0]&&mans[0].archive)||'restored'};
}
function renderJoin(){
  const el=$('#jSummary');
  if(!J.srcs.length&&!J.raw.length){$('#jFootSummary').textContent='Add the parts';el.innerHTML=`<div class="empty"><b>No parts yet</b><br>Add the zips or numbered pieces you made with Split. Missing parts are flagged before you merge.</div>`;return;}
  const A=analyze();
  const files=A.plain.length+A.series.size+A.raw.length;
  const pieces=A.raw.reduce((a,g)=>a+g.count,0);
  $('#jFootSummary').innerHTML=`<b>${J.srcs.length+pieces}</b> part${J.srcs.length+pieces===1?'':'s'}${A.total&&!A.raw.length?' of '+A.total:''} · <b>${files.toLocaleString()}</b> file${files===1?'':'s'}${A.problems.length?' · needs attention':''}`;
  const chips=`<div class="chips">${J.srcs.length?`<span class="chip">${J.srcs.length} zip${J.srcs.length===1?'':'s'}${A.total?` of ${A.total}`:''}</span>`:''}${pieces?`<span class="chip">${pieces} raw piece${pieces===1?'':'s'}</span>`:''}<span class="chip">${files.toLocaleString()} file${files===1?'':'s'}</span>${A.series.size?`<span class="chip">${A.series.size} rebuilt from pieces</span>`:''}</div>`;
  const okMsg=J.srcs.length&&A.mans.length?'Every part is here.':J.srcs.length?'No manifest found. Pieces will be joined by their .partNNN order.':'Every piece is here.';
  const probs=A.problems.length?`<ul class="warns" style="margin-top:12px">${A.problems.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>`:`<div class="note good" style="margin-top:12px">${okMsg}</div>`;
  const zl=J.srcs.map(s=>`<li><span>${esc(s.file.name)}</span><span>${s.manifest?'part '+s.manifest.part+' · ':''}${s.entries.length} files · ${fmtBytes(s.file.size)}</span></li>`);
  const rl=A.raw.map(g=>`<li><span>${esc(g.base)}</span><span>${g.count}${g.meta&&g.meta.pieces?' of '+g.meta.pieces:g.max>g.count?' of '+g.max:''} pieces · ${fmtBytes(g.size)}${g.meta&&g.meta.crc32?' · checksum ready':''}</span></li>`);
  el.innerHTML=chips+probs+`<ul class="list">${zl.concat(rl).join('')}</ul>`;
}
function jStat(m,f){$('#jStat').textContent=m;setBar('#jBar','#jBarWrap',f==null?null:f);}
async function jVerify(){
  if(J.busy||(!J.srcs.length&&!J.raw.length))return;J.busy=true;
  let totalBytes=0,done=0,bad=[],count=0;
  for(const s of J.srcs)for(const e of s.entries)totalBytes+=e.comp;
  try{
    for(const s of J.srcs){
      const mf=new Map(((s.manifest&&s.manifest.files)||[]).map(f=>[f.name+(f.chunk?'':''),f]));
      for(const en of s.entries){
        const raw=await entryRaw(s.file,en);
        let unc;
        if(en.method===0)unc=raw;else if(en.method===8)unc=await inflateBlob(raw);else{bad.push(en.name+' (unknown compression)');continue;}
        const crc=await crcOfBlob(unc);
        if(crc!==en.crc)bad.push(en.name);
        count++;done+=en.comp;jStat(`Checking ${count} files…`,totalBytes?done/totalBytes:1);
        await sleep(0);
      }
    }
    const R=analyze().raw.filter(g=>g.complete),rawMsg=[];
    let rawTotal=R.reduce((a,g)=>a+g.size,0),rawDone=0;
    for(const g of R){
      let c=0xFFFFFFFF;
      for(const i of g.order){
        const rd=g.pieces.get(i).file.stream().getReader();
        for(;;){const x=await rd.read();if(x.done)break;c=crcUpdate(c,x.value);rawDone+=x.value.length;jStat(`Checking ${g.base}…`,rawDone/Math.max(1,rawTotal));}
      }
      const got=hex((c^0xFFFFFFFF)>>>0);
      if(g.meta&&g.meta.crc32)rawMsg.push(got===g.meta.crc32?`${g.base}: checksum matches the original.`:`${g.base}: checksum does NOT match (got ${got}, expected ${g.meta.crc32}).`);
      else rawMsg.push(`${g.base}: CRC32 ${got}. Add the order list (.txt) to compare it automatically.`);
    }
    const zipMsg=J.srcs.length?(bad.length?`${bad.length} file${bad.length>1?'s':''} failed the checksum: ${bad.slice(0,5).join(', ')}${bad.length>5?'…':''}`:`All ${count} zip files passed the checksum check.`):'';
    jStat([zipMsg].concat(rawMsg).filter(Boolean).join(' ')||'Nothing to check yet.',null);
  }catch(err){jStat('Verify stopped: '+err.message,null);}
  finally{J.busy=false;}
}
async function jMerge(){
  if(J.busy||(!J.srcs.length&&!J.raw.length))return;
  const A=analyze();
  if(A.problems.length){jStat('Fix the problems listed on the right first. '+A.problems[0],null);return;}
  J.busy=true;
  try{
    const msgs=[];
    for(const g of A.raw){
      const whole=new Blob(g.order.map(i=>g.pieces.get(i).file));
      try{await saveFile(g.base,whole);msgs.push(`Joined ${g.count} pieces into ${g.base} (${fmtBytes(whole.size)}).`);}
      catch(e){msgs.push(e&&e.code==='declined'?'Save cancelled.':e&&e.code==='unavailable'?`${g.base} joined, but saving is not available in this view.`:'Could not save '+g.base+': '+((e&&e.message)||'error'));}
    }
    if(!J.srcs.length){jStat(msgs.join(' '),null);return;}
    const zw=new ZipWriter();let i=0;const n=A.plain.length+A.series.size;
    for(const {s,en} of A.plain){
      zw.add(en.name,{method:en.method,crc:en.crc,comp:en.comp,size:en.size,data:await entryRaw(s.file,en),time:en.time,date:en.date});
      if(++i%10===0){jStat(`Merging ${i} of ${n}…`,i/n);await sleep(0);}
    }
    for(const [name,map] of A.series){
      const blobs=[];
      for(const k of [...map.keys()].sort((a,b)=>a-b)){
        const {s,en}=map.get(k),raw=await entryRaw(s.file,en);
        blobs.push(en.method===0?raw:await inflateBlob(raw));
      }
      const whole=new Blob(blobs),first=map.get(Math.min(...map.keys())).en;
      zw.add(name,{method:0,crc:await crcOfBlob(whole),comp:whole.size,size:whole.size,data:whole,time:first.time,date:first.date});
      jStat(`Merging ${++i} of ${n}…`,i/n);await sleep(0);
    }
    const out=zw.finish(),fname=`${A.archive}-restored.zip`;
    try{await saveFile(fname,out);jStat(msgs.concat(`Merged ${n} files into ${fname} (${fmtBytes(out.size)}).`).join(' '),null);}
    catch(e){jStat(e&&e.code==='declined'?'Save cancelled.':e&&e.code==='unavailable'?'Merged, but saving is not available in this view.':'Could not save: '+((e&&e.message)||'error'),null);}
  }catch(err){jStat('Merge failed: '+err.message,null);}
  finally{J.busy=false;}
}
$('#jPick').onclick=()=>$('#jIn').click();
$('#jIn').onchange=e=>{jAdd([...e.target.files]);e.target.value='';};
$('#jClear').onclick=()=>{J.srcs=[];J.raw=[];J.lists=[];jnote('');jStat('',null);renderJoin();};
$('#jVerify').onclick=jVerify;
$('#jMerge').onclick=jMerge;



/* ---------- start ---------- */
$('#pattern').value=S.cfg.pattern;
syncControls();renderPlan();renderJoin();
window.FSTool={state:S,addFiles};
getDL();
})();
