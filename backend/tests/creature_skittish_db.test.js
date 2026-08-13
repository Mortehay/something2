// The SOMET-249 trap: a behaviour authored in the catalog but read through
// only one of two loaders is silently inert in the live tick. The assertion
// that matters is not "the catalog has a Skittish row" (Task 1 covers that) --
// it is that a real world_creatures row of a skittish TYPE arrives at the sim
// carrying chaseStyle 'skittish'.
//
// Load it the way the authority does: through creatures.js's own loader with
// its LEFT JOIN creature_behaviors, against a fixture creature of a skittish
// type. Fixture rows are named zzSkit* and deleted BY NAME, unconditionally,
// in a finally -- never by an id captured mid-test.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { loadCreatureTypes } = require('../src/authority/creatures.js');

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

test('skittish creature types', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('a fixture creature of a skittish type resolves chaseStyle skittish through loadCreatureTypes\' own join', async () => {
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
        + '\'skittish\' through loadCreatureTypes\' own LEFT JOIN creature_behaviors -- '
        + 'the SOMET-249 inertness trap');
    } finally {
      // By name, unconditionally.
      await pool.query(`DELETE FROM entity_types WHERE name = 'zzSkitFixture'`);
    }
  });

  await t.test('exactly the picked real types (Woodland/Beast/Highland Swarm) are flagged Skittish through the same loader', async () => {
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
