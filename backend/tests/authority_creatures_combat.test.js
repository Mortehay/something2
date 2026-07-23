const test = require('node:test');
const assert = require('node:assert');
const {
  CreatureSim, AGGRO_RADIUS, LEASH_RADIUS, CONTACT_RANGE,
  CREATURE_DAMAGE, CREATURE_ATTACK_COOLDOWN, loadCreatureTypes,
} = require('../src/authority/creatures.js');
const { spawnChunkCreatures } = require('../src/services/mapService.js');
const {
  applyElementEffect, SHOCK_INTERRUPT_MS, SHOCK_IMMUNITY_MS,
} = require('../src/authority/effects.js');

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
const rng = () => 0.5; // no redirect, deterministic roam dir
function player(userId, x, y) { return { userId, x, y, width: 64, height: 64, hp: 100, maxHp: 100 }; }
function creatureAt(id, x, y, hp = 10) { return { id, type: 'Wolf', x, y, hp, facing: 'S', color: '#c00' }; }

test('a creature acquires and chases the nearest in-aggro player', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  const p = player('u1', 100 + AGGRO_RADIUS - 50, 100); // east, within aggro
  s.tick(0.2, new Set(['0,0']), [p]);
  const c = s.all()[0];
  assert.equal(c.mode, 'chase');
  assert.equal(c._target, 'u1');
  assert.ok(c.x > 100, 'moved east toward the player');
});

test('a creature drops its target beyond the leash radius (back to roam)', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  const p = player('u1', 200, 100);
  s.tick(0.1, new Set(['0,0']), [p]); // acquire
  assert.equal(s.all()[0].mode, 'chase');
  p.x = 100 + LEASH_RADIUS + 100; // run far away
  s.tick(0.1, new Set(['0,0']), [p]);
  assert.equal(s.all()[0].mode, 'roam');
  assert.equal(s.all()[0]._target, null);
});

test('a chasing creature deals contact damage on cooldown', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  // Player centered within CONTACT_RANGE of the creature center.
  const p = player('u1', 110, 100);
  s.tick(0.05, new Set(['0,0']), [p]); // acquire + first hit
  assert.equal(p.hp, 100 - CREATURE_DAMAGE, 'took one hit');
  s.tick(0.05, new Set(['0,0']), [p]); // still on cooldown → no hit
  assert.equal(p.hp, 100 - CREATURE_DAMAGE);
  // Advance past the cooldown.
  s.tick(CREATURE_ATTACK_COOLDOWN, new Set(['0,0']), [p]);
  assert.equal(p.hp, 100 - 2 * CREATURE_DAMAGE, 'hit again after cooldown');
});

test('no player in aggro → creature roams (unchanged), no damage', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  const far = player('u1', 100 + AGGRO_RADIUS + 500, 100);
  const before = { ...s.all()[0] };
  s.tick(0.1, new Set(['0,0']), [far]);
  assert.equal(s.all()[0].mode, 'roam');
  assert.equal(far.hp, 100);
  // still moved (roam), i.e. it ticked
  assert.ok(s.all()[0].x !== before.x || s.all()[0].y !== before.y);
});

test('applyAttack damages in-range creatures and removes the dead, returning their ids', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('near', 100, 100, 8), creatureAt('far', 100000, 100000, 8)]);
  const killed = s.applyAttack(120, 120, 90, 10); // near center ~ (124,124), within 90
  assert.deepEqual(killed, ['near']);
  assert.ok(!s.has('near'));
  assert.ok(s.has('far'));
});

test('applyAttack only wounds (not kills) a creature with more hp', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100, 30)]);
  const killed = s.applyAttack(124, 124, 90, 10);
  assert.deepEqual(killed, []);
  assert.equal(s.all()[0].hp, 20);
});

test('snapshotForNeighborhood includes maxHp and mode', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100, 10)]);
  const snap = s.snapshotForNeighborhood(new Set(['0,0']));
  assert.equal(snap[0].maxHp, 10);
  assert.equal(snap[0].mode, 'roam');
});

// All-grass stub map so resolveMove/isWalkable never block (not used by these
// two methods, but CreatureSim's constructor needs a map with chunkSize).
function armSim() {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1 };
  const sim = new CreatureSim(map, () => 0.5);
  sim.addCreatures([
    { id: 'a', type: 'wolf', x: 100, y: 100, hp: 10, facing: 'S', color: '#f00' },
    { id: 'b', type: 'wolf', x: 300, y: 100, hp: 10, facing: 'S', color: '#f00' },
  ]);
  return sim;
}

