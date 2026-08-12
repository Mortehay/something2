// SOMET-279 / SOMET-285 — village guard stats.
//
// SOMET-279 (the bug these tests were written for): insertVillageGuards wrote
// every guard as level 1 / hp 300 / damage-column-default, in every world.
// Combined with the flat damage_override on the seeded Guard behaviour, a
// guard hit for 25 forever. applyDamage is `raw - defense` floored at
// MIN_DAMAGE, so against The Abyss: Hub's level-46..50 hostiles (a level-50
// Line has defense 27.5) every guard swing landed for literally 1. Two guards
// and a Void Line stood next to each other for ten minutes and the Line lost 5
// of its 251 hp.
//
// SOMET-285 (the rule now): the level is no longer derived from the world's
// band at all. Every guard is level 150 everywhere -- "guards are 150 lvl and
// they are very strong". The band-derived assertions below were NOT deleted;
// they were re-pointed at the fixed level and at the property that replaced
// them: a guard must overwhelm the strongest hostile in the game, in the
// WEAKEST world, not merely beat its own tier.
//
// These tests therefore assert the thing that was broken -- the guard's
// POST-MITIGATION damage against a real hostile, and now the hostile's
// post-mitigation damage against the guard -- not merely that some number was
// written to the row.

const test = require('node:test');
const assert = require('node:assert');

const {
  insertVillageGuards, guardStats, GUARD_TYPE, GUARD_LEVEL,
} = require('../src/services/villages.js');
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
// The top of the highest band any world in the game carries (The Abyss: Hub is
// 46..50), i.e. the strongest a hostile ever gets.
const TOP_HOSTILE_LEVEL = 50;

// A village whose gate posts villageGatePosts can compute. Geometry is
// irrelevant to scaling; it only has to be a legal box.
const VILLAGE = { minRow: 4, minCol: 4, width: 5, height: 4, gateEdge: 'S' };

// Records what insertVillageGuards actually writes. Column names are read out
// of the INSERT's own column list and zipped with the parameters rather than
// indexed positionally, so a column added/reordered in the wrong place fails
// here instead of quietly binding the wrong value.
//
// `levelMax` is still accepted and still answered by the worlds SELECT if one
// is ever made -- that is what lets the "no band lookup happens at all" test
// below be a real observation rather than an assumption.
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

// How many swings the attacker needs, run through the REAL applyDamage (floor
// and all) rather than a re-implementation of it here.
function swingsToKill(damage, target) {
  const probe = { hp: target.hp };
  let swings = 0;
  while (probe.hp > 0 && swings < 100000) {
    applyDamage(probe, damage, 'physical', { defense: target.defense, resistances: {} });
    swings += 1;
  }
  return swings;
}

test('every guard is level 150, whatever band its world carries (SOMET-285)', async () => {
  assert.equal(GUARD_LEVEL, 150, 'the product decision: guards are 150 lvl');
  // Every band in the live game, weakest to strongest. The level must not move.
  for (const levelMax of [1, 2, 14, 29, 50]) {
    const db = await placeOneWorldsGuards({ levelMax });
    assert.equal(db.rows.length, 2, 'a village gets two gate guards');
    for (const g of db.rows) {
      assert.equal(g.type, GUARD_TYPE);
      assert.equal(g.level, 150,
        `a guard in a level_max ${levelMax} world must still be level 150, got ${g.level}`);
    }
  }
});

test('the level-150 stat block, pinned absolutely', async () => {
  const db = await placeOneWorldsGuards({ levelMax: 1 });
  const g = db.rows[0];
  // base 300 hp / 25 damage / 10 defense, 149 steps of the shared curve.
  assert.equal(g.hp, 7005);
  assert.equal(g.damage, 397.5);
  assert.equal(g.defense, 84.5);
});

test('a level-1 world\'s guard overwhelms the STRONGEST hostile in the game', async () => {
  // The point of the fixed level: the weakest world's guard is measured
  // against the toughest hostile that exists anywhere, not against its own
  // tier. Pre-SOMET-285 this guard was level 1 (damage 25) and would have been
  // stuck on the MIN_DAMAGE floor against it forever.
  const db = await placeOneWorldsGuards({ levelMax: 1 });
  const g = db.rows[0];

  const apex = scaleCreature(APEX_BASE, TOP_HOSTILE_LEVEL);
  assert.deepEqual(apex, { hp: 1086, damage: 29.5, defense: 37.5 },
    'fixture check: the strongest hostile in the catalog, at the top band');

  const probe = { hp: 1e9 };
  const dealt = applyDamage(probe, g.damage, 'physical', { defense: apex.defense, resistances: {} });
  assert.ok(dealt > MIN_DAMAGE * 100,
    `a guard swing must land for far more than the ${MIN_DAMAGE}-damage floor, got ${dealt}`);
  assert.equal(swingsToKill(g.damage, apex), 4,
    'a guard must drop the toughest hostile in the game in a handful of swings');
});

