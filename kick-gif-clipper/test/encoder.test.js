'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../kick-gif-clipper.user.js');

/* Minimal GIF89a reader: header, screen, colour tables, GCE delays,
 * NETSCAPE loop, frames, and a real LZW decode of the pixel indices. */
function lzwDecode(minCode, data, pixelCount) {
  const clear = 1 << minCode, eoi = clear + 1, out = new Uint8Array(pixelCount);
  let size = minCode + 1, dict = [], next = 0, prev = null, o = 0, bits = 0, acc = 0, p = 0;
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = null; next = eoi + 1; size = minCode + 1; prev = null; };
  reset();
  while (true) {
    while (bits < size) { if (p >= data.length) return out.subarray(0, o); acc |= data[p++] << bits; bits += 8; }
    const code = acc & ((1 << size) - 1); acc >>>= size; bits -= size;
    if (code === clear) { reset(); continue; }
    if (code === eoi) break;
    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (code === next && prev) entry = prev.concat(prev[0]);
    else throw new Error('bad LZW code ' + code);
    for (const v of entry) if (o < pixelCount) out[o++] = v;
    if (prev && next < 4096) { dict[next++] = prev.concat(entry[0]); if (next === (1 << size) && size < 12) size++; }
    prev = entry;
  }
  return out.subarray(0, o);
}
function parseGif(b) {
  let p = 0;
  const u8 = () => b[p++], u16 = () => { const v = b[p] | (b[p + 1] << 8); p += 2; return v; };
  const sig = String.fromCharCode(...b.slice(0, 6)); p = 6;
  const gif = { sig, width: u16(), height: u16(), frames: [], loop: null };
  const f = u8(); u8(); u8();
  const table = (n) => { const t = []; for (let i = 0; i < n; i++) t.push([u8(), u8(), u8()]); return t; };
  if (f & 0x80) gif.gct = table(1 << ((f & 7) + 1));
  let delay = null;
  const subBlocks = () => { const parts = []; for (let n = u8(); n; n = u8()) { parts.push(b.slice(p, p + n)); p += n; } return Buffer.concat(parts.map((x) => Buffer.from(x))); };
  for (;;) {
    const t = u8();
    if (t === 0x3b) break;
    if (t === 0x21) {
      const label = u8();
      if (label === 0xf9) { u8(); u8(); delay = u16(); u8(); u8(); }
      else if (label === 0xff) {
        const n = u8(); const id = String.fromCharCode(...b.slice(p, p + n)); p += n;
        const data = subBlocks();
        if (id === 'NETSCAPE2.0') gif.loop = data[1] | (data[2] << 8);
      } else subBlocks();
    } else if (t === 0x2c) {
      const x = u16(), y = u16(), w = u16(), h = u16(), lf = u8();
      const lct = lf & 0x80 ? table(1 << ((lf & 7) + 1)) : null;
      const min = u8();
      const idx = lzwDecode(min, subBlocks(), w * h);
      gif.frames.push({ x, y, w, h, delay, lct, idx });
      delay = null;
    } else throw new Error('unexpected block 0x' + t.toString(16) + ' at ' + (p - 1));
  }
  return gif;
}

// 10 synthetic frames: 4 colour quadrants that rotate each frame.
const COLORS = [[255, 0, 0], [0, 200, 0], [0, 0, 255], [240, 240, 240]];
function frame(w, h, k) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const q = ((x < w / 2 ? 0 : 1) + (y < h / 2 ? 0 : 2) + k) % 4, p = (y * w + x) * 4;
    d[p] = COLORS[q][0]; d[p + 1] = COLORS[q][1]; d[p + 2] = COLORS[q][2]; d[p + 3] = 255;
  }
  return { data: d, width: w, height: h };
}
const W = 40, H = 24;
const frames = Array.from({ length: 10 }, (_, k) => frame(W, H, k));
const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= 12;

