'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../kick-gif-clipper.user.js');

test('fmtHMS keeps counting hours past a day', () => {
  assert.equal(K.fmtHMS(18003), '5:00:03');
  assert.equal(K.fmtHMS(28802), '8:00:02');
  assert.equal(K.fmtHMS(89348.45), '24:49:08');
  assert.equal(K.fmtHMS(59), '0:00:59');
  assert.equal(K.fmtHMS(-3), '0:00:00');
});

test("parseHMS reads Kick's counters (m:ss, h:mm:ss, d:hh:mm:ss)", () => {
  assert.equal(K.parseHMS('21:07:48'), 21 * 3600 + 7 * 60 + 48);
  assert.equal(K.parseHMS(' 5:00:03 '), 18003);
  assert.equal(K.parseHMS('01:00:49:08'), 86400 + 49 * 60 + 8);
  assert.equal(K.parseHMS('12:34'), 754);
  assert.equal(K.parseHMS('7:47 PM'), null);
  assert.equal(K.parseHMS('LIVE'), null);
  assert.equal(K.parseHMS(''), null);
});

test('timeLabel / timeTag for VOD and live', () => {
  assert.equal(K.timeLabel({ kind: 'vod', pos: 18003.4, dur: 28802 }), '5:00:03 / 8:00:02');
  assert.equal(K.timeLabel({ kind: 'live', pos: 4935, dur: 28802 }), '1:22:15 / LIVE');        // live (even rewound)
  assert.equal(K.timeLabel({ kind: 'live', pos: 76068 }), '21:07:48 / LIVE');                   // uptime only
  assert.equal(K.timeLabel({ kind: 'vod', pos: 3304.9, dur: 3304.3 }), '0:55:04 / 0:55:04');    // never pos > total
  assert.equal(K.timeLabel(null), '');
  assert.equal(K.timeTag({ kind: 'vod', pos: 18003.9, dur: 28802 }), 'at-5h00m03s');
  assert.equal(K.timeTag({ kind: 'live', pos: 76068 }), 'live-21h07m48s');
  assert.equal(K.timeTag(null), '');
});
