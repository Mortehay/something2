// backend/tests/audio_generation_prompts_db.test.js
// Precedence: request > stored > propose/entityPhrase. The fake box RECORDS
// every body it is sent (style, prompt, entity) and each case deepEquals that
// record, so a precedence bug shows up as a wrong recorded body -- the fake
// never ignores its input and answers the same regardless.
//
// SUBJECTS: creatures picked at test time with no prompt row and no binding
// at all, so this file assumes nothing about a scratch DB a batch run may
// have written to, and its cleanup (every prompt/clip for those creatures)
// removes only what it wrote.
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

async function freshCreatures(pool, n) {
  const names = (await pool.query(
    `SELECT e.name FROM entity_types e
      WHERE e.is_creature
        AND NOT EXISTS (SELECT 1 FROM audio_prompts p WHERE p.subject_kind = 'creature' AND p.subject_key = e.name)
        AND NOT EXISTS (SELECT 1 FROM audio_bindings b WHERE b.subject_kind = 'creature' AND b.subject_key = e.name)
      ORDER BY e.name LIMIT $1`, [n])).rows.map((r) => r.name);
  assert.equal(names.length, n, `need ${n} creatures with no prompt or binding on the scratch DB`);
  return names;
}

test('generation reads the stored prompt', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
    assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
    const tag = `genp-${process.pid}-${Date.now()}`;
    const creatures = await freshCreatures(pool, 5);
    const [creature, sharedA, sharedB, sharedC, own] = creatures;
    const worldId = (await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [tag])).rows[0].id;
    t.after(async () => {
      try {
        await pool.query(`DELETE FROM audio_clips WHERE id IN (SELECT clip_id FROM audio_bindings WHERE subject_key = ANY($1))`, [[tag, ...creatures]]);
        await pool.query('DELETE FROM audio_prompts WHERE subject_key = ANY($1)', [[tag, ...creatures]]);
        await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
      } finally { await pool.end(); }
    });

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

    // ---- Final review I2 + M10: a stored entity SHARED by several subjects.
    // The box caches by (engine, cue, entity) across every database, so the
    // second subject asking for the same text gets the first one's file back
    // with cached:true. That file is already stored (bound to ANOTHER slot),
    // so it is a duplicate: never stored, the take bumps instead.
    const box = new Map(); // `${cue}\0${entity}` -> bytes
    let fresh = 0;
    const boxAnswer = (cue, entity) => {
      const k = `${cue}\u0000${entity}`;
      if (box.has(k)) return { bytes: box.get(k), cached: true };
      fresh += 1;
      const bytes = Buffer.concat([OGG, Buffer.from(`${tag}-${fresh}`)]);
      box.set(k, bytes);
      return { bytes, cached: false };
    };
    const sent = [];
    const cachingRap = {
      generateSfx: async (p, body) => {
        sent.push(body.entity);
        const a = boxAnswer(body.cue, body.entity);
        return { ok: true, clips: [{ buffer: a.bytes, durationMs: 500 }], cached: a.cached, prompt: body.entity, seed: body.seed };
      },
      generateSfxPack: async (p, body) => {
        sent.push(...body.items.map((it) => it.entity));
        return {
          ok: true,
          items: body.items.map((it) => {
            const a = boxAnswer(it.cue, it.entity);
            return { ok: true, cue: it.cue, entity: it.entity, clips: [{ buffer: a.bytes, durationMs: 500 }], cached: a.cached, prompt: it.entity, seed: 1 };
          }),
        };
      },
    };
    const SHARED = 'a shared stone beast';
    for (const c of [sharedA, sharedB, sharedC]) {
      // eslint-disable-next-line no-await-in-loop
      await prompts.save(pool, 'creature', c, 'hurt', { text: SHARED });
    }
    await prompts.save(pool, 'creature', own, 'hurt', { text: 'a pale cave lizard' });
    const sfxSpec = (key) => ({ subjectKind: 'creature', subjectKey: key, slot: 'hurt', clipKind: 'sfx', seed: 7, variants: 1 });
    const boundSha1 = async (key) => (await pool.query(
      `SELECT c.sha1, c.label FROM audio_bindings b JOIN audio_clips c ON c.id = b.clip_id
        WHERE b.subject_kind = 'creature' AND b.subject_key = $1 AND b.slot = 'hurt'`, [key])).rows;

    // Single path: A renders fresh; B's take 0 is A's cached file -> take 1.
    r = await gen.generateForSlot(pool, provider, sfxSpec(sharedA), { rap: cachingRap, lib });
    assert.equal(r.ok, true, r.error);
    r = await gen.generateForSlot(pool, provider, sfxSpec(sharedB), { rap: cachingRap, lib });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(sent, [SHARED, SHARED, `${SHARED} (take 1)`], "B's take 0 came back cached and was bumped");
    const [aRows, bRows] = [await boundSha1(sharedA), await boundSha1(sharedB)];
    assert.equal(bRows.length, 1);
    assert.notEqual(bRows[0].sha1, aRows[0].sha1, "B must not be stored with A's bytes");
    assert.match(bRows[0].label, /take 1/);

    // Pack path (how queued sfx actually drain): the stored prompt is the
    // entity sent (M10), and a cached file stored for another subject is a
    // duplicate there too (I2).
    sent.length = 0;
    const job = (key) => ({ id: `${tag}-${key}`, subject_kind: 'creature', subject_key: key, slot: 'hurt', engine: null, last_error: null });
    const pack = await gen.generateSfxPackForJobs(pool, provider, [job(own), job(sharedC)], { rap: cachingRap, lib, variants: 1 });
    assert.deepEqual(pack.sent.map((s) => s.entity), ['a pale cave lizard', SHARED], 'stored prompts are the pack entities');
    assert.deepEqual(sent, ['a pale cave lizard', SHARED]);
    const byKey = new Map(pack.results.map((x) => [x.job.subject_key, x.result]));
    assert.equal(byKey.get(own).ok, true, byKey.get(own).error);
    assert.deepEqual(
      { ok: byKey.get(sharedC).ok, duplicate: byKey.get(sharedC).duplicate, retryable: byKey.get(sharedC).retryable },
      { ok: false, duplicate: true, retryable: true },
    );
    assert.equal((await boundSha1(sharedC)).length, 0, "C stored nothing: its only answer was A's file");
    assert.equal(gen.takeAfterDuplicate(byKey.get(sharedC).error), 1, 'the retry moves to a later take');
  });
});