for (const palette of ['global', 'frame']) {
  test('round trip, ' + palette + ' palette: header, loop, frame count, delays, pixels', () => {
    const bytes = K.encodeGif(frames, { fps: 15, speed: 1, loop: 'forever', palette, dither: 'none' });
    const g = parseGif(bytes);
    assert.equal(g.sig, 'GIF89a');
    assert.equal(g.width, W); assert.equal(g.height, H);
    assert.equal(g.loop, 0, 'NETSCAPE loop forever');
    assert.equal(g.frames.length, 10);
    for (const f of g.frames) { assert.equal(f.delay, 7); assert.equal(f.w, W); assert.equal(f.idx.length, W * H); }
    if (palette === 'global') assert.ok(g.frames.every((f) => !f.lct), 'no local tables');
    else assert.ok(g.frames.slice(1).every((f) => f.lct), 'local tables after frame 1');
    g.frames.forEach((f, k) => {
      const pal = f.lct || g.gct, src = frames[k].data;
      for (const [x, y] of [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3], [W / 2, H / 2]]) {
        const i = y * W + x, got = pal[f.idx[i]], want = [src[i * 4], src[i * 4 + 1], src[i * 4 + 2]];
        assert.ok(near(got, want), `frame ${k} (${x},${y}) got ${got} want ${want}`);
      }
    });
  });
}

test('loop settings map to the NETSCAPE block', () => {
  assert.equal(parseGif(K.encodeGif(frames.slice(0, 2), { loop: 'once' })).loop, null);   // no block = play once
  assert.equal(parseGif(K.encodeGif(frames.slice(0, 2), { loop: '3' })).loop, 2);          // 3 plays = 2 repeats
  assert.equal(parseGif(K.encodeGif(frames.slice(0, 2), { loop: 'forever' })).loop, 0);
});

test('delays follow fps and speed in hundredths (effective fps shown)', () => {
  assert.equal(K.delayCs(15, 1), 7);
  assert.equal(K.delayCs(24, 1), 4);
  assert.equal(K.delayCs(10, 2), 5);
  assert.equal(K.delayCs(60, 2), 2);         // never below 2 (browsers turn 0/1 into 10)
  assert.equal(K.effectiveFps(24, 1), 25);
  const g = parseGif(K.encodeGif(frames.slice(0, 3), { fps: 10, speed: 0.5 }));
  assert.ok(g.frames.every((f) => f.delay === 20));
});

test('dithered exports still decode to the right size', () => {
  for (const dither of ['ordered', 'fs']) {
    const g = parseGif(K.encodeGif(frames, { dither, palette: 'global' }));
    assert.equal(g.frames.length, 10);
    assert.ok(g.frames.every((f) => f.idx.length === W * H));
  }
});

test('worker protocol (stringified core, like the Blob-URL worker) produces the same bytes', async () => {
  // Build the worker source exactly as the userscript does and run it with a fake `self`.
  const src = '"use strict";const CORE=(' + K.makeCore.toString() + ')();(' + K.workerMain.toString() + ')(CORE,self);';
  const posted = [];
  const self = { postMessage: (m) => posted.push(m), onmessage: null };
  new Function('self', src)(self);
  const opts = { width: W, height: H, loop: 'forever', dither: 'ordered', palette: 'global' };
  const send = (data) => self.onmessage({ data });
  send({ type: 'init', opts, total: frames.length });
  for (const i of K.evenlySpaced(frames.length, 12)) send({ type: 'sample', buf: frames[i].data.slice().buffer, w: W, h: H });
  for (const f of frames) send({ type: 'frame', buf: f.data.slice().buffer, delayCs: 7 });
  send({ type: 'finish' });
  assert.equal(posted.filter((m) => m.type === 'progress').length, 10);
  const done = posted.find((m) => m.type === 'done');
  assert.ok(done, JSON.stringify(posted.find((m) => m.type === 'error')));
  const direct = K.encodeGif(frames, { dither: 'ordered', palette: 'global', delayCs: 7 });
  assert.deepEqual(Buffer.from(done.bytes), Buffer.from(direct));
});

test('helpers: evenlySpaced, fileName, fmtTime, decimateByTime', () => {
  assert.deepEqual(K.evenlySpaced(5, 12), [0, 1, 2, 3, 4]);
  const e = K.evenlySpaced(100, 12); assert.equal(e.length, 12); assert.equal(e[0], 0); assert.equal(e[11], 99);
  const d = new Date(2026, 9, 2, 14, 12, 33);
  assert.equal(K.fileName('kick_{channel}_{date}.gif', 'deenthegreat', d), 'kick_deenthegreat_20261002-141233.gif');
  assert.equal(K.fileName('a/b:{channel}', 'x', d), 'a_b_x.gif');
  assert.equal(K.fmtTime(12400), '00:12.4');
  assert.equal(K.fmtTime(61050), '01:01.0');
  const fr = Array.from({ length: 30 }, (_, i) => ({ t: i * 1000 / 15 }));
  const thin = K.decimateByTime(fr, 10);
  assert.ok(thin.length >= 19 && thin.length <= 21, 'decimated to ' + thin.length);
});
