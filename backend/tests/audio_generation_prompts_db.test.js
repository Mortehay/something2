// backend/tests/audio_generation_prompts_db.test.js
// Precedence: request > stored > propose/entityPhrase. The fake box FAILS on
// an unexpected body, so a precedence bug cannot pass by being ignored.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');
const gen = require('../src/services/audioGeneration');
const prompts = require('../src/services/audioPrompts');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

test('generation reads the stored prompt', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
    assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
    const tag = `genp-${process.pid}-${Date.now()}`;
    const creature = (await pool.query('SELECT name FROM entity_types WHERE is_creature ORDER BY name LIMIT 1')).rows[0].name;
    const worldId = (await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [tag])).rows[0].id;
    t.after(async () => {
      try {
        await pool.query(`DELETE FROM audio_clips WHERE id IN (SELECT clip_id FROM audio_bindings WHERE subject_key = ANY($1))`, [[tag, creature]]);
        await pool.query('DELETE FROM audio_prompts WHERE subject_key = ANY($1)', [[tag, creature]]);
        await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
      } finally { await pool.end(); }
    });
    // The creature's pre-existing active prompt (if any) must not be clobbered
    // on a shared DB -- this runs on the scratch DB only, but be explicit.
    assert.equal(await prompts.getActive(pool, 'creature', creature, 'hurt'), null, 'scratch DB expected: no creature prompt yet');

    const calls = [];
    const rap = {
      propose: async () => { calls.push('propose'); return { ok: true, style: 'village', slots: {}, prompt: 'proposed' }; },
      generateTrack: async (p, body) => { calls.push(['track', body.style, body.prompt]); return { ok: true, buffer: OGG, durationMs: 2000, loopStartMs: 0, loopEndMs: 2000, prompt: body.prompt, seed: body.seed }; },
      generateSfx: async (p, body) => { calls.push(['sfx', body.entity]); return { ok: true, clips: [{ buffer: OGG, durationMs: 500 }], cached: false, prompt: body.entity, seed: body.seed }; },
    };
    const provider = { id: null, base_url: 'http://x', modality: 'audio', models_cache: ['cue:hit'] };
    const spec = (over) => ({ subjectKind: 'world', subjectKey: tag, slot: 'music', clipKind: 'music', seed: 3, ...over });

    // 1. stored prompt, no request prompt -> stored used, NO propose
    await prompts.save(pool, 'world', tag, 'music', { style: 'medieval_fantasy', text: 'stored lute theme' });
    let r = await gen.generateForSlot(pool, provider, spec(), { rap, lib });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(calls, [['track', 'medieval_fantasy', 'stored lute theme']]);

    // 2. request prompt beats stored
    calls.length = 0;
    r = await gen.generateForSlot(pool, provider, spec({ style: 'tavern', prompt: 'typed' }), { rap, lib });
    assert.deepEqual(calls, [['track', 'tavern', 'typed']]);

    // 3. stored '' (cleared) -> falls through to propose
    calls.length = 0;
    await prompts.save(pool, 'world', tag, 'music', { style: null, text: '' });
    r = await gen.generateForSlot(pool, provider, spec(), { rap, lib });
    assert.deepEqual(calls, ['propose', ['track', 'village', 'proposed']]);

    // 4. sfx: stored text becomes entity, take suffix preserved
    calls.length = 0;
    await prompts.save(pool, 'creature', creature, 'hurt', { text: 'a mossy swamp beast' });
    r = await gen.generateForSlot(pool, provider,
      { subjectKind: 'creature', subjectKey: creature, slot: 'hurt', clipKind: 'sfx', seed: 4, variants: 1 }, { rap, lib });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(calls, [['sfx', 'a mossy swamp beast']], 'take 0 = no suffix');
    calls.length = 0;
    r = await gen.generateForSlot(pool, provider,
      { subjectKind: 'creature', subjectKey: creature, slot: 'hurt', clipKind: 'sfx', seed: 5, variants: 1 }, { rap, lib });
    assert.deepEqual(calls, [['sfx', 'a mossy swamp beast (take 1)']]);

    // 5. sfx cleared '' -> entityPhrase again
    calls.length = 0;
    await prompts.save(pool, 'creature', creature, 'hurt', { text: '' });
    r = await gen.generateForSlot(pool, provider,
      { subjectKind: 'creature', subjectKey: creature, slot: 'hurt', clipKind: 'sfx', seed: 6, variants: 1 }, { rap, lib });
    assert.deepEqual(calls, [['sfx', `${creature.toLowerCase()} (take 2)`]]);
  });
});
