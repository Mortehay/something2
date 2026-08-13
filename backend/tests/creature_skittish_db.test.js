// The SOMET-249 trap: a behaviour authored in the catalog but read through
// only one of two loaders is silently inert in the live tick. There are two
// SEPARATELY MAINTAINED SQL strings that can carry a creature's behaviour:
//   1. creatures.js's loadCreatureTypes -- builds the TYPE catalog
//      (entry.creatureTypes). Its own header comment says plainly that
//      nothing downstream reads this back off the world entry: "this
//      resolved `behavior` is not read by any live production path."
//   2. server.js's CREATURE_JOINED_SELECT -- THE query the live tick reads.
//      Reached via activateChunk (chunk load) or injectGuardIntoSim (a
//      guard spawned mid-session), both of which feed real rows straight
//      into CreatureSim.addCreatures, which resolves each one's behaviour
//      via resolveInstanceBehavior.
//
// Fix round 1 of this test proved the flag only through (1) -- the loader
// SOMET-249's own comment says nothing ticks from. That closed nothing; it
// exercised the dead path and would have passed even if (2) had never been
// touched at all. This file now proves the flag through (2): a real
// world_creatures row of a flagged type, read back through the EXACT
// CREATURE_JOINED_SELECT text server.js exports (not a retyped copy, which
// is how (1) and (2) drifted apart in the first place) and fed through
// CreatureSim.addCreatures -- the same call activateChunk makes at
// server.js:776 -- asserting the resulting in-memory creature carries
// chaseStyle 'skittish'.
//
// (1)'s coverage is kept below too -- it is not wrong, only insufficient on
// its own -- because it still guards the TYPE catalog's own join, which
// other code (creatureGold/behaviorDrops, per loadCreatureTypes' own
// comments) does read live.
//
// Fixture rows are named zzSkit* and deleted BY NAME, unconditionally, in a
// finally -- never by an id captured mid-test.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { loadCreatureTypes, CreatureSim } = require('../src/authority/creatures.js');
const { CREATURE_JOINED_SELECT } = require('../src/authority/server.js');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// The real types this slice puts the Skittish profile on -- Task 4's own
// choice (fix round 1: P4 bestiary wildlife at the lowest rung, NOT the four
// legacy types -- see the migration's own header for why that first choice
// was reverted), asserted here so a future edit that drops the flag from any
// of the three fails THIS test rather than going unnoticed.
const SKITTISH_TYPES = ['Woodland Swarm', 'Beast Swarm', 'Highland Swarm'];
// Two classes of negative control, not one -- the incident this migration's
// own header records was a WHERE clause that matched too broadly (94 live
// creatures flipped by accident), so "some other row did not change" has to
// be checked two ways:
//   - a legacy type (Wolf) untouched by this task at all, and
//   - a SIBLING Swarm-rung creature from a line this task did NOT pick
//     (Undead Swarm, Desert Swarm) -- these share the exact pre-migration
//     behavior_id (Swarm) that the three chosen types used to carry, so this
//     is the control that actually catches a WHERE clause broad enough to
//     repeat the incident.
const NOT_SKITTISH_TYPES = ['Wolf', 'Undead Swarm', 'Desert Swarm'];

