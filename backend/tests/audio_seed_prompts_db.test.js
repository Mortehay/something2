// backend/tests/audio_seed_prompts_db.test.js
// prompts.json round-trips through audio-export/audio-seed. Spec 2026-09-30
// §4: prompts.json is ALWAYS the full active set regardless of `kinds`/`only`
// (the merge-by-kind trap slice 2 already hit with bindings.json), and
// seeding a prompt is idempotent -- an unchanged (style, text) creates no
// history row.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const seed = require('../src/services/audioSeed');
const prompts = require('../src/services/audioPrompts');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('prompts.json round trip', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
    const key = `seedp-${process.pid}-${Date.now()}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-seed-'));
    t.after(async () => {
      fs.rmSync(root, { recursive: true, force: true });
      try { await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [key]); } finally { await pool.end(); }
    });
    await prompts.save(pool, 'world', key, 'music', { style: 'village', text: 'exported lute', sourceInput: 'ctx', model: 'q', via: 'box' });

    await seed.exportAudio({ db: pool, root, kinds: ['sfx'] });
    const file = JSON.parse(fs.readFileSync(path.join(root, 'prompts.json'), 'utf8'));
    assert.ok(file.some((p) => p.subject_key === key && p.text === 'exported lute'), 'KIND=sfx still exports every prompt');

    await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [key]);
    await seed.seedAudio({ db: pool, root });
    const row = await prompts.getActive(pool, 'world', key, 'music');
    assert.deepEqual([row.style, row.text, row.via, row.source_input], ['village', 'exported lute', 'box', 'ctx']);

    await seed.seedAudio({ db: pool, root });
    const n = await pool.query('SELECT count(*)::int n FROM audio_prompts WHERE subject_key = $1', [key]);
    assert.equal(n.rows[0].n, 1, 're-seeding an unchanged prompt adds no history');
  });
});