test('applyMeleeArc damages creatures in the cone, returns the dead ids', () => {
  const sim = armSim();
  // Origin just west of 'a' (center 124,124), aim east, wide reach+arc, lethal.
  const killed = sim.applyMeleeArc(60, 124, 1, 0, 120, 1.8, 20);
  assert.deepEqual(killed, ['a']);      // 'a' in reach, dead
  assert.ok(!sim.has('a'));
  assert.ok(sim.has('b'));              // 'b' at 324,124 is out of reach 120
});

test('applyMeleeArc excludes a creature outside the angular cone', () => {
  const sim = armSim();
  // Origin south of 'a' (124,300), aim NORTH with a narrow cone: 'a' at (124,124)
  // is dead ahead within reach → hit; 'b' at (324,124) is ~37° off the aim axis,
  // beyond the 0.6 rad (±0.3 rad) cone → excluded.
  const killed = sim.applyMeleeArc(124, 300, 0, -1, 400, 0.6, 20);
  assert.deepEqual(killed, ['a']);
  assert.ok(!sim.has('a'));
  assert.ok(sim.has('b'), "'b' is outside the cone and survives");
});

test('damageCreatureById reduces hp and reports death', () => {
  const sim = armSim();
  assert.equal(sim.damageCreatureById('a', 4), false); // 10→6, alive
  assert.equal(sim.creatures.get('a').hp, 6);
  assert.equal(sim.creatures.get('a').dirty, true);
  assert.equal(sim.damageCreatureById('a', 6), true);  // 6→0, dead
  assert.ok(!sim.has('a'));
  assert.equal(sim.damageCreatureById('missing', 5), false); // no-op
});

// ---------------------------------------------------------------------------
// Creature-side mitigation. Creatures used to take damage via a raw
// `c.hp -= damage` at three sites while DEALING damage through applyDamage,
// which made weapon elements inert in PvE. Each of the three tests below
// pins ONE of those sites; reverting any single site to `c.hp -= damage`
// must turn exactly one of them RED.
// ---------------------------------------------------------------------------

// Two creatures at the same spot-ish with lots of hp so nothing dies mid-test:
// one fire-resistant, one with no resistances at all. The control is
// load-bearing — a resistant creature taking "less than 20" proves nothing on
// its own, because a bug that halves ALL damage would satisfy it too.
function mitSim() {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1 };
  const sim = new CreatureSim(map, () => 0.5);
  sim.addCreatures([
    { id: 'resistant', type: 'Slime', x: 100, y: 100, hp: 200, facing: 'S', color: '#f00', defense: 0, resistances: { fire: 0.5 } },
    { id: 'plain', type: 'Wolf', x: 100, y: 100, hp: 200, facing: 'S', color: '#f00', defense: 0, resistances: {} },
  ]);
  return sim;
}

test('damageCreatureById: a fire-resistant creature takes less from a fire hit than an equal-damage physical one', () => {
  const sim = mitSim();
  const resistant = sim.creatures.get('resistant');
  const plain = sim.creatures.get('plain');

  sim.damageCreatureById('resistant', 20, 'fire');
  sim.damageCreatureById('plain', 20, 'fire');

  const rDelta = 200 - resistant.hp;
  const pDelta = 200 - plain.hp;
  assert.equal(pDelta, 20, 'the non-resistant control must take the full 20 (element-blind baseline)');
  assert.equal(rDelta, 10, 'fire 0.5 must halve a fire hit');
  assert.ok(rDelta < pDelta,
    'creature resistances are not being applied — damage is bypassing applyDamage');

  // And the same creature must take FULL damage from a physical hit of the
  // same size: this is what proves the ELEMENT is what varied, not the target.
  sim.damageCreatureById('resistant', 20, 'physical');
  assert.equal(200 - resistant.hp, 10 + 20, 'fire resistance must not reduce physical damage');
});

test('applyMeleeArc threads its element through to applyDamage', () => {
  const sim = mitSim();
  const resistant = sim.creatures.get('resistant');
  const plain = sim.creatures.get('plain');
  // Origin west of both centers (124,124), aim east, wide reach + cone: both hit.
  sim.applyMeleeArc(60, 124, 1, 0, 200, 3.0, 20, 'fire');
  assert.equal(200 - plain.hp, 20, 'control took the full swing');
  assert.equal(200 - resistant.hp, 10,
    'applyMeleeArc did not pass the element through to applyDamage');
});

