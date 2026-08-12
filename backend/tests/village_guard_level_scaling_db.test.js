// SOMET-279 — the LIVE invariants, read straight off the database.
//
// The unit suite (village_guard_level_scaling.test.js) proves villages.js
// writes scaled stats. That is not enough on its own for two reasons:
//
//  1. Every guard row that already existed was written by the OLD code. Only
//     migration 1714440173000 lifts those, and nothing else would notice if
//     it had not run.
//  2. Per-instance guard damage is only reachable at all because that same
//     migration nulls creature_behaviors.Guard.damage_override -- the tick
//     computes `(bh.damageOverride ?? c.damage)`, so a non-null override
//     SHADOWS world_creatures.damage and puts every guard back on a flat 25.
//     seeds/data/creatureBehaviors.js still authors 25 and seed-catalogs.js
//     still writes it, so `npm run seed:catalogs` re-breaks this. This test is
//     what makes that regression visible instead of silent.
//
// SELECT-only. Nothing here writes, so it is safe against the dev database and
// needs no TEST_DATABASE_URL gate -- but it does skip (rather than fail) when
// no database is reachable at all.

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const { scaleCreature } = require('../src/services/creatureLevel.js');
const { MIN_DAMAGE } = require('../src/authority/damage.js');
const { GUARD_LEVEL } = require('../src/services/villages.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool(t, why) {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch (err) {
    await pool.end().catch(() => {});
    const msg = `NO DATABASE at ${DB_URL} -- ${why} is UNVERIFIED (${err.message})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return null;
  }
}

test('the Guard behaviour does not shadow per-instance guard damage', async (t) => {
  const pool = await openPool(t, 'the damage_override invariant');
  if (!pool) return;
  try {
    const r = await pool.query(
      'SELECT damage_override FROM creature_behaviors WHERE name = $1', ['Guard'],
    );
    if (r.rowCount === 0) return t.skip('no Guard behaviour row -- catalog not seeded');
    assert.equal(r.rows[0].damage_override, null,
      'creature_behaviors.Guard.damage_override must be NULL, or (bh.damageOverride ?? c.damage) '
      + 'ignores every scaled guard row and guards go back to a flat 25 damage');
  } finally {
    await pool.end();
  }
});

test('every live village guard is level 150 and out-damages the toughest hostile in the game', async (t) => {
  const pool = await openPool(t, 'the live guard rows');
  if (!pool) return;
  try {
    const guards = await pool.query(
      `SELECT w.name AS world, w.level_min, w.level_max,
              wc.level, wc.hp, wc.damage, wc.defense
         FROM world_creatures wc
         JOIN worlds w ON w.id = wc.world_id
        WHERE wc.type = 'Village Guard'
        ORDER BY w.name`,
    );
    if (guards.rowCount === 0) return t.skip('no village guards in this database');

    // The toughest hostile rung actually present in the catalog, so the
    // comparison is against real content rather than an assumed number.
    const worst = await pool.query(
      `SELECT MAX(defense) AS defense, MAX(hp) AS hp
         FROM entity_types
        WHERE is_creature = true AND name <> 'Village Guard'`,
    );
    const hostileBase = {
      hp: Number(worst.rows[0].hp),
      damage: 5,
      defense: Number(worst.rows[0].defense),
    };

    // SOMET-285: the comparison is no longer against the guard's OWN band. The
    // level is fixed at 150 everywhere, so the hostile every guard is measured
    // against is the strongest one that exists anywhere in the game -- the
    // toughest rung, at the top of the highest band any world carries.
    const topBand = await pool.query('SELECT MAX(level_max) AS top FROM worlds');
    const topLevel = Number(topBand.rows[0].top) || 1;
    const hostile = scaleCreature(hostileBase, topLevel);

    for (const g of guards.rows) {
      const level = Number(g.level);
      assert.equal(level, GUARD_LEVEL,
        `${g.world}: guard level ${level} is not the fixed guard level ${GUARD_LEVEL} `
        + '(migration 1714440176000 lifts every row)');

      const net = Number(g.damage) - hostile.defense;
      assert.ok(net > MIN_DAMAGE,
        `${g.world}: a guard hitting for ${g.damage} against defense ${hostile.defense} lands `
        + `${Math.max(MIN_DAMAGE, net)} -- that is the ten-minute standoff SOMET-279 fixed`);
      // A bounded fight, not a war of attrition.
      assert.ok(hostile.hp / net <= 20,
        `${g.world}: ${Math.ceil(hostile.hp / net)} swings to kill the toughest hostile in the game`);

      // The other direction, which is what "very strong" means: the toughest
      // hostile's own swing must land on the MIN_DAMAGE floor against this
      // guard's defence.
      assert.ok(hostile.damage - Number(g.defense) <= MIN_DAMAGE,
        `${g.world}: the toughest hostile hits for ${hostile.damage} against a guard's `
        + `${g.defense} defense -- a guard must take the floor, not a real hit`);

      assert.ok(Number(g.hp) > 0, `${g.world}: guard hp must be positive`);
      assert.ok(g.defense != null, `${g.world}: guard defense must be written per-instance`);
    }
  } finally {
    await pool.end();
  }
});
