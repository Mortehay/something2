// backend/tests/audio_subjects_aura_db.test.js
// SOMET-607 (S5, spec §3.6). The 'aura' audio subject kind: list/exists/
// subjectCues, and that it reaches the registry generically (slotKind,
// GLOBAL_SUBJECT_KINDS) with no per-kind route change -- this ticket's own
// acceptance criterion. Real scratch DB, read-only against aura_effects (no
// writes, nothing to clean up).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const subjects = require('../src/services/audioSubjects');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to read a real database' : false;

test('aura is a known kind with loop/pulse/apply, all sfx, auto-included in GLOBAL_SUBJECT_KINDS', () => {
  assert.ok(subjects.isKnownKind('aura'));
  assert.deepEqual(subjects.SUBJECT_KINDS.aura.slots, { loop: 'sfx', pulse: 'sfx', apply: 'sfx' });
  for (const slot of ['loop', 'pulse', 'apply']) {
    assert.equal(subjects.slotKind('aura', slot), 'sfx', slot);
    assert.ok(subjects.isKnownSlot('aura', slot), slot);
  }
  assert.equal(subjects.isKnownSlot('aura', 'nonexistent'), false);
  assert.ok(subjects.GLOBAL_SUBJECT_KINDS.includes('aura'));
});

test('aura.list and .exists read the real aura_effects catalog', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const names = await subjects.SUBJECT_KINDS.aura.list(pool);
    assert.ok(names.length > 0, 'fixture assumption: at least one aura_effects row exists');
    assert.ok(names.includes('pack_leader'), 'the Champion ally buff seeded by S3');

    const found = await subjects.SUBJECT_KINDS.aura.exists(pool, [...names, 'zzNotARealAura']);
    assert.ok(found.has('pack_leader'));
    assert.equal(found.has('zzNotARealAura'), false);
  } finally {
    await pool.end();
  }
});

test('aura.subjectCues covers every listed aura with all-null (upload-only) cues', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const names = await subjects.SUBJECT_KINDS.aura.list(pool);
    const cues = await subjects.SUBJECT_KINDS.aura.subjectCues(pool);
    assert.deepEqual(Object.keys(cues).sort(), [...names].sort());
    for (const name of names) {
      assert.deepEqual(cues[name], { loop: null, pulse: null, apply: null }, name);
    }
  } finally {
    await pool.end();
  }
});

test('cueFor/entityPhrase never throw for the aura kind and degrade sanely with no cue', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    assert.equal(await subjects.cueFor(pool, 'aura', 'pack_leader', 'loop'), null);
    assert.equal(subjects.entityPhrase(pool, 'aura', 'pack_leader', 'loop'), 'pack_leader');
  } finally {
    await pool.end();
  }
});
