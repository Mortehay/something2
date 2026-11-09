// Effect sprites schema (1714440880000): loop/fps/stretch on vfx_effects, sprite columns on
// aura_effects, and the effect_sprite_jobs queue with one active job per subject.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const tag = `${process.pid}${Date.now()}`;

test('effect sprites migration', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 2 });
  t.after(async () => {
    await pool.query('DELETE FROM effect_sprite_jobs WHERE subject_name LIKE $1', [`zzmig${tag}%`]).catch(() => {});
    await pool.query('DELETE FROM vfx_effects WHERE name LIKE $1', [`zzmig${tag}%`]).catch(() => {});
    await pool.query('DELETE FROM aura_effects WHERE name LIKE $1', [`zzmig${tag}%`]).catch(() => {});
    await pool.end();
  });
  const job = (name, status) => pool.query(
    `INSERT INTO effect_sprite_jobs (subject_kind, subject_name, prompt, kind, frames, size, loop, blend, seed, status)
     VALUES ('vfx', $1, 'a flame', 'burst', 8, 64, false, 'additive', 1, $2)`, [name, status]);

  await t.test('vfx_effects has sprite_loop default false and sprite_fps null', async () => {
    const r = await pool.query(
      `INSERT INTO vfx_effects (name, shape) VALUES ($1, 'ring') RETURNING sprite_loop, sprite_fps, sprite_stretch`,
      [`zzmig${tag}v`]);
    assert.deepStrictEqual(r.rows[0], { sprite_loop: false, sprite_fps: null, sprite_stretch: false });
    await assert.rejects(pool.query('UPDATE vfx_effects SET sprite_fps = 61 WHERE name = $1', [`zzmig${tag}v`]), /check/);
  });
  await t.test('aura_effects sprite_frames 65 violates the check', async () => {
    const r = await pool.query(
      `INSERT INTO aura_effects (name, target_side, radius, damage_mult) VALUES ($1, 'allies', 100, 1) RETURNING sprite_image, sprite_frames, sprite_additive, sprite_fps`,
      [`zzmig${tag}a`]);
    assert.deepStrictEqual(r.rows[0], { sprite_image: null, sprite_frames: 1, sprite_additive: false, sprite_fps: null });
    await assert.rejects(pool.query('UPDATE aura_effects SET sprite_frames = 65 WHERE name = $1', [`zzmig${tag}a`]), /check/);
  });
  await t.test('two queued jobs for one subject violate the partial unique index; a queued + a done one do not', async () => {
    const n = `zzmig${tag}j`;
    await job(n, 'done');
    await job(n, 'queued');
    await assert.rejects(job(n, 'queued'), /unique|duplicate/);
    await assert.rejects(job(n, 'running'), /unique|duplicate/);
  });
});
