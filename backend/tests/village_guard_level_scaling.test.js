// SOMET-279 — village guards are level-scaled from their world's band.
//
// The bug these tests exist to keep dead: insertVillageGuards wrote every
// guard as level 1 / hp 300 / damage-column-default, in every world. Combined
// with the flat damage_override on the seeded Guard behaviour, a guard hit for
// 25 forever. applyDamage is `raw - defense` floored at MIN_DAMAGE, so against
// The Abyss: Hub's level-46..50 hostiles (a level-50 Line has defense 27.5)
// every guard swing landed for literally 1. Two guards and a Void Line stood
// next to each other for ten minutes and the Line lost 5 of its 251 hp.
//
// These tests therefore assert the thing that was broken -- the guard's
// POST-MITIGATION damage against a real same-world hostile -- not merely that
// some number was written to the row.

const test = require('node:test');
const assert = require('node:assert');

const { insertVillageGuards, guardStatsForWorld, GUARD_TYPE } = require('../src/services/villages.js');
const { scaleCreature } = require('../src/services/creatureLevel.js');
const { applyDamage, MIN_DAMAGE } = require('../src/authority/damage.js');
const { GUARD_DAMAGE } = require('../src/authority/creatures.js');

// Base stats straight off the seeded catalog (entity_types), used as the
// HOSTILE side of every comparison below. They are fixtures of what the world
// actually contains, not a restatement of anything villages.js computes:
//  - Line   (Void Line, Wolf, Skeleton, Slime, ...): hp 30, defense 3
//  - Apex   (the highest-defense hostile rung in the catalog): hp 130, def 13
const LINE_BASE = { hp: 30, damage: 5, defense: 3 };
const APEX_BASE = { hp: 130, damage: 5, defense: 13 };

// A village whose gate posts villageGatePosts can compute. Geometry is
// irrelevant to scaling; it only has to be a legal box.
const VILLAGE = { minRow: 4, minCol: 4, width: 5, height: 4, gateEdge: 'S' };