test('the strongest hostile in the game cannot meaningfully hurt a guard', async () => {
  // The other half of "very strong", and the half a level alone does not buy:
  // applyDamage floors at MIN_DAMAGE, so this is the best any hostile can do.
  const db = await placeOneWorldsGuards({ levelMax: 50 });
  const g = db.rows[0];
  const apex = scaleCreature(APEX_BASE, TOP_HOSTILE_LEVEL);

  const probe = { hp: 1e9 };
  const dealt = applyDamage(probe, apex.damage, 'physical', { defense: g.defense, resistances: {} });
  assert.equal(dealt, MIN_DAMAGE,
    `the strongest hostile's ${apex.damage} damage must land on the floor against `
    + `a guard's ${g.defense} defense, got ${dealt}`);
  assert.equal(swingsToKill(apex.damage, { hp: g.hp, defense: g.defense }), 7005,
    'and it would take one landed hit per hp to fell a guard');
});

test('the flat 25 the old guard used would still be stuck on the damage floor', () => {
  // Not a test of villages.js -- a test that the comparisons above are real.
  // If this ever stops failing, the ticket's premise is gone.
  const line = scaleCreature(LINE_BASE, 50);
  const probe = { hp: 1e9 };
  const dealt = applyDamage(probe, GUARD_DAMAGE, 'physical', { defense: line.defense, resistances: {} });
  assert.equal(dealt, MIN_DAMAGE,
    'the unscaled guard damage must still be floored -- otherwise this suite is measuring nothing');
  assert.equal(swingsToKill(GUARD_DAMAGE, line), 251);
});

test('guards reuse scaleCreature rather than carrying a second curve', async () => {
  // Same curve every other creature is placed with, at the fixed level.
  const db = await placeOneWorldsGuards({ levelMax: 29 });
  const expected = scaleCreature({ hp: 300, damage: GUARD_DAMAGE, defense: 10 }, GUARD_LEVEL);
  assert.deepEqual(
    { hp: db.rows[0].hp, damage: db.rows[0].damage, defense: db.rows[0].defense },
    expected,
    'guard stats must be exactly scaleCreature\'s output at the guard level',
  );
});

test('the world band is not looked up at all any more', async () => {
  // The level no longer depends on the world, so the SELECT that used to read
  // worlds.level_max is gone -- one fewer round-trip inside the caller's
  // village-create transaction. Asserted rather than assumed, because the fake
  // db above will happily answer a worlds query if one is still made.
  const db = fakeDb({ levelMax: 29 });
  await insertVillageGuards(db, 'world-1', [VILLAGE, { ...VILLAGE, minRow: 20 }]);
  assert.equal(db.rows.length, 4, 'two villages, two guards each');
  assert.equal(db.seen.worldLookups, 0, 'nothing reads the world band any more');
  assert.equal(db.seen.typeLookups, 1, 'one catalog lookup per call, not per guard');
});

test('a missing world row is now irrelevant rather than a fallback to level 1', async () => {
  // insertVillageGuards runs inside the caller's village-create transaction; a
  // throw here would roll the whole village back. With no band lookup left,
  // there is nothing to fall back FROM -- the guard is level 150 regardless.
  const db = await placeOneWorldsGuards({ levelMax: 50, worldMissing: true });
  assert.equal(db.rows.length, 2);
  assert.equal(db.rows[0].level, GUARD_LEVEL);
  assert.equal(db.rows[0].damage, 397.5);
});

test('a mis-authored Village Guard entity type still produces a usable guard', async () => {
  const db = fakeDb({ levelMax: 50, guardHp: 0, guardDefense: null });
  await insertVillageGuards(db, 'world-1', [VILLAGE]);
  const g = db.rows[0];
  assert.ok(g.hp > 0, 'a guard must never spawn dead on arrival');
  assert.equal(g.hp, 7005, 'the fallback base hp is the 300 the catalog carries');
  assert.equal(g.defense, 84.5);
});

test('guardStats is the single place the guard stat block is derived', async () => {
  const db = fakeDb({ levelMax: 50 });
  const stats = await guardStats(db);
  assert.deepEqual(stats, {
    level: 150, hp: 7005, damage: 397.5, defense: 84.5,
  });
});
