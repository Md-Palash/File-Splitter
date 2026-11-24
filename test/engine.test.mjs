// Round-trip test for the zip engine. Needs Node 20 or newer. Run: npm test
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const code = fs.readFileSync(new URL('../assets/core.js', import.meta.url), 'utf8');
const { readZip, planParts, buildPart, mkItem, ZipWriter, crcOfBytes, entryRaw, inflateBlob, dosFromMs, MANIFEST, planRaw, groupRaw, parseOrderList } =
  new Function(code + ';return {readZip,planParts,buildPart,mkItem,ZipWriter,crcOfBytes,entryRaw,inflateBlob,dosFromMs,MANIFEST,planRaw,groupRaw,parseOrderList};')();

// 1. Build a source zip: 120 small files, one empty file, one 3 MB file.
const originals = new Map();
const zw = new ZipWriter();
const d = dosFromMs(Date.now());
const addSource = (name, bytes) => {
  originals.set(name, Buffer.from(bytes));
  zw.add(name, { method: 0, crc: crcOfBytes(bytes), comp: bytes.length, size: bytes.length, data: bytes, time: d.time, date: d.date });
};
for (let i = 0; i < 120; i++) addSource(`img/${i % 3}/pic_${String(i).padStart(3, '0')}.png`, crypto.randomBytes(5000 + i * 700));
addSource('empty.txt', new Uint8Array(0));
addSource('big/huge.bin', crypto.randomBytes(3_000_000));
const sourceZip = new File([await zw.finish().arrayBuffer()], 'source.zip');

const entries = await readZip(sourceZip);
const items = entries.filter(e => !e.dir).map(en =>
  mkItem('zip', { file: sourceZip, entry: en, path: en.name, size: en.size, packed: en.comp, time: en.time, date: en.date }));
assert.equal(items.length, originals.size);

// 2. Try several configurations; each must restore every file byte for byte.
const configs = [
  { name: 'size, keep order', cfg: { limit: 1_000_000, mode: 'size', fit: false }, compress: 'keep' },
  { name: 'size, fewest parts, deflate', cfg: { limit: 1_000_000, mode: 'size', fit: true }, compress: 'deflate' },
  { name: 'file count', cfg: { limit: 1_000_000, mode: 'count', count: 25 }, compress: 'keep' },
  { name: 'by folder', cfg: { limit: 2_000_000, mode: 'folder', fit: false }, compress: 'keep' },
];
for (const c of configs) {
  const cfg = { split: true, manifest: true, pattern: '{name}-{n}', base: 'source', ...c.cfg };
  const plan = planParts(items, cfg);
  assert.ok(plan.parts.length > 1, c.name + ': expected several parts');
  const restored = new Map(), pieces = new Map();
  for (const part of plan.parts) {
    const blob = await buildPart(plan, part, { compress: c.compress, manifest: true });
    if (cfg.mode !== 'count') assert.ok(blob.size <= cfg.limit, `${c.name}: part ${part.n} is ${blob.size} bytes, over the limit`);
    const file = new File([await blob.arrayBuffer()], part.filename);
    for (const en of await readZip(file)) {
      if (en.name === MANIFEST) continue;
      const raw = await entryRaw(file, en);
      const data = Buffer.from(await (en.method === 8 ? await inflateBlob(raw) : raw).arrayBuffer());
      assert.equal(crcOfBytes(data), en.crc, `${c.name}: checksum mismatch in ${en.name}`);
      const m = /^(.*)\.part(\d{3,})$/.exec(en.name);
      if (m && !originals.has(en.name)) { if (!pieces.has(m[1])) pieces.set(m[1], new Map()); pieces.get(m[1]).set(+m[2], data); }
      else restored.set(en.name, data);
    }
  }
  for (const [name, map] of pieces) restored.set(name, Buffer.concat([...map.keys()].sort((a, b) => a - b).map(k => map.get(k))));
  assert.equal(restored.size, originals.size, c.name + ': file count differs');
  for (const [name, data] of originals) assert.ok(restored.get(name)?.equals(data), `${c.name}: ${name} differs`);
  console.log(`ok  ${c.name}: ${plan.parts.length} parts, ${pieces.size} file(s) cut into pieces`);
}

// 3. Sort orders: natural name order, date order and added order.
{
  const mk = (path, id, date) => ({ kind: 'file', id, path, size: 10, packed: 10, nb: path.length, time: 0, date, ext: 'png', top: '' });
  const list = [mk('f10.png', 1, 300), mk('f2.png', 2, 100), mk('f1.png', 3, 200)];
  const order = sort => planParts(list, { limit: 1_000_000, mode: 'size', fit: false, split: true, manifest: false, sort, base: 'x', pattern: '{name}-{n}' }).parts[0].items.map(i => i.path).join();
  assert.equal(order('name'), 'f1.png,f2.png,f10.png');
  assert.equal(order('date'), 'f2.png,f1.png,f10.png');
  assert.equal(order('added'), 'f10.png,f2.png,f1.png');
  console.log('ok  sort orders');
}

// 4. Raw pieces: cut a file, shuffle the pieces, group them and join them back.
{
  const data = crypto.randomBytes(2_500_000);
  const plan = planRaw([{ name: 'movie.mkv', size: data.length }], 1_000_000);
  assert.deepEqual(plan.parts.map(p => p.filename), ['movie.mkv.001', 'movie.mkv.002', 'movie.mkv.003']);
  assert.equal(plan.parts.reduce((a, p) => a + p.bytes, 0), data.length);
  const files = plan.parts.map(p => ({ name: p.filename, size: p.bytes, data: data.subarray(p.start, p.end) })).reverse();
  const [g] = groupRaw(files);
  assert.equal(g.base, 'movie.mkv'); assert.deepEqual(g.missing, []); assert.deepEqual(g.odd, []);
  assert.ok(Buffer.concat(g.order.map(i => g.pieces.get(i).data)).equals(data));
  const gap = groupRaw(files.filter(f => !f.name.endsWith('.002')))[0];
  assert.deepEqual(gap.missing, [2]);
  assert.equal(planRaw([{ name: 'a.bin', size: 5 }, { name: 'a.bin', size: 5 }], 10).parts[1].filename, 'a (2).bin.001');
  assert.equal(planRaw([{ name: 'big', size: 1e9 }], 1).error, true);
  const meta = parseOrderList('hello\n#FS name=movie.mkv size=2500000 crc32=0a0b0c0d pieces=3 piece=1000000\n');
  assert.deepEqual(meta, [{ name: 'movie.mkv', size: 2500000, crc32: '0a0b0c0d', pieces: 3, piece: 1000000 }]);
  console.log('ok  raw pieces: cut, group, gap detection, order list');
}
console.log('All engine tests passed.');
