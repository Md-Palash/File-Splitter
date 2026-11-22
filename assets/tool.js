/* File Spliter: split and rejoin logic. Needs core.js. Everything runs in the browser. */
(function(){
'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const UNIT={KB:1e3,MB:1e6,GB:1e9};
const S={items:[],sample:false,base:'files',skipped:[],origItems:null,plan:null,busy:false,open:new Set(),
  cfg:{value:25,unit:'MB',mode:'size',count:50,fit:false,compress:'keep',split:true,manifest:true,pattern:'{name}-part-{n}-of-{total}'},
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
    S.plan=planParts(S.items,{limit:limitBytes(),mode:S.cfg.mode,count:S.cfg.count,fit:S.cfg.fit,split:S.cfg.split,manifest:S.cfg.manifest,pattern:S.cfg.pattern,base:S.base});
    renderStats();renderPlan();
  });
}
function renderStats(){
  const orig=S.items.reduce((a,i)=>a+i.size,0),pack=S.items.reduce((a,i)=>a+i.packed,0);
  $('#stFiles').textContent=S.items.length.toLocaleString();
  $('#stOrig').textContent=fmtBytes(orig);
  $('#stPack').textContent=fmtBytes(pack);
  $('#sampleBanner').hidden=!S.sample;
  $('#patHint').textContent=S.plan&&S.plan.parts.length?'First part: '+S.plan.parts[0].filename:'Tokens: {name}  {n}  {total}';
}
function partCard(p,lim){
  const pct=Math.min(100,Math.round(p.bytes/lim*100));
  const built=!!p.blob;
  const status=p.error?`<span class="tag bad">Failed</span>`:built?(p.over?`<span class="tag bad">Over limit</span>`:p.ok?`<span class="tag good">Ready</span>`:`<span class="tag bad">Check failed</span>`):(p.over?`<span class="tag bad">Over limit</span>`:`<span class="tag">Estimate</span>`);
  const open=S.open.has(p.n);
  const rows=open?p.items.slice(0,300).map(it=>`<li><span>${esc(it.path)}</span><span>${fmtBytes(it.packed)}</span></li>`).join('')+(p.items.length>300?`<li><span>+${p.items.length-300} more</span><span></span></li>`:''):'';
  return `<article class="part" id="part-${p.n}">
    <div class="top2"><span class="no">Part ${p.n}</span><span class="sz">${fmtBytes(built?p.blob.size:p.bytes)}</span></div>
    <div class="fillbar ${p.over?'over':''}"><i data-w="${pct}"></i></div>
    <div class="meta"><span>${p.items.length.toLocaleString()} file${p.items.length===1?'':'s'}${p.group?' · '+esc(p.group):''}</span>${status}</div>
    <div class="nm">${esc(p.filename)}</div>
    <details data-n="${p.n}" ${open?'open':''}><summary>Show files</summary><ul class="files">${rows}</ul></details>
    <div class="pills"><button class="pill" data-save="${p.n}" ${built&&p.ok?'':'disabled'}>${p.saved?'Save again':'Save'}</button></div>
  </article>`;
}
function renderPlan(){
  const el=$('#plan'),P=S.plan;
  if(!S.items.length||!P){
    el.innerHTML=`<div class="empty"><b>No files yet</b><br>Add a zip, images or a folder to see how it will be split.</div>`;
    $('#buildBtn').disabled=true;$('#saveAllBtn').disabled=true;$('#footSummary').textContent='Add files to begin';return;
  }
  const lim=limitBytes(),built=P.parts.length&&P.parts.every(p=>p.blob&&p.ok);
  const sum=P.parts.reduce((a,p)=>a+(p.blob?p.blob.size:p.bytes),0);
  $('#buildBtn').disabled=S.busy||!P.parts.length;
  $('#buildBtn').textContent=built?'Rebuild parts':'Create parts';
  $('#saveAllBtn').disabled=S.busy||!built;
  const chips=`<div class="chips"><span class="chip">${P.parts.length} part${P.parts.length===1?'':'s'}</span><span class="chip">${S.items.length.toLocaleString()} files</span><span class="chip">${built?'':'about '}${fmtBytes(sum)} total</span>${S.cfg.mode==='count'?'':`<span class="chip">limit ${fmtBytes(lim)}</span>`}</div>`;
  const warns=P.warnings.length?`<ul class="warns">${P.warnings.slice(0,6).map(w=>`<li>${esc(w)}</li>`).join('')}${P.warnings.length>6?`<li>+${P.warnings.length-6} more notes</li>`:''}</ul>`:'';
  $('#footSummary').innerHTML=`<b>${P.parts.length}</b> part${P.parts.length===1?'':'s'} · ${built?'':'about '}<b>${fmtBytes(sum)}</b>`;
  el.innerHTML=chips+warns+`<div class="parts">${P.parts.map(p=>partCard(p,S.cfg.mode==='count'?Math.max(...P.parts.map(x=>x.bytes)):lim)).join('')}</div>`;
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
$('#clearAll').onclick=()=>{S.items=[];S.sample=false;S.skipped=[];S.origItems=null;S.base='files';srcNote('');note('');replan();};

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
  S.items=makeSample();S.sample=true;S.base='sample';S.origItems=null;srcNote('');replan();openDrawer('split');
};

