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

const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { withAdvisoryLock, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');
const { existingBindingSubjects } = require('../src/services/audioSeed');
const { allSlots } = require('../scripts/describe-audio-slots');

const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

test('every door refuses a boss slot on an ordinary creature; demotion hides boss slots', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {}, removeObject: async () => {} });
  const tag = `${process.pid}-${Date.now()}`;
  const TEMP_BOSS = `zz-s2-boss-${tag}`; // our own row, so we may demote it
  const TEMP_PLAIN = `zz-s2-plain-${tag}`; // our own ordinary creature: its misses are ours to write and delete
  const clipIds = [];
  let userId = null;
  try {
    await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
      try {
        await pool.query(
          `INSERT INTO entity_types (name, is_creature, color, hp, boss_tier, element)
           VALUES ($1, true, '#123456', 100, 'world', 'fire')`, [TEMP_BOSS]);
        await pool.query(
          `INSERT INTO entity_types (name, is_creature, color, hp) VALUES ($1, true, '#654321', 100)`, [TEMP_PLAIN]);
        const u = (await pool.query(
          "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, username, role, token_version",
          [`s2-admin-${tag}`])).rows[0];
        userId = u.id;
        const auth = `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.token_version })}`;
        const clip = await lib.storeClip(pool, { buffer: OGG, kind: 'sfx', label: `s2 boss ${tag}`, source: 'uploaded', durationMs: 500 });
        clipIds.push(clip.id);

        // Door 1: POST /admin/bindings (bind-from-library) -> 400 for Slime/presence.
        const bad = await request(app).post('/api/audio/admin/bindings').set('Authorization', auth)
          .send({ subject_kind: 'creature', subject_key: PLAIN, slot: 'presence', clip_id: clip.id });
        assert.equal(bad.status, 400);
        assert.match(bad.body.error, /has no 'presence' slot/);
        const ok = await request(app).post('/api/audio/admin/bindings').set('Authorization', auth)
          .send({ subject_kind: 'creature', subject_key: TEMP_BOSS, slot: 'presence', clip_id: clip.id });
        assert.equal(ok.status, 201);

        // Door 2: bindClip directly (generate/upload/queued-job paths all land here).
        await assert.rejects(
          lib.bindClip(pool, { subjectKind: 'creature', subjectKey: PLAIN, slot: 'enrage', clipId: clip.id }),
          (err) => err.status === 400 && /has no 'enrage' slot/.test(err.message));

        // Door 3: a game client's miss report, through the player-reachable route.
        const missBefore = (await pool.query(
          "SELECT count(*)::int AS n FROM audio_misses WHERE subject_key = $1 AND slot = 'presence'", [PLAIN])).rows[0].n;
        const dropped = await request(app).post('/api/audio/misses').set('Authorization', auth)
          .send({ misses: [{ subject_kind: 'creature', subject_key: PLAIN, slot: 'presence', world: null }] });
        assert.equal(dropped.status, 200);
        assert.equal(dropped.body.accepted, 0);
        const kept = await request(app).post('/api/audio/misses').set('Authorization', auth)
          .send({ misses: [
            { subject_kind: 'creature', subject_key: PLAIN, slot: 'presence', world: null },
            { subject_kind: 'creature', subject_key: TEMP_BOSS, slot: 'presence', world: null },
            { subject_kind: 'creature', subject_key: TEMP_PLAIN, slot: 'hurt', world: null },
          ] });
        assert.equal(kept.body.accepted, 2, 'boss slot kept for the boss, base slot kept for the ordinary creature');
        const missAfter = (await pool.query(
          "SELECT count(*)::int AS n FROM audio_misses WHERE subject_key = $1 AND slot = 'presence'", [PLAIN])).rows[0].n;
        assert.equal(missAfter, missBefore, 'no junk miss row for an ordinary creature boss slot');

        // Door 4: a seed manifest.
        const seen = await existingBindingSubjects(pool, [
          { subject_kind: 'creature', subject_key: PLAIN, slot: 'spawn' },
          { subject_kind: 'creature', subject_key: PLAIN, slot: 'hurt' },
          { subject_kind: 'creature', subject_key: TEMP_BOSS, slot: 'spawn' },
        ]);
        assert.deepEqual([...seen].sort(), [`creature/${PLAIN}/hurt`, `creature/${TEMP_BOSS}/spawn`].sort());

        // The tab: /admin/subjects sends per-subject slots for creatures only.
        const subj = await request(app).get('/api/audio/admin/subjects').set('Authorization', auth);
        assert.equal(subj.status, 200);
        const creature = subj.body.find((g) => g.kind === 'creature');
        assert.deepEqual(creature.subjectSlots[PLAIN], ['nearby', 'attack', 'hurt', 'death']);
        assert.equal(creature.subjectSlots[TEMP_BOSS].includes('presence'), true);
        assert.equal(subj.body.find((g) => g.kind === 'world').subjectSlots, undefined);
        assert.equal(Object.hasOwn(creature.cues[PLAIN], 'presence'), false);

        // The prompt writer's slot list.
        const every = await allSlots(pool);
        assert.equal(every.some((s) => s.id === `creature/${PLAIN}/presence`), false);
        assert.equal(every.some((s) => s.id === `creature/${TEMP_BOSS}/presence`), true);

        // Demotion: boss slots vanish from /admin/slots and /admin/prompts, binds are refused,
        // the existing binding row stays (re-promotion brings it back), nothing throws.
        await pool.query('UPDATE entity_types SET boss_tier = NULL WHERE name = $1', [TEMP_BOSS]);
        const slots = await request(app).get(`/api/audio/admin/slots/creature/${encodeURIComponent(TEMP_BOSS)}`).set('Authorization', auth);
        assert.equal(slots.status, 200);
        assert.deepEqual(Object.keys(slots.body), ['nearby', 'attack', 'hurt', 'death']);
        const prompts = await request(app).get(`/api/audio/admin/prompts/creature/${encodeURIComponent(TEMP_BOSS)}`).set('Authorization', auth);
        assert.deepEqual(Object.keys(prompts.body), ['nearby', 'attack', 'hurt', 'death']);
        const again = await request(app).post('/api/audio/admin/bindings').set('Authorization', auth)
          .send({ subject_kind: 'creature', subject_key: TEMP_BOSS, slot: 'spawn', clip_id: clip.id });
        assert.equal(again.status, 400);
        const rows = await pool.query("SELECT 1 FROM audio_bindings WHERE subject_key = $1 AND slot = 'presence'", [TEMP_BOSS]);
        assert.equal(rows.rowCount, 1, 'demotion does not delete bindings');
      } finally {
        const names = [TEMP_BOSS, TEMP_PLAIN];
        const steps = [
          () => pool.query('DELETE FROM audio_misses WHERE subject_key = ANY($1)', [names]),
          () => pool.query('DELETE FROM audio_bindings WHERE subject_key = ANY($1)', [names]),
          () => (clipIds.length ? pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clipIds]) : null),
          () => pool.query('DELETE FROM entity_types WHERE name = ANY($1)', [names]),
          () => (userId ? pool.query('DELETE FROM users WHERE id = $1', [userId]) : null),
        ];
        // Each step guarded on its own, so one failure cannot strand the rest.
        for (const step of steps) {
          // eslint-disable-next-line no-await-in-loop
          try { await step(); } catch (e) { console.error('cleanup step failed', e.message); }
        }
      }
    });
  } finally { await pool.end(); }
});
