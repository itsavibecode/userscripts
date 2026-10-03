'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../kick-gif-clipper.user.js');

test('boomerang plays forward then back without repeating the ends', () => {
  assert.deepEqual(K.timeline.boomerang([0, 1, 2, 3]), [0, 1, 2, 3, 2, 1]);
  assert.deepEqual(K.timeline.boomerang([5, 9]), [5, 9]);
  assert.deepEqual(K.timeline.boomerang([]), []);
  // works on thinned / cut sequences too
  const seq = K.timeline.resample(K.timeline.keptIndices(K.timeline.remove(K.timeline.reset(10), { from: 3, to: 6 })), 15, 15);
  assert.deepEqual(K.timeline.boomerang(seq), [0, 1, 2, 6, 7, 8, 9, 8, 7, 6, 2, 1]);
});

test('caption wrap fits lines to the width (monospace measure)', () => {
  const m = (s) => s.length * 10;            // 10 units per character
  assert.deepEqual(K.wrapText('when the stream hits', 100, m), ['when the', 'stream', 'hits']);
  assert.deepEqual(K.wrapText('short', 100, m), ['short']);
  assert.deepEqual(K.wrapText('  ', 100, m), []);
  assert.deepEqual(K.wrapText('a\nb c', 100, m), ['a', 'b c']);
  const long = K.wrapText('supercalifragilistic', 100, m);  // 20 chars into 10-char lines
  assert.deepEqual(long, ['supercalif', 'ragilistic']);
  for (const l of K.wrapText('one two three four five six seven', 70, m)) assert.ok(m(l) <= 70, l);
});

test('pickSize keeps quality as high as fits, width first, fps >= 10 when possible', () => {
  const widths = [480, 400, 360, 320, 280, 240], fpss = [5, 8, 10, 12, 15];
  const cands = []; for (const w of widths) for (const fps of fpss) cands.push({ w, fps });
  const cur = { w: 480, fps: 15 };
  // 20 MB at 480/15, target 10 MB: needs ~0.46x of w^2*fps
  const p = K.pickSize(cands, cur, 20e6, 10e6);
  const pred = (c) => 20e6 * (c.w * c.w * c.fps) / (480 * 480 * 15);
  assert.ok(pred(p) <= 10e6 * 0.92, JSON.stringify(p));
  assert.ok(p.fps >= 10);
  // nothing better fits -> best possible is still the largest under target
  for (const c of cands) if (pred(c) <= 10e6 * 0.92 && c.fps >= 10) assert.ok(pred(c) <= pred(p) + 1);
  // already tiny: nothing smaller than cur -> null
  assert.equal(K.pickSize([{ w: 480, fps: 15 }], cur, 20e6, 10e6), null);
  // impossible target -> smallest candidate
  assert.deepEqual(K.pickSize(cands, cur, 20e6, 1e3), { w: 240, fps: 5 });
});

/* --- minimal EBML reader for the WebM test --- */
function vint(b, p, keepMarker) {
  const first = b[p]; let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  let v = keepMarker ? first : first & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + b[p + i];
  return { v, len };
}
const MASTER = new Set([0x1A45DFA3, 0x18538067, 0x1549A966, 0x1654AE6B, 0xAE, 0xE0, 0x1F43B675]);
function parse(b, p, end) {
  const out = [];
  while (p < end) {
    const id = vint(b, p, true); p += id.len;
    const sz = vint(b, p, false); p += sz.len;
    const node = { id: id.v, start: p, size: sz.v };
    if (MASTER.has(id.v)) node.kids = parse(b, p, p + sz.v);
    else node.data = b.subarray(p, p + sz.v);
    out.push(node); p += sz.v;
  }
  return out;
}
const find = (nodes, id) => nodes.find((n) => n.id === id);
const all = (nodes, id) => nodes.filter((n) => n.id === id);
const uint = (d) => d.reduce((a, x) => a * 256 + x, 0);
const str = (d) => String.fromCharCode(...d);

test('WebM muxer round trip: header, track, clusters, blocks', () => {
  const frames = [];
  for (let i = 0; i < 90; i++) frames.push({ data: new Uint8Array(200 + (i % 7)).fill(i & 255), tsMs: i * 1000 / 15, key: i % 30 === 0 });
  const bytes = K.muxWebM({ width: 480, height: 270, codecId: 'V_VP9', frames, durationMs: 6000 });
  const top = parse(bytes, 0, bytes.length);
  assert.equal(top.length, 2);
  const hdr = find(top, 0x1A45DFA3);
  assert.equal(str(find(hdr.kids, 0x4282).data), 'webm');
  const seg = find(top, 0x18538067);
  const info = find(seg.kids, 0x1549A966);
  assert.equal(uint(find(info.kids, 0x2AD7B1).data), 1000000);
  assert.equal(new DataView(find(info.kids, 0x4489).data.buffer, find(info.kids, 0x4489).data.byteOffset, 8).getFloat64(0), 6000);
  const te = find(find(seg.kids, 0x1654AE6B).kids, 0xAE);
  assert.equal(str(find(te.kids, 0x86).data), 'V_VP9');
  const video = find(te.kids, 0xE0);
  assert.equal(uint(find(video.kids, 0xB0).data), 480);
  assert.equal(uint(find(video.kids, 0xBA).data), 270);
  const clusters = all(seg.kids, 0x1F43B675);
  assert.equal(clusters.length, 3, 'a new cluster at each keyframe');
  let n = 0, lastT = -1;
  for (const cl of clusters) {
    const base = uint(find(cl.kids, 0xE7).data);
    all(cl.kids, 0xA3).forEach((blk, j) => {
      const d = blk.data;
      assert.equal(d[0], 0x81, 'track 1');
      const rel = (d[1] << 8) | d[2];
      const t = base + rel;
      assert.ok(t > lastT, 'timestamps increase'); lastT = t;
      assert.equal(Math.round(frames[n].tsMs), t);
      assert.equal(!!(d[3] & 0x80), frames[n].key, 'keyframe flag ' + n);
      assert.equal(j === 0, frames[n].key, 'clusters start on keyframes');
      assert.equal(d.length - 4, frames[n].data.length);
      n++;
    });
  }
  assert.equal(n, 90);
});

test('WebM muxer splits long gaps into new clusters (int16 block offsets)', () => {
  const frames = [{ data: new Uint8Array(4), tsMs: 0, key: true }, { data: new Uint8Array(4), tsMs: 40000, key: false }];
  const bytes = K.muxWebM({ width: 2, height: 2, codecId: 'V_VP8', frames, durationMs: 40100 });
  const seg = find(parse(bytes, 0, bytes.length), 0x18538067);
  assert.equal(all(seg.kids, 0x1F43B675).length, 2);
});

test('fileName swaps the extension for WebM', () => {
  const d = new Date(2026, 9, 2, 14, 12, 33);
  assert.equal(K.fileName('kick_{channel}_{date}.gif', 'deen', d, 'webm'), 'kick_deen_20261002-141233.webm');
  assert.equal(K.fileName('kick_{channel}_{date}.gif', 'deen', d), 'kick_deen_20261002-141233.gif');
  assert.equal(K.fileName('clip_{channel}', 'deen', d, 'webm'), 'clip_deen.webm');
});
