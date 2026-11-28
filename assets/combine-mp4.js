/* File Spliter: lossless MP4 / MOV joiner. No DOM access, so Node tests can run it.
   It does not decode or re-encode anything: it reads each file's index (the "moov" box), checks that the files
   use identical track formats, and writes one new index that points at the original picture and sound data.
   Only the index is held in memory; the media data is copied by the browser straight from the files. */
var CombineMp4=(function(){
'use strict';
const u32=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const u64=(b,o)=>u32(b,o)*4294967296+u32(b,o+4);
const typ=(b,o)=>String.fromCharCode(b[o],b[o+1],b[o+2],b[o+3]);
function put32(b,o,v){b[o]=v>>>24;b[o+1]=(v>>>16)&255;b[o+2]=(v>>>8)&255;b[o+3]=v&255;}
function put64(b,o,v){put32(b,o,Math.floor(v/4294967296));put32(b,o+4,v>>>0);}
function err(kind,msg){const e=new Error(msg);e.kind=kind;return e;}
const CONTAINERS={moov:1,trak:1,mdia:1,minf:1,stbl:1};

/* child boxes of b[start..end) */
function boxes(b,start,end){
  const out=[];let p=start;
  while(p+8<=end){
    let size=u32(b,p),hs=8;const t=typ(b,p+4);
    if(size===1){if(p+16>end)break;size=u64(b,p+8);hs=16;}
    else if(size===0)size=end-p;
    if(size<hs||p+size>end)break;
    out.push({type:t,start:p,hs,end:p+size});
    p+=size;
  }
  return out;
}
const find=(b,list,t)=>list.find(x=>x.type===t);
const kids=(b,box)=>boxes(b,box.start+box.hs,box.end);

/* top-level layout of a file, reading only box headers */
async function scan(rd,name){
  const top=[];let p=0;
  while(p+8<=rd.size){
    const h=await rd.read(p,Math.min(16,rd.size-p));
    let size=u32(h,0),hs=8;const t=typ(h,4);
    if(size===1){if(h.length<16)break;size=u64(h,8);hs=16;}
    else if(size===0)size=rd.size-p;
    if(size<hs||p+size>rd.size)break;
    top.push({type:t,start:p,hs,end:p+size});
    p+=size;
  }
  const moov=top.find(x=>x.type==='moov');
  const mdats=top.filter(x=>x.type==='mdat');
  if(!moov||!mdats.length)throw err('unsupported',name+' is not a standard MP4 or MOV file that can be joined without re-encoding.');
  if(top.some(x=>x.type==='moof'))throw err('unsupported',name+' is a fragmented MP4 (streaming style), which cannot be joined without re-encoding.');
  if(mdats.length>1)throw err('unsupported',name+' stores its media in several pieces, which cannot be joined without re-encoding.');
  return {ftyp:top.find(x=>x.type==='ftyp')||null,moov,mdat:mdats[0]};
}

/* The sample description says which codec and settings a track uses. Bitrate figures inside it ("btrt", and the
   bitrate fields of an "esds") differ from clip to clip without changing how the data is decoded, so they are blanked
   before two descriptions are compared. */
function fingerprint(src){
  const b=Uint8Array.from(src);
  for(let i=4;i+16<=b.length;i++){
    if(b[i]===0x62&&b[i+1]===0x74&&b[i+2]===0x72&&b[i+3]===0x74&&u32(b,i-4)===20){for(let k=i+4;k<i+16;k++)b[k]=0;}
    if(b[i]===0x65&&b[i+1]===0x73&&b[i+2]===0x64&&b[i+3]===0x73){ // esds: find the 0x04 DecoderConfig descriptor
      for(let j=i+8;j+18<b.length&&j<i+40;j++){
        if(b[j]===0x04){let q=j+1;while(b[q]&0x80)q++;q++; // skip length bytes
          // objectType(1) streamType(1) bufferSize(3) maxBitrate(4) avgBitrate(4)
          for(let k=q+5;k<q+13&&k<b.length;k++)b[k]=0;break;}
      }
    }
  }
  return Array.from(b).join(',');
}

/* ---------- reading one file's index ---------- */
function parseTrack(b,trak,name){
  const t=kids(b,trak);
  const tkhd=find(b,t,'tkhd'),mdia=find(b,t,'mdia');
  if(!tkhd||!mdia)throw err('unsupported',name+' has a damaged track index.');
  const m=kids(b,mdia),mdhd=find(b,m,'mdhd'),hdlr=find(b,m,'hdlr'),minf=find(b,m,'minf');
  if(!mdhd||!hdlr||!minf)throw err('unsupported',name+' has a damaged track index.');
  const stbl=find(b,kids(b,minf),'stbl');if(!stbl)throw err('unsupported',name+' has a damaged track index.');
  const s=kids(b,stbl),g=x=>find(b,s,x);
  const stsd=g('stsd'),stts=g('stts'),stsc=g('stsc'),stsz=g('stsz'),stco=g('stco')||g('co64');
  if(!stsd||!stts||!stsc||!stsz||!stco)throw err('unsupported',name+' has an incomplete track index.');
  const pay=bx=>bx.start+bx.hs;
  const v1=b[pay(mdhd)]===1;
  const timescale=u32(b,pay(mdhd)+(v1?20:12));
  const mdhdDur=v1?u64(b,pay(mdhd)+24):u32(b,pay(mdhd)+16);
  const tv1=b[pay(tkhd)]===1;
  const tw=u32(b,tkhd.end-8)>>>16,th=u32(b,tkhd.end-4)>>>16;
  void tv1;
  /* tables */
  const T={};
  let o=pay(stts);let n=u32(b,o+4);T.stts=[];for(let i=0;i<n;i++)T.stts.push([u32(b,o+8+i*8),u32(b,o+12+i*8)]);
  o=pay(stsc);n=u32(b,o+4);T.stsc=[];for(let i=0;i<n;i++)T.stsc.push([u32(b,o+8+i*12),u32(b,o+12+i*12),u32(b,o+16+i*12)]);
  o=pay(stsz);const fixed=u32(b,o+4);n=u32(b,o+8);T.count=n;T.size=fixed;
  if(!fixed){T.sizes=new Uint32Array(n);for(let i=0;i<n;i++)T.sizes[i]=u32(b,o+12+i*4);}
  o=pay(stco);n=u32(b,o+4);T.chunks=new Array(n);
  if(stco.type==='stco')for(let i=0;i<n;i++)T.chunks[i]=u32(b,o+8+i*4);else for(let i=0;i<n;i++)T.chunks[i]=u64(b,o+8+i*8);
  const ctts=g('ctts');
  if(ctts){o=pay(ctts);n=u32(b,o+4);T.cttsVer=b[o];T.ctts=[];for(let i=0;i<n;i++)T.ctts.push([u32(b,o+8+i*8),u32(b,o+12+i*8)]);}
  const stss=g('stss');
  if(stss){o=pay(stss);n=u32(b,o+4);T.stss=new Array(n);for(let i=0;i<n;i++)T.stss[i]=u32(b,o+8+i*4);}
  return {
    handler:typ(b,pay(hdlr)+8),timescale,mdhdDur,w:tw,h:th,
    stsd:fingerprint(b.subarray(stsd.start,stsd.end)),
    T,box:trak
  };
}
function parseMoov(b,name){
  const moov={start:0,hs:u32(b,0)===1?16:8,end:b.length,type:'moov'};
  const c=kids(b,moov);
  if(c.some(x=>x.type==='mvex'))throw err('unsupported',name+' is a fragmented MP4 (streaming style), which cannot be joined without re-encoding.');
  const mvhd=find(b,c,'mvhd');if(!mvhd)throw err('unsupported',name+' has a damaged index.');
  const v1=b[mvhd.start+mvhd.hs]===1;
  const ts=u32(b,mvhd.start+mvhd.hs+(v1?20:12));
  const tracks=c.filter(x=>x.type==='trak').map(t=>parseTrack(b,t,name));
  if(!tracks.length)throw err('unsupported',name+' has no tracks.');
  return {movieTimescale:ts,tracks};
}

/* ---------- strategy decision ----------
   infos: [{name, tracks:[{handler,timescale,w,h,stsd}]}]
   Returns {strategy:'remux'} when every file has the same tracks in the same format, otherwise
   {strategy:'reencode', reason} (this build has no encoder, so the caller reports the reason). */
function plan(infos){
  if(infos.length<2)return {strategy:'remux'};
  const a=infos[0];
  for(let i=1;i<infos.length;i++){
    const b=infos[i];
    if(a.tracks.length!==b.tracks.length)return {strategy:'reencode',reason:b.name+' has a different number of tracks (for example video only, or sound missing) than '+a.name+'.',file:b.name};
    for(let t=0;t<a.tracks.length;t++){
      const x=a.tracks[t],y=b.tracks[t];
      if(x.handler!==y.handler)return {strategy:'reencode',reason:b.name+' has its tracks in a different order than '+a.name+'.',file:b.name};
      const kind=x.handler==='vide'?'video':x.handler==='soun'?'audio':'data';
      if(x.handler==='vide'&&(x.w!==y.w||x.h!==y.h))return {strategy:'reencode',reason:b.name+' is '+y.w+'×'+y.h+' but '+a.name+' is '+x.w+'×'+x.h+'.',file:b.name};
      if(x.stsd!==y.stsd)return {strategy:'reencode',reason:b.name+' uses a different '+kind+' format (codec or settings) than '+a.name+'.',file:b.name};
      if(x.timescale!==y.timescale)return {strategy:'reencode',reason:b.name+' uses a different '+kind+' timing than '+a.name+'.',file:b.name};
    }
  }
  return {strategy:'remux'};
}
const sig=m=>m.tracks.map(t=>({handler:t.handler,timescale:t.timescale,w:t.w,h:t.h,stsd:t.stsd}));

/* ---------- writing ---------- */
const cat=arr=>{let n=0;for(const a of arr)n+=a.length;const o=new Uint8Array(n);let p=0;for(const a of arr){o.set(a,p);p+=a.length;}return o;};
function mk(type,payload){const o=new Uint8Array(8+payload.length);put32(o,0,o.length);for(let i=0;i<4;i++)o[4+i]=type.charCodeAt(i);o.set(payload,8);return o;}
function pairs(type,list,ver){ // stts / ctts
  const p=new Uint8Array(8+list.length*8);p[0]=ver||0;put32(p,4,list.length);
  list.forEach((e,i)=>{put32(p,8+i*8,e[0]);put32(p,12+i*8,e[1]);});return mk(type,p);
}
function mergePairs(lists){
  const out=[];
  for(const l of lists)for(const e of l){const last=out[out.length-1];if(last&&last[1]===e[1])last[0]+=e[0];else out.push([e[0],e[1]]);}
  return out;
}

/* Build the merged tables for every track. */
function mergeTables(metas,prefixes,mdatStarts,base){
  const nt=metas[0].tracks.length,res=[];
  for(let t=0;t<nt;t++){
    const parts=metas.map(m=>m.tracks[t].T);
    const R={};
    R.stts=mergePairs(parts.map(p=>p.stts));
    R.dur=metas.reduce((s,m)=>s+m.tracks[t].mdhdDur,0);
    if(parts.some(p=>p.ctts)){
      const first=parts.find(p=>p.ctts);R.cttsVer=first.cttsVer;
      R.ctts=mergePairs(parts.map(p=>p.ctts||[[p.count,0]]));
    }
    if(parts.some(p=>p.stss)){
      R.stss=[];let off=0;
      for(const p of parts){
        if(p.stss)for(const s of p.stss)R.stss.push(s+off);else for(let i=1;i<=p.count;i++)R.stss.push(i+off);
        off+=p.count;
      }
    }
    R.stsc=[];let chunkOff=0;
    for(const p of parts){for(const e of p.stsc)R.stsc.push([e[0]+chunkOff,e[1],e[2]]);chunkOff+=p.chunks.length;}
    R.count=parts.reduce((s,p)=>s+p.count,0);
    const uniform=parts.every(p=>p.size&&p.size===parts[0].size);
    if(uniform)R.size=parts[0].size;
    else{
      R.sizes=new Uint32Array(R.count);let k=0;
      for(const p of parts){for(let i=0;i<p.count;i++)R.sizes[k++]=p.size||p.sizes[i];}
    }
    R.chunks=[];
    parts.forEach((p,i)=>{for(const c of p.chunks){
      if(c<mdatStarts[i].payload||c>=mdatStarts[i].end)throw err('unsupported',metas[i].name+' has media data outside its main data block, so it cannot be joined without re-encoding.');
      R.chunks.push(base+prefixes[i]+(c-mdatStarts[i].payload));}});
    res.push(R);
  }
  return res;
}
function tablesBytes(R){
  const out=[pairs('stts',R.stts,0)];
  if(R.ctts)out.push(pairs('ctts',R.ctts,R.cttsVer||0));
  if(R.stss){const p=new Uint8Array(8+R.stss.length*4);put32(p,4,R.stss.length);R.stss.forEach((s,i)=>put32(p,8+i*4,s));out.push(mk('stss',p));}
  const sc=new Uint8Array(8+R.stsc.length*12);put32(sc,4,R.stsc.length);R.stsc.forEach((e,i)=>{put32(sc,8+i*12,e[0]);put32(sc,12+i*12,e[1]);put32(sc,16+i*12,e[2]);});out.push(mk('stsc',sc));
  const sz=new Uint8Array(12+(R.size?0:R.count*4));put32(sz,4,R.size||0);put32(sz,8,R.count);
  if(!R.size)for(let i=0;i<R.count;i++)put32(sz,12+i*4,R.sizes[i]);
  out.push(mk('stsz',sz));
  const co=new Uint8Array(8+R.chunks.length*8);put32(co,4,R.chunks.length);R.chunks.forEach((c,i)=>put64(co,8+i*8,c));out.push(mk('co64',co));
  return cat(out);
}
function setDur(b,box,v0,v1,value){ // patch a duration field in a copy of the box
  const o=box.start+box.hs,ver=b[o]===1;
  if(ver)put64(b,o+v1,value);else put32(b,o+v0,Math.min(value,4294967295));
}

function buildMoov(b0,meta0,R,movieDur){
  const root={start:0,hs:u32(b0,0)===1?16:8,end:b0.length,type:'moov'};
  let ti=0;
  const out=[];
  for(const c of kids(b0,root)){
    if(c.type==='trak'){out.push(buildTrak(b0,c,R[ti],meta0.tracks[ti],meta0.movieTimescale));ti++;}
    else if(c.type==='udta'||c.type==='meta'||c.type==='iods'){continue;}
    else if(c.type==='mvhd'){const cp=b0.slice(c.start,c.end);setDur(cp,{start:0,hs:c.hs},16,24,movieDur);out.push(cp);}
    else out.push(b0.slice(c.start,c.end));
  }
  return mk('moov',cat(out));
}
function buildTrak(b,trak,R,tmeta,movieTs){
  const out=[];
  const mediaDurInMovie=Math.round(R.dur*movieTs/tmeta.timescale);
  for(const c of kids(b,trak)){
    if(c.type==='edts'||c.type==='udta'||c.type==='meta')continue;
    if(c.type==='tkhd'){const cp=b.slice(c.start,c.end);setDur(cp,{start:0,hs:c.hs},20,28,mediaDurInMovie);out.push(cp);}
    else if(c.type==='mdia')out.push(mk('mdia',cat(kids(b,c).map(m=>{
      if(m.type==='mdhd'){const cp=b.slice(m.start,m.end);setDur(cp,{start:0,hs:m.hs},16,24,R.dur);return cp;}
      if(m.type==='minf')return mk('minf',cat(kids(b,m).map(x=>x.type==='stbl'?buildStbl(b,x,R):b.slice(x.start,x.end))));
      return b.slice(m.start,m.end);
    }))));
    else out.push(b.slice(c.start,c.end));
  }
  return mk('trak',cat(out));
}
function buildStbl(b,stbl,R){
  const stsd=kids(b,stbl).find(x=>x.type==='stsd');
  return mk('stbl',cat([b.slice(stsd.start,stsd.end),tablesBytes(R)]));
}

/* readers: [{name,size,read(start,len)->Promise<Uint8Array>}]
   Returns {parts:[{bytes}|{src,start,end}], size, info}. parts are written in order to make the output file. */
async function merge(readers,onProgress){
  const metas=[],layouts=[],moovBytes=[];
  for(let i=0;i<readers.length;i++){
    const rd=readers[i],lay=await scan(rd,rd.name);
    const mb=await rd.read(lay.moov.start,lay.moov.end-lay.moov.start);
    const m=parseMoov(mb,rd.name);m.name=rd.name;
    metas.push(m);layouts.push(lay);moovBytes.push(mb);
    if(onProgress)onProgress(0.5*(i+1)/readers.length,i);
  }
  const verdict=plan(metas.map(m=>({name:m.name,tracks:sig(m)})));
  if(verdict.strategy!=='remux'){const e=err('incompatible',verdict.reason);e.verdict=verdict;throw e;}
  const mdatStarts=layouts.map(l=>({payload:l.mdat.start+l.mdat.hs,end:l.mdat.end}));
  const prefixes=[];let total=0;
  for(const s of mdatStarts){prefixes.push(total);total+=s.end-s.payload;}
  const ftyp=layouts[0].ftyp?await readers[0].read(layouts[0].ftyp.start,layouts[0].ftyp.end-layouts[0].ftyp.start):new Uint8Array(0);
  /* moov size does not depend on the offsets (co64 is fixed width), so build once to measure, then again with real offsets */
  const movieTs=metas[0].movieTimescale;
  const movieDurOf=R=>Math.max.apply(null,R.map((r,t)=>Math.round(r.dur*movieTs/metas[0].tracks[t].timescale)));
  let R=mergeTables(metas,prefixes,mdatStarts,0);
  const size0=buildMoov(moovBytes[0],metas[0],R,movieDurOf(R)).length;
  const base=ftyp.length+size0+16;
  R=mergeTables(metas,prefixes,mdatStarts,base);
  const moov=buildMoov(moovBytes[0],metas[0],R,movieDurOf(R));
  if(moov.length!==size0)throw err('internal','Internal size mismatch while joining.');
  const hdr=new Uint8Array(16);put32(hdr,0,1);for(let i=0;i<4;i++)hdr[4+i]='mdat'.charCodeAt(i);put64(hdr,8,16+total);
  const parts=[{bytes:ftyp},{bytes:moov},{bytes:hdr}];
  mdatStarts.forEach((s,i)=>parts.push({src:i,start:s.payload,end:s.end}));
  if(onProgress)onProgress(1,-1);
  const seconds=R.length?Math.max.apply(null,R.map((r,t)=>r.dur/metas[0].tracks[t].timescale)):0;
  return {parts,size:ftyp.length+moov.length+16+total,seconds,tracks:R.length};
}
/* quick look used when a file is added: do we understand it, and what is in it? */
async function inspect(rd){
  const lay=await scan(rd,rd.name);
  const mb=await rd.read(lay.moov.start,lay.moov.end-lay.moov.start);
  const m=parseMoov(mb,rd.name);m.name=rd.name;
  const v=m.tracks.find(t=>t.handler==='vide');
  return {sig:sig(m),name:rd.name,width:v?v.w:0,height:v?v.h:0,
    seconds:Math.max.apply(null,m.tracks.map(t=>t.mdhdDur/t.timescale)),hasAudio:m.tracks.some(t=>t.handler==='soun'),tracks:m.tracks.length};
}

return {merge,inspect,plan,scan,parseMoov};
})();
