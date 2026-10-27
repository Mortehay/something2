// backend/tests/boss_aura_hydration_db.test.js
// SOMET-604 x SOMET-603 merge contract (spec §6): a world boss is spawned from
// ENTITY_CATALOG_SELECT through hydrateCreatureRow, never through
// CREATURE_JOINED_SELECT. If that SELECT does not carry `aura_names`/`aura_defs`
// (AURAS_LATERAL), every aura bound to a boss or its minions is inert while
// the chunk-loader tests stay green. This drives the real path end to end:
// a real entity_types row -> loadWorldBossCatalog -> hydrateCreatureRow ->
// CreatureSim.addCreatures -> resolveInstanceAuras.
//
// The fixture row lives only inside a transaction that is always rolled back,
// so parallel invariant readers (creature_drops_db, creature_behaviors_seed_db)
// never see a hostile creature with no drop rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { loadWorldBossCatalog } = require('../src/authority/worldBoss');
const { CreatureSim, hydrateCreatureRow } = require('../src/authority/creatures');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;
const NAME = 'zzBossAuraContract';

test('a world boss bound to pack_leader hydrates with the resolved aura def', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lib = await client.query(
      'SELECT radius, damage_mult, defense_mult, speed_mult, target_side FROM aura_effects WHERE name = $1',
      ['pack_leader']);
    assert.equal(lib.rows.length, 1, 'precondition: pack_leader is in the aura library');
    const expected = lib.rows[0];

    await client.query(
      `INSERT INTO entity_types (name, color, is_creature, boss_tier, element, hp, max_hp, auras)
       VALUES ($1, '#ff0000', true, 'world', 'fire', 5000, 5000, $2::jsonb)`,
      [NAME, JSON.stringify(['pack_leader'])]);

    const catalog = await loadWorldBossCatalog(client);
    const row = catalog.bosses.find((b) => b.name === NAME);
    assert.ok(row, 'the fixture boss is in the world-boss catalog');

    const sim = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
    sim.addCreatures([hydrateCreatureRow(row, { id: 'zz_boss_aura_1', x: 100, y: 100, level: 1, hp: 5000 })]);
    const c = sim.get('zz_boss_aura_1');
    assert.ok(c, 'the boss was placed');
    assert.ok(Array.isArray(c.auras), 'auras is an array');
    const pl = c.auras.find((a) => a.name === 'pack_leader');
    assert.ok(pl, `pack_leader resolved onto the boss (got ${JSON.stringify(c.auras)})`);
    assert.equal(pl.targetSide, expected.target_side);
    assert.equal(pl.radius, Number(expected.radius));
    assert.equal(pl.damageMult, Number(expected.damage_mult));
    assert.equal(pl.defenseMult, Number(expected.defense_mult));
    assert.equal(pl.speedMult, Number(expected.speed_mult));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