// Builds one real world_creatures row of `type` in a fresh fixture world,
// reads it back through the EXACT live query, and resolves it through the
// EXACT live class -- the path activateChunk actually runs, not a
// hand-assembled object shaped like one.
async function loadLiveInstance(pool, type) {
  const world = await pool.query(
    `INSERT INTO worlds (name, seed) VALUES ('zzSkitWorld', 1) RETURNING id`,
  );
  const worldId = world.rows[0].id;
  try {
    const creature = await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing)
       VALUES ($1, $2, 100, 100, 8, 'S') RETURNING id`,
      [worldId, type],
    );
    const rows = await pool.query(`${CREATURE_JOINED_SELECT} WHERE wc.id = $1`, [creature.rows[0].id]);
    assert.equal(rows.rowCount, 1, `CREATURE_JOINED_SELECT did not find the fixture ${type} row at all`);
    // chunkSize is the only field CreatureSim's constructor reads eagerly;
    // nothing in addCreatures touches the map, so a bare stub is enough --
    // this is exercising resolveInstanceBehavior via addCreatures, not roam.
    const sim = new CreatureSim({ chunkSize: 8 });
    sim.addCreatures(rows.rows);
    return sim.all()[0];
  } finally {
    // World, by name, unconditionally -- world_creatures.world_id is
    // ON DELETE CASCADE (migration 1714440013000), so this alone cleans up
    // the fixture creature row too.
    await pool.query(`DELETE FROM worlds WHERE name = 'zzSkitWorld'`);
  }
}

test('skittish creature types', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('a real world_creatures row of a flagged type resolves chaseStyle skittish through the LIVE path (CREATURE_JOINED_SELECT + CreatureSim.addCreatures)', async () => {
    const instance = await loadLiveInstance(pool, 'Woodland Swarm');
    assert.equal(instance.behavior.chaseStyle, 'skittish',
      'a real world_creatures row of a flagged type did not resolve chaseStyle \'skittish\' '
      + 'through the query and class the live tick actually uses -- the SOMET-249 inertness '
      + 'trap, on the path that matters');
  });

  await t.test('a real world_creatures row of an UN-flagged sibling does not resolve skittish through the same live path', async () => {
    // Same rung the three flagged types used to share (Swarm), same live
    // path -- this is the control that would catch CREATURE_JOINED_SELECT
    // resolving every creature (or every Swarm) to Skittish regardless of
    // which row it is, a bug the positive assertion alone cannot see.
    const instance = await loadLiveInstance(pool, 'Undead Swarm');
    assert.notEqual(instance.behavior.chaseStyle, 'skittish',
      'Undead Swarm resolved chaseStyle \'skittish\' through the live path -- it was never '
      + 'flagged, so CREATURE_JOINED_SELECT or resolveInstanceBehavior is over-applying the '
      + 'profile');
  });

  // ---------------------------------------------------------------------
  // The TYPE-catalog coverage below is loadCreatureTypes' own join, kept
  // because loadCreatureTypes still has live readers of its own
  // (creatureGold/behaviorGold/behaviorDrops -- see its comments) -- but it
  // is NOT the path the running tick's behaviour comes from. Do not read
  // green here as proof the instance-level flag is live; the two tests
  // above are what prove that.
  // ---------------------------------------------------------------------

  await t.test('a fixture creature of a skittish type resolves chaseStyle skittish through loadCreatureTypes\' own join (TYPE catalog only, not the live tick path)', async () => {
    try {
      // faction 'guard', not the 'hostile' default: a dropless is_creature=true
      // fixture with faction 'hostile' would trip creature_drops_db.test.js's
      // catalog-wide "every hostile creature has a drop rule" invariant while
      // it briefly exists -- node:test runs test FILES concurrently, so that
      // is a real race, not a hypothetical (same trick, same reasoning, as
      // loot_behavior_drops_db.test.js's makeCreatureType).
      await pool.query(
        `INSERT INTO entity_types (name, color, is_creature, behavior_id, faction)
         VALUES ('zzSkitFixture', '#fff', true,
           (SELECT id FROM creature_behaviors WHERE name = 'Skittish'), 'guard')`,
      );

      const { creatureTypes } = await loadCreatureTypes(pool);
      const row = creatureTypes.find((c) => c.name === 'zzSkitFixture');
      assert.ok(row, 'the fixture creature type did not load through loadCreatureTypes at all');
      assert.equal(row.behavior.chaseStyle, 'skittish',
        'a creature type with behavior_id pointing at Skittish did not resolve chaseStyle '
        + '\'skittish\' through loadCreatureTypes\' own LEFT JOIN creature_behaviors');
    } finally {
      // By name, unconditionally.
      await pool.query(`DELETE FROM entity_types WHERE name = 'zzSkitFixture'`);
    }
  });

  await t.test('exactly the picked real types (Woodland/Beast/Highland Swarm) are flagged Skittish through the same TYPE-catalog loader (not the live tick path)', async () => {
    const { creatureTypes } = await loadCreatureTypes(pool);
    const byName = new Map(creatureTypes.map((c) => [c.name, c]));

    for (const name of SKITTISH_TYPES) {
      const row = byName.get(name);
      assert.ok(row, `${name} is missing from the live creature catalog`);
      assert.equal(row.behavior.chaseStyle, 'skittish',
        `${name} did not resolve the Skittish profile through loadCreatureTypes -- `
        + 'its entity_types.behavior_id must point at Skittish, not Swarm');
    }

    for (const name of NOT_SKITTISH_TYPES) {
      const row = byName.get(name);
      if (!row) continue; // not this task's concern if it is ever removed
      assert.notEqual(row.behavior.chaseStyle, 'skittish',
        `${name} unexpectedly resolved the Skittish profile -- only the three picked Swarm `
        + 'types should, and this is exactly the "WHERE matched too broadly" failure mode '
        + 'that sent the first version of this migration back for a rewrite');
    }
  });
});
