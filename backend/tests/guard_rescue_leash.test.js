// SOMET-291 — the leash a gate guard needs, and why it is that number.
//
// `creature_behaviors.Guard.leash_radius` is live data. This file pins the
// GEOMETRY behind it: each of the three terms separately, so a failure names
// which fact about villages moved rather than just reporting that a total
// changed. A single assert.equal(600) would go red on any of them and tell
// nobody anything.
const test = require('node:test');
const assert = require('node:assert');
const {
  guardRescueLeashRadius, guardRescueLeashTerms, eachLegalVillage, VILLAGE_LIMITS,
} = require('../src/services/villages.js');
const { villageGatePoint, villageGatePosts, villageGateCell } = require('../src/services/mapService.js');
const { GUARD_AGGRO_RADIUS, GUARD_LEASH_RADIUS } = require('../src/authority/creatures.js');
const { MAP_TILE_SIZE } = require('../src/authority/coords.js');
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');

// --- the gate point must actually be the gate --------------------------------

// The derivation measures post -> gate. If villageGatePoint named a tile that
// is not the gate, every number below would be a measurement of nothing, and
// nothing else in the codebase would notice: villageGateCell (the stamper's
// yes/no form, which decides which ring tile is left passable) is the only
// other statement of that rule.
test('villageGatePoint names exactly the tile villageGateCell opens', () => {
  let checked = 0;
  eachLegalVillage((v) => {
    const p = villageGatePoint(v);
    const row = Math.floor(p.y / MAP_TILE_SIZE);
    const col = Math.floor(p.x / MAP_TILE_SIZE);
    assert.equal(villageGateCell(row, col, v), true,
      `${v.width}x${v.height} gate ${v.gateEdge}: villageGatePoint -> tile (${row},${col}), `
      + 'which villageGateCell does not consider the gate');

    // ...and it is the ONLY such tile in the box, so "agrees" is not satisfied
    // by a villageGateCell that returns true everywhere.
    let opens = 0;
    for (let r = v.minRow; r < v.minRow + v.height; r++) {
      for (let c = v.minCol; c < v.minCol + v.width; c++) {
        if (villageGateCell(r, c, v)) opens++;
      }
    }
    assert.equal(opens, 1, `${v.width}x${v.height} gate ${v.gateEdge}: ${opens} gate tiles`);
    checked++;
  });
  assert.ok(checked > 0, 'eachLegalVillage yielded nothing — this test asserted nothing');
});

// --- the three terms ---------------------------------------------------------

test('a guard post can be a full diagonal tile from its own gate', () => {
  const { worstGate } = guardRescueLeashTerms();
  // The posts are the interior tiles FLANKING the gate: one tile in from the
  // ring, one tile to the side of the gate's centre line. That is a diagonal.
  assert.ok(Math.abs(worstGate.d - Math.SQRT2 * MAP_TILE_SIZE) < 1e-9,
    `worst post->gate is ${worstGate.d}, expected one diagonal tile `
    + `(${Math.SQRT2 * MAP_TILE_SIZE})`);
  // Independently re-measured off the named village, so the term is not just
  // whatever the function happened to return.
  const v = worstGate.village;
  const gate = villageGatePoint(v);
  const far = Math.max(...villageGatePosts(v).map((p) => Math.hypot(p.x - gate.x, p.y - gate.y)));
  assert.equal(far, worstGate.d, 'the named village does not reproduce the reported distance');
});

test('the largest legal village puts an interior tile 4 tiles from a guard post', () => {
  const { worstInterior } = guardRescueLeashTerms();
  assert.equal(worstInterior.d, 4 * MAP_TILE_SIZE,
    `worst post->interior is ${worstInterior.d}px`);
  // The box that produces it, spelled out: a 7x3 with the gate on a SHORT edge
  // is the shape that hurts. Its interior is a single 5-tile row, both posts
  // clamp onto the same tile beside the gate, and the far end of that row is
  // four tiles away. This is the village the golden trace uses.
  const v = worstInterior.village;
  assert.equal(v.width + v.height, VILLAGE_LIMITS.maxSum,
    'the worst case must be a maximum-size village, or the search missed one');
  assert.ok(v.gateEdge === 'E' || v.gateEdge === 'W',
    `worst interior distance came from a ${v.gateEdge} gate on a ${v.width}x${v.height} box`);
});

test('a guard could not previously reach everything it could see', () => {
  // The premise of the whole ticket, stated as an assertion: the shipped leash
  // was SHORTER than the shipped aggro radius, so selectGuardTarget's leash
  // filter -- not the aggro radius -- was deciding what a guard would engage.
  assert.ok(GUARD_LEASH_RADIUS < GUARD_AGGRO_RADIUS,
    'the legacy guard leash is no longer shorter than the aggro radius; this ticket\'s '
    + 'premise has changed and the derivation should be revisited');
});

// --- the number itself -------------------------------------------------------

test('the derived leash covers all three terms and is a whole number of tiles', () => {
  const t = guardRescueLeashTerms();
  const r = guardRescueLeashRadius();

  assert.equal(r % MAP_TILE_SIZE, 0, `${r} is not a whole number of tiles`);
  assert.ok(r >= t.aggro, `leash ${r} is inside the guard's own aggro radius ${t.aggro}`);
  assert.ok(r >= t.worstInterior.d,
    `leash ${r} cannot cross the largest legal village (${t.worstInterior.d}px)`);
  assert.ok(r >= t.worstGate.d + t.aggro,
    `leash ${r} cannot hold an interception one aggro radius past the gate `
    + `(${t.worstGate.d} + ${t.aggro})`);

  // Tight, not merely sufficient: one tile less must FAIL a term. Without this
  // the assertions above would be satisfied by any large number, and "guards
  // hold the gate, they do not roam" would quietly stop meaning anything.
  assert.ok(r - MAP_TILE_SIZE < t.required,
    `leash ${r} is more than a tile of slack over the ${t.required}px actually required`);
});

test('the seeded Guard leash is the derived number', () => {
  // The bridge from the derivation to the data. The live-row half of this pin
  // lives in creature_behaviors_seed_db.test.js (the database) and
  // guard_rescue_leash_db.test.js (the live tick); this half is the seed file,
  // which is what `npm run seed:catalogs` writes back over the live row.
  const guard = CREATURE_BEHAVIORS.find((b) => b.name === 'Guard');
  assert.ok(guard, 'Guard is missing from the seed catalog');
  assert.equal(guard.leash_radius, guardRescueLeashRadius(),
    'the seeded Guard leash no longer matches the geometry it was derived from — either the '
    + 'village limits moved and the leash must be re-derived by a new migration, or someone '
    + 'hand-edited the row');
});
