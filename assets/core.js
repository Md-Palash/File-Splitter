/* Zip engine: reading, planning and writing zips. No dependencies. */
const enc=new TextEncoder(), dec=new TextDecoder('utf-8');
const MANIFEST='_slicer-manifest.json';
const CRC_T=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crcUpdate(c,buf){for(let i=0;i<buf.length;i++)c=CRC_T[(c^buf[i])&255]^(c>>>8);return c;}
function crcOfBytes(b){return (crcUpdate(0xFFFFFFFF,b)^0xFFFFFFFF)>>>0;}
async function crcOfBlob(blob,onBytes){let c=0xFFFFFFFF;const r=blob.stream().getReader();for(;;){const x=await r.read();if(x.done)break;c=crcUpdate(c,x.value);if(onBytes)onBytes(x.value.length);}return (c^0xFFFFFFFF)>>>0;}
const hex=n=>(n>>>0).toString(16).padStart(8,'0');
const pad=(n,w)=>String(n).padStart(w,'0');
const cmpPath=(a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true,sensitivity:'base'});
function fmtBytes(n){if(n<1e3)return n+' B';if(n<1e6)return (n/1e3).toFixed(1)+' KB';if(n<1e9)return (n/1e6).toFixed(n<1e7?2:1)+' MB';return (n/1e9).toFixed(2)+' GB';}
function dosFromMs(ms){const d=new Date(ms||Date.now());const y=Math.max(1980,d.getFullYear());return {time:(d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1),date:((y-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate()};}

async function readZip(file){
  const size=file.size;
  if(size<22) throw new Error('This file is too small to be a zip.');
  const tailLen=Math.min(size,65557+22);
  const tv=new DataView(await file.slice(size-tailLen,size).arrayBuffer());
  let e=-1;
  for(let i=tailLen-22;i>=0;i--){if(tv.getUint32(i,true)===0x06054b50){e=i;break;}}
  if(e<0) throw new Error('This does not look like a zip file.');
  let total=tv.getUint16(e+10,true),cdSize=tv.getUint32(e+12,true),cdOff=tv.getUint32(e+16,true);
  if(total===0xFFFF||cdSize===0xFFFFFFFF||cdOff===0xFFFFFFFF){
    const l=e-20;
    if(l<0||tv.getUint32(l,true)!==0x07064b50) throw new Error('This zip64 layout is not supported.');
    const z=Number(tv.getBigUint64(l+8,true));
    const zb=new DataView(await file.slice(z,z+56).arrayBuffer());
    if(zb.getUint32(0,true)!==0x06064b50) throw new Error('Damaged zip64 end record.');
    total=Number(zb.getBigUint64(32,true));cdSize=Number(zb.getBigUint64(40,true));cdOff=Number(zb.getBigUint64(48,true));
  }
  const cd=new DataView(await file.slice(cdOff,cdOff+cdSize).arrayBuffer());
  const u8=new Uint8Array(cd.buffer);
  const out=[];let p=0;
  while(p+46<=cd.byteLength&&cd.getUint32(p,true)===0x02014b50){
    const flags=cd.getUint16(p+8,true),method=cd.getUint16(p+10,true),time=cd.getUint16(p+12,true),date=cd.getUint16(p+14,true);
    const crc=cd.getUint32(p+16,true);let comp=cd.getUint32(p+20,true),unc=cd.getUint32(p+24,true);
    const nl=cd.getUint16(p+28,true),el=cd.getUint16(p+30,true),cl=cd.getUint16(p+32,true);
    let off=cd.getUint32(p+42,true);
    const name=dec.decode(u8.subarray(p+46,p+46+nl));
    if(comp===0xFFFFFFFF||unc===0xFFFFFFFF||off===0xFFFFFFFF){
      let q=p+46+nl;const end=q+el;
      while(q+4<=end){const id=cd.getUint16(q,true),sz=cd.getUint16(q+2,true);
        if(id===1){let r=q+4;
          if(unc===0xFFFFFFFF){unc=Number(cd.getBigUint64(r,true));r+=8;}
          if(comp===0xFFFFFFFF){comp=Number(cd.getBigUint64(r,true));r+=8;}
          if(off===0xFFFFFFFF){off=Number(cd.getBigUint64(r,true));r+=8;}}
        q+=4+sz;}
    }
    out.push({name,flags,method,time,date,crc,comp,size:unc,off,dir:name.endsWith('/')});
    p+=46+nl+el+cl;
  }
  return out;
}
async function entryRaw(file,en){
  const h=new DataView(await file.slice(en.off,en.off+30).arrayBuffer());
  if(h.byteLength<30||h.getUint32(0,true)!==0x04034b50) throw new Error('Damaged entry: '+en.name);
  const s=en.off+30+h.getUint16(26,true)+h.getUint16(28,true);
  return file.slice(s,s+en.comp);
}
const inflateBlob=raw=>new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
const deflateBlob=b=>new Response(b.stream().pipeThrough(new CompressionStream('deflate-raw'))).blob();

class ZipWriter{
  constructor(){this.parts=[];this.cd=[];this.off=0;this.count=0;}
  add(name,o){
    if(o.comp>=0xFFFFFFFF||o.size>=0xFFFFFFFF||this.off>=0xFFFFFFFF) throw new Error('A part would pass 4 GB. Choose a smaller size.');
    if(this.count>=65535) throw new Error('Too many files for one zip part.');
    const nb=enc.encode(name);
    const h=new Uint8Array(30+nb.length),v=new DataView(h.buffer);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x0800,true);v.setUint16(8,o.method,true);v.setUint16(10,o.time,true);v.setUint16(12,o.date,true);v.setUint32(14,o.crc,true);v.setUint32(18,o.comp,true);v.setUint32(22,o.size,true);v.setUint16(26,nb.length,true);h.set(nb,30);
    const c=new Uint8Array(46+nb.length),w=new DataView(c.buffer);
    w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);w.setUint16(8,0x0800,true);w.setUint16(10,o.method,true);w.setUint16(12,o.time,true);w.setUint16(14,o.date,true);w.setUint32(16,o.crc,true);w.setUint32(20,o.comp,true);w.setUint32(24,o.size,true);w.setUint16(28,nb.length,true);w.setUint32(42,this.off,true);c.set(nb,46);
    this.parts.push(h,o.data);this.cd.push(c);this.off+=h.length+o.comp;this.count++;
  }
  finish(){
    let n=0;for(const c of this.cd){this.parts.push(c);n+=c.length;}
    const e=new Uint8Array(22),v=new DataView(e.buffer);
    v.setUint32(0,0x06054b50,true);v.setUint16(8,this.count,true);v.setUint16(10,this.count,true);v.setUint32(12,n,true);v.setUint32(16,this.off,true);
    this.parts.push(e);
    return new Blob(this.parts,{type:'application/zip'});
  }
}

