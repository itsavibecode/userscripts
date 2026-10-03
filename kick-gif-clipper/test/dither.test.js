'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dither: D } = require('../kick-gif-clipper.user.js');

// Horizontal grey gradient, 0 -> 255 across the width.
function gradient(w, h) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.round(x * 255 / (w - 1)), p = (y * w + x) * 4;
    a[p] = a[p + 1] = a[p + 2] = v; a[p + 3] = 255;
  }
  return a;
}
const BW = [[0, 0, 0], [255, 255, 255]];
// Mean brightness of output in a column band, 0..255.
function bandMean(idx, w, h, x0, x1) {
  let s = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) { s += idx[y * w + x] ? 255 : 0; n++; }
  return s / n;
}

const w = 256, h = 32, img = gradient(w, h);

test('none = hard threshold (no in-between tones)', () => {
  const idx = D.none(img, w, h, BW);
  assert.equal(bandMean(idx, w, h, 0, 100), 0);
  assert.equal(bandMean(idx, w, h, 156, 256), 255);
});

for (const mode of ['ordered', 'fs']) {
  test(mode + ' keeps the local average brightness of a gradient', () => {
    const idx = D[mode](img, w, h, BW);
    assert.equal(idx.length, w * h);
    for (let x0 = 0; x0 < w; x0 += 32) {
      const want = (x0 + 15.5) * 255 / (w - 1);
      const got = bandMean(idx, w, h, x0, x0 + 32);
      assert.ok(Math.abs(got - want) < 20, `${mode} band ${x0}: want ~${want.toFixed(0)} got ${got.toFixed(0)}`);
    }
  });
  test(mode + ' produces a mix of both colours in the middle', () => {
    const idx = D[mode](img, w, h, BW);
    const m = bandMean(idx, w, h, 112, 144);
    assert.ok(m > 60 && m < 200, 'middle mean ' + m);
  });
}

test('ordered uses the Bayer 4x4 pattern (repeats every 4 px on flat grey)', () => {
  const flat = new Uint8ClampedArray(16 * 16 * 4).fill(128);
  const idx = D.ordered(flat, 16, 16, BW);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) assert.equal(idx[y * 16 + x], idx[(y % 4) * 16 + (x % 4)]);
  const on = idx.reduce((a, b) => a + b, 0);
  assert.equal(on, 128);                      // exactly half of a 50% grey
});

test('with a rich palette dithering stays close to the source colours', () => {
  const pal = [];
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) pal.push([r, g, b]);
  for (const mode of ['none', 'ordered', 'fs']) {
    const idx = D.apply(mode, img, w, h, pal);
    let err = 0;
    for (let i = 0; i < w * h; i++) err += Math.abs(pal[idx[i]][0] - img[i * 4]);
    assert.ok(err / (w * h) < 30, mode + ' mean error ' + err / (w * h));
  }
});
