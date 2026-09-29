// backend/tests/audio_subjects_sfx_db.test.js
//
// Game audio slice 3, Task 2: the new SUBJECT_KINDS entries (creature,
// world_point, attack_type, item, skill), cueFor/entityPhrase, and
// worldAudioBundle's global bindings. Real scratch DB, fake MinIO client --
// only reads real catalog rows (entity_types, item_types, skills.js), never
// mutates them; the only writes are this test's own audio_bindings/
// audio_clips/audio_misses rows, cleaned up in t.after.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');
const subjects = require('../src/services/audioSubjects');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

// Real, stable seeded rows this file only ever READS -- never inserted or
// deleted, per common.md ("never touch catalog tables except rows your test
// itself created").
const CREATURE = 'Slime'; // entity_types.is_creature
const WORLD_POINT = 'waypoint_stone'; // entity_types.point_kind = 'waypoint'
const ITEM_MELEE = 'dagger'; // item_types: kind='melee'
// A gear-ladder bow, NOT the legacy 'bow' row -- the gear-ladder generator
// never wires ammo_type_id (verified against the live schema), so this only
// resolves to 'ranged' via attackKindOf's getWeaponCategory(name) fallback.
// Using this rather than the ammo-wired legacy row is the point: it is what
// actually proves the controller-ruling fix, not just the pure-function test.
const ITEM_RANGED = 'crude-bow'; // item_types: kind='projectile', ammo_type_id NULL
const ITEM_MAGIC = 'apprentice staff'; // item_types: kind='projectile', ammo_type_id NULL
const SKILL_MELEE = 'war_crushing_blow'; // skills.js: type='melee'
const SKILL_MAGIC = 'war_shockwave'; // skills.js: type='magic'
const SKILL_BUFF = 'war_battle_shout'; // skills.js: type='buff'