let UID=0;
function mkItem(kind,props){
  const segs=props.path.split('/'),leaf=segs[segs.length-1],m=/\.([^.]+)$/.exec(leaf);
  return Object.assign({id:++UID,kind,nb:enc.encode(props.path).length,ext:m?m[1].toLowerCase():'',top:segs.length>1?segs[0]:''},props);
}

async function getUncompressed(it){
  if(it.kind==='chunk'){const p=it.parent;if(!p._unc)p._unc=getUncompressed(p);return (await p._unc).slice(it.start,it.end);}
  if(it.kind==='zip'){
    const raw=await entryRaw(it.file,it.entry);
    if(it.entry.method===0)return raw;
    if(it.entry.method===8)return inflateBlob(raw);
    throw new Error('Unsupported compression in '+it.path);
  }
  return it.blob;
}
async function packBlob(blob,crc,compress){
  if(crc==null)crc=await crcOfBlob(blob);
  if(compress==='deflate'&&blob.size>0){const d=await deflateBlob(blob);if(d.size<blob.size)return {method:8,crc,comp:d.size,size:blob.size,data:d};}
  return {method:0,crc,comp:blob.size,size:blob.size,data:blob};
}
async function getPayload(it,compress){
  if(it.kind==='zip'){
    const en=it.entry,raw=await entryRaw(it.file,en);
    if(compress==='deflate'&&en.method===0&&en.size>0)return packBlob(raw,en.crc,'deflate');
    return {method:en.method,crc:en.crc,comp:en.comp,size:en.size,data:raw};
  }
  return packBlob(await getUncompressed(it),null,compress);
}

