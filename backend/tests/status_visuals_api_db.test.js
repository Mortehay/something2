// GET /api/status-visuals and the approve path for a status row, against a real DB
// (TEST_DATABASE_URL only). The sprite columns it writes are restored in t.after.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const jobs = require('../src/services/effectSpriteJobs.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;

test('status visuals API', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  __setPool(pool);
  // rowSnapshot.js reinserts whole rows, which a generated column refuses: restore the sprite columns.
  const saved = (await pool.query('SELECT status_key, variant, sprite_image, sprite_frames, sprite_additive, sprite_fps FROM status_visuals')).rows;
  t.after(async () => {
    await pool.query('DELETE FROM effect_sprite_jobs WHERE subject_kind = $1', ['status']).catch(() => {});
    for (const r of saved) {
      await pool.query(`UPDATE status_visuals SET sprite_image=$3, sprite_frames=$4, sprite_additive=$5, sprite_fps=$6
        WHERE status_key=$1 AND variant=$2`, [r.status_key, r.variant, r.sprite_image, r.sprite_frames, r.sprite_additive, r.sprite_fps]).catch(() => {});
    }
    await pool.end();
  });

  await t.test('GET is open and lists the ten amber variants in order, keyed amber_stance_<n>', async () => {
    const r = await request(app).get('/api/status-visuals');
    assert.equal(r.status, 200);
    const amber = r.body.filter((v) => v.status_key === 'amber_stance');
    assert.deepEqual(amber.map((v) => v.variant), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(amber.map((v) => v.key), Array.from({ length: 10 }, (_, i) => `amber_stance_${i + 1}`));
    for (const k of ['sprite_image', 'sprite_frames', 'sprite_additive', 'sprite_fps']) assert.ok(k in amber[0], k);
  });

  await t.test('approving amber_stance_2 writes the sprite columns on (amber_stance, 2) only', async () => {
    await pool.query('UPDATE status_visuals SET sprite_image = NULL, sprite_frames = 1, sprite_additive = false, sprite_fps = NULL');
    await pool.query("DELETE FROM effect_sprite_jobs WHERE subject_kind = 'status'");
    const { queued: [j], skipped } = await jobs.enqueue(pool, [{ subject_kind: 'status', name: 'amber_stance_2' }], { seed: () => 5 });
    assert.equal(skipped.length, 0);
    assert.equal(j.kind, 'aura');
    assert.match(j.prompt, /amber/i);
    await jobs.markDone(pool, j.id, { imageKey: 'vfx/amber2.png', atlas: { frames: 8, fps_hint: 12.5, blend: 'alpha' } });
    const a = await jobs.approve(pool, j.id);
    assert.deepEqual(a.columns, { sprite_image: 'vfx/amber2.png', sprite_frames: 8, sprite_additive: false, sprite_fps: 12.5 });
    const { rows } = await pool.query("SELECT variant, sprite_image, sprite_frames, sprite_fps FROM status_visuals WHERE status_key = 'amber_stance' ORDER BY variant");
    for (const r of rows) {
      if (r.variant === 2) assert.deepEqual([r.sprite_image, r.sprite_frames, r.sprite_fps], ['vfx/amber2.png', 8, 12.5]);
      else assert.deepEqual([r.sprite_image, r.sprite_frames, r.sprite_fps], [null, 1, null], `variant ${r.variant} untouched`);
    }
    const r = await request(app).get('/api/status-visuals');
    assert.equal(r.body.find((v) => v.key === 'amber_stance_2').sprite_image, 'vfx/amber2.png');
  });
});
