// backend/tests/audio_sfx_generation_db.test.js
//
// Game audio slice 3, Task 3: generateForSlot's sfx branch against a fake
// rap (remoteAudioProvider) and the real library/DB on the scratch DB.
// Subjects use `attack_type` (melee/ranged), a fixed catalog that needs no
// row of its own -- this file only ever writes its OWN audio_clips/
// audio_bindings rows, cleaned up in t.after (per common.md, never touch a
// catalog table).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');
const gen = require('../src/services/audioGeneration');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

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

    await t.test('an upload-only slot (no cue on the box today) is refused with no box call', async () => {
      const calls = [];
      const rap = { generateSfx: async (...args) => { calls.push(args); return oneClip(1); } };
      // attack_type/ranged/use has no cue (ATTACK_TYPE_CUES.ranged.use = null).
      const r = await gen.generateForSlot(pool, providerWithCues,
        { subjectKind: 'attack_type', subjectKey: 'ranged', slot: 'use', clipKind: 'sfx', seed: 1 }, { rap, lib });
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
      assert.equal(r.ok, false);
      assert.match(r.error, /upload only/i);
      assert.match(r.error, /slash/);
      assert.equal(calls.length, 0, 'no box call for a cue the provider has not discovered');
    });

    await t.test('with 1 clip already bound, the entity sent is "<phrase> (take 1)"', async () => {
      // Pre-bind one sfx clip to attack_type/melee/hit so `take` starts at 1.
      // entityPhrase('attack_type', 'melee') is 'a steel sword' regardless of
      // slot (Task 2, audio_subjects_sfx_db.test.js) -- not the per-slot
      // phrase in the spec's batch-prompt table, which Task 3 consumes as-is.
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
      assert.equal(r.ok, true, r.error);
      assert.equal(calls.length, 1, 'no cache hit, so no retry');
      assert.equal(calls[0].cue, 'hit');
      assert.equal(calls[0].entity, 'a steel sword (take 1)');
      assert.equal(calls[0].seed, 9);
      bindingIds.push(r.bindings[0].id);
      clipIds.push(r.clips[0].id);
    });

    await t.test('cached:true triggers exactly one retry with take+1, then accepts the retry\'s result', async () => {
      // Fresh slot (attack_type/magic/use, cue 'spell') -- no pre-existing
      // binding here, so `take` starts at 0 and the retry's take is 1.
      const providerWithSpell = { id: null, base_url: 'http://x', modality: 'audio', models_cache: ['cue:spell'] };
      const calls = [];
      const rap = {
        generateSfx: async (p, body) => {
          calls.push(body);
          return calls.length === 1
            ? { ...oneClip(body.seed), cached: true }
            : { ...oneClip(body.seed), cached: false };
        },
      };
      const r = await gen.generateForSlot(pool, providerWithSpell,
        { subjectKind: 'attack_type', subjectKey: 'magic', slot: 'use', clipKind: 'sfx', seed: 4 }, { rap, lib });
      assert.equal(r.ok, true, r.error);
      assert.equal(calls.length, 2, 'exactly one retry, not a loop');
      assert.equal(calls[0].entity, 'a magic blast', 'first attempt: take 0, phrase alone');
      assert.equal(calls[1].entity, 'a magic blast (take 1)', 'retry: take bumped to 1');
      bindingIds.push(r.bindings[0].id);
      clipIds.push(r.clips[0].id);
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
      const r = await gen.generateForSlot(pool, providerWithCues,
        { subjectKind: 'attack_type', subjectKey: 'melee', slot: 'use', clipKind: 'sfx', variants: 3, seed: 7 }, { rap, lib });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.clips.length, 3);
      assert.equal(r.bindings.length, 3);
      assert.equal(r.clip.id, r.clips[0].id, 'clip/binding expose the first variant for the dispatcher\'s existing path');
      assert.equal(r.binding.id, r.bindings[0].id);
      for (const c of r.clips) { assert.equal(c.kind, 'sfx'); assert.equal(c.style_or_cue, 'slash'); assert.equal(c.engine, 'realistic'); }
      const rows = await pool.query('SELECT id FROM audio_bindings WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3',
        ['attack_type', 'melee', 'use']);
      assert.equal(rows.rowCount, 3);
      for (const c of r.clips) clipIds.push(c.id);
      for (const b of r.bindings) bindingIds.push(b.id);
    });
  });
});