function packGroup(list,cap,fit,maxEntries){
  const bins=[];
  if(!fit){
    let cur=null;
    for(const w of list){
      if(!cur||cur.used+w.cost>cap||cur.items.length>=maxEntries){cur={items:[],used:0};bins.push(cur);}
      cur.items.push(w);cur.used+=w.cost;
    }
  }else{
    for(const w of [...list].sort((a,b)=>b.cost-a.cost)){
      let b=bins.find(x=>x.used+w.cost<=cap&&x.items.length<maxEntries);
      if(!b){b={items:[],used:0};bins.push(b);}
      b.items.push(w);b.used+=w.cost;
    }
    for(const b of bins)b.items.sort((x,y)=>cmpPath(x.it,y.it));
  }
  return bins;
}
function partFileName(pattern,base,n,total){
  let s=(pattern||'{name}-part-{n}-of-{total}').replace(/\{name\}/g,base).replace(/\{n\}/g,pad(n,String(total).length)).replace(/\{total\}/g,String(total));
  s=s.replace(/[\\/:*?"<>|]+/g,'_').trim()||'part';
  return /\.zip$/i.test(s)?s:s+'.zip';
}
function planParts(items,cfg){
  const warnings=[],man=!!cfg.manifest,count=cfg.mode==='count';
  const idx=man?items.reduce((a,it)=>a+it.nb+14,0):0;
  const reserve=22+(man?30+46+2*MANIFEST.length+idx+400:0);
  const cap=cfg.limit-reserve;
  const ov=nb=>30+46+2*nb+(man?nb+90:0);
  const out={parts:[],warnings,reserve,cap,base:cfg.base||'files',index:{},error:false};
  if(!items.length)return out;
  if(!count&&cap<2048){out.error=true;warnings.push('The size limit is too small to hold even the zip overhead. Choose a larger size.');return out;}
  const work=[];
  for(const it of items){
    const cost=it.packed+ov(it.nb);
    if(!count&&cost>cap){
      const room=Math.floor(cap-ov(it.nb+8));
      if(cfg.split&&room>=1024){
        const n=Math.ceil(it.size/room),w=Math.max(3,String(n).length);
        for(let i=0;i<n;i++){
          const s=i*room,e=Math.min(it.size,s+room),path=it.path+'.part'+pad(i+1,w),nb=enc.encode(path).length;
          work.push({it:{kind:'chunk',parent:it,index:i,total:n,start:s,end:e,size:e-s,packed:e-s,path,nb,time:it.time,date:it.date,ext:it.ext,top:it.top},cost:(e-s)+ov(nb)});
        }
        warnings.push(`${it.path} is ${fmtBytes(it.size)}, so it is cut into ${n} pieces. Use Rejoin to put it back together.`);
        continue;
      }
      warnings.push(`${it.path} is ${fmtBytes(it.packed)} and cannot fit. It gets a part of its own that is over the limit. Turn on "Cut oversized files into pieces" to fix this.`);
    }
    work.push({it,cost});
  }
  const keyOf=cfg.mode==='type'?w=>w.it.ext||'(no extension)':cfg.mode==='folder'?w=>w.it.top||'(top level)':()=>'';
  const groups=new Map();
  for(const w of work){const k=keyOf(w);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(w);}
  const bins=[];
  for(const k of [...groups.keys()].sort((a,b)=>a.localeCompare(b))){
    const list=groups.get(k).sort((a,b)=>cmpPath(a.it,b.it));
    if(count){const n=Math.max(1,cfg.count|0);for(let i=0;i<list.length;i+=n){const s=list.slice(i,i+n);bins.push({items:s,used:s.reduce((a,x)=>a+x.cost,0),group:k});}}
    else for(const b of packGroup(list,cap,cfg.fit,60000)){b.group=k;bins.push(b);}
  }
  const total=bins.length;
  bins.forEach((b,i)=>{
    const n=i+1,bytes=b.used+reserve;
    out.parts.push({n,items:b.items.map(w=>w.it),bytes,group:b.group,over:!count&&bytes>cfg.limit,filename:partFileName(cfg.pattern,out.base,n,total)});
  });
  for(const p of out.parts)for(const it of p.items){
    const key=it.kind==='chunk'?it.parent.path:it.path;
    const cur=out.index[key];
    if(cur===undefined)out.index[key]=p.n;else if(Array.isArray(cur))cur.push(p.n);else out.index[key]=[cur,p.n];
  }
  return out;
}
async function buildPart(plan,part,o,onItem){
  const zw=new ZipWriter(),files=[];
  for(const it of part.items){
    const pl=await getPayload(it,o.compress);
    zw.add(it.path,{method:pl.method,crc:pl.crc,comp:pl.comp,size:pl.size,data:pl.data,time:it.time,date:it.date});
    files.push(it.kind==='chunk'?{name:it.parent.path,chunk:(it.index+1)+'/'+it.total,size:pl.size,crc32:hex(pl.crc)}:{name:it.path,size:pl.size,crc32:hex(pl.crc)});
    if(onItem)await onItem(it);
  }
  if(o.manifest){
    const bytes=enc.encode(JSON.stringify({tool:'Zip Slicer',version:1,archive:plan.base,part:part.n,totalParts:plan.parts.length,index:plan.index,files}));
    const d=dosFromMs(Date.now());
    zw.add(MANIFEST,{method:0,crc:crcOfBytes(bytes),comp:bytes.length,size:bytes.length,data:bytes,time:d.time,date:d.date});
  }
  return zw.finish();
}
