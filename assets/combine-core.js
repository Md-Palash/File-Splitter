/* File Spliter: Combine mode logic. No DOM access, so Node tests can run it. */
var CombineCore=(function(){
'use strict';
const EXT={pdf:'pdf',xlsx:'excel',xls:'excel',csv:'excel',mp4:'video',m4v:'video',mov:'video',webm:'video',mkv:'video',avi:'video'};
const LABEL={pdf:'PDF',excel:'Excel',video:'video'};
/* Type comes from the extension first, then the MIME type. Returns 'pdf', 'excel', 'video' or null. */
function typeOf(name,mime){
  const m=/\.([^.\/\\]+)$/.exec(String(name||''));
  const ext=m?m[1].toLowerCase():'';
  if(EXT[ext])return EXT[ext];
  mime=String(mime||'').toLowerCase();
  if(mime==='application/pdf')return 'pdf';
  if(mime==='text/csv'||mime==='application/vnd.ms-excel'||mime.indexOf('spreadsheetml')>=0)return 'excel';
  if(mime.indexOf('video/')===0)return 'video';
  return null;
}
const labelOf=t=>LABEL[t]||String(t);

/* "1-3,5" -> [0,1,2,4] (zero-based). "" means every page. Also accepts "4-" (to the end) and "-3" (from the start). */
function parseRanges(spec,count){
  const s=String(spec==null?'':spec).trim();
  if(!s)return Array.from({length:count},(_,i)=>i);
  const out=[];
  for(const raw of s.split(',')){
    const t=raw.trim();
    if(!t)continue;
    const m=/^(\d*)\s*(-?)\s*(\d*)$/.exec(t);
    if(!m||(!m[1]&&!m[3])||(!m[2]&&m[3]))throw new Error('"'+t+'" is not a page range. Use numbers like 1-3,5.');
    let a,b;
    if(!m[2]){a=b=+m[1];}else{a=m[1]?+m[1]:1;b=m[3]?+m[3]:count;}
    if(a<1||b<1)throw new Error('Page numbers start at 1.');
    if(a>count||b>count)throw new Error('Page '+Math.max(a,b)+' is out of range. This file has '+count+' page'+(count===1?'':'s')+'.');
    if(a>b)throw new Error('"'+t+'" runs backwards. Write it as '+b+'-'+a+'.');
    for(let i=a;i<=b;i++)out.push(i-1);
  }
  if(!out.length)throw new Error('No pages are selected.');
  return out;
}
function rangeInfo(spec,count){
  try{return {ok:true,count:parseRanges(spec,count).length};}
  catch(e){return {ok:false,error:e.message};}
}

function describePdfError(e,name){
  const msg=String((e&&e.message)||e);
  const enc=(e&&e.constructor&&e.constructor.name==='EncryptedPDFError')||/encrypt/i.test(msg);
  const err=new Error(enc?name+' is password-protected. Remove the password first, then add it again.':name+' could not be read. It may be damaged or not a real PDF.');
  err.kind=enc?'encrypted':'corrupt';
  return err;
}

/* Merge PDFs in the given order. inputs: [{name, range, bytes | read()}]. PDFLib is the pdf-lib module. */
async function mergePdfs(PDFLib,inputs,onProgress,yieldFn){
  const PDFDocument=PDFLib.PDFDocument;
  const out=await PDFDocument.create({updateMetadata:false});
  const counts=[];
  let pages=0;
  for(let i=0;i<inputs.length;i++){
    const inp=inputs[i];
    let src;
    try{src=await PDFDocument.load(inp.bytes||await inp.read(),{updateMetadata:false});}
    catch(e){throw describePdfError(e,inp.name);}
    let idx;
    try{idx=parseRanges(inp.range,src.getPageCount());}
    catch(e){throw new Error(inp.name+': '+e.message);}
    const copied=await out.copyPages(src,idx);
    for(const p of copied)out.addPage(p);
    counts.push(idx.length);pages+=idx.length;
    src=null;
    if(onProgress)onProgress((i+1)/inputs.length,i);
    if(yieldFn)await yieldFn();
  }
  /* The originals' titles, authors and dates are not copied. Only a neutral title is set. */
  out.setTitle('Combined PDF');
  out.setProducer('File Spliter');
  out.setCreator('File Spliter');
  const bytes=await out.save();
  return {bytes,pages,counts};
}

return {typeOf,labelOf,parseRanges,rangeInfo,describePdfError,mergePdfs};
})();
