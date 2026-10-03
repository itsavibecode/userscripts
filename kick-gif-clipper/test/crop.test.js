'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { crop: C } = require('../kick-gif-clipper.user.js');

const W = 640, H = 360;
const inside = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H;

test('clamp keeps the rect inside the frame and at least 32x32', () => {
  assert.deepEqual(C.clamp({ x: -20, y: 10, w: 100, h: 50 }, W, H), { x: 0, y: 10, w: 100, h: 50 });
  assert.deepEqual(C.clamp({ x: 600, y: 350, w: 100, h: 50 }, W, H), { x: 540, y: 310, w: 100, h: 50 });
  assert.deepEqual(C.clamp({ x: 10, y: 10, w: 5, h: 5 }, W, H), { x: 10, y: 10, w: 32, h: 32 });
  assert.deepEqual(C.clamp({ x: 0, y: 0, w: 9999, h: 9999 }, W, H), { x: 0, y: 0, w: W, h: H });
});

test('centered preset gives the biggest rect of the aspect', () => {
  assert.deepEqual(C.centered(1, W, H), { x: 140, y: 0, w: 360, h: 360 });
  assert.deepEqual(C.centered(16 / 9, W, H), { x: 0, y: 0, w: 640, h: 360 });
  const p = C.centered(9 / 16, W, H);
  assert.equal(p.h, 360); assert.ok(Math.abs(p.w - 202.5) <= 1);
});

test('fitAspect keeps the centre and the ratio', () => {
  const r = C.fitAspect({ x: 100, y: 50, w: 300, h: 200 }, 1, W, H);
  assert.equal(r.w, r.h);
  assert.ok(Math.abs(r.x + r.w / 2 - 250) <= 1 && Math.abs(r.y + r.h / 2 - 150) <= 1);
});

test('move drag is clamped to the frame', () => {
  const s = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(C.drag(s, 'move', 1000, -1000, W, H), { x: 440, y: 0, w: 200, h: 100 });
});

test('free corner drag moves only that corner', () => {
  const s = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(C.drag(s, 'se', 40, 20, W, H), { x: 100, y: 100, w: 240, h: 120 });
  assert.deepEqual(C.drag(s, 'nw', -40, -20, W, H), { x: 60, y: 80, w: 240, h: 120 });
  assert.deepEqual(C.drag(s, 'e', -500, 0, W, H), { x: 100, y: 100, w: 32, h: 100 });  // min width
});

test('aspect-locked corner drag keeps ratio and the opposite corner', () => {
  const s = { x: 100, y: 100, w: 160, h: 90 };
  const r = C.drag(s, 'se', 80, 0, W, H, 16 / 9);
  assert.equal(r.x, 100); assert.equal(r.y, 100);
  assert.ok(Math.abs(r.w / r.h - 16 / 9) < 0.03, 'ratio ' + r.w / r.h);
  assert.ok(r.w > 160);
});

test('aspect-locked drag never leaves the frame', () => {
  const s = { x: 400, y: 200, w: 160, h: 90 };
  for (const h of C.HANDLES) {
    const r = C.drag(s, h, 900, 900, W, H, 16 / 9);
    assert.ok(inside(r), h + ' ' + JSON.stringify(r));
    assert.ok(Math.abs(r.w / r.h - 16 / 9) < 0.05, h + ' ratio ' + r.w / r.h);
    const q = C.drag(s, h, -900, -900, W, H, 1);
    assert.ok(inside(q), h + ' ' + JSON.stringify(q));
    assert.ok(Math.abs(q.w / q.h - 1) < 0.05, h + ' sq ratio');
  }
});

test('fromPoints draws in any direction and honours aspect', () => {
  assert.deepEqual(C.fromPoints(300, 200, 100, 100, W, H), { x: 100, y: 100, w: 200, h: 100 });
  const r = C.fromPoints(100, 100, 300, 120, W, H, 1);
  assert.equal(r.w, r.h); assert.equal(r.x, 100); assert.equal(r.y, 100);
  const tiny = C.fromPoints(10, 10, 12, 12, W, H);
  assert.equal(tiny.w, 32); assert.equal(tiny.h, 32);
});

test('view letterboxes and maps both ways', () => {
  const v = C.view(640, 360, 800, 600);          // width-bound
  assert.equal(v.scale, 1.25); assert.equal(v.ox, 0); assert.equal(v.oy, 75);
  const p = C.toSource(400, 300, v);
  assert.deepEqual(p, { x: 320, y: 180 });
  const q = C.toView({ x: 320, y: 180, w: 64, h: 36 }, v);
  assert.deepEqual(q, { x: 400, y: 300, w: 80, h: 45 });
});

test('hit finds handles, inside = move, outside = null', () => {
  const v = C.view(640, 360, 640, 360);
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.equal(C.hit(r, v, 100, 100), 'nw');
  assert.equal(C.hit(r, v, 300, 200), 'se');
  assert.equal(C.hit(r, v, 200, 100), 'n');
  assert.equal(C.hit(r, v, 300, 150), 'e');
  assert.equal(C.hit(r, v, 180, 150), 'move');
  assert.equal(C.hit(r, v, 20, 20), null);
});

test('outputSize never upscales and gives even numbers', () => {
  assert.deepEqual(C.outputSize({ x: 0, y: 0, w: 640, h: 360 }, 480), { w: 480, h: 270 });
  assert.deepEqual(C.outputSize({ x: 0, y: 0, w: 300, h: 301 }, 480), { w: 300, h: 300 });
  assert.deepEqual(C.outputSize({ x: 0, y: 0, w: 411, h: 231 }, 480), { w: 410, h: 230 });  // odd crop: round down, never up
  const o = C.outputSize({ x: 0, y: 0, w: 333, h: 187 }, 320);
  assert.equal(o.w % 2, 0); assert.equal(o.h % 2, 0);
});
