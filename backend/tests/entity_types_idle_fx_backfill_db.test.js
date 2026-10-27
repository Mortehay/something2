// Migration 1714440824000: GPU-box prop rows queued before sprite_sets.prop_fx
// existed get the effect their actions asked for ('sway' in actions -> 'sway',
// else 'none'); other rows and rows that already chose stay as they are. Runs
// the migration's SQL inside a transaction that is always rolled back.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { PROP_FX_BACKFILL_SQL } = require('../migrations/1714440824000_entity_types_idle_fx');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('prop_fx backfill: gpu-box object rows without prop_fx follow their actions', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  const tag = `fxbackfill-${process.pid}-${Date.now()}`;
  try {
    await client.query('BEGIN');
    const ins = async (key, { backend = 'gpu-box', kind = 'object', actions = null, fx = null } = {}) => (await client.query(
      `INSERT INTO sprite_sets (creature, backend, generation_kind, actions, prop_fx)
       VALUES ($1, $2, $3, $4::text[], $5) RETURNING id`,
      [`${tag}-${key}`, backend, kind, actions, fx],
    )).rows[0].id;
    const ids = {
      sway: await ins('sway', { actions: ['idle', 'sway'] }),
      idle: await ins('idle', { actions: ['idle'] }),
      noActions: await ins('none'),
      chosen: await ins('chosen', { actions: ['idle', 'sway'], fx: 'shine' }),
      creature: await ins('creature', { kind: 'creature', actions: ['idle', 'sway'] }),
      local: await ins('local', { backend: 'local', actions: ['idle', 'sway'] }),
    };

    await client.query(PROP_FX_BACKFILL_SQL);

    const { rows } = await client.query('SELECT id, prop_fx FROM sprite_sets WHERE id = ANY($1::uuid[])', [Object.values(ids)]);
    const got = Object.fromEntries(rows.map((r) => [r.id, r.prop_fx]));
    const want = { sway: 'sway', idle: 'none', noActions: 'none', chosen: 'shine', creature: null, local: null };
    for (const [name, expected] of Object.entries(want)) assert.strictEqual(got[ids[name]], expected, name);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
