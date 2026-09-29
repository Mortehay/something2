// backend/tests/audio_generation_db.test.js
// generateForSlot against a fake rap + the real library on the scratch DB.
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

test('generateForSlot', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  // AUDIO_CLIPS_LOCK_KEY: see advisoryLock.js -- delete-unbound deletes every
  // unbound clip in the database, so clip-creating bodies are serialized with it.
  await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
    assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
    const tag = `gen-${process.pid}-${Date.now()}`;
    const worldIds = [];
    t.after(async () => {
      try {
        await pool.query(`DELETE FROM audio_clips WHERE id IN (SELECT clip_id FROM audio_bindings WHERE subject_key = $1)`, [tag]);
        await pool.query('DELETE FROM audio_clips WHERE label LIKE $1', [`${tag}%`]);
        if (worldIds.length) await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [worldIds]);
      } finally { await pool.end(); }
    });
    worldIds.push((await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [tag])).rows[0].id);

    const calls = [];
    const rap = {
      propose: async (p, body) => { calls.push(['propose', body]); return { ok: true, style: 'village', slots: { mood: 'calm and sunny' }, prompt: 'p' }; },
      generateTrack: async (p, body) => { calls.push(['generate', body]); return { ok: true, buffer: OGG, durationMs: 2000, sampleRate: 44100, loopStartMs: 0, loopEndMs: 2000, prompt: 'p', seed: body.seed }; },
    };
    const provider = { id: null, base_url: 'http://x', modality: 'audio' };

    const r = await gen.generateForSlot(pool, provider,
      { subjectKind: 'world', subjectKey: tag, slot: 'music', clipKind: 'music', seed: 77 }, { rap, lib });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(calls.map((c) => c[0]), ['propose', 'generate'], 'no style/prompt → propose first');
    assert.equal(calls[1][1].style, 'village');
    assert.equal(calls[1][1].seed, 77);
    assert.equal(r.binding.subject_key, tag);

    calls.length = 0;
    const r2 = await gen.generateForSlot(pool, provider,
      { subjectKind: 'world', subjectKey: tag, slot: 'ambience', clipKind: 'ambience', style: 'forest', seed: 5 }, { rap, lib });
    assert.equal(r2.ok, true);
    assert.deepEqual(calls.map((c) => c[0]), ['generate'], 'an explicit style skips propose');

    const failing = { ...rap, generateTrack: async () => ({ ok: false, error: 'box busy', retryable: true }) };
    const r3 = await gen.generateForSlot(pool, provider,
      { subjectKind: 'world', subjectKey: tag, slot: 'music', clipKind: 'music', style: 'x', seed: 9 }, { rap: failing, lib });
    assert.deepEqual({ ok: r3.ok, retryable: r3.retryable }, { ok: false, retryable: true });

    // F1 (spec §2 "all in one DB transaction after the upload"): the clip row
    // and its binding commit together. A "Delete all unbound" that runs in the
    // gap between them -- simulated here by running the exact delete-unbound
    // predicate (scoped to this file's own label, so no foreign clip is
    // touched) on a SEPARATE pool connection right before the bind -- must not
    // be able to see, let alone delete, the fresh clip.
    await t.test('a concurrent delete-unbound between insert and bind cannot delete the fresh clip', async () => {
      const racingLib = {
        ...lib,
        bindClip: async (db, args) => {
          await pool.query(
            `DELETE FROM audio_clips c
              WHERE NOT EXISTS (SELECT 1 FROM audio_bindings b WHERE b.clip_id = c.id)
                AND c.label LIKE $1`, [`${tag}%`]);
          return lib.bindClip(db, args);
        },
      };
      const r4 = await gen.generateForSlot(pool, provider,
        { subjectKind: 'world', subjectKey: tag, slot: 'music', clipKind: 'music', style: 'race', seed: 11 }, { rap, lib: racingLib });
      assert.equal(r4.ok, true, r4.error);
      const row = await pool.query(
        'SELECT c.id FROM audio_clips c JOIN audio_bindings b ON b.clip_id = c.id WHERE c.id = $1 AND b.subject_key = $2',
        [r4.clip.id, tag]);
      assert.equal(row.rowCount, 1, 'the clip survived the concurrent delete-unbound and ended bound');
    });

    await t.test('a bind failure leaves no clip row and removes the uploaded object', async () => {
      const puts = [];
      const removes = [];
      assetStore.__setAssetClient({
        bucketExists: async () => true,
        putObject: async (bucket, key) => { puts.push(key); },
        removeObject: async (bucket, key) => { removes.push(key); },
      });
      try {
        // slot 'music' takes music clips; an ambience clip is a kind mismatch
        // that bindClip rejects AFTER the object is uploaded and the row inserted.
        await assert.rejects(gen.generateForSlot(pool, provider,
          { subjectKind: 'world', subjectKey: tag, slot: 'music', clipKind: 'ambience', style: 'mismatch', seed: 12 }, { rap, lib }),
        /kind/);
        const left = await pool.query("SELECT id FROM audio_clips WHERE label = $1", [`${tag} music (mismatch)`]);
        assert.equal(left.rowCount, 0, 'the clip row was rolled back with the failed bind');
        assert.equal(puts.length, 1, 'the object was uploaded once');
        assert.deepEqual(removes, puts, 'the uploaded object was removed after the rollback');
      } finally {
        assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
      }
    });
  });
});
