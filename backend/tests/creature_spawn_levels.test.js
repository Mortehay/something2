const test = require('node:test');
const assert = require('node:assert');
const { placeMapCreatures } = require('../src/services/mapService.js');

const TYPES = [
  { name: 'Wolf', hp: 12, defense: 0, resistances: {} },
  { name: 'Bat', hp: 8, defense: 0, resistances: { lightning: 0.5 } },
];

const BOUNDED = {
  seed: 999, chunkSize: 16, width: 40, height: 40,
  tileTypes: { grass: { walkable: true } },
};

test('bounded placement assigns levels inside the band and is deterministic', () => {
  const world = { ...BOUNDED, levelMin: 3, levelMax: 5 };
  const a = placeMapCreatures(world, 8, TYPES, 4242);
  const b = placeMapCreatures(world, 8, TYPES, 4242);
  assert.ok(a.length > 0, 'fixture placed no creatures — this test would assert nothing');
  assert.deepEqual(a.map((c) => [c.type, c.x, c.y, c.level]),
                   b.map((c) => [c.type, c.x, c.y, c.level]));
  for (const c of a) {
    assert.ok(c.level >= 3 && c.level <= 5, `level ${c.level} escaped the band [3,5]`);
    assert.ok(Number.isFinite(c.damage) && c.damage > 0, 'damage must be carried');
  }
});

test('bounded placement scales hp/damage/defense exactly for a fixed level', () => {
  // A hardcoded level (e.g. always 3, the band floor) or an unscaled carry of
  // the entity type's base stats would satisfy the range/finite checks above
  // without doing any real scaling. Pin the band to a single value so every
  // placed creature's stats are pinned to one exact, hand-computed answer.
  const world = { ...BOUNDED, levelMin: 4, levelMax: 4 };
  const out = placeMapCreatures(world, 10, TYPES, 4242);
  assert.ok(out.length > 0, 'fixture placed no creatures — this test would assert nothing');
  for (const c of out) {
    assert.equal(c.level, 4);
    // Level 4 = 3 steps. Wolf: round(12 * (1 + 0.15*3)) = round(17.4) = 17.
    //                    Bat: round(8 * 1.45) = round(11.6) = 12.
    assert.equal(c.hp, c.type === 'Wolf' ? 17 : 12);
    // Damage from the CREATURE_BASE_DAMAGE baseline of 5: round2(5 * 1.3) = 6.5.
    assert.equal(c.damage, 6.5);
    // Both fixture types have base defense 0: round2(0 + 0.5*3) = 1.5.
    assert.equal(c.defense, 1.5);
  }
});

test('bounded placement level roll is independent of the type roll', () => {
  // placeMapCreatures rejection-samples per call, not per tile, so a single
  // call can't fan out across many draws the way a per-tile roll would --
  // sample many rngSeeds instead. Reusing the type-pick rng() draw for the
  // level roll wouldn't collapse every creature of a type to one level, it
  // would split the band between types (e.g. Wolf 1-10, Bat 11-20 for 2
  // types over a [1,20] band), so check that each type ranges across the
  // whole band.
  const world = { ...BOUNDED, levelMin: 1, levelMax: 20 };
  const midpoint = (world.levelMin + world.levelMax) / 2; // 10.5
  const byType = new Map();
  for (let seed = 1; seed <= 60; seed++) {
    const out = placeMapCreatures(world, 6, TYPES, seed);
    for (const c of out) {
      if (!byType.has(c.type)) byType.set(c.type, []);
      byType.get(c.type).push(c.level);
    }
  }
  assert.ok(byType.size === TYPES.length, 'not every type was placed across the sample -- widen the sample');
  for (const [type, levels] of byType) {
    assert.ok(Math.max(...levels) > midpoint,
      `${type} never rolled above the band midpoint — level may be reusing the type-pick draw`);
    assert.ok(Math.min(...levels) < midpoint,
      `${type} never rolled below the band midpoint — level may be reusing the type-pick draw`);
  }
});
