// Real-DB coverage for SOMET-253 Task 7 (per-rung loot and gold): the NEW
// `behavior_drops` table (a rung-level fallback pool, alongside the existing
// per-creature `creature_drops`) and the `behaviorGold` fallback range that
// backs it, both wired through loadCreatureTypes + spawnDrops.
//
// Exercises loadCreatureTypes + spawnDrops against the REAL schema rather
// than a scripted pool (unlike goldDrop.test.js's unit tests) -- this is the
// only place that proves the JOIN against a live behavior_id, and the
// row->Map wiring loadCreatureTypes performs for behaviorDrops/behaviorGold,
// actually work end to end.
//
// SAFETY: every fixture row is zz-prefixed (creature type/behaviour/world
// names) and torn down BY NAME, unconditionally, in a `finally`. No test
// here reads gold/dagger/short sword as anything but a foreign key target --
// see the task's Global Constraints on never writing to a real catalog row.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { loadCreatureTypes } = require('../src/authority/creatures.js');
const { spawnDrops } = require('../src/authority/loot.js');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Real item types this file only ever READS via FK -- never mutated, never
// asserted to have any particular chance/qty of their own. 'gold' is the
// same currency item goldDrop.test.js and claimGold.test.js reference.
const TYPE_ITEM = 'dagger';
const RUNG_ITEM = 'short sword';
const GOLD_ITEM = 'gold';

async function makeWorld(pool, name) {
  const r = await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [name]);
  return r.rows[0].id;
}

async function makeBehavior(pool, name, { goldMin = 0, goldMax = 0 } = {}) {
  const r = await pool.query(
    `INSERT INTO creature_behaviors (name, aggro_radius, leash_radius, chase_style, gold_min, gold_max)
     VALUES ($1, 400, 800, 'charge', $2, $3) RETURNING id`,
    [name, goldMin, goldMax],
  );
  return r.rows[0].id;
}

async function makeCreatureType(pool, name, behaviorId, { goldMin = 0, goldMax = 0 } = {}) {
  const r = await pool.query(
    `INSERT INTO entity_types (name, color, is_creature, behavior_id, gold_min, gold_max)
     VALUES ($1, '#fff', true, $2, $3, $4) RETURNING id`,
    [name, behaviorId, goldMin, goldMax],
  );
  return r.rows[0].id;
}

async function itemTypeId(pool, name) {
  const r = await pool.query('SELECT id FROM item_types WHERE name = $1', [name]);
  assert.equal(r.rowCount, 1, `fixture item type "${name}" must exist in the real catalog`);
  return r.rows[0].id;
}

async function cleanup(pool, { worldName, behaviorName, creatureName }) {
  // creature_drops/behavior_drops cascade away with their parent (entity_types
  // / creature_behaviors, both ON DELETE CASCADE), and world_items cascades
  // with worlds -- so deleting the three roots is enough.
  if (worldName) await pool.query('DELETE FROM worlds WHERE name = $1', [worldName]).catch(() => {});
  if (creatureName) await pool.query('DELETE FROM entity_types WHERE name = $1', [creatureName]).catch(() => {});
  if (behaviorName) await pool.query('DELETE FROM creature_behaviors WHERE name = $1', [behaviorName]).catch(() => {});
}

// Full integration, not a hand-built entry: catches a bug in loadCreatureTypes'
// row->Map wiring (behaviorDrops/behaviorGold), not just in spawnDrops' own
// logic given a correctly-shaped entry.
async function loadEntry(pool, worldId, goldItemTypeId = null) {
  const {
    creatureTypeIds, creatureGold, behaviorGold, behaviorDrops,
  } = await loadCreatureTypes(pool);
  const added = [];
  return {
    entry: {
      worldId,
      goldItemTypeId,
      creatureTypeIds,
      creatureGold,
      behaviorGold,
      behaviorDrops,
      world: { groundItems: { add: (rows) => added.push(...rows) } },
    },
    added,
  };
}

