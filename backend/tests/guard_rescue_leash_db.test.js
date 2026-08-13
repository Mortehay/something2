// SOMET-291 — the raised leash is LIVE, not merely authored.
//
// The SOMET-249 trap: behaviour data reaches the sim through two separately
// maintained SQL strings, and only one of them ticks anything.
//   1. creatures.js's loadCreatureTypes builds the TYPE catalog; its own header
//      says plainly that "this resolved `behavior` is not read by any live
//      production path".
//   2. server.js's CREATURE_JOINED_SELECT is THE query the running tick reads,
//      via activateChunk and injectGuardIntoSim, both of which feed rows
//      straight into CreatureSim.addCreatures.
//
// So this file goes through (2), and then further: a value can be present on
// the in-memory creature and still not be the value the tick's leash gate uses.
// The second test drives a real tick() with a hostile placed in the band the
// migration opened up -- beyond the old 300px leash, inside the new 600 -- and
// asserts the guard engages it. That is the assertion the whole ticket rests on.
//
// Fixture rows live in a zzGuardLeash* world and are deleted BY NAME,
// unconditionally, in a finally -- never by an id captured mid-test.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const {
  CreatureSim, GUARD_LEASH_RADIUS, GUARD_AGGRO_RADIUS,
} = require('../src/authority/creatures.js');
const { CREATURE_JOINED_SELECT } = require('../src/authority/server.js');
const { guardRescueLeashRadius } = require('../src/services/villages.js');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const WORLD = 'zzGuardLeashWorld';
const GUARD_TYPE = 'Village Guard';

// The post, and a hostile in the band the migration opened FOR ACQUISITION.
//
// That band is (old leash, aggro radius], not (old leash, new leash]: a guard
// still only notices what is inside GUARD_AGGRO_RADIUS of where it stands, and
// the raise deliberately did not change that. The extra leash beyond 400 buys
// PURSUIT, which the golden trace covers; what is provable in a single tick is
// that a hostile the guard could always SEE but was forbidden to engage is now
// engaged. Placed midway through the band so neither endpoint is being tested.
const POST = { x: 3000, y: 3000 };
const BAND_X = POST.x + (GUARD_LEASH_RADIUS + GUARD_AGGRO_RADIUS) / 2;

// Builds a real world_creatures guard row, reads it back through the EXACT live
// query, and resolves it through the EXACT live class -- the path activateChunk
// actually runs, not a hand-assembled object shaped like one.
async function liveGuard(pool, sim) {
  const world = await pool.query(
    `INSERT INTO worlds (name, seed) VALUES ('${WORLD}', 1) RETURNING id`,
  );
  const worldId = world.rows[0].id;
  try {
    const row = await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y)
       VALUES ($1, $2, $3, $4, 100000, 'S', $5, $6) RETURNING id`,
      [worldId, GUARD_TYPE, POST.x - 24, POST.y - 24, POST.x, POST.y],
    );
    const rows = await pool.query(`${CREATURE_JOINED_SELECT} WHERE wc.id = $1`, [row.rows[0].id]);
    assert.equal(rows.rowCount, 1, 'CREATURE_JOINED_SELECT did not find the fixture guard row');
    sim.addCreatures(rows.rows);
    return sim.all().find((c) => c.type === GUARD_TYPE);
  } finally {
    // By name, unconditionally. world_creatures.world_id is ON DELETE CASCADE
    // (migration 1714440013000), so this alone removes the fixture creature.
    await pool.query(`DELETE FROM worlds WHERE name = '${WORLD}'`);
  }
}

const MAP = { chunkSize: 64, isWalkable: () => true, speedAt: () => 1 };
const KEYS = new Set(['0,0']);

test('the raised guard leash', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('a real Village Guard row carries the raised leash through the LIVE loader', async () => {
    const g = await liveGuard(pool, new CreatureSim(MAP, () => 0.5));
    assert.equal(g.behavior.chaseStyle, 'guard',
      'a real Village Guard row did not resolve into the guard branch at all');
    assert.equal(g.behavior.leashRadius, guardRescueLeashRadius(),
      'the live guard row did not arrive at the sim carrying the derived rescue leash. Three '
      + 'causes, in order of likelihood: (a) scripts/seed-catalogs.js was run from a checkout '
      + 'whose seeds/data/creatureBehaviors.js still carries the old value — it UPSERTs '
      + 'leash_radius and will silently overwrite the migration, which is what makes seeding from '
      + 'a stale tree dangerous on a shared database; (b) migration 1714440210000 has not been '
      + 'applied here; (c) entity_types.behavior_id no longer points Village Guard at the Guard '
      + 'profile, in which case the fallback assertion below fires too');

    // The way this test would go vacuous: GUARD_DEFAULT_BEHAVIOR (the
    // unprofiled fallback) still carries 300, so a guard that failed to join a
    // profile at all would resolve to a complete, plausible behaviour object
    // and only this comparison would notice.
    assert.ok(g.behavior.leashRadius > GUARD_LEASH_RADIUS,
      'the live guard fell back to the unprofiled GUARD_LEASH_RADIUS — the join found no profile');
    assert.ok(g.behavior.leashRadius >= g.behavior.aggroRadius,
      'the live leash is still shorter than the live aggro radius, which is the defect itself');
    assert.equal(g.behavior.aggroRadius, GUARD_AGGRO_RADIUS, 'the aggro radius drifted too');
  });

  await t.test('and the TICK uses it: a hostile beyond the old leash is engaged', async () => {
    // The field being copied onto the creature is not the claim. The claim is
    // that selectGuardTarget's leash filter and the chase clamp read it, and
    // the only way to see that is a real tick.
    const sim = new CreatureSim(MAP, () => 0.5);
    const g = await liveGuard(pool, sim);
    sim.addCreatures([{ id: 'zzHostile', type: 'Slime', x: BAND_X - 24, y: POST.y - 24, hp: 100000, damage: 0 }]);

    // Fixture checks, so a failure below cannot be a mis-placed hostile.
    assert.ok(BAND_X - POST.x > GUARD_LEASH_RADIUS,
      'fixture: the hostile must be beyond the OLD leash or this proves nothing');
    assert.ok(BAND_X - POST.x <= GUARD_AGGRO_RADIUS,
      'fixture: the hostile must be inside the guard\'s aggro radius, which the raise did not change');

    sim.tick(0.05, KEYS, [], 0);
    assert.equal(g._target, 'zzHostile',
      `a guard loaded from the live database refused a hostile ${BAND_X - POST.x}px from its post — `
      + `inside its 600px leash but outside the old ${GUARD_LEASH_RADIUS}px one, i.e. the migration `
      + 'is inert on the path the running authority actually uses');
    assert.equal(g._targetKind, 'creature');
  });
});
