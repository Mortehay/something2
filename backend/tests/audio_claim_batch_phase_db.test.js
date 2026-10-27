// SOMET-620: a bad merge left TWO `async function claimBatch` in
// audioJobQueue.js; the later, phase-blind one won, so the prompt-phase drain
// re-claimed the same job forever.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const { parkingForeignQueued } = require('./helpers/foreignAudioJobs.js');
const q = require('../src/services/audioJobQueue');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('audioJobQueue.js defines each function exactly once', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/audioJobQueue.js'), 'utf8');
  const names = [...src.matchAll(/^(?:async )?function (\w+)\(/gm)].map((m) => m[1]);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `duplicate definitions shadow each other: ${dupes}`);
  assert.equal(names.filter((n) => n === 'claimBatch').length, 1, 'claimBatch defined exactly once');
});

test('claimBatch: a prompt-phase claim takes only needs_prompt jobs, and never one twice', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `claimphase-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}%`]); }
    finally { await pool.end(); }
  });
  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    await parkingForeignQueued(pool, `${tag}%`, async () => {
      // no style, no prompt, no stored prompt => needs_prompt
      const [needy] = await q.enqueue(pool, [
        { subject_kind: 'biome', subject_key: `${tag}-needy`, slot: 'ambience', clip_kind: 'ambience' },
      ]).then((r) => r.queued.length ? pool.query('SELECT * FROM audio_jobs WHERE subject_key = $1', [`${tag}-needy`]).then((x) => x.rows) : []);
      // explicit style => ready for the audio phase, NOT needs_prompt
      const [ready] = await q.enqueue(pool, [
        { subject_kind: 'biome', subject_key: `${tag}-ready`, slot: 'ambience', clip_kind: 'ambience', style: 'calm' },
      ]).then(() => pool.query('SELECT * FROM audio_jobs WHERE subject_key = $1', [`${tag}-ready`]).then((x) => x.rows));
      assert.equal(needy.needs_prompt, true);
      assert.equal(ready.needs_prompt, false);

      const first = await q.claimBatch(pool, 5, { phase: 'prompt' });
      assert.deepEqual(first.map((j) => String(j.id)), [String(needy.id)], 'prompt claim: only the needs_prompt job');
      const again = await q.claimBatch(pool, 5, { phase: 'prompt' });
      assert.deepEqual(again, [], 'a claimed job is not claimed again (no infinite re-claim)');
      const audio = await q.claimBatch(pool, 5, { phase: 'audio' });
      assert.deepEqual(audio.map((j) => String(j.id)), [String(ready.id)], 'audio claim: only the ready job');
    });
  });
});
