/* File Spliter: Excel and CSV combining. Values only (no styles). No DOM access, so Node tests can run it.
   Needs JSZip (assets/vendor/jszip.min.js) for the .xlsx container; everything else is plain code. */
var CombineXlsx=(function(){
'use strict';
const MAX_ROWS=1048576,MAX_COLS=16384;

function err(kind,msg){const e=new Error(msg);e.kind=kind;return e;}
function xmlUnesc(s){
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g,(m,g)=>{
    if(g==='lt')return '<';if(g==='gt')return '>';if(g==='amp')return '&';if(g==='quot')return '"';if(g==='apos')return "'";
    const n=g[1]==='x'?parseInt(g.slice(2),16):parseInt(g.slice(1),10);
    try{return String.fromCodePoint(n);}catch(e){return '';}
  });
}
function xmlEsc(s){
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function attrs(s){const o={};s.replace(/([\w:.-]+)\s*=\s*"([^"]*)"/g,(m,k,v)=>{o[k]=xmlUnesc(v);return m;});return o;}
function colIndex(ref){const m=/^([A-Za-z]+)/.exec(ref||'');if(!m)return -1;let n=0;for(const ch of m[1].toUpperCase())n=n*26+ch.charCodeAt(0)-64;return n-1;}
function colName(i){let s='';for(i++;i>0;i=Math.floor((i-1)/26))s=String.fromCharCode(65+(i-1)%26)+s;return s;}
function textOf(xml){
  xml=xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g,'');
  let out='';xml.replace(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g,(m,t)=>{out+=t?xmlUnesc(t):'';return m;});
  return out;
}

/* What kind of container is this? Used to tell a password-protected or old Excel file from a real .xlsx. */
function sniff(bytes){
  if(bytes.length>=4&&bytes[0]===0x50&&bytes[1]===0x4B)return 'zip';
  if(bytes.length>=8&&bytes[0]===0xD0&&bytes[1]===0xCF&&bytes[2]===0x11&&bytes[3]===0xE0)return 'cfb';
  return 'other';
}

async function readXlsx(JSZip,bytes,name){
  let zip;
  try{zip=await JSZip.loadAsync(bytes);}
  catch(e){throw err('corrupt',name+' could not be read. It may be damaged or not a real Excel file.');}
  const wbFile=zip.file('xl/workbook.xml');
  if(!wbFile)throw err('corrupt',name+' could not be read. It may be damaged or not a real Excel file.');
  const wb=await wbFile.async('string');
  const relsFile=zip.file('xl/_rels/workbook.xml.rels');
  const rels={};
  if(relsFile){(await relsFile.async('string')).replace(/<Relationship\b[^>]*>/g,m=>{const a=attrs(m);if(a.Id)rels[a.Id]=a.Target;return m;});}
  let shared=[];
  const ssFile=zip.file('xl/sharedStrings.xml');
  if(ssFile){const ss=await ssFile.async('string');ss.replace(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g,(m,b)=>{shared.push(b?textOf(b):'');return m;});}
  const sheets=[];
  const defs=[];
  wb.replace(/<sheet\b[^>]*>/g,m=>{defs.push(attrs(m));return m;});
  for(let i=0;i<defs.length;i++){
    const d=defs[i];
    let target=rels[d['r:id']];
    if(!target)target='worksheets/sheet'+(i+1)+'.xml';
    const path=target[0]==='/'?target.slice(1):'xl/'+target.replace(/^\.\//,'');
    const sf=zip.file(path);
    if(!sf)continue; // chartsheets and the like have no cells
    const xml=await sf.async('string');
    sheets.push({name:d.name||('Sheet'+(i+1)),rows:parseSheet(xml,shared)});
  }
  if(!sheets.length)throw err('corrupt',name+' has no worksheets that could be read.');
  return sheets;
}

function parseSheet(xml,shared){
  const rows=[];
  let seq=0;
  xml.replace(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g,(m,ra,body)=>{
    const rattr=attrs(ra);
    const r=rattr.r?parseInt(rattr.r,10)-1:seq;
    seq=r+1;
    if(!body)return m;
    const row=[];let next=0;
    body.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,(mm,ca,cb)=>{
      const a=attrs(ca);
      let ci=a.r?colIndex(a.r):next;if(ci<0)ci=next;
      next=ci+1;
      if(ci>=MAX_COLS||!cb)return mm;
      const v=/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cb);
      let val=null;
      if(a.t==='inlineStr'){const is=/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(cb);val=is?textOf(is[1]):null;}
      else if(v){
        const raw=xmlUnesc(v[1]);
        if(a.t==='s')val=shared[parseInt(raw,10)];
        else if(a.t==='str'||a.t==='e')val=raw;
        else if(a.t==='b')val=raw==='1';
        else{const n=Number(raw);val=raw===''||isNaN(n)?raw:n;}
      }
      if(val===undefined||val==='')val=null;
      if(val!==null)row[ci]=val;
      return mm;
    });
    if(row.length)rows[r]=row;
    return m;
  });
  for(let i=0;i<rows.length;i++)if(!rows[i])rows[i]=[];
  return rows;
}

