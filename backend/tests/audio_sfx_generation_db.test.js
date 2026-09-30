// backend/tests/audio_sfx_generation_db.test.js
//
// Game audio slice 3, Task 3: generateForSlot's sfx branch against a fake
// rap (remoteAudioProvider) and the real library/DB on the scratch DB.
// Subjects use `attack_type` (melee/ranged/magic), a fixed catalog that
// needs no row of its own, plus one real `skill` id (SKILL_MELEE below,
// read-only, never mutated -- same catalog row Task 2's
// audio_subjects_sfx_db.test.js uses) for the review round 1 fix tests that
// need MORE distinct (kind, key, slot) triples than attack_type alone
// offers. This file only ever writes its OWN audio_clips/audio_bindings
// rows, cleaned up in t.after (per common.md, never touch a catalog table).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const path = require('node:path');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');
const gen = require('../src/services/audioGeneration');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));
// skills.js: type='melee', nameEn='Crushing Blow' -- real, stable, read-only.
const SKILL_MELEE = 'war_crushing_blow';

test('generateForSlot: sfx', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  // AUDIO_CLIPS_LOCK_KEY: see advisoryLock.js -- delete-unbound deletes every
  // unbound clip in the database, so clip-creating bodies are serialized
  // with it.
  await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
    assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
    const clipIds = [];
    const bindingIds = [];
    t.after(async () => {
      try {
        if (bindingIds.length) await pool.query('DELETE FROM audio_bindings WHERE id = ANY($1)', [bindingIds]);
        if (clipIds.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clipIds]);
      } finally { await pool.end(); }
    });

    // provider.models_cache is the discovered allow-list (spec §2): a
    // provider row whose Refresh has never seen a cue must refuse it, even
    // when the registry maps a slot to that cue.
    const providerWithCues = { id: null, base_url: 'http://x', modality: 'audio', models_cache: ['cue:slash', 'cue:hit'] };
    const providerNoCues = { id: null, base_url: 'http://x', modality: 'audio', models_cache: [] };

    const oneClip = (seed) => ({
      ok: true,
      clips: [{ buffer: OGG, durationMs: 2000, sampleRate: 44100 }],
      prompt: 'p',
      seed,
      cached: false,
    });

    // Record a result's own rows BEFORE any assertion runs, so a failing
    // assertion cannot leak them into the scratch DB.
    const track = (r) => {
      if (r && Array.isArray(r.clips)) for (const c of r.clips) clipIds.push(c.id);
      if (r && Array.isArray(r.bindings)) for (const b of r.bindings) bindingIds.push(b.id);
      return r;
    };

    await t.test('an upload-only slot (no cue on the box today) is refused with no box call', async () => {
      const calls = [];
      const rap = { generateSfx: async (...args) => { calls.push(args); return oneClip(1); } };
      // attack_type/ranged/use has no cue (ATTACK_TYPE_CUES.ranged.use = null).
      const r = await gen.generateForSlot(pool, providerWithCues,
        { subjectKind: 'attack_type', subjectKey: 'ranged', slot: 'use', clipKind: 'sfx', seed: 1 }, { rap, lib });
      track(r);
      assert.equal(r.ok, false);
      assert.match(r.error, /upload only/i);
      assert.equal(calls.length, 0, 'no box call for an upload-only slot');
    });

    await t.test('a cue missing from the provider\'s models_cache is refused with no box call', async () => {
      const calls = [];
      const rap = { generateSfx: async (...args) => { calls.push(args); return oneClip(1); } };
      // attack_type/melee/use has a real cue ('slash') -- but providerNoCues
      // has never discovered it.
      const r = await gen.generateForSlot(pool, providerNoCues,
        { subjectKind: 'attack_type', subjectKey: 'melee', slot: 'use', clipKind: 'sfx', seed: 1 }, { rap, lib });
      track(r);
      assert.equal(r.ok, false);
      assert.match(r.error, /upload only/i);
      assert.match(r.error, /slash/);
      assert.equal(calls.length, 0, 'no box call for a cue the provider has not discovered');
    });

    await t.test('with 1 clip already bound, the entity sent is "<phrase> (take 1)"', async () => {
      // Pre-bind one sfx clip to attack_type/melee/hit so `take` starts at 1.
      // The phrase is the spec §4 per-slot one for melee/hit (M2).
      const existing = await lib.storeClip(pool, {
        buffer: OGG, kind: 'sfx', label: 'pre-existing melee hit', source: 'uploaded', durationMs: 500,
      });
      clipIds.push(existing.id);
      const binding = await lib.bindClip(pool, {
        subjectKind: 'attack_type', subjectKey: 'melee', slot: 'hit', clipId: existing.id,
      });
      bindingIds.push(binding.id);

      const calls = [];
      const rap = { generateSfx: async (p, body) => { calls.push(body); return oneClip(body.seed); } };
      const r = await gen.generateForSlot(pool, providerWithCues,
        { subjectKind: 'attack_type', subjectKey: 'melee', slot: 'hit', clipKind: 'sfx', seed: 9 }, { rap, lib });
      track(r);
      assert.equal(r.ok, true, r.error);
      assert.equal(calls.length, 1, 'no cache hit, so no retry');
      assert.equal(calls[0].cue, 'hit');
      assert.equal(calls[0].entity, 'a blade on a creature (take 1)');
      assert.equal(calls[0].seed, 9);
      bindingIds.push(r.bindings[0].id);
      clipIds.push(r.clips[0].id);
    });

    // SOMET-592 (I1): `cached` means the BOX had the file -- its cache is
    // shared by every database on the box -- not that this slot has it.
    await t.test('I1: a cached answer whose bytes are new to the slot is stored and bound, no retry', async () => {
      // Fresh slot (attack_type/magic/use, cue 'spell'): nothing bound.
      const providerWithSpell = { id: null, base_url: 'http://x', modality: 'audio', models_cache: ['cue:spell'] };
      const calls = [];
      const rap = {
        generateSfx: async (p, body) => { calls.push(body); return { ...oneClip(body.seed), cached: true }; },
      };
      const r = await gen.generateForSlot(pool, providerWithSpell,
        { subjectKind: 'attack_type', subjectKey: 'magic', slot: 'use', clipKind: 'sfx', seed: 4 }, { rap, lib });
      track(r);
      assert.equal(r.ok, true, r.error);
      bindingIds.push(r.bindings[0].id);
      clipIds.push(r.clips[0].id);
      assert.equal(calls.length, 1, 'a cached file new to this slot is not a reason to ask again');
      assert.equal(calls[0].entity, 'a magic spell', 'take 0, phrase alone');
      assert.equal(r.clips.length, 1);
      assert.equal(r.clips[0].sha1, lib.sha1Of(OGG), 'the stored row records the sha1 of its bytes');
    });

    await t.test('N variants store and bind N clips, all in the response', async () => {
      const rap = {
        generateSfx: async (p, body) => ({
          ok: true,
          clips: Array.from({ length: body.variants }, () => ({ buffer: OGG, durationMs: 2000, sampleRate: 44100 })),
          prompt: 'p',
          seed: body.seed,
          cached: false,
        }),
      };
      const countUse = async () => (await pool.query(
        'SELECT id FROM audio_bindings WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3',
        ['attack_type', 'melee', 'use'])).rowCount;
      // Relative, not absolute: the scratch DB may hold live clips on this
      // slot (browser checks), and ids are recorded BEFORE any assertion so a
      // failure cannot leak this test's own rows.
      const before = await countUse();
      const r = await gen.generateForSlot(pool, providerWithCues,
        { subjectKind: 'attack_type', subjectKey: 'melee', slot: 'use', clipKind: 'sfx', variants: 3, seed: 7 }, { rap, lib });
      track(r);
      assert.equal(r.ok, true, r.error);
      for (const c of r.clips) clipIds.push(c.id);
      for (const b of r.bindings) bindingIds.push(b.id);
      assert.equal(r.clips.length, 3);
      assert.equal(r.bindings.length, 3);
      assert.equal(r.clip.id, r.clips[0].id, 'clip/binding expose the first variant for the dispatcher\'s existing path');
      assert.equal(r.binding.id, r.bindings[0].id);
      for (const c of r.clips) { assert.equal(c.kind, 'sfx'); assert.equal(c.style_or_cue, 'slash'); assert.equal(c.engine, 'realistic'); }
      assert.equal(await countUse(), before + 3);
    });

    // Review round 1, fix 1: a per-variant storeAndBindClip failure must not
    // escape generateForSlot as an uncaught exception (route -> bare 500)
    // while whichever variants DID commit stay silently bound and
    // unreported.
    await t.test('fix 1: a store failure on one variant is partial, not a thrown exception -- the stored variant stays bound', async () => {
      const rap = {
        generateSfx: async (p, body) => ({
          ok: true,
          clips: Array.from({ length: body.variants }, () => ({ buffer: OGG, durationMs: 2000, sampleRate: 44100 })),
          prompt: 'p',
          seed: body.seed,
          cached: false,
        }),
      };
      let calls = 0;
      const flakyLib = {
        ...lib,
        storeAndBindClip: async (...args) => {
          calls += 1;
          if (calls >= 2) throw new Error('simulated store failure');
          return lib.storeAndBindClip(...args);
        },
      };
      // attack_type/ranged/hit: untouched by any earlier test in this file.
      const r = await gen.generateForSlot(pool, providerWithCues,
        { subjectKind: 'attack_type', subjectKey: 'ranged', slot: 'hit', clipKind: 'sfx', variants: 3, seed: 8 }, { rap, lib: flakyLib });
      track(r);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.partial, true);
      assert.match(r.error, /simulated store failure/);
      assert.equal(r.clips.length, 1, 'only the first (successful) variant is in the result');
      assert.equal(r.bindings.length, 1);
      const rows = await pool.query(
        'SELECT id FROM audio_bindings WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3',
        ['attack_type', 'ranged', 'hit']);
      assert.equal(rows.rowCount, 1, 'exactly the one successfully-stored variant is bound in the DB');
      clipIds.push(r.clips[0].id);
      bindingIds.push(r.bindings[0].id);
    });

    await t.test('fix 1: a store failure on every variant is ok:false, nothing bound', async () => {
      const rap = {
        generateSfx: async (p, body) => ({
          ok: true,
          clips: Array.from({ length: body.variants }, () => ({ buffer: OGG, durationMs: 2000, sampleRate: 44100 })),
          prompt: 'p',
          seed: body.seed,
          cached: false,
        }),
      };
      const alwaysFailLib = {
        ...lib,
        storeAndBindClip: async () => { throw new Error('simulated store failure'); },
      };
      // attack_type/magic/hit: untouched by any earlier test in this file.
      const r = await gen.generateForSlot(pool, providerWithCues,
        { subjectKind: 'attack_type', subjectKey: 'magic', slot: 'hit', clipKind: 'sfx', variants: 2, seed: 8 }, { rap, lib: alwaysFailLib });
      track(r);
      assert.equal(r.ok, false);
      assert.match(r.error, /simulated store failure/);
      assert.equal(r.retryable, false);
      assert.equal(r.clips, undefined);
      const rows = await pool.query(
        'SELECT id FROM audio_bindings WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3',
        ['attack_type', 'magic', 'hit']);
      assert.equal(rows.rowCount, 0, 'nothing bound when every variant failed to store');
    });

    // Review round 1, fix 2: take must be read from the highest surviving
    // "(take N)" label, not a raw COUNT(*) of current bindings -- a COUNT
    // goes stale the moment any earlier take's clip is deleted, because the
    // box's own cache (keyed by entity text, which encodes the take) has no
    // idea our DB deleted anything.
    await t.test('fix 2: take is read from the highest surviving "(take N)" label, not a raw count', async () => {
      // skill/war_crushing_blow/hit: untouched by any earlier test in this
      // file (SKILL_MELEE is only otherwise read by Task 2's own test file).
      const make = async (label) => {
        const c = await lib.storeClip(pool, {
          buffer: OGG, kind: 'sfx', label, source: 'uploaded', durationMs: 500,
        });
        const b = await lib.bindClip(pool, {
          subjectKind: 'skill', subjectKey: SKILL_MELEE, slot: 'hit', clipId: c.id,
        });
        return { clip: c, binding: b };
      };
      const take0 = await make('pre-take-test'); // no suffix == take 0
      const take1 = await make('pre-take-test (take 1)');
      const take2 = await make('pre-take-test (take 2)');
      clipIds.push(take0.clip.id, take1.clip.id, take2.clip.id);
      bindingIds.push(take0.binding.id, take1.binding.id, take2.binding.id);

      // Delete takes 0 and 1 -- only take 2's clip survives bound.
      await pool.query('DELETE FROM audio_bindings WHERE id = ANY($1)', [[take0.binding.id, take1.binding.id]]);
      await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [[take0.clip.id, take1.clip.id]]);

      const calls = [];
      const rap = { generateSfx: async (p, body) => { calls.push(body); return oneClip(body.seed); } };
      const r = await gen.generateForSlot(pool, providerWithCues,
        { subjectKind: 'skill', subjectKey: SKILL_MELEE, slot: 'hit', clipKind: 'sfx', seed: 5 }, { rap, lib });
      track(r);
      assert.equal(r.ok, true, r.error);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].entity, 'Crushing Blow (take 3)',
        'a raw COUNT(*) of the 1 surviving binding would have sent "(take 1)" -- a request the box already has cached from take1\'s deleted clip');
      clipIds.push(r.clips[0].id);
      bindingIds.push(r.bindings[0].id);
    });

    // SOMET-592 (I1): a TRUE duplicate -- bytes equal to a clip already
    // bound to this slot -- is never stored; the single path steps to the
    // next take, a bounded number of times.
    const variant = (n) => Buffer.concat([OGG, Buffer.from([n])]);
    const bindOwn = async (subjectKey, slot, buffer, label) => {
      const c = await lib.storeClip(pool, {
        buffer, kind: 'sfx', label, source: 'uploaded', durationMs: 500,
      });
      clipIds.push(c.id);
      const b = await lib.bindClip(pool, {
        subjectKind: 'skill', subjectKey, slot, clipId: c.id,
      });
      bindingIds.push(b.id);
      return c;
    };
    const boundCount = async (subjectKey, slot) => (await pool.query(
      'SELECT id FROM audio_bindings WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3',
      ['skill', subjectKey, slot])).rowCount;

    await t.test('I1: a cached duplicate steps to the next take, and the next take\'s new bytes are stored', async () => {
      // skill/war_crushing_blow/use (cue 'slash'): untouched by any earlier
      // test in this file.
      await bindOwn(SKILL_MELEE, 'use', variant(1), 'dup-single');
      const calls = [];
      const rap = {
        generateSfx: async (p, body) => {
          calls.push(body);
          return {
            ...oneClip(body.seed), clips: [{ buffer: variant(calls.length), durationMs: 500 }], cached: true,
          };
        },
      };
      const r = await gen.generateForSlot(pool, providerWithCues,
        { subjectKind: 'skill', subjectKey: SKILL_MELEE, slot: 'use', clipKind: 'sfx', seed: 2 }, { rap, lib });
      track(r);
      assert.equal(r.ok, true, r.error);
      for (const c of r.clips) clipIds.push(c.id);
      for (const b of r.bindings) bindingIds.push(b.id);
      assert.deepEqual(calls.map((c) => c.entity), ['Crushing Blow (take 1)', 'Crushing Blow (take 2)'],
        'take 1 came back as the bound bytes; take 2 was new');
      assert.equal(r.clips.length, 1);
      assert.equal(r.clips[0].sha1, lib.sha1Of(variant(2)));
      assert.match(r.clips[0].label, /\(take 2\)$/);
      assert.equal(await boundCount(SKILL_MELEE, 'use'), 2, 'the duplicate was not stored a second time');
    });

    await t.test('I1: a slot whose every take comes back a duplicate gives up after the bound, stores nothing, and stays retryable', async () => {
      const SKILL = 'war_whirlwind';
      await bindOwn(SKILL, 'use', variant(9), 'dup-always');
      const calls = [];
      const rap = {
        generateSfx: async (p, body) => {
          calls.push(body);
          return { ...oneClip(body.seed), clips: [{ buffer: variant(9), durationMs: 500 }], cached: true };
        },
      };
      const r = await gen.generateForSlot(pool, providerWithCues,
        { subjectKind: 'skill', subjectKey: SKILL, slot: 'use', clipKind: 'sfx', seed: 2 }, { rap, lib });
      track(r);
      assert.equal(r.ok, false);
      assert.equal(r.duplicate, true);
      assert.equal(r.retryable, true, 'a duplicate is never marked retryable:false');
      assert.match(r.error, /already bound to this slot/);
      assert.equal(calls.length, 1 + gen.MAX_EXTRA_DUPLICATE_TAKES);
      assert.deepEqual(calls.map((c) => c.entity), [1, 2, 3, 4].map((n) => `Whirlwind (take ${n})`));
      assert.equal(await boundCount(SKILL, 'use'), 1, 'nothing new bound');
    });

    await t.test('I1: a legacy clip (sha1 NULL) is hashed from the asset store on demand, and the hash is kept', async () => {
      const SKILL = 'war_whirlwind';
      const legacy = await bindOwn(SKILL, 'hit', variant(5), 'legacy');
      await pool.query('UPDATE audio_clips SET sha1 = NULL WHERE id = $1', [legacy.id]);
      const reads = [];
      assetStore.__setAssetClient({
        bucketExists: async () => true,
        putObject: async () => {},
        getObject: async (bucket, key) => { reads.push(key); return Readable.from([variant(5)]); },
      });
      try {
        const calls = [];
        const rap = {
          generateSfx: async (p, body) => {
            calls.push(body);
            // take 1 duplicates the legacy clip, take 2 is new.
            return { ...oneClip(body.seed), clips: [{ buffer: variant(calls.length === 1 ? 5 : 6), durationMs: 500 }], cached: true };
          },
        };
        const r = await gen.generateForSlot(pool, providerWithCues,
          { subjectKind: 'skill', subjectKey: SKILL, slot: 'hit', clipKind: 'sfx', seed: 3 }, { rap, lib });
        track(r);
        assert.equal(r.ok, true, r.error);
        for (const c of r.clips) clipIds.push(c.id);
        for (const b of r.bindings) bindingIds.push(b.id);
        assert.equal(calls.length, 2);
        assert.deepEqual(reads, [legacy.storage_key], 'the legacy object is read once; the hash is written back');
        const row = (await pool.query('SELECT sha1 FROM audio_clips WHERE id = $1', [legacy.id])).rows[0];
        assert.equal(row.sha1, lib.sha1Of(variant(5)));
      } finally {
        assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
      }
    });

    // The pack path against the real library: a duplicate row fails its job
    // RETRYABLE (never permanently), and the job's next attempt moves past
    // the duplicated take.
    await t.test('I1 pack: a cached row with new bytes is stored; a duplicate row is retryable and its retry uses a later take', async () => {
      const SKILL = 'war_shield_slam';
      await bindOwn(SKILL, 'use', variant(20), 'dup-pack');
      const jobA = {
        id: 'a', subject_kind: 'skill', subject_key: SKILL, slot: 'use', engine: 'realistic',
      };
      const jobB = {
        id: 'b', subject_kind: 'skill', subject_key: SKILL, slot: 'hit', engine: 'realistic',
      };
      const bodies = [];
      const bytesFor = { 1: variant(20), 2: variant(21) };
      const rap = {
        generateSfxPack: async (p, body) => {
          bodies.push(body);
          return {
            ok: true,
            items: body.items.map((it) => ({
              ok: true,
              cue: it.cue,
              entity: it.entity,
              // use: the bound bytes on the first pack, new bytes on the next.
              // hit: bytes this slot has never had.
              clips: [{ buffer: it.cue === 'slash' ? bytesFor[bodies.length] : variant(30), durationMs: 500 }],
              prompt: 'p',
              seed: 1,
              cached: true,
            })),
          };
        },
      };
      const providerSlashHit = { ...providerWithCues, models_cache: ['cue:slash', 'cue:hit'] };
      const first = await gen.generateSfxPackForJobs(pool, providerSlashHit, [jobA, jobB], { rap, lib, seed: 1 });
      for (const x of first.results) track(x.result);
      const res = Object.fromEntries(first.results.map((x) => [x.job.id, x.result]));
      assert.equal(res.b.ok, true, res.b.error);
      for (const c of res.b.clips) clipIds.push(c.id);
      for (const b of res.b.bindings) bindingIds.push(b.id);
      assert.equal(res.a.ok, false);
      assert.equal(res.a.duplicate, true);
      assert.equal(res.a.retryable, true);
      assert.match(res.a.error, /already bound to this slot \(take 1\)/);
      assert.equal(await boundCount(SKILL, 'use'), 1);

      // The dispatcher writes result.error into last_error; the re-sent job
      // carries it back.
      assert.equal(gen.takeAfterDuplicate(res.a.error), 2);
      const second = await gen.generateSfxPackForJobs(pool, providerSlashHit,
        [{ ...jobA, last_error: res.a.error }], { rap, lib, seed: 1 });
      assert.equal(bodies[1].items[0].entity, 'Shield Slam (take 2)', 'the retry moves past the duplicated take');
      for (const x of second.results) track(x.result);
      const r2 = second.results[0].result;
      assert.equal(r2.ok, true, r2.error);
      for (const c of r2.clips) clipIds.push(c.id);
      for (const b of r2.bindings) bindingIds.push(b.id);
      assert.equal(await boundCount(SKILL, 'use'), 2);
    });
  });
});