test('applyAttack threads its element through to applyDamage', () => {
  const sim = mitSim();
  const resistant = sim.creatures.get('resistant');
  const plain = sim.creatures.get('plain');
  sim.applyAttack(124, 124, 90, 20, 'fire');
  assert.equal(200 - plain.hp, 20, 'control took the full hit');
  assert.equal(200 - resistant.hp, 10,
    'applyAttack did not pass the element through to applyDamage');
});

test('creature defense is applied alongside resistance', () => {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1 };
  const sim = new CreatureSim(map, () => 0.5);
  sim.addCreatures([{ id: 'sk', type: 'Skeleton', x: 100, y: 100, hp: 200, facing: 'S', color: '#fff', defense: 2, resistances: { ice: 0.5 } }]);
  sim.damageCreatureById('sk', 20, 'ice'); // (20 - 2) * 0.5 = 9
  assert.equal(200 - sim.creatures.get('sk').hp, 9);
});

test('creature mitigation is built at spawn from its entity type', () => {
  // Guards the wiring, not just the maths: a creature spawned without `mit`
  // silently falls back to NO_MITIGATION and every resistance is inert.
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1 };
  const sim = new CreatureSim(map, () => 0.5);
  sim.addCreatures([{ id: 's1', type: 'Slime', x: 0, y: 0, hp: 10, facing: 'S', color: '#0f0', defense: 1, resistances: { fire: 0.6 } }]);
  assert.deepEqual(sim.creatures.get('s1').mit, { defense: 1, resistances: { fire: 0.6 } });
});

test('a creature row with no defense/resistances still gets an inert mit (never undefined)', () => {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1 };
  const sim = new CreatureSim(map, () => 0.5);
  sim.addCreatures([{ id: 'w1', type: 'Wolf', x: 0, y: 0, hp: 10, facing: 'S', color: '#c00' }]);
  assert.deepEqual(sim.creatures.get('w1').mit, { defense: 0, resistances: {} });
});

test('spawnChunkCreatures carries defense and resistances from the entity type', () => {
  const world = { seed: 1, chunkSize: 8, tileTypes: { grass: { walkable: true, speed: 1 } } };
  const types = [{ name: 'Slime', hp: 12, color: '#0f0', defense: 1, resistances: { fire: 0.6 } }];
  const spawned = spawnChunkCreatures(world, 0, 0, types);
  assert.ok(spawned.length > 0, 'chunk (0,0) must spawn at least one creature for this to prove anything');
  for (const c of spawned) {
    assert.equal(c.defense, 1);
    assert.deepEqual(c.resistances, { fire: 0.6 });
  }
});

// The mock pools elsewhere ignore the SQL string, so every maths test above
// would still pass with `resistances` dropped from the SELECT — while against
// a real DB it would load as undefined and every creature resistance would be
// silently inert. Assert on the query text itself. (Same failure mode
// loadItemTypes needed this guard for.)
test('loadCreatureTypes actually SELECTs every column it maps', async () => {
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rows: [] }; } };
  await loadCreatureTypes(pool);
  for (const col of ['id', 'name', 'color', 'hp', 'defense', 'resistances']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(sql),
      `loadCreatureTypes SELECT must name ${col} — a mapped column missing from the SELECT loads as undefined, so creature resistances are silently inert`);
  }
});

test('loadCreatureTypes maps defense/resistances and defaults them', async () => {
  const pool = { query: async () => ({ rows: [
    { id: 1, name: 'Slime', color: '#0f0', hp: 12, defense: '1', resistances: { fire: 0.6 } },
    { id: 2, name: 'Wolf', color: '#c00', hp: 10, defense: null, resistances: null },
  ] }) };
  const { creatureTypes, creatureTypeIds } = await loadCreatureTypes(pool);
  assert.deepEqual(creatureTypes[0], { name: 'Slime', hp: 12, color: '#0f0', faction: 'hostile', defense: 1, resistances: { fire: 0.6 } });
  assert.deepEqual(creatureTypes[1], { name: 'Wolf', hp: 10, color: '#c00', faction: 'hostile', defense: 0, resistances: {} });
  assert.equal(creatureTypeIds.get('Slime'), 1);
  assert.equal(creatureTypeIds.get('Wolf'), 2);
});

test('creature contact damage is mitigated by player armor (defense)', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  // Player WITH armor: mit.defense = 3 should reduce CREATURE_DAMAGE by 3
  const armored = {
    userId: 'u1', x: 110, y: 100, width: 64, height: 64,
    hp: 100, maxHp: 100, mit: { defense: 3, resistances: {} }
  };
  s.tick(0.05, new Set(['0,0']), [armored]); // acquire + first hit
  // Raw damage is CREATURE_DAMAGE, defense is 3, so mitigated damage = CREATURE_DAMAGE - 3 = 5 - 3 = 2
  const mitigated = Math.max(1, CREATURE_DAMAGE - 3); // MIN_DAMAGE floor
  assert.equal(armored.hp, 100 - mitigated, `armored player took ${mitigated} (reduced by defense 3)`);
});