test('behavior_drops + behaviorGold (rung loot/gold)', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('a creature rolls BOTH its rung drops and its type drops', async () => {
    const worldName = 'zzLootBothWorld';
    const behaviorName = 'zzLootBothBehavior';
    const creatureName = 'zzLootBothCreature';
    try {
      const worldId = await makeWorld(pool, worldName);
      const behaviorId = await makeBehavior(pool, behaviorName);
      const creatureId = await makeCreatureType(pool, creatureName, behaviorId);
      const typeItemId = await itemTypeId(pool, TYPE_ITEM);
      const rungItemId = await itemTypeId(pool, RUNG_ITEM);
      await pool.query(
        `INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty)
         VALUES ($1, $2, 1, 1, 1)`,
        [creatureId, typeItemId],
      );
      await pool.query(
        `INSERT INTO behavior_drops (behavior_id, item_type_id, chance, min_qty, max_qty)
         VALUES ($1, $2, 1, 1, 1)`,
        [behaviorId, rungItemId],
      );

      const { entry, added } = await loadEntry(pool, worldId);

      // rng forced to 0: chance=1 always rolls (rollDrops skips only when
      // rng() >= chance, and 0 >= 1 is false), and min_qty === max_qty === 1
      // makes the quantity roll irrelevant. This is what makes the test
      // load-bearing rather than probabilistic -- an implementation that
      // queries only ONE of the two tables (whichever it checks first) would
      // still drop exactly one item under this rng; only requiring BOTH
      // landed catches that weaker implementation.
      await spawnDrops(pool, entry, { type: creatureName, x: 10, y: 20 }, { rng: () => 0 });

      const droppedItemIds = added.map((r) => r.item_type_id).sort((a, b) => a - b);
      assert.deepEqual(
        droppedItemIds,
        [typeItemId, rungItemId].sort((a, b) => a - b),
        'a creature with both a type-level AND a rung-level drop rule must roll BOTH',
      );
    } finally {
      await cleanup(pool, { worldName, behaviorName, creatureName });
    }
  });

  await t.test('a creature type with no drops of its own still gets its rung drop', async () => {
    const worldName = 'zzLootRungOnlyWorld';
    const behaviorName = 'zzLootRungOnlyBehavior';
    const creatureName = 'zzLootRungOnlyCreature';
    try {
      const worldId = await makeWorld(pool, worldName);
      const behaviorId = await makeBehavior(pool, behaviorName);
      await makeCreatureType(pool, creatureName, behaviorId); // no creature_drops row at all
      const rungItemId = await itemTypeId(pool, RUNG_ITEM);
      await pool.query(
        `INSERT INTO behavior_drops (behavior_id, item_type_id, chance, min_qty, max_qty)
         VALUES ($1, $2, 1, 1, 1)`,
        [behaviorId, rungItemId],
      );

      const { entry, added } = await loadEntry(pool, worldId);
      await spawnDrops(pool, entry, { type: creatureName, x: 0, y: 0 }, { rng: () => 0 });

      assert.deepEqual(
        added.map((r) => r.item_type_id),
        [rungItemId],
        'a creature with zero creature_drops rows of its own must still roll its rung fallback',
      );
    } finally {
      await cleanup(pool, { worldName, behaviorName, creatureName });
    }
  });

  await t.test('the type gold range wins when it is set', async () => {
    const worldName = 'zzLootTypeGoldWorld';
    const behaviorName = 'zzLootTypeGoldBehavior';
    const creatureName = 'zzLootTypeGoldCreature';
    try {
      const worldId = await makeWorld(pool, worldName);
      // Fixed [min,max] ranges (not just non-zero) so the rolled amount is
      // deterministic regardless of rng, and the two ranges are pinned to
      // different values so picking the wrong one is provably wrong, not
      // coincidentally right.
      const behaviorId = await makeBehavior(pool, behaviorName, { goldMin: 5, goldMax: 5 });
      await makeCreatureType(pool, creatureName, behaviorId, { goldMin: 9, goldMax: 9 });
      const goldItemTypeId = await itemTypeId(pool, GOLD_ITEM);

      const { entry, added } = await loadEntry(pool, worldId, goldItemTypeId);
      await spawnDrops(pool, entry, { type: creatureName, x: 0, y: 0 }, { rng: () => 0.5 });

      const goldRows = added.filter((r) => r.item_type_id === goldItemTypeId);
      assert.equal(goldRows.length, 1, 'exactly one gold world_item');
      assert.equal(goldRows[0].quantity, 9, 'the TYPE range (9) must win over the rung range (5)');
    } finally {
      await cleanup(pool, { worldName, behaviorName, creatureName });
    }
  });

  await t.test('the rung gold range is used when the type has none', async () => {
    const worldName = 'zzLootRungGoldWorld';
    const behaviorName = 'zzLootRungGoldBehavior';
    const creatureName = 'zzLootRungGoldCreature';
    try {
      const worldId = await makeWorld(pool, worldName);
      const behaviorId = await makeBehavior(pool, behaviorName, { goldMin: 7, goldMax: 7 });
      // Type's own gold_min/gold_max both default to 0 -- no range of its own.
      await makeCreatureType(pool, creatureName, behaviorId);
      const goldItemTypeId = await itemTypeId(pool, GOLD_ITEM);

      const { entry, added } = await loadEntry(pool, worldId, goldItemTypeId);
      await spawnDrops(pool, entry, { type: creatureName, x: 0, y: 0 }, { rng: () => 0.5 });

      const goldRows = added.filter((r) => r.item_type_id === goldItemTypeId);
      assert.equal(goldRows.length, 1, 'exactly one gold world_item');
      assert.equal(goldRows[0].quantity, 7, 'must fall back to the rung range (7) when the type has none');
    } finally {
      await cleanup(pool, { worldName, behaviorName, creatureName });
    }
  });

  await t.test('a type gold range of zero with no rung fallback drops no gold', async () => {
    const worldName = 'zzLootNoGoldWorld';
    const behaviorName = 'zzLootNoGoldBehavior';
    const creatureName = 'zzLootNoGoldCreature';
    try {
      const worldId = await makeWorld(pool, worldName);
      const behaviorId = await makeBehavior(pool, behaviorName); // gold_min/max default 0/0
      await makeCreatureType(pool, creatureName, behaviorId); // gold_min/max default 0/0
      const goldItemTypeId = await itemTypeId(pool, GOLD_ITEM);

      const { entry, added } = await loadEntry(pool, worldId, goldItemTypeId);
      // rng near 1: if either range were misread as non-empty this would
      // still roll the maximum of it, so a high rng does not mask a bug --
      // it is the zero MAX on both ranges that must produce zero gold.
      await spawnDrops(pool, entry, { type: creatureName, x: 0, y: 0 }, { rng: () => 0.999 });

      const goldRows = added.filter((r) => r.item_type_id === goldItemTypeId);
      assert.equal(goldRows.length, 0, 'no gold world_item may be inserted when both ranges are empty');
    } finally {
      await cleanup(pool, { worldName, behaviorName, creatureName });
    }
  });
});
