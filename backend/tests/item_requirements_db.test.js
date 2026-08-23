const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

async function openPool() {
  if (!DB_URL) return { unreachable: 'no TEST_DATABASE_URL / DATABASE_URL' };
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: `NO DATABASE at ${DB_URL} (${err.message})` };
  }
  return pool;
}

test('item_types carries the requirement, item level and tier columns', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const r = await pool.query(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'item_types'
        AND column_name IN ('req_level','req_strength','req_dexterity','req_constitution',
                            'req_intelligence','req_wisdom','req_charisma','item_level','tier')
      ORDER BY column_name`,
  );
  assert.deepStrictEqual(
    r.rows.map((row) => row.column_name),
    ['item_level', 'req_charisma', 'req_constitution', 'req_dexterity',
      'req_intelligence', 'req_level', 'req_strength', 'req_wisdom', 'tier'],
  );
  for (const row of r.rows) assert.strictEqual(row.is_nullable, 'NO', `${row.column_name} must be NOT NULL`);

  // Hand-written defaults: every pre-existing catalog row must stay equippable
  // by a level-1 character with base stats, so the requirement defaults are
  // the identity values, not the ladder's tier-1 values.
  const d = Object.fromEntries(r.rows.map((row) => [row.column_name, row.column_default]));
  assert.match(d.req_level, /^1\b/);
  assert.match(d.req_strength, /^0\b/);
  assert.match(d.item_level, /^1\b/);
  assert.match(d.tier, /^1\b/);
});

test('the requirement columns reject nonsense values', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  await assert.rejects(
    pool.query(`INSERT INTO item_types (name, category, slot, kind, damage, cooldown, defense, req_level)
                VALUES ('req-check-probe-a', 'armor', 'chest', NULL, 0, 0, 1, 0)`),
    /item_types_req_level_check/,
  );
  await assert.rejects(
    pool.query(`INSERT INTO item_types (name, category, slot, kind, damage, cooldown, defense, req_strength)
                VALUES ('req-check-probe-b', 'armor', 'chest', NULL, 0, 0, 1, -1)`),
    /item_types_req_stats_check/,
  );
});
