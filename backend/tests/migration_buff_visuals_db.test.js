// buff_visuals table and the effect_sprite_jobs 'buff' subject kind (1714440883000). Gated on
// TEST_DATABASE_URL; writes only inside a transaction that is always rolled back.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { SEED } = require('../migrations/1714440883000_buff_visuals.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

test('buff_visuals migration', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 2 });
  t.after(() => pool.end());

  await t.test('seeds the frozen 55 rows with their placement and colour, and column defaults', async () => {
    assert.strictEqual(SEED.length, 55);
    assert.strictEqual(SEED.filter(([, placement]) => placement === 'ground').length, 7);
    const { rows } = await pool.query('SELECT * FROM buff_visuals WHERE skill_id = ANY($1::text[]) ORDER BY skill_id',
      [SEED.map(([id]) => id)]);
    assert.deepStrictEqual(rows.map((r) => [r.skill_id, r.placement, r.color]),
      [...SEED].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    for (const r of rows) {
      assert.strictEqual(r.radius, 64);
      assert.ok(Math.abs(r.scale - 1.3) < 1e-6);
      assert.strictEqual(r.priority, null);
      assert.strictEqual(r.sprite_image, null);
      assert.strictEqual(r.sprite_frames, 1);
      assert.strictEqual(r.sprite_additive, true);
      assert.strictEqual(r.sprite_fps, null);
      assert.ok(r.sync_uuid);
    }
  });

  await t.test("placement is checked and effect_sprite_jobs accepts subject_kind 'buff'", async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SAVEPOINT s');
      await assert.rejects(c.query("UPDATE buff_visuals SET placement = 'head' WHERE skill_id = 'war_shield_wall'"),
        (e) => e.code === '23514');
      await c.query('ROLLBACK TO s');
      await c.query(`INSERT INTO effect_sprite_jobs (subject_kind, subject_name, prompt, kind, frames, size, loop, blend, seed)
                     VALUES ('buff', 'war_shield_wall', 'p', 'aura', 8, 128, true, 'additive', 1)`);
      await c.query('SAVEPOINT s2');
      await assert.rejects(c.query(`INSERT INTO effect_sprite_jobs (subject_kind, subject_name, prompt, kind, frames, size, loop, blend, seed)
                     VALUES ('item', 'x', 'p', 'aura', 8, 128, true, 'additive', 1)`), (e) => e.code === '23514');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
