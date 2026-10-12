// backend/tests/aura_effects_schema_db.test.js
// Real-DB guards for 1714440680000. Gated on TEST_DATABASE_URL (never the dev
// DB). READ-ONLY except for statements wrapped in a transaction that is
// always ROLLED BACK -- nothing here persists.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

async function rejects(pool, sql, params, constraint) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await assert.rejects(c.query(sql, params), (e) => e.constraint === constraint || e.code === '23503',
      `expected ${constraint}`);
  } finally { await c.query('ROLLBACK'); c.release(); }
}

test('aura_effects schema', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 2 });
  t.after(() => pool.end());

  await t.test('pack_leader holds Champion\'s 2026-10-10 values', async () => {
    const r = await pool.query("SELECT * FROM aura_effects WHERE name = 'pack_leader'");
    assert.strictEqual(r.rowCount, 1);
    const a = r.rows[0];
    assert.strictEqual(a.target_side, 'allies');
    assert.strictEqual(a.radius, 260);
    assert.strictEqual(a.damage_mult, 1.25);
    assert.ok(Math.abs(a.defense_mult - 1.2) < 1e-6);   // real column: 1.2 is not exact in float4
    assert.ok(Math.abs(a.speed_mult - 1.1) < 1e-6);
    assert.strictEqual(a.dot_dps, 0);
  });

  const ins = `INSERT INTO aura_effects (name, target_side, radius, damage_mult, tick_ms, dot_dps, dot_element, shape, color)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
  const ok = ['zzAura', 'allies', 100, 1, 1000, 0, 'physical', 'ring', '#aabbcc'];
  const bad = (i, v) => { const p = [...ok]; p[i] = v; return p; };

  await t.test('radius 0, negative and 26000 are refused', async () => {
    await rejects(pool, ins, bad(2, 0), 'aura_effects_radius_check');
    await rejects(pool, ins, bad(2, -5), 'aura_effects_radius_check');
    await rejects(pool, ins, bad(2, 26000), 'aura_effects_radius_check');
  });
  await t.test('a zero multiplier is refused', async () => {
    await rejects(pool, ins, bad(3, 0), 'aura_effects_mult_check');
  });
  await t.test('tick_ms outside 100..5000 is refused', async () => {
    await rejects(pool, ins, bad(4, 50), 'aura_effects_tick_check');
    await rejects(pool, ins, bad(4, 6000), 'aura_effects_tick_check');
  });
  await t.test('an allies aura with a DoT is refused', async () => {
    await rejects(pool, ins, bad(5, 4), 'aura_effects_dot_side_check');
  });
  await t.test('an unknown element is refused by the FK', async () => {
    const p = bad(1, 'enemies'); p[6] = 'plasma';
    await rejects(pool, ins, p, 'aura_effects_dot_element_fkey');
  });
  await t.test('unknown shape / side / colour are refused', async () => {
    await rejects(pool, ins, bad(7, 'cone'), 'aura_effects_shape_check');
    await rejects(pool, ins, bad(1, 'neutral'), 'aura_effects_side_check');
    await rejects(pool, ins, bad(8, 'gold'), 'aura_effects_color_check');
  });
  await t.test('the valid row itself is accepted (proves the negatives are not vacuous)', async () => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query(ins, ok); } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
