'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { timeline: T } = require('../kick-gif-clipper.user.js');

test('reset covers every frame, empty for zero', () => {
  assert.deepEqual(T.reset(10), [{ from: 0, to: 10 }]);
  assert.deepEqual(T.reset(0), []);
});

test('keep trims to the selection (either handle order)', () => {
  assert.deepEqual(T.keep(T.reset(10), { from: 2, to: 6 }), [{ from: 2, to: 6 }]);
  assert.deepEqual(T.keep(T.reset(10), { from: 6, to: 2 }), [{ from: 2, to: 6 }]);
});

test('remove cuts the middle out and leaves two segments', () => {
  const s = T.remove(T.reset(10), { from: 3, to: 7 });
  assert.deepEqual(s, [{ from: 0, to: 3 }, { from: 7, to: 10 }]);
  assert.equal(T.count(s), 6);
  assert.deepEqual(T.keptIndices(s), [0, 1, 2, 7, 8, 9]);
});

test('keep across a cut keeps both sides of it', () => {
  const s = T.remove(T.reset(20), { from: 5, to: 10 });
  assert.deepEqual(T.keep(s, { from: 2, to: 15 }), [{ from: 2, to: 5 }, { from: 10, to: 15 }]);
});

test('removing a gap neighbour then resetting restores all', () => {
  let s = T.remove(T.reset(10), { from: 0, to: 2 });
  s = T.remove(s, { from: 8, to: 10 });
  assert.deepEqual(s, [{ from: 2, to: 8 }]);
  assert.deepEqual(T.reset(10), [{ from: 0, to: 10 }]);
});

test('normalize merges adjacent and overlapping segments and drops empties', () => {
  assert.deepEqual(T.normalize([{ from: 5, to: 8 }, { from: 0, to: 5 }, { from: 7, to: 9 }, { from: 3, to: 3 }]), [{ from: 0, to: 9 }]);
});

test('removing everything gives an empty list (the UI refuses it)', () => {
  assert.equal(T.count(T.remove(T.reset(5), { from: 0, to: 5 })), 0);
  assert.equal(T.count(T.keep(T.remove(T.reset(10), { from: 2, to: 6 }), { from: 3, to: 5 })), 0);
});

test('isKept and durationMs', () => {
  const s = T.remove(T.reset(30), { from: 10, to: 20 });
  assert.equal(T.isKept(s, 9), true);
  assert.equal(T.isKept(s, 10), false);
  assert.equal(T.isKept(s, 20), true);
  assert.equal(T.durationMs(s, 15), 20 * 1000 / 15);
});

test('resample keeps every frame at equal fps and thins by ratio when lower', () => {
  const idx = Array.from({ length: 15 }, (_, i) => i);
  assert.deepEqual(T.resample(idx, 15, 15), idx);
  assert.deepEqual(T.resample(idx, 15, 20), idx);            // never invents frames
  const ten = T.resample(idx, 15, 10);                         // every 1.5th
  assert.equal(ten.length, 10);
  assert.deepEqual(ten.slice(0, 4), [0, 1, 3, 4]);
  assert.equal(T.resample(idx, 15, 5).length, 5);
});

test('resample walks kept indices, not source indices', () => {
  const kept = T.keptIndices(T.remove(T.reset(12), { from: 2, to: 8 })); // 0,1,8..11
  assert.deepEqual(T.resample(kept, 12, 6), [0, 8, 10]);
});
