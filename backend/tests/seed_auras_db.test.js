// SOMET-604 Task 3. Proves the seeder binds the Champion aura to Champion-behaviour
// entities whose auras are NULL (a FRESH database/staging runs migration
// 1714440680000 before any Champion entity exists), leaves an admin's explicit []
// alone, and restores the library row. Uses only its own zz_ entities (cleaned up)
// so parallel test files reading shared catalog rows are never disturbed.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { bindDefaultAuras, bindWorldBossAuras, seedOneAura, seedCatalogs } = require('../scripts/seed-catalogs.js');
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

  // is_creature=false: bindDefaultAuras keys on behavior_id only, and a hostile
  // creature clone (no drop rule) would fail creature_drops_db / creature_behaviors_seed_db
  // for a parallel reader while it lives through the ~10 s seedCatalogs below.
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
            'name', $1::text, 'auras', $2::jsonb, 'behavior_id', $3::int,
            'is_creature', false))::json)).*
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

  // Guards the ORDERING: a Champion that seedCatalogs itself (re)creates must be
  // bound in the same run, i.e. bindDefaultAuras must run after the creature
  // loop. Runs in a rolled-back transaction so the shared catalog is untouched.
  await t.test('seedCatalogs binds a Champion it recreates, and keeps an explicit []', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const d = await c.query("DELETE FROM entity_types WHERE name = 'Beast Champion'");
      assert.strictEqual(d.rowCount, 1, 'Beast Champion must exist to be recreated');
      await c.query("UPDATE entity_types SET auras = NULL WHERE name = 'zz_aura_champ_null'");
      await c.query("UPDATE entity_types SET auras = '[]'::jsonb WHERE name = 'zz_aura_champ_empty'");
      await seedCatalogs(c);
      const q = async (n) => (await c.query('SELECT auras FROM entity_types WHERE name = $1', [n])).rows[0]?.auras;
      assert.deepStrictEqual(await q('Beast Champion'), ['pack_leader'], 'recreated Champion bound in the same seed');
      assert.deepStrictEqual(await q('zz_aura_champ_null'), ['pack_leader']);
      assert.deepStrictEqual(await q('zz_aura_champ_empty'), []);
    } finally { await c.query('ROLLBACK'); c.release(); }
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

  // SOMET-606 Task 6B. Everything below runs in a rolled-back transaction so the
  // real boss rows and the library are never left changed.
  const IGNIS = 'Ignis, the Magma Colossus';
  await t.test('bindWorldBossAuras: NULL is bound, [] survives, a clone with another name is untouched', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE entity_types SET auras = NULL WHERE name = $1', [IGNIS]);
      const clone = await c.query(`SELECT id FROM entity_types WHERE name = 'zz_aura_plain_null'`);
      await c.query(`UPDATE entity_types SET boss_tier = 'world' WHERE id = $1`, [clone.rows[0].id]);
      const q = async (n) => (await c.query('SELECT auras FROM entity_types WHERE name = $1', [n])).rows[0].auras;
      const n = await bindWorldBossAuras(c);
      assert.ok(n >= 1);
      assert.deepStrictEqual(await q(IGNIS), ['ignis_inferno']);
      assert.strictEqual(await q('zz_aura_plain_null'), null, 'a world-tier clone not in the map is never bound');
      await c.query("UPDATE entity_types SET auras = '[]'::jsonb WHERE name = $1", [IGNIS]);
      await bindWorldBossAuras(c);
      assert.deepStrictEqual(await q(IGNIS), [], 'an admin [] must survive a rebind');
      await c.query("UPDATE entity_types SET auras = '[\"pack_leader\"]'::jsonb WHERE name = $1", [IGNIS]);
      await bindWorldBossAuras(c);
      assert.deepStrictEqual(await q(IGNIS), ['pack_leader'], 'an authored binding is not appended to');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  await t.test('bindWorldBossAuras does not bind a non-world entity that shares a boss name', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE entity_types SET auras = NULL, boss_tier = NULL WHERE name = $1`, [IGNIS]);
      await bindWorldBossAuras(c);
      const r = await c.query('SELECT auras FROM entity_types WHERE name = $1', [IGNIS]);
      assert.strictEqual(r.rows[0].auras, null);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  await t.test('seedOneAura restores a DoT aura with its dot_dps, dot_element and tick_ms', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("DELETE FROM aura_effects WHERE name = 'ignis_inferno'");
      const seeded = AURA_EFFECTS.find((a) => a.name === 'ignis_inferno');
      assert.ok(seeded, 'ignis_inferno must be in AURA_EFFECTS');
      await seedOneAura(c, seeded);
      const r = await c.query("SELECT target_side, radius, dot_dps, dot_element, tick_ms FROM aura_effects WHERE name = 'ignis_inferno'");
      assert.deepStrictEqual(r.rows[0], { target_side: 'enemies', radius: 360, dot_dps: 6, dot_element: 'fire', tick_ms: 1000 });
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  await t.test('seedCatalogs binds a world boss it finds with NULL auras', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE entity_types SET auras = NULL WHERE name = $1', [IGNIS]);
      await seedCatalogs(c);
      const r = await c.query('SELECT auras FROM entity_types WHERE name = $1', [IGNIS]);
      assert.deepStrictEqual(r.rows[0].auras, ['ignis_inferno']);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
