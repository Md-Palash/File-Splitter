// Tests for Combine mode (PDF, Excel, video decisions). Needs Node 20 or newer. Run: npm test
import fs from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const PDFLib = require('../assets/vendor/pdf-lib.min.js');
const code = fs.readFileSync(new URL('../assets/combine-core.js', import.meta.url), 'utf8');
const K = new Function(code + ';return CombineCore;')();
const { PDFDocument } = PDFLib;

// ---------- type detection ----------
{
  assert.equal(K.typeOf('a.PDF', ''), 'pdf');
  assert.equal(K.typeOf('book.xlsx', ''), 'excel');
  assert.equal(K.typeOf('old.xls', ''), 'excel');
  assert.equal(K.typeOf('data.csv', ''), 'excel');
  assert.equal(K.typeOf('clip.MOV', ''), 'video');
  assert.equal(K.typeOf('noext', 'application/pdf'), 'pdf');
  assert.equal(K.typeOf('noext', 'text/csv'), 'excel');
  assert.equal(K.typeOf('noext', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'excel');
  assert.equal(K.typeOf('noext', 'video/mp4'), 'video');
  assert.equal(K.typeOf('photo.png', 'image/png'), null);
  console.log('ok  type detection');
}

// ---------- page ranges ----------
{
  assert.deepEqual(K.parseRanges('', 4), [0, 1, 2, 3]);
  assert.deepEqual(K.parseRanges('1-3,5', 6), [0, 1, 2, 4]);
  assert.deepEqual(K.parseRanges(' 2 , 4- ', 5), [1, 3, 4]);
  assert.deepEqual(K.parseRanges('-2', 5), [0, 1]);
  assert.deepEqual(K.parseRanges('3,1,3', 3), [2, 0, 2]);
  for (const bad of ['0', '9', '5-3', 'a', ',,', '-', '2 4', '0-3'])
    assert.throws(() => K.parseRanges(bad, 6), Error, 'should reject ' + JSON.stringify(bad));
  assert.deepEqual(K.parseRanges('6-', 6), [5]);
  assert.equal(K.rangeInfo('1-3,5', 6).count, 4);
  assert.equal(K.rangeInfo('9', 6).ok, false);
  console.log('ok  page ranges');
}

// ---------- merge: order, page count, ranges, metadata ----------
const makePdf = async (widths, meta) => {
  const d = await PDFDocument.create();
  for (const w of widths) d.addPage([w, 200]);
  if (meta) { d.setTitle(meta.title); d.setAuthor(meta.author); d.setSubject(meta.subject); d.setKeywords(meta.keywords); }
  return d.save();
};
const widthsOf = async bytes => (await PDFDocument.load(bytes)).getPages().map(p => p.getWidth());
{
  const A = await makePdf([101, 102, 103], { title: 'Secret plan', author: 'Alice', subject: 'S', keywords: ['k'] });
  const B = await makePdf([201, 202]);
  const C = await makePdf([301, 302, 303, 304]);

  // order follows the list, not the input order of the files
  let r = await K.mergePdfs(PDFLib, [{ name: 'b.pdf', bytes: B }, { name: 'a.pdf', bytes: A }, { name: 'c.pdf', bytes: C }]);
  assert.equal(r.pages, 9);
  assert.deepEqual(r.counts, [2, 3, 4]);
  assert.deepEqual(await widthsOf(r.bytes), [201, 202, 101, 102, 103, 301, 302, 303, 304]);

  // page ranges per file
  r = await K.mergePdfs(PDFLib, [{ name: 'b.pdf', bytes: B }, { name: 'a.pdf', bytes: A, range: '1,3' }, { name: 'c.pdf', bytes: C, range: '2-3' }]);
  assert.equal(r.pages, 6);
  assert.deepEqual(await widthsOf(r.bytes), [201, 202, 101, 103, 302, 303]);

  // lazy read() is supported and progress is reported once per file
  const seen = [];
  r = await K.mergePdfs(PDFLib, [{ name: 'a.pdf', read: async () => A }, { name: 'b.pdf', read: async () => B }], f => seen.push(f));
  assert.equal(r.pages, 5);
  assert.deepEqual(seen, [0.5, 1]);

  // the originals' metadata is not carried over; a neutral title is set
  const out = await PDFDocument.load(r.bytes);
  assert.equal(out.getTitle(), 'Combined PDF');
  assert.ok(!out.getAuthor(), 'author must be empty');
  assert.ok(!out.getSubject(), 'subject must be empty');
  assert.ok(!out.getKeywords(), 'keywords must be empty');

  // a bad range names the file
  await assert.rejects(K.mergePdfs(PDFLib, [{ name: 'a.pdf', bytes: A, range: '9' }]), /a\.pdf: Page 9 is out of range/);
  console.log('ok  pdf merge: order, page count, ranges, metadata');
}

// ---------- inherited page attributes survive (MediaBox set on the Pages node) ----------
{
  const d = await PDFDocument.create();
  const page = d.addPage([333, 444]);
  const pages = d.catalog.lookup(PDFLib.PDFName.of('Pages'), PDFLib.PDFDict);
  pages.set(PDFLib.PDFName.of('MediaBox'), page.node.get(PDFLib.PDFName.of('MediaBox')));
  page.node.delete(PDFLib.PDFName.of('MediaBox'));
  const bytes = await d.save();
  const r = await K.mergePdfs(PDFLib, [{ name: 'inh.pdf', bytes }]);
  const p = (await PDFDocument.load(r.bytes)).getPage(0).getSize();
  assert.deepEqual([p.width, p.height], [333, 444]);
  console.log('ok  inherited MediaBox is kept');
}

// ---------- encrypted and damaged files ----------
{
  const encrypted = new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\n' +
    '4 0 obj<</Filter/Standard/V 1/R 2/O(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)/U(bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)/P -4>>endobj\n' +
    'xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000186 00000 n \n' +
    'trailer<</Size 5/Root 1 0 R/Encrypt 4 0 R>>\nstartxref\n0\n%%EOF\n');
  await assert.rejects(K.mergePdfs(PDFLib, [{ name: 'locked.pdf', bytes: encrypted }]),
    e => e.kind === 'encrypted' && /locked\.pdf is password-protected\. Remove the password first/.test(e.message));
  await assert.rejects(K.mergePdfs(PDFLib, [{ name: 'junk.pdf', bytes: new TextEncoder().encode('this is not a pdf at all') }]),
    e => e.kind === 'corrupt' && /junk\.pdf could not be read/.test(e.message));
  await assert.rejects(K.mergePdfs(PDFLib, [{ name: 'empty.pdf', bytes: new Uint8Array(0) }]), e => e.kind === 'corrupt');
  console.log('ok  encrypted and damaged PDFs are reported by name');
}
console.log('All combine tests passed.');
