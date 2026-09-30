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
  assert.deepEqual(r.skipped, { written: 1, stale: 1, uploadOnly: 0 });
  r = selectSlots(slots, active, current, { stale: true });
  assert.deepEqual(r.todo.map((s) => s.id), ['world/Vale/music'], '--stale rewrites stale rows ONLY');
  assert.deepEqual(r.skipped, { written: 1, stale: 0, uploadOnly: 0 }, '--stale counts the active, fresh row (Wolf) it excludes');
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
  assert.deepEqual(sum.creature, {
    written: 2, failed: 1, changedDuringRun: 0, box: 1, fallback: 1, duplicates: 1,
  });
});

// Final review I3: an sfx entity describes the SOURCE, so one subject's hurt
// and death rightly share a text. Only a text another subject already wrote
// is a duplicate -- the collapse the canary is looking for.
test('the same subject writing one text on two slots is NOT a duplicate', () => {
  const sum = summarize([
    { kind: 'creature', key: 'Bat', ok: true, via: 'box', text: 'a small brown cave bat' },
    { kind: 'creature', key: 'Bat', ok: true, via: 'box', text: 'A small brown cave bat' },
  ]);
  assert.equal(sum.creature.duplicates, 0);
});

test('a text shared by a second subject still counts once per extra subject', () => {
  const sum = summarize([
    { kind: 'creature', key: 'Bat', ok: true, via: 'box', text: 'a beast' },
    { kind: 'creature', key: 'Bat', ok: true, via: 'box', text: 'a beast' },
    { kind: 'creature', key: 'Wolf', ok: true, via: 'box', text: 'a beast' },
    { kind: 'creature', key: 'Wolf', ok: true, via: 'box', text: 'a beast' },
  ]);
  assert.equal(sum.creature.duplicates, 2, "both of Wolf's writes repeat Bat's text; Bat's second does not");
});

// Final review I1: a slot changed since the snapshot is a skip, not a failure.
test('a conflict is counted as changed during run, not as a failure', () => {
  const sum = summarize([
    { kind: 'world', key: 'Vale', ok: false, conflict: true, via: 'box' },
    { kind: 'world', key: 'Dunes', ok: true, via: 'box', text: 'x' },
  ]);
  assert.deepEqual([sum.world.changedDuringRun, sum.world.failed, sum.world.written], [1, 0, 1]);
});

// Final review M4: an sfx slot with no cue can never be generated.
test('upload-only slots are skipped and counted, in both modes', () => {
  const up = { ...S('creature', 'Bat', 'nearby'), uploadOnly: true };
  let r = selectSlots([...slots, up], new Map(), new Map(), {});
  assert.equal(r.todo.some((s) => s.id === up.id), false);
  assert.equal(r.skipped.uploadOnly, 1);
  r = selectSlots([up], new Map([[up.id, { source_input: 'old' }]]), new Map([[up.id, 'new']]), { stale: true });
  assert.deepEqual([r.todo.length, r.skipped.uploadOnly], [0, 1]);
});
