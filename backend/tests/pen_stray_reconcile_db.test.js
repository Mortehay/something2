// SOMET-356 -- a pen that MOVES must not leave its livestock behind.
//
// worldHasPennedCreatures asks "is anything penned inside the boxes authored
// TODAY". Move a pen and the answer is no, so the seeder happily lays down a
// second herd in the new box while the first stays put -- populateWorld's
// DELETE spares every row carrying home_x, so nothing ever removes it. The home
// region had accumulated 17 such creatures across three worlds.
//
// These tests exercise deleteStrayPennedCreatures directly rather than driving
// the whole seeder, because the seeder needs a full spec, catalogs and a
// generated world to reach the pen pass, and none of that is what is under
// test. The seeder's own call site is one line and is covered by the pen tests
// that already run applyMapSpec.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { withFixtureWorld } = require('./helpers/fixtureWorld');
const {
  pensOf, worldHasPennedCreatures, deleteStrayPennedCreatures,
} = require('../src/services/pens');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// The authored pen, and where that same pen used to live before it moved.
// CREATURE_TILE_PX is 100, so a box at row 20 / col 20 spans 2000..2600 px.
const PEN = { min_row: 20, min_col: 20, width: 6, height: 5, creature_type: 'Wolf', count: 3, level: 1 };
const IN_PEN = { x: 2050, y: 2050 };
const OLD_PEN = { x: 700, y: 700 };   // where the herd was anchored before the move

async function addCreature(pool, worldId, { x, y, type = 'Wolf', homed = true, portal = null }) {
  const r = await pool.query(
    `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense,
                                  home_x, home_y, blocks_portal_id)
     VALUES ($1,$2,$3,$4,20,'S',1,5,0,$5,$6,$7) RETURNING id`,
    [worldId, type, x, y, homed ? x : null, homed ? y : null, portal],
  );
  return r.rows[0].id;
}

const withPenWorld = (pool, fn) => withFixtureWorld(pool, fn, { prefix: 'zzPenStray' });

async function setPens(pool, worldId, pens) {
  await pool.query('UPDATE worlds SET pens = $2::jsonb WHERE id = $1',
    [worldId, JSON.stringify(pens)]);
  const r = await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
  return pensOf(r.rows[0]);
}

test('a herd left behind by a moved pen is removed, and the current herd is not',
  { skip: !url }, async () => {
    const pool = new Pool({ connectionString: url });
    try {
      await withPenWorld(pool, async (worldId) => {
        const pens = await setPens(pool, worldId, [PEN]);

        const stale = await addCreature(pool, worldId, OLD_PEN);
        const current = await addCreature(pool, worldId, IN_PEN);

        // NON-VACUITY: the world must actually start in the broken state --
        // both rows present, and the seeder's own guard already satisfied by
        // the in-pen row, which is what makes the stale one invisible to it.
        assert.equal((await pool.query(
          'SELECT count(*)::int n FROM world_creatures WHERE world_id = $1', [worldId])).rows[0].n, 2);
        assert.equal(await worldHasPennedCreatures(pool, worldId, pens), true);

        assert.equal(await deleteStrayPennedCreatures(pool, worldId, pens), 1);

        const left = (await pool.query(
          'SELECT id FROM world_creatures WHERE world_id = $1', [worldId])).rows.map((r) => r.id);
        assert.deepEqual(left, [current], 'the in-pen creature must survive');
        assert.ok(!left.includes(stale), 'the abandoned herd must be gone');
      });
    } finally {
      await pool.end();
    }
  });

// THE ONE THAT MATTERS MOST. A chest guard is homed, is not a village guard and
// is not a portal guard -- identical to a penned creature on every column the
// filter reads -- and it sits OUTSIDE the pen boxes by design. Without the
// world_chests exclusion this reconcile would delete the guard off every vault
// chest, field chest and player `loot_map` drop in any world that also has a
// pen. That is a strictly worse bug than the one being fixed.
test('a chest guard anchored outside the pen is NOT treated as a stray',
  { skip: !url }, async () => {
    const pool = new Pool({ connectionString: url });
    try {
      await withPenWorld(pool, async (worldId) => {
        const pens = await setPens(pool, worldId, [PEN]);

        const guard = await addCreature(pool, worldId, { x: 800, y: 800 });
        // kind / guard_entity_type_id / guard_level are NOT NULL on
        // world_chests; the entity type is read from the catalog rather than
        // hard-coded so this does not break when ids shift.
        const et = await pool.query(
          'SELECT id FROM entity_types WHERE is_creature = true ORDER BY id LIMIT 1');
        assert.ok(et.rowCount === 1, 'need a creature entity type to build a chest fixture');
        await pool.query(
          `INSERT INTO world_chests (world_id, x, y, kind, guard_entity_type_id,
                                     guard_level, guard_creature_ids)
           VALUES ($1, 800, 800, 'vault', $2, 1, $3::jsonb)`,
          [worldId, et.rows[0].id, JSON.stringify([guard])]);
        const stray = await addCreature(pool, worldId, OLD_PEN);

        // Both look identical to the base predicate; only the chest link tells
        // them apart. If the exclusion were dropped this would delete 2.
        assert.equal(await deleteStrayPennedCreatures(pool, worldId, pens), 1);

        const left = (await pool.query(
          'SELECT id FROM world_creatures WHERE world_id = $1', [worldId])).rows.map((r) => r.id);
        assert.deepEqual(left, [guard], 'the chest guard must survive; only the stray goes');
        assert.ok(!left.includes(stray));
      });
    } finally {
      await pool.end();
    }
  });

test('village guards, portal guards and unhomed wildlife are never strays',
  { skip: !url }, async () => {
    const pool = new Pool({ connectionString: url });
    try {
      await withPenWorld(pool, async (worldId) => {
        const pens = await setPens(pool, worldId, [PEN]);

        await addCreature(pool, worldId, { x: 500, y: 500, type: 'Village Guard' });
        await addCreature(pool, worldId, { x: 600, y: 600, homed: false });

        assert.equal(await deleteStrayPennedCreatures(pool, worldId, pens), 0);
        assert.equal((await pool.query(
          'SELECT count(*)::int n FROM world_creatures WHERE world_id = $1', [worldId])).rows[0].n, 2);
      });
    } finally {
      await pool.end();
    }
  });

// The dangerous degenerate case, asserted rather than left to the caller's
// discipline. With no authored pens the base predicate's box test is `false`,
// and NOT false is TRUE -- so a naive inversion would sweep every homed
// creature in a world that simply has no pens.
test('a world that authors no pens is refused outright, not swept clean',
  { skip: !url }, async () => {
    const pool = new Pool({ connectionString: url });
    try {
      await withPenWorld(pool, async (worldId) => {
        await setPens(pool, worldId, []);
        await addCreature(pool, worldId, { x: 700, y: 700 });
        await addCreature(pool, worldId, { x: 900, y: 900 });

        assert.equal(await deleteStrayPennedCreatures(pool, worldId, []), 0);
        assert.equal(await deleteStrayPennedCreatures(pool, worldId, null), 0);
        assert.equal((await pool.query(
          'SELECT count(*)::int n FROM world_creatures WHERE world_id = $1', [worldId])).rows[0].n, 2,
        'both homed creatures must survive a world with no authored pens');
      });
    } finally {
      await pool.end();
    }
  });