// Records what insertVillageGuards actually writes. Column names are read out
// of the INSERT's own column list and zipped with the parameters rather than
// indexed positionally, so a column added/reordered in the wrong place fails
// here instead of quietly binding the wrong value.
function fakeDb({ levelMax, guardHp = 300, guardDefense = 10, worldMissing = false }) {
  const rows = [];
  const seen = { worldLookups: 0, typeLookups: 0 };
  return {
    rows,
    seen,
    query: async (sql, params) => {
      const s = String(sql);
      if (/FROM worlds/i.test(s)) {
        seen.worldLookups += 1;
        return { rows: worldMissing ? [] : [{ level_max: levelMax }] };
      }
      if (/FROM entity_types/i.test(s)) {
        seen.typeLookups += 1;
        return { rows: [{ hp: guardHp, defense: guardDefense }] };
      }
      const m = /INSERT INTO world_creatures\s*\(([^)]*)\)/i.exec(s);
      if (m) {
        const cols = m[1].split(',').map((c) => c.trim());
        assert.equal(cols.length, params.length,
          'every column in the guard INSERT must have a bound parameter');
        const row = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        rows.push(row);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function placeOneWorldsGuards(opts) {
  const db = fakeDb(opts);
  await insertVillageGuards(db, 'world-1', [VILLAGE]);
  return db;
}

// How many swings the guard needs, run through the REAL applyDamage (floor
// and all) rather than a re-implementation of it here.
function swingsToKill(guardDamage, hostileBase, level) {
  const h = scaleCreature(hostileBase, level);
  const target = { hp: h.hp };
  let swings = 0;
  while (target.hp > 0 && swings < 10000) {
    applyDamage(target, guardDamage, 'physical', { defense: h.defense, resistances: {} });
    swings += 1;
  }
  return swings;
}

test('a guard in a level-46..50 world out-damages that world\'s hostile defense', async () => {
  const db = await placeOneWorldsGuards({ levelMax: 50 });
  assert.equal(db.rows.length, 2, 'a village gets two gate guards');
  const g = db.rows[0];

  assert.equal(g.type, GUARD_TYPE);
  assert.equal(g.level, 50, 'the guard takes the TOP of its world\'s band');

  // The hostiles this guard actually faces, from the shared curve.
  const line = scaleCreature(LINE_BASE, 50);   // hp 251, defense 27.5
  const apex = scaleCreature(APEX_BASE, 50);   // hp 1086, defense 37.5
  assert.equal(line.defense, 27.5, 'fixture check: the measured Void Line defense');
  assert.equal(apex.defense, 37.5, 'fixture check: the highest hostile defense at level 50');

  // THE regression. Pre-fix the guard's swing was a flat 25 -- below both
  // defenses -- so applyDamage floored it at MIN_DAMAGE and the fight never
  // ended. Assert the guard is nowhere near that floor.
  const probe = { hp: 1e9 };
  const dealtToLine = applyDamage(probe, g.damage, 'physical', { defense: line.defense, resistances: {} });
  assert.ok(dealtToLine > MIN_DAMAGE * 10,
    `a guard swing must land for far more than the ${MIN_DAMAGE}-damage floor, got ${dealtToLine}`);

  // And in fight terms: a handful of swings, at 1.0s cooldown -- not 251.
  assert.ok(swingsToKill(g.damage, LINE_BASE, 50) <= 4,
    'a level-50 guard must drop a level-50 Line in a few swings');
  assert.ok(swingsToKill(g.damage, APEX_BASE, 50) <= 15,
    'a level-50 guard must beat even the toughest level-50 hostile rung inside a real fight');

  // Absolute pins, so a silent change to the shared curve is visible here and
  // not merely absorbed by the relational assertions above.
  assert.equal(g.damage, 147.5);
  assert.equal(g.hp, 2505);
  assert.equal(g.defense, 34.5);
});

test('the flat 25 the old guard used would still be stuck on the damage floor', () => {
  // Not a test of villages.js -- a test that the comparison above is real.
  // If this ever stops failing, the ticket's premise is gone.
  const line = scaleCreature(LINE_BASE, 50);
  const probe = { hp: 1e9 };
  const dealt = applyDamage(probe, GUARD_DAMAGE, 'physical', { defense: line.defense, resistances: {} });
  assert.equal(dealt, MIN_DAMAGE,
    'the unscaled guard damage must still be floored -- otherwise this suite is measuring nothing');
  assert.equal(swingsToKill(GUARD_DAMAGE, LINE_BASE, 50), 251);
});

test('a guard in a level-1 world is unchanged', async () => {
  const db = await placeOneWorldsGuards({ levelMax: 1 });
  assert.equal(db.rows.length, 2);
  for (const g of db.rows) {
    assert.equal(g.level, 1);
    assert.equal(g.hp, 300, 'a level-1 guard keeps the hp it has always had');
    assert.equal(g.damage, GUARD_DAMAGE, 'a level-1 guard keeps the damage it has always had');
    assert.equal(g.defense, 10, 'a level-1 guard keeps the entity type\'s own defense');
  }
});

test('an intermediate band scales every stat, not just hp', async () => {
  const db = await placeOneWorldsGuards({ levelMax: 14 });   // The Underdeep: Hub
  const g = db.rows[0];
  assert.equal(g.level, 14);
  assert.equal(g.hp, 885);
  assert.equal(g.damage, 57.5);
  assert.equal(g.defense, 16.5);
  // Still a decisive win over the local hostiles, at a fight-length that has
  // not drifted from the level-50 case.
  assert.ok(swingsToKill(g.damage, APEX_BASE, 14) <= 15);
});

test('guards reuse scaleCreature rather than carrying a second curve', async () => {
  // Same input, same output as the curve every other creature is placed with.
  for (const level of [1, 7, 14, 29, 50]) {
    const db = await placeOneWorldsGuards({ levelMax: level });
    const expected = scaleCreature({ hp: 300, damage: GUARD_DAMAGE, defense: 10 }, level);
    assert.deepEqual(
      { hp: db.rows[0].hp, damage: db.rows[0].damage, defense: db.rows[0].defense },
      expected,
      `guard stats at level ${level} must be exactly scaleCreature's output`,
    );
  }
});

test('the band is looked up once per call, not once per guard', async () => {
  const db = fakeDb({ levelMax: 29 });
  await insertVillageGuards(db, 'world-1', [VILLAGE, { ...VILLAGE, minRow: 20 }]);
  assert.equal(db.rows.length, 4, 'two villages, two guards each');
  assert.equal(db.seen.worldLookups, 1);
  assert.equal(db.seen.typeLookups, 1);
});

test('a missing world row falls back to level 1 instead of throwing', async () => {
  // insertVillageGuards runs inside the caller's village-create transaction;
  // a throw here would roll the whole village back.
  const db = await placeOneWorldsGuards({ levelMax: 50, worldMissing: true });
  assert.equal(db.rows.length, 2);
  assert.equal(db.rows[0].level, 1);
  assert.equal(db.rows[0].damage, GUARD_DAMAGE);
});

test('a mis-authored Village Guard entity type still produces a usable guard', async () => {
  const db = fakeDb({ levelMax: 50, guardHp: 0, guardDefense: null });
  await insertVillageGuards(db, 'world-1', [VILLAGE]);
  const g = db.rows[0];
  assert.ok(g.hp > 0, 'a guard must never spawn dead on arrival');
  assert.equal(g.hp, 2505, 'the fallback base hp is the 300 the catalog carries');
  assert.equal(g.defense, 34.5);
});

test('guardStatsForWorld is the single place the guard stat block is derived', async () => {
  const db = fakeDb({ levelMax: 50 });
  const stats = await guardStatsForWorld(db, 'world-1');
  assert.deepEqual(stats, { level: 50, hp: 2505, damage: 147.5, defense: 34.5 });
});
