// SOMET-605 (S2, spec §3.6): boss slots (spawn/presence/phase/enrage) exist
// only on creature rows with a boss_tier. Every door that can create a
// binding, a miss, a prompt or a job asks the registry WITH the slot, so an
// ordinary creature can never grow one. Reads seeded catalog rows only;
// any rows this file writes are its own and are removed inside the lock.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const subjects = require('../src/services/audioSubjects');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;
const BOSS = 'Ignis, the Magma Colossus'; // boss_tier 'world' (S1 seed)
const PLAIN = 'Slime'; // ordinary creature

test('registry: boss slots only on boss-tier creatures', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('vocabulary: every creature slot is an sfx slot, boss ones included', () => {
    for (const s of ['nearby', 'attack', 'hurt', 'death', 'spawn', 'presence', 'phase', 'enrage']) {
      assert.equal(subjects.slotKind('creature', s), 'sfx', s);
    }
    assert.equal(subjects.slotKind('creature', 'music'), null);
  });

  await t.test('subjectSlotNames: a boss carries 8 slots, an ordinary creature exactly the base 4', async () => {
    const by = await subjects.SUBJECT_KINDS.creature.subjectSlotNames(pool, [BOSS, PLAIN, 'no-such-creature']);
    assert.deepEqual(by[PLAIN], ['nearby', 'attack', 'hurt', 'death']);
    assert.deepEqual(by[BOSS], ['nearby', 'attack', 'hurt', 'death', 'spawn', 'presence', 'phase', 'enrage']);
    assert.equal(by['no-such-creature'], undefined);
  });

  await t.test('existingSubjects with a boss slot keeps only boss rows; a base slot keeps both', async () => {
    assert.deepEqual([...await subjects.existingSubjects(pool, 'creature', [BOSS, PLAIN], 'presence')], [BOSS]);
    assert.deepEqual([...await subjects.existingSubjects(pool, 'creature', [BOSS, PLAIN], 'hurt')].sort(), [BOSS, PLAIN].sort());
    // Omitted slot = today's meaning (the subject exists at all).
    assert.deepEqual([...await subjects.existingSubjects(pool, 'creature', [PLAIN])], [PLAIN]);
    assert.equal(await subjects.subjectExists(pool, 'creature', PLAIN, 'enrage'), false);
    assert.equal(await subjects.subjectExists(pool, 'creature', BOSS, 'enrage'), true);
  });

  await t.test('slotNamesFor / slotsBySubject: per subject for creature, the whole vocabulary elsewhere', async () => {
    assert.deepEqual(await subjects.slotNamesFor(pool, 'creature', PLAIN), ['nearby', 'attack', 'hurt', 'death']);
    assert.equal((await subjects.slotNamesFor(pool, 'creature', BOSS)).includes('presence'), true);
    assert.deepEqual(await subjects.slotNamesFor(pool, 'creature', 'no-such-creature'), []);
    assert.deepEqual(await subjects.slotNamesFor(pool, 'attack_type', 'melee'), ['use', 'hit']);
    const all = await subjects.slotsBySubject(pool, 'creature');
    assert.equal(all[PLAIN].includes('presence'), false);
    assert.equal(all[BOSS].includes('presence'), true);
  });

  await t.test('subjectCues: boss slots are upload-only (null) on a boss, absent on an ordinary creature', async () => {
    const cues = await subjects.SUBJECT_KINDS.creature.subjectCues(pool);
    assert.deepEqual(cues[PLAIN], { nearby: null, attack: null, hurt: 'hit', death: 'death' });
    assert.deepEqual(cues[BOSS], {
      nearby: null, attack: null, hurt: 'hit', death: 'death', spawn: null, presence: null, phase: null, enrage: null,
    });
    assert.equal(await subjects.cueFor(pool, 'creature', BOSS, 'presence'), null);
  });
});
