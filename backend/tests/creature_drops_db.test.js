const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

// THE COVERAGE GAP THIS FILE CLOSES: adding a creature is a one-line INSERT in
// a migration, and nothing anywhere else in the codebase has to change for it
// to start spawning — spawnChunkCreatures (mapService.js) picks uniformly from
// whatever `entity_types WHERE is_creature = true` returns. That is exactly
// why the drop table silently fell behind: slice 3b3c added Slime, Skeleton
// and Bat, every test stayed green, and ~75% of the creatures in every newly
// generated chunk began dropping nothing.
//
// No unit test could have caught it. The defect is not in any function's
// behaviour — rollDrops handles an empty row set correctly, which is precisely
// the problem — it is in the DATA, in the join between two tables that only a
// real schema has. So the assertion lives here, against the live catalog.
//
// It is written as a coverage invariant over the whole table rather than as
// three assertions naming Slime, Skeleton and Bat. A test naming today's
// creatures would pass forever while creature number five shipped dropless;
// this one fails the moment anyone adds a creature without a drop rule, which
// is the mistake actually worth preventing.
//
// Skipping: if no database is reachable this SKIPS rather than fails, so the
// suite still runs without Postgres — but under CI an unreachable database is
// a hard failure, because a skip reads identically to a pass in the summary
// and this is the only enforcement of the invariant. Same posture as
// authority_ammo_db.test.js; treat a skip as "unknown", never as "passing".
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: err.message };
  }
}

test('EVERY creature type has at least one creature_drops row', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — creature drop coverage is UNVERIFIED on this run`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    // Scoped to the HOSTILE faction: this invariant is about huntable content —
    // a mob a player kills must yield something. Guard-faction creatures
    // (village gate guards) are defenders, not loot piles: they are never a
    // kill target for progression and deliberately have no drop rule.
    const creatures = await pool.query(
      "SELECT id, name FROM entity_types WHERE is_creature = true AND faction = 'hostile' ORDER BY name ASC",
    );
    // Guard the guard: if the creature list ever comes back empty this test
    // would "pass" having asserted nothing at all — the vacuous-green failure
    // mode. There is always at least one creature (Wolf predates this slice).
    assert.ok(creatures.rowCount > 0,
      'no creature types found — this test cannot prove anything against an empty catalog');

    const dropless = await pool.query(
      `SELECT et.name
         FROM entity_types et
         LEFT JOIN creature_drops cd ON cd.entity_type_id = et.id
        WHERE et.is_creature = true AND et.faction = 'hostile' AND cd.id IS NULL
        ORDER BY et.name ASC`,
    );
    assert.deepEqual(dropless.rows.map((r) => r.name), [],
      'these creature types have NO drop rule and will die yielding nothing — '
      + 'add a creature_drops row in a new migration (see 1714440024000_elements_creature_drops.js)');
  } finally {
    await pool.end().catch(() => {});
  }
});

test('every creature_drops row points at a real item and a creature (not scenery)', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — drop-row sanity is UNVERIFIED on this run`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    // The guarded cross-join INSERT style used by the drop migrations fails
    // OPEN: a typo in an item name inserts zero rows rather than erroring. That
    // is the right posture for a migration (a rename must not wedge a deploy)
    // but it means a typo is otherwise completely silent, so it gets caught
    // here instead — a drop rule attached to scenery, or none at all, both
    // surface as a creature missing from the coverage check above plus a
    // suspicious row here.
    const misattached = await pool.query(
      `SELECT et.name
         FROM creature_drops cd
         JOIN entity_types et ON et.id = cd.entity_type_id
        WHERE et.is_creature = false
        ORDER BY et.name ASC`,
    );
    assert.deepEqual(misattached.rows.map((r) => r.name), [],
      'drop rules are attached to non-creature entity types — those rows can never fire');

    const rows = await pool.query(
      `SELECT et.name AS creature, it.name AS item, cd.chance, cd.min_qty, cd.max_qty
         FROM creature_drops cd
         JOIN entity_types et ON et.id = cd.entity_type_id
         JOIN item_types it ON it.id = cd.item_type_id`,
    );
    assert.ok(rows.rowCount > 0, 'creature_drops is empty — no creature can drop anything');
    for (const r of rows.rows) {
      const chance = Number(r.chance);
      // rollDrops treats a non-finite or <= 0 chance as "never drops" and skips
      // the row silently, so a bad value here is another way to ship an inert
      // rule that no unit test would notice.
      assert.ok(Number.isFinite(chance) && chance > 0 && chance <= 1,
        `${r.creature} -> ${r.item} has an unusable chance (${r.chance})`);
      assert.ok(r.min_qty >= 1 && r.max_qty >= r.min_qty,
        `${r.creature} -> ${r.item} has an inverted quantity range`);
    }
  } finally {
    await pool.end().catch(() => {});
  }
});