/* ---------- build and save ---------- */
function setBar(id,wrap,f){$(wrap).hidden=f==null;if(f!=null)$(id).style.width=Math.round(f*100)+'%';}
async function createParts(){
  const P=S.plan;if(S.busy||!P||!P.parts.length)return;
  S.busy=true;note('');
  for(const p of P.parts){delete p.blob;delete p.ok;delete p.saved;}
  renderPlan();
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
      if(i===P.parts.length-1)note('All parts saved.','good');
    }
  }finally{S.busy=false;setBar('#buildBar','#buildBarWrap',null);renderPlan();}
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
const J={srcs:[],busy:false};
const CHUNK=/^(.*)\.part(\d{3,})$/;
function jnote(m){const n=$('#jNote');n.hidden=!m;n.textContent=m||'';}
async function jAdd(files){
  jnote('');const errs=[];
  for(const f of files){
    if(J.srcs.some(s=>s.file.name===f.name&&s.file.size===f.size))continue;
    try{
      const ens=await readZip(f),me=ens.find(e=>e.name===MANIFEST);let man=null;
      if(me){try{const raw=await entryRaw(f,me);man=JSON.parse(await (me.method===8?await inflateBlob(raw):raw).text());}catch(e){}}
      J.srcs.push({file:f,entries:ens.filter(e=>!e.dir&&e.name!==MANIFEST),manifest:man});
    }catch(err){errs.push(`${f.name}: ${err.message}`);}
  }
  if(errs.length)jnote(errs.join(' '));
  renderJoin();
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
  return {mans,total,have,missingParts,plain,series,problems,archive:(mans[0]&&mans[0].archive)||'restored'};
}
function renderJoin(){
  const el=$('#jSummary');
  if(!J.srcs.length){$('#jFootSummary').textContent='Add the part zips';el.innerHTML=`<div class="empty"><b>No parts yet</b><br>Add the zips you made with Split. Missing parts are flagged before you merge.</div>`;return;}
  const A=analyze();
  const files=A.plain.length+A.series.size;
  $('#jFootSummary').innerHTML=`<b>${J.srcs.length}</b> zip${J.srcs.length===1?'':'s'}${A.total?' of '+A.total:''} · <b>${files.toLocaleString()}</b> files${A.problems.length?' · needs attention':''}`;
  const chips=`<div class="chips"><span class="chip">${J.srcs.length} zip${J.srcs.length===1?'':'s'}${A.total?` of ${A.total}`:''}</span><span class="chip">${files.toLocaleString()} files</span>${A.series.size?`<span class="chip">${A.series.size} rebuilt from pieces</span>`:''}</div>`;
  const probs=A.problems.length?`<ul class="warns" style="margin-top:12px">${A.problems.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>`:`<div class="note good" style="margin-top:12px">${A.mans.length?'Every part is here.':'No manifest found. Pieces will be joined by their .partNNN order.'}</div>`;
  el.innerHTML=chips+probs+`<ul class="list">${J.srcs.map(s=>`<li><span>${esc(s.file.name)}</span><span>${s.manifest?'part '+s.manifest.part+' · ':''}${s.entries.length} files · ${fmtBytes(s.file.size)}</span></li>`).join('')}</ul>`;
}
function jStat(m,f){$('#jStat').textContent=m;setBar('#jBar','#jBarWrap',f==null?null:f);}
async function jVerify(){
  if(J.busy||!J.srcs.length)return;J.busy=true;
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
    jStat(bad.length?`${bad.length} file${bad.length>1?'s':''} failed the checksum: ${bad.slice(0,5).join(', ')}${bad.length>5?'…':''}`:`All ${count} files passed the checksum check.`,null);
  }catch(err){jStat('Verify stopped: '+err.message,null);}
  finally{J.busy=false;}
}
async function jMerge(){
  if(J.busy||!J.srcs.length)return;
  const A=analyze();
  if(A.problems.length){jStat('Fix the problems listed on the right first. '+A.problems[0],null);return;}
  J.busy=true;
  try{
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
    try{await saveFile(fname,out);jStat(`Merged ${n} files into ${fname} (${fmtBytes(out.size)}).`,null);}
    catch(e){jStat(e&&e.code==='declined'?'Save cancelled.':e&&e.code==='unavailable'?'Merged, but saving is not available in this view.':'Could not save: '+((e&&e.message)||'error'),null);}
  }catch(err){jStat('Merge failed: '+err.message,null);}
  finally{J.busy=false;}
}
$('#jPick').onclick=()=>$('#jIn').click();
$('#jIn').onchange=e=>{jAdd([...e.target.files]);e.target.value='';};
$('#jClear').onclick=()=>{J.srcs=[];jnote('');jStat('',null);renderJoin();};
$('#jVerify').onclick=jVerify;
$('#jMerge').onclick=jMerge;



/* ---------- start ---------- */
$('#pattern').value=S.cfg.pattern;
syncControls();renderPlan();renderJoin();
window.FSTool={state:S,addFiles};
getDL();
})();
