// Tests for the lossless MP4 joiner and the video strategy decision. Needs Node 20+. Run: npm test
// Files are made with ffmpeg when it is installed; without ffmpeg only the decision tests run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const M = new Function(fs.readFileSync(new URL('../assets/combine-mp4.js', import.meta.url), 'utf8') + ';return CombineMp4;')();

// strategy decision (pure logic)
{
  const t = (o = {}) => ({ handler: 'vide', timescale: 12800, w: 320, h: 240, stsd: 'avc1-A', ...o });
  const au = (o = {}) => ({ handler: 'soun', timescale: 44100, w: 0, h: 0, stsd: 'mp4a-A', ...o });
  const f = (name, tracks) => ({ name, tracks });
  assert.equal(M.plan([f('a', [t(), au()]), f('b', [t(), au()])]).strategy, 'remux');
  let v = M.plan([f('a', [t(), au()]), f('b', [t({ w: 640, h: 360 }), au()])]);
  assert.equal(v.strategy, 'reencode'); assert.match(v.reason, /b is 640×360 but a is 320×240/);
  v = M.plan([f('a', [t(), au()]), f('b', [t({ stsd: 'hvc1' }), au()])]); assert.match(v.reason, /different video format/);
  v = M.plan([f('a', [t(), au()]), f('b', [t()])]); assert.match(v.reason, /different number of tracks/);
  v = M.plan([f('a', [t(), au()]), f('b', [t(), au({ stsd: 'other' })])]); assert.match(v.reason, /different audio format/);
  console.log('ok  strategy decision (same format joins, differences are named)');
}

const have = spawnSync('ffmpeg', ['-version']).status === 0;
if (!have) { console.log('skip  real-file tests (ffmpeg not installed)'); console.log('All mp4 tests passed.'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4t-'));
const ff = (...a) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a]);
const clip = (name, { size = '320x240', secs = 1, hz = 440, audio = true, extra = [], src = 'testsrc' } = {}) => {
  const out = path.join(dir, name);
  const args = ['-f', 'lavfi', '-i', `${src}=size=${size}:rate=25:duration=${secs}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${secs}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', ...(audio ? ['-c:a', 'aac', '-ar', '44100', '-shortest'] : []), ...extra, out);
  ff(...args); return out;
};
const rd = p => { const b = fs.readFileSync(p); return { name: path.basename(p), size: b.length, buf: b, read: async (s, l) => new Uint8Array(b.subarray(s, s + l)) }; };
const assemble = (res, rds) => Buffer.concat(res.parts.map(p => p.bytes ? Buffer.from(p.bytes) : rds[p.src].buf.subarray(p.start, p.end)));
const probe = (p, ...a) => execFileSync('ffprobe', ['-v', 'error', ...a, p]).toString().trim();

// B-frames on, so the index carries composition offsets
const BF = ['-bf', '2'];
const a = clip('a.mp4', { secs: 2, extra: BF }), b = clip('b.mp4', { secs: 3, hz: 880, src: 'testsrc2', extra: BF }), c = clip('c.mp4', { secs: 1, hz: 330, extra: BF });
{
  const rds = [rd(a), rd(b), rd(c)];
  const res = await M.merge(rds);
  const out = path.join(dir, 'out.mp4'); fs.writeFileSync(out, assemble(res, rds));
  assert.equal(fs.statSync(out).size, res.size);
  const frames = +probe(out, '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0');
  assert.equal(frames, 50 + 75 + 25);
  const dur = +probe(out, '-show_entries', 'format=duration', '-of', 'csv=p=0');
  assert.ok(Math.abs(dur - 6) < 0.15, 'duration ' + dur);
  // the whole file decodes without errors
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-']);
  assert.equal(dec.stderr.toString().trim(), '', 'decode errors: ' + dec.stderr);
  // every decoded picture equals the picture of its source file, in order
  const fm = f => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v:0', '-f', 'framemd5', '-']).toString().split('\n').filter(l => l && l[0] !== '#').map(l => l.split(',').pop().trim());
  assert.deepEqual(fm(out), [...fm(a), ...fm(b), ...fm(c)]);
  assert.equal(probe(out, '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0'), 'aac');
  console.log('ok  lossless join of 3 files (' + frames + ' frames, ' + dur.toFixed(2) + ' s, decodes cleanly, order kept)');
  // order matters
  const fm2 = f => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v:0', '-f', 'framemd5', '-']).toString().split('\n').filter(l => l && l[0] !== '#').map(l => l.split(',').pop().trim());
  const rev = [rd(c), rd(a)]; const r2 = await M.merge(rev); const o2 = path.join(dir, 'rev.mp4'); fs.writeFileSync(o2, assemble(r2, rev));
  assert.deepEqual(fm2(o2), [...fm2(c), ...fm2(a)]);
  console.log('ok  reordering changes the output order');
}
{
  // QuickTime (.mov) files join with each other
  const m1 = clip('m1.mov', { secs: 1, extra: BF }), m2 = clip('m2.mov', { secs: 1, hz: 660, extra: BF });
  const rds = [rd(m1), rd(m2)], res = await M.merge(rds), out = path.join(dir, 'm.mov'); fs.writeFileSync(out, assemble(res, rds));
  assert.equal(+probe(out, '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0'), 50);
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-']).stderr.toString().trim(), '');
  // an MP4 and a MOV are different containers, so they are refused with a reason
  await assert.rejects(M.merge([rd(a), rd(m1)]), e => e.kind === 'incompatible');
  console.log('ok  .mov files join with each other; mixing .mp4 and .mov is refused');
}
{
  const d = clip('d.mp4', { size: '640x360' });
  await assert.rejects(M.merge([rd(a), rd(d)]), e => e.kind === 'incompatible' && /640×360 but a\.mp4 is 320×240/.test(e.message));
  const na = clip('na.mp4', { audio: false });
  await assert.rejects(M.merge([rd(a), rd(na)]), e => e.kind === 'incompatible' && /different number of tracks/.test(e.message));
  const fr = clip('frag.mp4', { extra: ['-movflags', '+frag_keyframe+empty_moov'] });
  await assert.rejects(M.merge([rd(a), rd(fr)]), e => e.kind === 'unsupported' && /fragmented/.test(e.message));
  fs.writeFileSync(path.join(dir, 'junk.mp4'), 'not a video at all, just text');
  await assert.rejects(M.merge([rd(a), rd(path.join(dir, 'junk.mp4'))]), e => e.kind === 'unsupported');
  console.log('ok  different size, missing audio, fragmented and damaged files are refused with a reason');
}
fs.rmSync(dir, { recursive: true, force: true });
console.log('All mp4 tests passed.');