/* ---------- CSV ---------- */
function parseCsv(text){
  if(text.charCodeAt(0)===0xFEFF)text=text.slice(1);
  const first=text.split(/\r?\n/,1)[0]||'';
  const count=ch=>first.split(ch).length-1;
  let delim=',';
  if(count(';')>count(delim))delim=';';
  if(count('\t')>count(delim))delim='\t';
  const rows=[];let row=[],cell='',q=false,quoted=false;
  const push=()=>{row.push(finish(cell,quoted));cell='';quoted=false;};
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){
      if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else q=false;}
      else cell+=c;
    }else if(c==='"'&&cell===''){q=true;quoted=true;}
    else if(c===delim)push();
    else if(c==='\n'||c==='\r'){
      if(c==='\r'&&text[i+1]==='\n')i++;
      push();rows.push(row);row=[];
    }else cell+=c;
  }
  if(cell!==''||quoted||row.length){push();rows.push(row);}
  while(rows.length&&rows[rows.length-1].every(v=>v===null))rows.pop();
  return rows;
}
function finish(s,quoted){
  if(s==='')return null;
  if(!quoted&&/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(s))return Number(s);
  return s;
}

/* ---------- reading any supported input ---------- */
const extOf=n=>{const m=/\.([^.\\/]+)$/.exec(n||'');return m?m[1].toLowerCase():'';};
const baseOf=n=>(n||'').replace(/\.[^.\\/]+$/,'');
async function readAny(JSZip,name,bytes){
  const ext=extOf(name),kind=sniff(bytes);
  if(ext==='csv'){
    let text;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(e){text=new TextDecoder('windows-1252').decode(bytes);}
    return [{name:baseOf(name),rows:parseCsv(text)}];
  }
  if(kind==='cfb'){
    throw err(ext==='xls'?'xls':'encrypted',ext==='xls'
      ?name+' is an old-format .xls file, which this tool cannot read yet. Open it in Excel and use Save As .xlsx or .csv, then add it again.'
      :name+' is password-protected. Remove the password first, then add it again.');
  }
  if(ext==='xls')throw err('xls',name+' is an old-format .xls file, which this tool cannot read yet. Open it in Excel and use Save As .xlsx or .csv, then add it again.');
  if(kind!=='zip')throw err('corrupt',name+' could not be read. It may be damaged or not a real Excel file.');
  return readXlsx(JSZip,bytes,name);
}
function sheetInfo(sheets){
  return sheets.map(s=>({name:s.name,rows:s.rows.length,cols:s.rows.reduce((m,r)=>Math.max(m,r.length),0)}));
}

/* ---------- sheet names: max 31 characters, none of \ / ? * [ ] :, unique ignoring case ---------- */
function sheetName(raw,used){
  let n=String(raw||'').replace(/[\\\/?*\[\]:]/g,'_').replace(/^'+|'+$/g,'').trim();
  if(!n)n='Sheet';
  if(n.toLowerCase()==='history')n='History_';
  n=n.slice(0,31);
  let out=n,k=2;
  while(used.has(out.toLowerCase())){
    const suf=' ('+k+')';out=n.slice(0,31-suf.length)+suf;k++;
  }
  used.add(out.toLowerCase());
  return out;
}

