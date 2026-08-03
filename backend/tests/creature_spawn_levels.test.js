const test = require('node:test');
const assert = require('node:assert');
const { spawnChunkCreatures, placeMapCreatures } = require('../src/services/mapService.js');

const TYPES = [
  { name: 'Wolf', hp: 12, defense: 0, resistances: {} },
  { name: 'Bat', hp: 8, defense: 0, resistances: { lightning: 0.5 } },
];

// tileTypes must be non-empty: worldConfig() throws on an empty map (see
// worldGen.test.js:62), so a bare `{}` here would fail before the level roll
// is ever exercised. Every other spawnChunkCreatures test in the suite uses
// the same minimal `{ grass: {} }` fixture.
const UNBOUNDED = { seed: 12345, chunkSize: 16, tileTypes: { grass: {} } };

test('unbounded spawn assigns every creature a level inside the band', () => {
  const world = { ...UNBOUNDED, levelMin: 4, levelMax: 7 };
  const out = spawnChunkCreatures(world, 0, 0, TYPES);
  assert.ok(out.length > 0, 'fixture produced no creatures — this test would assert nothing');
  for (const c of out) {
    assert.ok(Number.isInteger(c.level), `${c.type} level must be an integer`);
    assert.ok(c.level >= 4 && c.level <= 7, `level ${c.level} escaped the band [4,7]`);
  }
});

test('unbounded spawn is deterministic: the same chunk re-rolls identical levels', () => {
  // world_chunks is CACHED. A creature whose level changed on chunk reload
  // would harden or soften as a player walked away and came back.
  const world = { ...UNBOUNDED, levelMin: 2, levelMax: 9 };
  const a = spawnChunkCreatures(world, 3, 5, TYPES);
  const b = spawnChunkCreatures(world, 3, 5, TYPES);
  assert.deepEqual(a.map((c) => [c.type, c.x, c.y, c.level]),
                   b.map((c) => [c.type, c.x, c.y, c.level]));
});

test('the level roll is independent of the type roll', () => {
  // The type-pick hash varies per tile too, so reusing it for the level draw
  // would NOT collapse every creature of a type to one level -- it would
  // PARTITION the band by type instead (e.g. Wolf only ever rolls 1-10, Bat
  // only ever rolls 11-20). A single chunk can't tell "full range" apart from
  // "half range each, no overlap", so sample many chunks: a genuine partition
  // stays a partition no matter how many chunks you sample, while a correct,
  // independent roll lets every type range across the whole band.
  const world = { ...UNBOUNDED, levelMin: 1, levelMax: 20 };
  const midpoint = (world.levelMin + world.levelMax) / 2; // 10.5
  const byType = new Map();
  for (let cx = 0; cx < 8; cx++) {
    for (let cy = 0; cy < 8; cy++) {
      const out = spawnChunkCreatures(world, cx, cy, TYPES);
      for (const c of out) {
        if (!byType.has(c.type)) byType.set(c.type, []);
        byType.get(c.type).push(c.level);
      }
    }
  }
  assert.ok(byType.size === TYPES.length, 'not every type spawned across the sample -- widen the sample');
  for (const [type, levels] of byType) {
    assert.ok(Math.max(...levels) > midpoint,
      `${type} never rolled above the band midpoint — level may be partitioned by type`);
    assert.ok(Math.min(...levels) < midpoint,
      `${type} never rolled below the band midpoint — level may be partitioned by type`);
    // Genuine guard against reusing the SPAWN roll instead of a fresh draw:
    // that roll is always < CREATURE_SPAWN_CHANCE (0.01), which maps to level
    // 1 every time, so every type's levels would collapse to a single value.
    assert.ok(new Set(levels).size > 1,
      `${type}'s levels collapsed to one value — the level roll may be reusing the spawn roll`);
  }
});

test('unbounded spawn scales hp with level and leaves resistances alone', () => {
  const world = { ...UNBOUNDED, levelMin: 6, levelMax: 6 };
  const out = spawnChunkCreatures(world, 0, 0, TYPES);
  assert.ok(out.length > 0);
  for (const c of out) {
    assert.equal(c.level, 6);
    // Level 6 = 5 steps. Wolf: round(12 * (1 + 0.15*5)) = round(21) = 21.
    //                    Bat: round(8 * 1.75) = 14.
    assert.equal(c.hp, c.type === 'Wolf' ? 21 : 14);
    // Damage from the CREATURE_DAMAGE baseline of 5: round2(5 * 1.5) = 7.5
    assert.equal(c.damage, 7.5);
    // Both fixture types have base defense 0, so a scaled value here can only
    // come from LEVEL_DEFENSE_PER_LEVEL: round2(0 + 0.5*5) = 2.5. Catches a
    // regression back to carrying the entity type's unscaled base defense.
    assert.equal(c.defense, 2.5);
  }
  const bat = out.find((c) => c.type === 'Bat');
  assert.ok(bat, 'fixture produced no Bat — the resistances check below would be vacuous');
  assert.deepEqual(bat.resistances, { lightning: 0.5 }, 'resistances must pass through unscaled');
});

test('a world with no band spawns everything at level 1 with unscaled hp', () => {
  const out = spawnChunkCreatures({ ...UNBOUNDED }, 0, 0, TYPES);
  assert.ok(out.length > 0);
  for (const c of out) {
    assert.equal(c.level, 1);
    assert.equal(c.hp, c.type === 'Wolf' ? 12 : 8);
    assert.equal(c.damage, 5);
    assert.equal(c.defense, 0);
  }
});

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
  // call can't fan out across many draws the way spawnChunkCreatures does
  // within one chunk -- sample many rngSeeds instead. Same partition risk as
  // the unbounded path: reusing the type-pick rng() draw for the level roll
  // wouldn't collapse every creature of a type to one level, it would split
  // the band between types (e.g. Wolf 1-10, Bat 11-20 for 2 types over a
  // [1,20] band), so check that each type ranges across the whole band.
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
