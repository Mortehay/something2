// backend/tests/describe_audio_slots.test.js
const test = require('node:test');
const assert = require('node:assert');
const { selectSlots, summarize } = require('../scripts/describe-audio-slots');

const S = (kind, key, slot) => ({ kind, key, slot, id: `${kind}/${key}/${slot}` });
const slots = [S('world', 'Vale', 'music'), S('world', 'Vale', 'ambience'), S('creature', 'Wolf', 'hurt'), S('creature', 'Bat', 'hurt')];

test('skip active, keep missing; stale only with --stale', () => {
  const active = new Map([['world/Vale/music', { source_input: 'old' }], ['creature/Wolf/hurt', { source_input: 'same' }]]);
  const current = new Map([['world/Vale/music', 'new'], ['creature/Wolf/hurt', 'same']]);
  let r = selectSlots(slots, active, current, {});
  assert.deepEqual(r.todo.map((s) => s.id), ['world/Vale/ambience', 'creature/Bat/hurt']);
  assert.deepEqual(r.skipped, { written: 1, stale: 1 });
  r = selectSlots(slots, active, current, { stale: true });
  assert.deepEqual(r.todo.map((s) => s.id), ['world/Vale/music'], '--stale rewrites stale rows ONLY');
  assert.deepEqual(r.skipped, { written: 1, stale: 0 }, '--stale counts the active, fresh row (Wolf) it excludes');
});

test('kinds, slot and limit filter', () => {
  const r = selectSlots(slots, new Map(), new Map(), { kinds: ['creature'], slot: 'hurt', limit: 1 });
  assert.deepEqual(r.todo.map((s) => s.id), ['creature/Wolf/hurt']);
});

test('summary counts duplicates ACROSS subjects', () => {
  const sum = summarize([
    { kind: 'creature', key: 'Wolf', ok: true, via: 'box', text: 'a beast' },
    { kind: 'creature', key: 'Bat', ok: true, via: 'fallback', text: 'A Beast' },
    { kind: 'creature', key: 'Rat', ok: false },
  ]);
  assert.deepEqual(sum.creature, { written: 2, failed: 1, box: 1, fallback: 1, duplicates: 1 });
});