/* ---------- writing .xlsx ---------- */
async function writeXlsx(JSZip,sheets){
  const z=new JSZip();
  const ct='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    +sheets.map((s,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')+'</Types>';
  z.file('[Content_Types].xml',ct);
  z.file('_rels/.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  z.file('xl/workbook.xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    +sheets.map((s,i)=>'<sheet name="'+xmlEsc(s.name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets></workbook>');
  z.file('xl/_rels/workbook.xml.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    +sheets.map((s,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+'</Relationships>');
  sheets.forEach((s,i)=>{
    const parts=['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
    s.rows.forEach((row,r)=>{
      let cells='';
      for(let c=0;c<row.length;c++){
        const v=row[c];if(v===null||v===undefined)continue;
        const ref=colName(c)+(r+1);
        if(typeof v==='number'&&isFinite(v))cells+='<c r="'+ref+'"><v>'+v+'</v></c>';
        else if(typeof v==='boolean')cells+='<c r="'+ref+'" t="b"><v>'+(v?1:0)+'</v></c>';
        else cells+='<c r="'+ref+'" t="inlineStr"><is><t xml:space="preserve">'+xmlEsc(v)+'</t></is></c>';
      }
      if(cells)parts.push('<row r="'+(r+1)+'">'+cells+'</row>');
    });
    parts.push('</sheetData></worksheet>');
    z.file('xl/worksheets/sheet'+(i+1)+'.xml',parts.join(''));
  });
  return z.generateAsync({type:'uint8array',compression:'DEFLATE'});
}

/* ---------- combining ---------- */
function hkey(v,i){const s=v===null||v===undefined?'':String(v).trim();return s?s.toLowerCase():'column '+(i+1);}
function hlabel(v,i){const s=v===null||v===undefined?'':String(v).trim();return s||'Column '+(i+1);}
function uniqKeys(row){const seen={};return row.map((v,i)=>{let k=hkey(v,i),n=seen[k]=(seen[k]||0)+1;return n>1?k+'#'+n:k;});}

/* parsed = [{name, sheets:[{name,rows}]}] */
function combineParsed(parsed,opts){
  opts=opts||{};
  const mode=opts.mode==='stack'?'stack':'sheets';
  if(mode==='sheets'){
    const used=new Set(),out=[];let total=0;
    for(const f of parsed){
      const base=baseOf(f.name);
      for(const s of f.sheets){
        if(s.rows.length>MAX_ROWS)throw err('limit',f.name+' has more rows than an Excel sheet can hold.');
        out.push({name:sheetName(f.sheets.length===1?base:base+' - '+s.name,used),rows:s.rows});
        total+=s.rows.length;
      }
    }
    if(out.length>255)throw err('limit','That would make '+out.length+' sheets, which is more than Excel allows in one workbook.');
    return {sheets:out,rowCount:total,dropped:[]};
  }
  /* stack rows: the first sheet of each file that has data; columns are matched by header text */
  const union=opts.headers==='union',withSource=!!opts.sourceCol;
  const blocks=[];
  for(const f of parsed){
    const s=f.sheets.find(x=>x.rows.some(r=>r.length));
    if(!s){blocks.push({name:f.name,headers:[],keys:[],body:[]});continue;}
    const first=s.rows.findIndex(r=>r.length);
    const hrow=s.rows[first];
    const width=Math.max(hrow.length,0);
    const hdr=[];for(let i=0;i<width;i++)hdr.push(hrow[i]===undefined?null:hrow[i]);
    blocks.push({name:f.name,headers:hdr.map(hlabel),keys:uniqKeys(hdr),body:s.rows.slice(first+1),hrow:hdr});
  }
  const cols=[],colIdx={};
  const addCol=(k,label)=>{if(!(k in colIdx)){colIdx[k]=cols.length;cols.push(label);}};
  const firstWith=blocks.find(b=>b.keys.length)||{keys:[],headers:[]};
  if(union)blocks.forEach(b=>b.keys.forEach((k,i)=>addCol(k,b.headers[i])));
  else firstWith.keys.forEach((k,i)=>addCol(k,firstWith.headers[i]));
  const rows=[cols.slice().concat(withSource?['Source file']:[])];
  const dropped=[];
  for(const b of blocks){
    const miss=[];
    b.keys.forEach((k,i)=>{if(!(k in colIdx))miss.push(b.headers[i]);});
    if(miss.length)dropped.push({file:b.name,cols:miss});
    for(const r of b.body){
      if(!r.length)continue;
      const o=new Array(cols.length).fill(null);
      b.keys.forEach((k,i)=>{const ci=colIdx[k];if(ci!==undefined&&r[i]!==undefined)o[ci]=r[i];});
      if(withSource)o.push(b.name);
      rows.push(o);
    }
  }
  if(rows.length>MAX_ROWS)throw err('limit','The stacked result has '+rows.length+' rows, more than an Excel sheet can hold ('+MAX_ROWS+').');
  return {sheets:[{name:'Combined',rows}],rowCount:rows.length-1,dropped};
}

/* inputs: [{name, bytes | read()}] */
async function mergeExcel(JSZip,inputs,opts,onProgress,yieldFn){
  const parsed=[];
  for(let i=0;i<inputs.length;i++){
    const inp=inputs[i];
    const bytes=inp.bytes||await inp.read();
    parsed.push({name:inp.name,sheets:await readAny(JSZip,inp.name,bytes)});
    if(onProgress)onProgress(0.6*(i+1)/inputs.length,i);
    if(yieldFn)await yieldFn();
  }
  return finishMerge(JSZip,parsed,opts,onProgress);
}
async function finishMerge(JSZip,parsed,opts,onProgress){
  const r=combineParsed(parsed,opts);
  if(onProgress)onProgress(0.8,-1);
  const bytes=await writeXlsx(JSZip,r.sheets);
  if(onProgress)onProgress(1,-1);
  return {bytes,sheetNames:r.sheets.map(s=>s.name),rowCount:r.rowCount,dropped:r.dropped};
}

return {sniff,readAny,readXlsx,parseCsv,sheetInfo,sheetName,writeXlsx,combineParsed,mergeExcel,finishMerge,colName,colIndex};
})();
