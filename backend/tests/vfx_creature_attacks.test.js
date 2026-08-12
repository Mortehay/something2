const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');
const { CREATURE_VFX } = require('../migrations/1714440170000_vfx_entity_bindings.js');

// Slice D (SOMET-161): creature contact damage stamps the SAME descriptor
// shape a player swing does. That sameness is the point -- it is what makes
// "every actor is visible" one code path rather than two, so the client draws
// a wolf bite through exactly the code that draws a halberd.

const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };

function simWithBiter({ vfx = null } = {}) {
  const sim = new CreatureSim(map);
  sim.addCreatures([{
    id: 'w1', type: 'Wolf', x: 100, y: 100, hp: 50, facing: 'S', color: '#c00',
    damage: 5, faction: 'hostile', vfx,
  }]);
  return sim;
}

// A player standing in contact range of the creature above.
const victim = () => ({
  userId: 'u1', x: 110, y: 100, width: 64, height: 64, hp: 100, maxHp: 100,
  mit: null, speed: 200,
});

function biteOnce(sim, players) {
  // Several ticks: the creature has to close and its ability cooldown has to
  // come up. Collect across all of them rather than assuming which tick lands.
  const attacks = []; const impacts = [];
  for (let i = 0; i < 40; i++) {
    const r = sim.tick(0.1, ['0,0', '1,1'], players, 1000 + i * 100);
    attacks.push(...(r.attacks || []));
    impacts.push(...(r.impacts || []));
  }
  return { attacks, impacts };
}

test('tick() always returns attacks and impacts arrays, even when nothing bit', () => {
  // Every caller can then read them without a guard -- the same contract
  // world.attack's early returns already keep.
  const sim = new CreatureSim(map);
  const r = sim.tick(0.1, [], [], 1000);
  assert.ok(Array.isArray(r.attacks));
  assert.ok(Array.isArray(r.impacts));
});

test('a creature contact hit emits the same descriptor SHAPE as a player swing', () => {
  const sim = simWithBiter();
  const { attacks } = biteOnce(sim, [victim()]);
  assert.ok(attacks.length > 0, 'the wolf must actually have bitten');

  const a = attacks[0];
  // Field for field, the shape world.js's melee branch produces.
  for (const k of ['a', 'v', 'x', 'y', 'nx', 'ny', 'reach', 'arc', 'hit']) {
    assert.ok(k in a, `descriptor is missing "${k}" -- the client draws both through one path`);
  }
  assert.equal(a.a, 'c:w1', 'attacker id is prefixed c: for a creature, p: for a player');
  assert.equal(a.hit, true, 'a contact attack only stamps once it has landed');
  assert.ok(Number.isFinite(a.nx) && Number.isFinite(a.ny));
  // Unit vector, like the player descriptor's.
  assert.ok(Math.abs(Math.hypot(a.nx, a.ny) - 1) < 1e-6);
});

test('an UNBOUND creature still emits a visible effect, via the creature kind default', () => {
  // Contact damage used to be an invisible HP drain. A creature nobody has
  // authored a binding for must not go back to that.
  const sim = simWithBiter({ vfx: null });
  const { attacks, impacts } = biteOnce(sim, [victim()]);
  assert.equal(attacks[0].v, 'generic_slash');
  assert.equal(impacts[0].v, 'spark_hit');
});

test('a BOUND creature uses its own binding', () => {
  const sim = simWithBiter({ vfx: { attack: 'slash_heavy', impact: 'spark_fire' } });
  const { attacks, impacts } = biteOnce(sim, [victim()]);
  assert.equal(attacks[0].v, 'slash_heavy');
  assert.equal(impacts[0].v, 'spark_fire');
});

test('the impact names the player that was hit', () => {
  const sim = simWithBiter();
  const { impacts } = biteOnce(sim, [victim()]);
  assert.equal(impacts[0].t, 'p:u1');
  assert.equal(impacts[0].el, 'physical', 'creature contact damage is always physical');
});

test('every creature binding names an effect some migration seeds', () => {
  const { EFFECTS } = require('../migrations/1714440168000_vfx_slice_b_effects.js');
  const { IMPACTS } = require('../migrations/1714440169000_vfx_particles.js');
  const seeded = new Set([...EFFECTS.map(([n]) => n), ...IMPACTS.map(([n]) => n), 'sweep_arc']);
  for (const [creature, bindings] of Object.entries(CREATURE_VFX)) {
    for (const [moment, name] of Object.entries(bindings)) {
      assert.ok(seeded.has(name), `${creature}.${moment} -> "${name}" is not seeded`);
    }
  }
});

test('no creature binds a miss', () => {
  // A creature stamps its descriptor only once the hit has landed, so a
  // creature whiff is not an event that exists -- binding one would be dead
  // data that a later reader would assume was reachable.
  for (const [creature, b] of Object.entries(CREATURE_VFX)) {
    assert.ok(!b.miss, `${creature} binds a miss, which can never fire`);
  }
});
