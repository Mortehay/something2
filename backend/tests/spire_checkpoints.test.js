const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const spec = require(path.join(__dirname, '../seeds/maps/spire-of-trials.map.json'));
const floorOf = (w) => Number(w.key.slice('spire_f'.length));

// Floors 1-30: a checkpoint every 5; above 30: every 10.
const expected = [5, 10, 15, 20, 25, 30, 40, 50, 60, 61]; // 61 is the special endgame floor

test('the Spire has 61 floors chained east, one after the other', () => {
  assert.strictEqual(spec.worlds.length, 61);
  assert.deepStrictEqual(spec.worlds.map(floorOf), Array.from({ length: 61 }, (_, i) => i + 1));
  for (let f = 1; f < 61; f++) {
    const link = spec.links.find((l) => l.edge === 'E' && l.from === `spire_f${String(f).padStart(2, '0')}`);
    assert.ok(link, `floor ${f} must lead east`);
    assert.strictEqual(link.to, `spire_f${String(f + 1).padStart(2, '0')}`);
  }
});

test('checkpoint waypoints sit on floors 5..30 every 5, then every 10', () => {
  const have = spec.worlds.filter((w) => Array.isArray(w.waypoints) && w.waypoints.length).map(floorOf);
  assert.deepStrictEqual(have, expected);
});

test('each checkpoint is one named waypoint for its own floor, and floors share no checkpoint name', () => {
  const names = new Set();
  for (const w of spec.worlds.filter((x) => x.waypoints)) {
    assert.strictEqual(w.waypoints.length, 1, 'one waypoint per world');
    assert.strictEqual(w.waypoints[0].name, `Spire Checkpoint: Floor ${floorOf(w)}`);
    assert.ok(!names.has(w.waypoints[0].name));
    names.add(w.waypoints[0].name);
  }
});

test('the monster level band keeps rising with the floor', () => {
  let prev = -1;
  for (const w of spec.worlds) {
    assert.ok(w.level_band[0] > prev, `floor ${floorOf(w)} must not drop below the floor before it`);
    prev = w.level_band[0];
  }
  assert.ok(spec.worlds[60].level_band[1] <= 150, 'stays under the level cap');
});

test('Floor 60 is held by a WORLD boss, and Floor 61 (the endgame floor) has no boss of its own', () => {
  const f60 = spec.worlds.find((w) => w.key === 'spire_f60');
  assert.strictEqual(f60.boss.entity, 'Gorgon, the Thunder Titan');
  const f61 = spec.worlds.find((w) => w.key === 'spire_f61');
  assert.ok(f61 && !f61.boss, 'floor 61 has no gate of its own');
  assert.ok(f61.level_band[0] > spec.worlds.find((w) => w.key === 'spire_f60').level_band[1], 'tougher than floor 60');
});

// Decision (kept as-is): checkpoints are lit by walking onto them, and teleporting
// (T) only reaches lit ones. That is safe by construction as long as every floor
// below a checkpoint that has a gate boss really has it: you cannot have stood on
// the checkpoint without passing each of those gates. This pins the "as long as".
test('no checkpoint can be reached without passing every gate boss below it', () => {
  const bossFloors = new Set(spec.worlds.filter((w) => w.boss).map(floorOf));
  for (const w of spec.worlds.filter((x) => x.waypoints)) {
    const f = floorOf(w);
    for (let g = 5; g < f; g += 5) {
      assert.ok(bossFloors.has(g), `floor ${g} lies below checkpoint ${f} but has no gate boss`);
    }
  }
});

// Item 5: every gate-boss floor carries a vault chest whose guard sits at the
// floor's top level, so chest loot band, item level and XP all grow with the climb.
test('each gate-boss floor has a vault chest guarded at the floor\'s top level, rising up the tower', () => {
  const bossFloors = spec.worlds.filter((w) => w.boss);
  assert.strictEqual(bossFloors.length, 12);
  let prev = 0;
  for (const w of bossFloors) {
    assert.ok(w.chest, `floor ${floorOf(w)} has no chest`);
    assert.strictEqual(w.chest.level, w.level_band[1], `floor ${floorOf(w)} chest level`);
    assert.ok(w.chest.level > prev, 'rewards must grow with the floor');
    assert.ok(w.allowed_creature_types.includes(w.chest.guard_creature_type), 'the guard belongs to the floor\'s own family');
    prev = w.chest.level;
  }
  assert.ok(!spec.worlds.some((w) => w.chest && !w.boss), 'no chest on a floor without a gate boss');
});
