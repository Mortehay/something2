// backend/tests/minibosses_seed_db.test.js
// SOMET-624 (S11). The generated miniboss roster, seeded onto a real
// migrated DB: every generated row lands, re-running is a no-op, and each
// biome's creature_types actually gains its miniboss name(s).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { buildMinibosses, minibossSpawnsByBiome } = require('../seeds/data/minibosses.js');
const { seedOneBiome, seedOneMiniboss, seedOneBehavior } = require('../scripts/seed-catalogs.js');
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('seedOneMiniboss lands every generated row, and a repeat pass inserts none', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    // Behaviours first: minibosses resolve 'Heavy'/'Champion' by name.
    for (const b of CREATURE_BEHAVIORS) await seedOneBehavior(pool, b);
    const rows = buildMinibosses(STARTER_BIOMES);

    // Not asserted on count: this DB may already be fully seeded (the
    // standard scratch-DB recipe runs the whole `make seed-catalogs` before
    // any test file), so a "first pass" here is not necessarily the first
    // pass ever. What matters is the END STATE below, and that repeating it
    // from THAT state inserts nothing.
    for (const b of rows) await seedOneMiniboss(pool, b);

    let second = 0;
    for (const b of rows) second += await seedOneMiniboss(pool, b);
    assert.equal(second, 0, 'a pass from a fully-seeded state is a no-op (ownership transfers to the row after insert)');

    const live = await pool.query(
      `SELECT name, boss_tier, hp, defense, attack_element, element
         FROM entity_types WHERE boss_tier = 'miniboss' ORDER BY name`);
    assert.equal(live.rows.length, rows.length);
    const byName = new Map(rows.map((r) => [r.name, r]));
    for (const row of live.rows) {
      const gen = byName.get(row.name);
      assert.ok(gen, row.name);
      assert.equal(row.hp, gen.hp, row.name);
      assert.equal(row.defense, gen.defense, row.name);
      assert.equal(row.attack_element, gen.attack_element, row.name);
      assert.equal(row.element, gen.element, row.name);
    }
  } finally {
    await pool.end();
  }
});

test('every miniboss has a creature_drops row (tests/creature_drops_db.test.js\'s whole-catalog invariant)', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const dropless = await pool.query(
      `SELECT et.name FROM entity_types et
         LEFT JOIN creature_drops cd ON cd.entity_type_id = et.id
        WHERE et.boss_tier = 'miniboss' AND cd.id IS NULL`);
    assert.deepEqual(dropless.rows, []);
  } finally {
    await pool.end();
  }
});

// SOMET-625 (S12).
test('every miniboss has exactly its two generated drop rows, matching item + chance', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const rows = buildMinibosses(STARTER_BIOMES);
    const r = await pool.query(
      `SELECT et.name AS creature, it.name AS item, cd.chance, cd.min_qty, cd.max_qty
         FROM creature_drops cd
         JOIN entity_types et ON et.id = cd.entity_type_id
         JOIN item_types it ON it.id = cd.item_type_id
        WHERE et.boss_tier = 'miniboss'`);
    const byCreature = new Map();
    for (const row of r.rows) {
      if (!byCreature.has(row.creature)) byCreature.set(row.creature, []);
      byCreature.get(row.creature).push(row);
    }
    for (const gen of rows) {
      const live = byCreature.get(gen.name) || [];
      assert.equal(live.length, 2, gen.name);
      for (const d of gen.drops) {
        const match = live.find((l) => l.item === d.item);
        assert.ok(match, `${gen.name}: expected a drop row for ${d.item}`);
        assert.equal(Number(match.chance), d.chance, `${gen.name}/${d.item}`);
      }
    }
  } finally {
    await pool.end();
  }
});

test('seeding a biome wires its generated miniboss name(s) into creature_types', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const rows = buildMinibosses(STARTER_BIOMES);
    const spawns = minibossSpawnsByBiome(rows);
    const meadow = STARTER_BIOMES.find((b) => b.name === 'Meadow');
    const withSpawns = { ...meadow, creature_types: [...meadow.creature_types, ...spawns.get('Meadow')] };
    await seedOneBiome(pool, withSpawns);

    const r = await pool.query('SELECT creature_types FROM biomes WHERE name = $1', ['Meadow']);
    assert.ok(r.rows[0].creature_types.includes('Beast Miniboss'));
    // The legacy names stay too -- this is an addition, not a replacement.
    assert.ok(r.rows[0].creature_types.includes('Wolf'));
  } finally {
    await pool.end();
  }
});