test('audio subjects: creature/world_point/attack_type/item/skill', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  // AUDIO_CLIPS_LOCK_KEY: see advisoryLock.js -- delete-unbound deletes every
  // unbound clip in the database, so clip-creating bodies are serialized with it.
  await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
    assetStore.__setAssetClient({
      bucketExists: async () => true,
      putObject: async () => {},
    });
    const tag = `${process.pid}-${Date.now()}`;
    const worldName = `sfx-test-world-${tag}`;
    const clipIds = [];
    let worldId;
    t.after(async () => {
      try {
        if (clipIds.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clipIds]);
        // Scoped to the exact (subject_kind, subject_key, slot) triples this
        // test records via recordMisses below, AND to this test's own unique
        // `world` tag. subject_key alone (CREATURE/'ranged'/ITEM_MELEE/
        // SKILL_MELEE) is a real, shared catalog value -- the new subject
        // kinds validate existence server-side, so there is no synthetic
        // key to record a miss against instead -- and node --test runs
        // files in parallel, so an unscoped `subject_key = ANY(...)` delete
        // could remove a peer test file's miss row for the same subject.
        // `world` is upserted to whichever caller recorded most recently
        // (recordMisses' ON CONFLICT ... world = EXCLUDED.world), and
        // worldName is unique per test run (pid + Date.now()), so adding it
        // as a fourth condition means this can only ever match the rows
        // THIS test's own recordMisses call touched.
        await pool.query(
          `DELETE FROM audio_misses WHERE world = $4 AND (subject_kind, subject_key, slot) IN (
             SELECT * FROM unnest($1::text[], $2::text[], $3::text[]))`,
          [
            ['creature', 'attack_type', 'item', 'skill'],
            [CREATURE, 'ranged', ITEM_MELEE, SKILL_MELEE],
            ['nearby', 'use', 'use', 'use'],
            worldName,
          ],
        );
        if (worldId) await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
      } finally { await pool.end(); }
    });
    worldId = (await pool.query(
      'INSERT INTO worlds (name, seed, biomes) VALUES ($1, 1, $2::jsonb) RETURNING id',
      [worldName, JSON.stringify([])],
    )).rows[0].id;

    const storeSfx = async (label) => {
      const c = await lib.storeClip(pool, {
        buffer: OGG, kind: 'sfx', label, source: 'uploaded', durationMs: 500,
      });
      clipIds.push(c.id);
      return c;
    };

    await t.test('list/exists: creature, world_point, attack_type, item, skill', async () => {
      assert.ok((await subjects.SUBJECT_KINDS.creature.list(pool)).includes(CREATURE));
      assert.ok((await subjects.SUBJECT_KINDS.world_point.list(pool)).includes(WORLD_POINT));
      assert.deepEqual(await subjects.SUBJECT_KINDS.attack_type.list(pool), ['melee', 'ranged', 'magic']);
      assert.ok((await subjects.SUBJECT_KINDS.item.list(pool)).includes(ITEM_MELEE));
      assert.ok((await subjects.SUBJECT_KINDS.skill.list(pool)).includes(SKILL_MELEE));

      const creatureExists = await subjects.existingSubjects(pool, 'creature', [CREATURE, 'nonsense-creature']);
      assert.deepEqual([...creatureExists], [CREATURE]);
      const pointExists = await subjects.existingSubjects(pool, 'world_point', [WORLD_POINT, CREATURE]);
      assert.deepEqual([...pointExists], [WORLD_POINT], 'a creature name is not a world_point subject');
      const attackExists = await subjects.existingSubjects(pool, 'attack_type', ['melee', 'nonsense']);
      assert.deepEqual([...attackExists], ['melee']);
      const itemExists = await subjects.existingSubjects(pool, 'item', [ITEM_MELEE, 'nonsense-item']);
      assert.deepEqual([...itemExists], [ITEM_MELEE]);
      const skillExists = await subjects.existingSubjects(pool, 'skill', [SKILL_MELEE, 'nonsense-skill']);
      assert.deepEqual([...skillExists], [SKILL_MELEE]);
    });

    await t.test('cueFor: creature (fixed, including upload-only nulls)', async () => {
      assert.equal(await subjects.cueFor(pool, 'creature', CREATURE, 'nearby'), null, 'no cue on the box today');
      assert.equal(await subjects.cueFor(pool, 'creature', CREATURE, 'attack'), null, 'no cue on the box today');
      assert.equal(await subjects.cueFor(pool, 'creature', CREATURE, 'hurt'), 'hit');
      assert.equal(await subjects.cueFor(pool, 'creature', CREATURE, 'death'), 'death');
    });

    await t.test('cueFor: world_point (fixed)', async () => {
      assert.equal(await subjects.cueFor(pool, 'world_point', WORLD_POINT, 'nearby'), 'waypoint');
    });

    await t.test('cueFor: attack_type (per-subject, upload-only ranged/use)', async () => {
      assert.equal(await subjects.cueFor(pool, 'attack_type', 'melee', 'use'), 'slash');
      assert.equal(await subjects.cueFor(pool, 'attack_type', 'melee', 'hit'), 'hit');
      assert.equal(await subjects.cueFor(pool, 'attack_type', 'ranged', 'use'), null, 'no cue on the box today');
      assert.equal(await subjects.cueFor(pool, 'attack_type', 'ranged', 'hit'), 'hit');
      assert.equal(await subjects.cueFor(pool, 'attack_type', 'magic', 'use'), 'spell');
      assert.equal(await subjects.cueFor(pool, 'attack_type', 'magic', 'hit'), 'hit');
    });

    await t.test('cueFor: item resolves through attackKindOf (melee/ranged/magic)', async () => {
      assert.equal(await subjects.cueFor(pool, 'item', ITEM_MELEE, 'use'), 'slash');
      assert.equal(await subjects.cueFor(pool, 'item', ITEM_MELEE, 'hit'), 'hit');
      assert.equal(await subjects.cueFor(pool, 'item', ITEM_RANGED, 'use'), null, 'ranged use has no cue on the box today');
      assert.equal(await subjects.cueFor(pool, 'item', ITEM_RANGED, 'hit'), 'hit');
      assert.equal(await subjects.cueFor(pool, 'item', ITEM_MAGIC, 'use'), 'spell');
      assert.equal(await subjects.cueFor(pool, 'item', ITEM_MAGIC, 'hit'), 'hit');
    });

    await t.test('cueFor: skill (use follows type, hit is always hit)', async () => {
      assert.equal(await subjects.cueFor(pool, 'skill', SKILL_MELEE, 'use'), 'slash');
      assert.equal(await subjects.cueFor(pool, 'skill', SKILL_MELEE, 'hit'), 'hit');
      assert.equal(await subjects.cueFor(pool, 'skill', SKILL_MAGIC, 'use'), 'spell');
      assert.equal(await subjects.cueFor(pool, 'skill', SKILL_BUFF, 'use'), 'spell', 'non-melee falls to the magic cue');
    });

    await t.test('cueFor: unknown kind/slot/subject is null, not a throw', async () => {
      assert.equal(await subjects.cueFor(pool, 'creature', CREATURE, 'nonsense-slot'), null);
      assert.equal(await subjects.cueFor(pool, 'item', 'nonsense-item', 'use'), null);
      assert.equal(await subjects.cueFor(pool, 'nonsense-kind', 'x', 'use'), null);
    });

    await t.test('entityPhrase', () => {
      assert.equal(subjects.entityPhrase(pool, 'creature', CREATURE), CREATURE.toLowerCase());
      assert.equal(subjects.entityPhrase(pool, 'item', ITEM_MELEE), ITEM_MELEE);
      assert.equal(subjects.entityPhrase(pool, 'world_point', WORLD_POINT), WORLD_POINT);
      assert.equal(subjects.entityPhrase(pool, 'skill', SKILL_MELEE), 'Crushing Blow');
      assert.equal(subjects.entityPhrase(pool, 'attack_type', 'melee'), 'a steel sword');
      assert.equal(subjects.entityPhrase(pool, 'attack_type', 'ranged'), 'an arrow');
      assert.equal(subjects.entityPhrase(pool, 'attack_type', 'magic'), 'a magic blast');
    });

    await t.test('binding an sfx clip to creature/*/hurt works; creature/*/music is a 400', async () => {
      const clip = await storeSfx(`sfx ${tag}`);
      const binding = await lib.bindClip(pool, {
        subjectKind: 'creature', subjectKey: CREATURE, slot: 'hurt', clipId: clip.id,
      });
      assert.equal(binding.subject_key, CREATURE);
      await assert.rejects(
        lib.bindClip(pool, {
          subjectKind: 'creature', subjectKey: CREATURE, slot: 'music', clipId: clip.id,
        }),
        (e) => e instanceof lib.AudioInputError && e.status === 400 && /slot/.test(e.message),
      );
      await pool.query('DELETE FROM audio_bindings WHERE id = $1', [binding.id]);
    });

    await t.test('recordMisses accepts the new kinds and drops unknown keys', async () => {
      const accepted = await lib.recordMisses(pool, [
        { subject_kind: 'creature', subject_key: CREATURE, slot: 'nearby', world: worldName },
        { subject_kind: 'attack_type', subject_key: 'ranged', slot: 'use', world: worldName },
        { subject_kind: 'item', subject_key: ITEM_MELEE, slot: 'use', world: worldName },
        { subject_kind: 'skill', subject_key: SKILL_MELEE, slot: 'use', world: worldName },
        { subject_kind: 'creature', subject_key: 'nonsense-creature', slot: 'nearby', world: worldName },
        { subject_kind: 'attack_type', subject_key: 'nonsense-kind', slot: 'use', world: worldName },
        { subject_kind: 'item', subject_key: ITEM_MELEE, slot: 'nonsense-slot', world: worldName },
      ]);
      assert.equal(accepted, 4, 'the four real (kind, key, slot) misses are kept; the three unknown ones are dropped');
      const rows = await pool.query(
        `SELECT subject_kind, subject_key, slot FROM audio_misses
          WHERE (subject_kind, subject_key) IN (('creature', $1), ('attack_type', 'ranged'), ('item', $2), ('skill', $3))`,
        [CREATURE, ITEM_MELEE, SKILL_MELEE],
      );
      assert.equal(rows.rowCount, 4);
    });

    await t.test('worldAudioBundle includes a creature binding and an attack_type binding, globally', async () => {
      const creatureClip = await storeSfx(`creature sfx ${tag}`);
      const attackClip = await storeSfx(`attack sfx ${tag}`);
      const creatureBinding = await lib.bindClip(pool, {
        subjectKind: 'creature', subjectKey: CREATURE, slot: 'death', clipId: creatureClip.id,
      });
      const attackBinding = await lib.bindClip(pool, {
        subjectKind: 'attack_type', subjectKey: 'melee', slot: 'use', clipId: attackClip.id,
      });

      const bundle = await lib.worldAudioBundle(pool, worldId);
      assert.equal(bundle.world, worldName);
      assert.equal(bundle.bindings[`creature/${CREATURE}/death`][0].key, creatureClip.storage_key,
        'a creature binding is present even though this world never mentions the creature by name');
      assert.equal(bundle.bindings['attack_type/melee/use'][0].key, attackClip.storage_key);

      await pool.query('DELETE FROM audio_bindings WHERE id = ANY($1)', [[creatureBinding.id, attackBinding.id]]);
    });
  });
});
