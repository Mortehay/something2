// SOMET-604 Task 3. Proves the seeder binds the Champion aura to Champion-behaviour
// entities whose auras are NULL (a FRESH database/staging runs migration
// 1714440680000 before any Champion entity exists), leaves an admin's explicit []
// alone, and restores the library row. Uses only its own zz_ entities (cleaned up)
// so parallel test files reading shared catalog rows are never disturbed.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { bindDefaultAuras, seedOneAura } = require('../scripts/seed-catalogs.js');
const { AURA_EFFECTS, BEHAVIOR_DEFAULT_AURAS } = require('../seeds/data/auraEffects.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

test('seeded auras', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const tpl = await pool.query(`
    SELECT e.* FROM entity_types e JOIN creature_behaviors b ON b.id = e.behavior_id
     WHERE b.name = 'Champion' ORDER BY e.id LIMIT 1`);
  assert.strictEqual(tpl.rowCount, 1, 'scratch DB must be seeded with a Champion entity');
  const names = ['zz_aura_champ_null', 'zz_aura_champ_empty', 'zz_aura_plain_null'];
  const cleanup = () => pool.query('DELETE FROM entity_types WHERE name = ANY($1)', [names]);
  await cleanup();
  t.after(async () => { await cleanup(); await pool.end(); });

  // Column-order-independent clone of the template row (behavior NULL for the plain one).
  await cloneRow('zz_aura_champ_null', null, tpl.rows[0].behavior_id);
  await cloneRow('zz_aura_champ_empty', '[]', tpl.rows[0].behavior_id);
  await cloneRow('zz_aura_plain_null', null, null);

  async function cloneRow(name, auras, behaviorId) {
    await pool.query(
      `INSERT INTO entity_types
       SELECT (json_populate_record(NULL::entity_types,
         (row_to_json(e)::jsonb || jsonb_build_object(
            'id', nextval(pg_get_serial_sequence('entity_types','id')),
            'name', $1::text, 'auras', $2::jsonb, 'behavior_id', $3::int))::json)).*
         FROM entity_types e WHERE e.id = $4`,
      [name, auras, behaviorId, tpl.rows[0].id]);
  }

  const auras = async (name) =>
    (await pool.query('SELECT auras FROM entity_types WHERE name = $1', [name])).rows[0].auras;

  await t.test('exports the Champion binding and the pack_leader floor', () => {
    assert.deepStrictEqual(BEHAVIOR_DEFAULT_AURAS, { Champion: ['pack_leader'] });
    assert.ok(AURA_EFFECTS.some((a) => a.name === 'pack_leader'));
  });

  await t.test('a Champion entity with NULL auras is bound; [] and non-Champion are not', async () => {
    assert.strictEqual(await auras('zz_aura_champ_null'), null);
    const n = await bindDefaultAuras(pool);
    assert.ok(n >= 1);
    assert.deepStrictEqual(await auras('zz_aura_champ_null'), ['pack_leader']);
    assert.deepStrictEqual(await auras('zz_aura_champ_empty'), [], 'reseed must not undo a deliberate removal');
    assert.strictEqual(await auras('zz_aura_plain_null'), null, 'non-Champion is never bound');
  });

  await t.test('a second bind is a no-op for already-bound rows', async () => {
    await bindDefaultAuras(pool);
    assert.deepStrictEqual(await auras('zz_aura_champ_null'), ['pack_leader']);
    assert.deepStrictEqual(await auras('zz_aura_champ_empty'), []);
  });

  await t.test('the library row is restored on a DB that lost it', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("DELETE FROM aura_effects WHERE name = 'pack_leader'");
      for (const a of AURA_EFFECTS) await seedOneAura(c, a);
      const r = await c.query("SELECT radius, damage_mult FROM aura_effects WHERE name = 'pack_leader'");
      assert.strictEqual(r.rows[0].radius, 260);
      assert.strictEqual(r.rows[0].damage_mult, 1.25);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