test('creature contact damage on player with no mit falls back to NO_MITIGATION (regression)', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  // Player WITHOUT mit field (legacy or test object)
  const unarmored = {
    userId: 'u2', x: 110, y: 100, width: 64, height: 64,
    hp: 100, maxHp: 100
    // no mit field
  };
  s.tick(0.05, new Set(['0,0']), [unarmored]); // acquire + first hit
  assert.equal(unarmored.hp, 100 - CREATURE_DAMAGE, 'unarmored player took full damage (no crash)');
});

// --- SHOCK'S INTERRUPT AGAINST CREATURES ------------------------------------
//
// canAct was read at exactly two sites, world.js's canAttack and attack — both
// PLAYER attack paths. Creature contact damage never consulted it, so
// applyElementEffect stamped _interruptedUntil and _shockImmuneUntil onto every
// creature hit by lightning and nothing anywhere read either field. The
// interrupt was live in PvP and inert in PvE.
//
// That is a balance defect, not just an untidy one: the storm staff is priced
// at the worst damage-per-mana in the game (0.636) specifically for carrying
// three riders, and against creatures — which is most of the game — it was
// delivering two. The design doc's own text says vulnerability AND interrupt
// are what land in PvE.
//
// These tests drive the real tick loop rather than calling canAct directly, so
// they fail if the guard is removed from the contact-damage site even while
// effects.js keeps working perfectly.
test('a SHOCKED creature misses its bite (the interrupt is not PvE-inert)', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  const c = s.creatures.get('a');
  const p = player('u1', 110, 100);

  // Land the interrupt the way a lightning weapon does — through the one
  // element->rider mapping, not by setting the field by hand, so this also
  // proves the rider actually reaches a creature.
  applyElementEffect(c, 'lightning', 1000);
  assert.ok(c._interruptedUntil > 1000, 'setup: the lightning hit must have stamped an interrupt');

  // Inside the interrupt window: in contact range, off cooldown, and still
  // must not land a hit.
  s.tick(0.05, new Set(['0,0']), [p], 1000 + SHOCK_INTERRUPT_MS / 2);
  assert.equal(p.hp, 100, 'a shocked creature bit anyway — canAct is not gating contact damage');

  // The refusal must not have burned the cooldown either: once the stagger
  // ends the creature bites immediately, exactly as if it had been waiting.
  s.tick(0.05, new Set(['0,0']), [p], 1000 + SHOCK_INTERRUPT_MS + 1);
  assert.equal(p.hp, 100 - CREATURE_DAMAGE,
    'the creature did not recover its bite after the interrupt lapsed');
});

test('a shocked creature cannot be PERMA-stunned: the immunity window is not refreshed', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  const c = s.creatures.get('a');
  const p = player('u1', 110, 100);

  // Sustained lightning, re-applied far faster than the storm staff's real
  // 1100ms cooldown — the worst case the immunity window exists to survive.
  // If applyShockInterrupt ever starts re-stamping on a hit that arrives
  // inside the window, this creature never acts again and this test goes red.
  for (let now = 1000; now <= 1000 + SHOCK_IMMUNITY_MS * 2; now += 100) {
    applyElementEffect(c, 'lightning', now);
    s.tick(0.05, new Set(['0,0']), [p], now);
  }
  assert.ok(p.hp < 100,
    'under sustained lightning the creature never got a single bite in — that is a chain-lock, '
    + 'which means the immunity window is being refreshed instead of running to completion');

  // And the gate is real in the other direction too: the creature is NOT
  // simply ignoring the interrupt. It landed once, so it cost the creature
  // strictly fewer bites than an un-shocked one over the same span.
  const s2 = new CreatureSim(stubMap(), rng);
  s2.addCreatures([creatureAt('b', 100, 100)]);
  const p2 = player('u2', 110, 100);
  for (let now = 1000; now <= 1000 + SHOCK_IMMUNITY_MS * 2; now += 100) {
    s2.tick(0.05, new Set(['0,0']), [p2], now);
  }
  assert.ok(p2.hp < p.hp,
    'the shocked creature dealt as much damage as an un-shocked one — the interrupt bought nothing');
});
