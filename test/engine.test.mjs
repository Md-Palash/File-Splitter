// Round-trip test for the zip engine. Needs Node 20 or newer. Run: npm test
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const code = fs.readFileSync(new URL('../assets/core.js', import.meta.url), 'utf8');
const { readZip, planParts, buildPart, mkItem, ZipWriter, crcOfBytes, entryRaw, inflateBlob, dosFromMs, MANIFEST } =
  new Function(code + ';return {readZip,planParts,buildPart,mkItem,ZipWriter,crcOfBytes,entryRaw,inflateBlob,dosFromMs,MANIFEST};')();

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
console.log('All engine tests passed.');
