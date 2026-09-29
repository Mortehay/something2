// backend/tests/audio_generation_db.test.js
// generateForSlot against a fake rap + the real library on the scratch DB.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');
const gen = require('../src/services/audioGeneration');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

test('generateForSlot', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
  const tag = `gen-${process.pid}-${Date.now()}`;
  const worldIds = [];
  t.after(async () => {
    try {
      await pool.query(`DELETE FROM audio_clips WHERE id IN (SELECT clip_id FROM audio_bindings WHERE subject_key = $1)`, [tag]);
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
});