// Game audio slice 3, Task 4: the pack path. One sfx-pack request for many
// queued jobs; result rows are matched back by the box-echoed (cue, entity),
// never by position. Subjects are `creature` with made-up, tagged keys:
// creature cues are fixed per slot (hurt->hit, death->death, nearby->none)
// and entityPhrase is just the lowercased key. Those subjects do not exist,
// so bindClip would refuse them: storage goes through a RECORDING lib (the
// real store/bind path is the same storeSfxVariants helper the single-cue
// tests above run against the real library). nextSfxTake still reads the
// real audio_bindings (nothing bound for these keys -> take 0), so no clip
// is created and no clips lock is needed.
test('generateSfxPackForJobs', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `sfxpack-${process.pid}-${Date.now()}`;
  t.after(() => pool.end());
  {
    const stored = [];
    const lib = {
      bindClip: async () => ({}),
      storeAndBindClip: async (db, clipSpec, target, opts) => {
        assert.equal(typeof opts.bind, 'function');
        const n = stored.push({ ...clipSpec, ...target });
        return { clip: { id: `clip-${n}`, ...clipSpec }, binding: { id: `bind-${n}`, ...target } };
      },
    };

    const provider = { id: null, base_url: 'http://x', modality: 'audio', models_cache: ['cue:hit', 'cue:death'] };
    const clip = () => ({ buffer: OGG, durationMs: 1000, sampleRate: 44100 });
    let nextId = 1;
    const job = (key, slot, engine = 'retro') => ({
      id: String(nextId++), subject_kind: 'creature', subject_key: `${key}-${tag}`, slot, engine,
    });

    await t.test('maps rows back by (cue, entity), refuses upload-only, de-duplicates entities, stores a cached row new to its slot, and fails missing/error rows per job', async () => {
      const a = job('A', 'hurt');
      const b = job('B', 'death');
      const c = job('C', 'nearby'); // no cue: upload only
      const d1 = job('Dup', 'hurt');
      const d2 = job('DUP', 'hurt'); // same phrase once lowercased
      const e = job('E', 'hurt');   // the box returns no row for it
      const f = job('F', 'hurt');   // cached, but nothing is bound to its slot
      const g = job('G', 'hurt');   // per-item error
      const calls = [];
      const rap = {
        generateSfxPack: async (p, body) => {
          calls.push(body);
          const row = (it, extra = {}) => ({
            ok: true, cue: it.cue, entity: it.entity, clips: [clip(), clip()], prompt: `p ${it.entity}`, seed: 77, cached: false, ...extra,
          });
          const by = Object.fromEntries(body.items.map((it) => [it.entity, it]));
          const L = (k) => by[`${k}-${tag}`.toLowerCase()];
          // Deliberately NOT in request order, plus an unattributable error row.
          return {
            ok: true,
            items: [
              { ok: false, cue: undefined, entity: undefined, error: 'mystery', providerFault: true },
              row(by[`dup-${tag} (take 1)`]),
              { ok: false, cue: L('G').cue, entity: L('G').entity, error: 'cuda oom', providerFault: true },
              row(L('F'), { cached: true }),
              row(L('B')),
              row(L('Dup')),
              row(L('A')),
            ],
          };
        },
      };
      const out = await gen.generateSfxPackForJobs(pool, provider, [a, b, c, d1, d2, e, f, g], { rap, lib, seed: 5 });

      assert.equal(calls.length, 1, 'one pack request');
      assert.equal(calls[0].seed, 5);
      assert.equal(calls[0].variants, 3);
      assert.deepEqual(calls[0].items.map((it) => [it.cue, it.entity, it.engine]), [
        ['hit', `a-${tag}`, 'retro'],
        ['death', `b-${tag}`, 'retro'],
        ['hit', `dup-${tag}`, 'retro'],
        ['hit', `dup-${tag} (take 1)`, 'retro'],
        ['hit', `e-${tag}`, 'retro'],
        ['hit', `f-${tag}`, 'retro'],
        ['hit', `g-${tag}`, 'retro'],
      ], 'no upload-only item; the second "dup" gets a distinct take');

      assert.deepEqual(out.refused.map((r) => r.job.id), [c.id]);
      assert.match(out.refused[0].result.error, /upload only/);
      assert.equal(out.packFailure, undefined);
      const res = Object.fromEntries(out.results.map((r) => [r.job.id, r.result]));
      assert.equal(out.results.length, 7);

      for (const j of [a, b, d1, d2, f]) assert.equal(res[j.id].ok, true, `${j.subject_key}: ${res[j.id].error}`);
      for (const j of [a, b, d1, d2]) assert.equal(res[j.id].clips.length, 2);
      const labels = async (j) => stored.filter((x) => x.subjectKey === j.subject_key && x.slot === j.slot);
      assert.deepEqual((await labels(a)).map((r) => [r.label, r.styleOrCue, r.engine, r.kind, r.prompt, r.seed]),
        [[`${a.subject_key} hurt (hit)`, 'hit', 'retro', 'sfx', `p a-${tag}`, 77],
          [`${a.subject_key} hurt (hit)`, 'hit', 'retro', 'sfx', `p a-${tag}`, 77]]);
      assert.deepEqual((await labels(b)).map((r) => [r.styleOrCue, r.prompt]),
        [['death', `p b-${tag}`], ['death', `p b-${tag}`]], 'b got the death row, not a hit row');
      assert.deepEqual((await labels(d2)).map((r) => [r.label, r.prompt]),
        [[`${d2.subject_key} hurt (hit) (take 1)`, `p dup-${tag} (take 1)`], [`${d2.subject_key} hurt (hit) (take 1)`, `p dup-${tag} (take 1)`]],
        'the bumped take is on the label, and it got ITS row');
      assert.deepEqual((await labels(d1)).map((r) => r.prompt), [`p dup-${tag}`, `p dup-${tag}`]);
      assert.equal(res[a.id].clip.id, res[a.id].clips[0].id);

      assert.equal(res[e.id].ok, false);
      assert.equal(res[e.id].providerFault, true, 'no matching row = a failed item, provider fault');
      assert.equal(res[e.id].retryable, true);
      // SOMET-592 (I1): the box's cache is not this slot. A cached row is
      // stored; within one cached answer, byte-identical variants are kept
      // once.
      assert.equal(res[f.id].clips.length, 1, 'the two identical cached variants are stored once');
      assert.equal((await labels(f)).length, 1);
      assert.equal(res[g.id].ok, false);
      assert.equal(res[g.id].error, 'cuda oom');
      assert.equal(res[g.id].retryable, true);
      assert.deepEqual(await labels(g), []);
    });

    await t.test('a cue missing from models_cache is refused before the request; nothing sendable means no request', async () => {
      const calls = [];
      const rap = { generateSfxPack: async (p, body) => { calls.push(body); return { ok: true, items: [] }; } };
      const onlyHit = { ...provider, models_cache: ['cue:hit'] };
      const out = await gen.generateSfxPackForJobs(pool, onlyHit, [job('N', 'death'), job('M', 'nearby')], { rap, lib, seed: 1 });
      assert.equal(calls.length, 0, 'no box call when every job is refused');
      assert.deepEqual(out.refused.map((r) => /upload only/.test(r.result.error)), [true, true]);
      assert.match(out.refused[0].result.error, /'death'/);
      assert.deepEqual(out.results, []);
    });

    await t.test('a whole-pack failure comes back as packFailure with every sent job undecided', async () => {
      const rap = {
        generateSfxPack: async () => ({
          ok: false, status: 422, error: "unknown cue 'death'", retryable: false, providerFault: false, unknownCue: 'death',
        }),
      };
      const x = job('X', 'hurt');
      const y = job('Y', 'death');
      const out = await gen.generateSfxPackForJobs(pool, provider, [x, y], { rap, lib, seed: 1 });
      assert.equal(out.packFailure.unknownCue, 'death');
      assert.deepEqual(out.sent.map((s) => [s.job.id, s.cue]), [[x.id, 'hit'], [y.id, 'death']]);
      assert.deepEqual(out.results, []);
    });
  }
});
