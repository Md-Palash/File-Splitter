// Tests for Excel/CSV combining. Needs Node 20+. Run: npm test
import fs from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const JSZip = require('../assets/vendor/jszip.min.js');
const X = new Function(fs.readFileSync(new URL('../assets/combine-xlsx.js', import.meta.url), 'utf8') + ';return CombineXlsx;')();
const enc = s => new TextEncoder().encode(s);
const book = (sheets) => X.writeXlsx(JSZip, sheets);

// sheet names: sanitised, <=31 chars, unique ignoring case
{
  const used = new Set();
  assert.equal(X.sheetName('Sales: Q1/2', used), 'Sales_ Q1_2');
  assert.equal(X.sheetName('sales_ q1_2', used), 'sales_ q1_2 (2)');
  const long = 'x'.repeat(40);
  const a = X.sheetName(long, used), b = X.sheetName(long, used);
  assert.equal(a.length, 31); assert.equal(b.length, 31); assert.notEqual(a, b);
  assert.equal(X.sheetName('[]', used), '__'); assert.equal(X.sheetName('', used), 'Sheet');
  console.log('ok  sheet names');
}
// csv
{
  const r = X.parseCsv('Name;Qty\n"Fay; Jr";7\nGus;"08"\n');
  assert.deepEqual(r, [['Name', 'Qty'], ['Fay; Jr', 7], ['Gus', '08']]);
  assert.deepEqual(X.parseCsv('a,b\r\n"x ""q""",\r\n'), [['a', 'b'], ['x "q"', null]]);
  console.log('ok  csv parsing');
}
// write then read back
{
  const bytes = await book([{ name: 'S', rows: [['a', 1, true], [null, 'é & <x>', 2.5]] }]);
  const back = await X.readAny(JSZip, 'S.xlsx', bytes);
  assert.deepEqual(back[0].rows, [['a', 1, true], [undefined, 'é & <x>', 2.5]].map(r => { const o = []; r.forEach((v, i) => { if (v !== undefined && v !== null) o[i] = v; }); return o; }));
  console.log('ok  xlsx write/read round trip');
}
// one sheet per file/sheet
const A = await book([{ name: 'Sales', rows: [['Name', 'Qty'], ['Ann', 3], ['Bob', 4]] }, { name: 'Second', rows: [['a'], [1]] }]);
const B = await book([{ name: 'Sheet1', rows: [['qty', 'NAME', 'Extra'], [10, 'Dan', 'e1'], [20, 'Eve', 'e2']] }]);
const C = enc('Name;Qty\nFay;7\n');
{
  const r = await X.mergeExcel(JSZip, [{ name: 'a.xlsx', bytes: A }, { name: 'b.xlsx', bytes: B }, { name: 'c.csv', bytes: C }, { name: 'b2.xlsx', bytes: B }], { mode: 'sheets' });
  assert.deepEqual(r.sheetNames, ['a - Sales', 'a - Second', 'b', 'c', 'b2']);
  const back = await X.readAny(JSZip, 'out.xlsx', r.bytes);
  assert.equal(back.length, 5); assert.equal(back[3].rows[1][0], 'Fay'); assert.equal(back[0].rows[2][1], 4);
  console.log('ok  one sheet per file/sheet, in order');
}
// stack rows: keep first headers, match by header text, case-insensitive
{
  const r = await X.mergeExcel(JSZip, [{ name: 'a.xlsx', bytes: A }, { name: 'b.xlsx', bytes: B }, { name: 'c.csv', bytes: C }], { mode: 'stack', headers: 'first', sourceCol: true });
  const rows = (await X.readAny(JSZip, 'o.xlsx', r.bytes))[0].rows;
  const norm = rows.map(x => Array.from({ length: 3 }, (_, i) => x[i] === undefined ? null : x[i]));
  assert.deepEqual(norm, [['Name', 'Qty', 'Source file'], ['Ann', 3, 'a.xlsx'], ['Bob', 4, 'a.xlsx'], ['Dan', 10, 'b.xlsx'], ['Eve', 20, 'b.xlsx'], ['Fay', 7, 'c.csv']]);
  assert.equal(r.rowCount, 5);
  assert.deepEqual(r.dropped, [{ file: 'b.xlsx', cols: ['Extra'] }]);
  console.log('ok  stack rows (keep first headers, source column)');
  const u = await X.mergeExcel(JSZip, [{ name: 'a.xlsx', bytes: A }, { name: 'b.xlsx', bytes: B }], { mode: 'stack', headers: 'union' });
  const ur = (await X.readAny(JSZip, 'o.xlsx', u.bytes))[0].rows;
  assert.deepEqual(ur[0], ['Name', 'Qty', 'Extra']); assert.equal(ur[3][2], 'e1'); assert.equal(u.dropped.length, 0);
  console.log('ok  stack rows (union of headers)');
}
// errors
{
  await assert.rejects(X.readAny(JSZip, 'old.xls', new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])), e => e.kind === 'xls' && /old\.xls is an old-format/.test(e.message));
  await assert.rejects(X.readAny(JSZip, 'lock.xlsx', new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])), e => e.kind === 'encrypted' && /password-protected/.test(e.message));
  await assert.rejects(X.readAny(JSZip, 'x.xlsx', enc('not a zip')), e => e.kind === 'corrupt');
  console.log('ok  old, locked and damaged files are reported');
}
// external file made by openpyxl (set EXTERNAL_FIXTURES=/path to run)
if (process.env.EXTERNAL_FIXTURES) {
  const d = process.env.EXTERNAL_FIXTURES;
  const s = await X.readAny(JSZip, 'a.xlsx', fs.readFileSync(d + '/a.xlsx'));
  assert.equal(s[0].name, 'Sales Q1 & 2'); assert.deepEqual(s[0].rows[1], ['Ann', 3, 'héllo & <b>']); assert.equal(s[0].rows[3][1], true);
  const r = await X.mergeExcel(JSZip, ['a.xlsx', 'b.xlsx', 'c.csv'].map(n => ({ name: n, bytes: fs.readFileSync(d + '/' + n) })), { mode: 'sheets' });
  fs.writeFileSync(d + '/out.xlsx', r.bytes);
  console.log('ok  external openpyxl file read; wrote out.xlsx');
}
console.log('All excel tests passed.');
