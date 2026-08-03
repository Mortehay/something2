// Task 4: derived player stats wired into the live authority simulation.
//
// The whole point of this suite is that a multiplier applied at SOME of the
// read sites looks correct, keeps everything else green, and silently leaves
// half the game unscaled. Every damage/cooldown assertion below checks
// BEHAVIOUR (hp actually lost, cooldown actually stamped) rather than a
// field, and the melee-vs-players / projectile / projectile-cooldown sites
// each get their own dedicated assertion because those are exactly the
// sites a partial wiring would miss.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { World } = require('../src/authority/world.js');
const { derivePlayerStats, DEFAULT_PROGRESSION } = require('../src/services/playerStats.js');

const BASE_STATS = derivePlayerStats(DEFAULT_PROGRESSION);

function stat(overrides) {
  return derivePlayerStats({ ...DEFAULT_PROGRESSION, ...overrides });
}

// All-grass map, same shape as the sibling authority-combat suite's armWorld().
function stubMap() {
  return {
    chunkSize: 8,
    isWalkable: () => true,
    speedAt: () => 1,
    getChunk: () => [],
  };
}

// Weapon catalog for this suite. reach/arc mirror the sibling suite's
// "halberd" fixture (wide + long enough to land on a target directly on the
// aim vector) so melee assertions don't have to fight geometry.
const TYPES = new Map([
  [1, {
    id: 1, name: 'blade', category: 'weapon', kind: 'melee', damage: 10, cooldown: 0.5,
    reach: 190, arc_width: 1.8, mana_cost: 0, element: null,
  }],
  [2, {
    id: 2, name: 'fire-blade', category: 'weapon', kind: 'melee', damage: 10, cooldown: 0.5,
    reach: 190, arc_width: 1.8, mana_cost: 0, element: 'fire',
  }],
  [3, {
    id: 3, name: 'physical-blade', category: 'weapon', kind: 'melee', damage: 10, cooldown: 0.5,
    reach: 190, arc_width: 1.8, mana_cost: 0, element: 'physical',
  }],
  [4, {
    id: 4, name: 'bow', category: 'weapon', kind: 'projectile', damage: 10, cooldown: 0.6,
    range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, element: null,
  }],
  [5, {
    id: 5, name: 'fire-bow', category: 'weapon', kind: 'projectile', damage: 10, cooldown: 0.6,
    range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, element: 'fire',
  }],
]);

function invFor(typeId) {
  return { items: [{ id: `i${typeId}`, typeId }], equipment: { main_hand: `i${typeId}` } };
}

function armWorld() { return new World(stubMap(), TYPES, 1); }

test('a player joining with no progression behaves exactly as before A2', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 });
  const p = w.getPlayer('u1');
  assert.equal(p.hp, 100);
  assert.equal(p.maxHp, 100);
  assert.equal(p.mana, 100);
  assert.equal(p.maxMana, 100);
});

test('CON raises max hp and the player joins at full', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, stat({ constitution: 10 }));
  const p = w.getPlayer('u1');
  assert.equal(p.maxHp, 150);
  assert.equal(p.hp, 150);
});

test('STR scales melee damage against creatures AND against players', () => {
  const w = armWorld();
  // strength 25 -> above base 20 -> meleeMult 1 + 0.05*20 = 2.0
  w.addPlayer('u1', { x: 100, y: 100 }, invFor(1), undefined, 0, stat({ strength: 25 }));
  w.addPlayer('u2', { x: 150, y: 100 }); // east of u1, in arc
  w.creatures.addCreatures([{
    id: 'c1', type: 'wolf', x: 150, y: 108, hp: 50, facing: 'S', color: '#f00',
  }]);
  w.attack('u1', 1, 0);
  const c1 = w.creatures.all().find((c) => c.id === 'c1');
  assert.equal(c1.hp, 30, 'creature took 20 (10 base * 2.0 STR mult), not 10');
  const u2 = w.getPlayer('u2');
  assert.equal(u2.hp, u2.maxHp - 20, 'player-vs-player melee also took 20, not 10');
});

test('INT scales a magic weapon, STR does not', () => {
  // fire element, high STR / base INT -> spellMult 1.0 -> damage UNCHANGED at 10.
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, invFor(2), undefined, 0, stat({ strength: 25 }));
    w.creatures.addCreatures([{
      id: 'c1', type: 'wolf', x: 150, y: 108, hp: 50, facing: 'S', color: '#f00',
    }]);
    w.attack('u1', 1, 0);
    const c1 = w.creatures.all().find((c) => c.id === 'c1');
    assert.equal(c1.hp, 40, 'high STR must not scale a fire weapon');
  }
  // fire element, base STR / high INT -> spellMult 2.0 -> damage 20.
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, invFor(2), undefined, 0, stat({ intelligence: 25 }));
    w.creatures.addCreatures([{
      id: 'c1', type: 'wolf', x: 150, y: 108, hp: 50, facing: 'S', color: '#f00',
    }]);
    w.attack('u1', 1, 0);
    const c1 = w.creatures.all().find((c) => c.id === 'c1');
    assert.equal(c1.hp, 30, 'high INT must scale a fire weapon to 20 damage');
  }
  // Mirror image: element 'physical' is STR's lane, INT does not touch it.
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, invFor(3), undefined, 0, stat({ strength: 25 }));
    w.creatures.addCreatures([{
      id: 'c1', type: 'wolf', x: 150, y: 108, hp: 50, facing: 'S', color: '#f00',
    }]);
    w.attack('u1', 1, 0);
    const c1 = w.creatures.all().find((c) => c.id === 'c1');
    assert.equal(c1.hp, 30, 'high STR must scale a physical weapon to 20 damage');
  }
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, invFor(3), undefined, 0, stat({ intelligence: 25 }));
    w.creatures.addCreatures([{
      id: 'c1', type: 'wolf', x: 150, y: 108, hp: 50, facing: 'S', color: '#f00',
    }]);
    w.attack('u1', 1, 0);
    const c1 = w.creatures.all().find((c) => c.id === 'c1');
    assert.equal(c1.hp, 40, 'high INT must not scale a physical weapon');
  }
});

test('a projectile carries its owner-scaled damage', () => {
  const w = armWorld();
  // intelligence 25 -> spellMult 2.0 -> fire-bow's 10 damage snapshots as 20.
  w.addPlayer('u1', { x: 0, y: 0 }, invFor(5), undefined, 0, stat({ intelligence: 25 }));
  // Player center is (32,32); place the creature east of it, within the
  // projectile's capture radius after one substep.
  w.creatures.addCreatures([{
    id: 'c1', type: 'wolf', x: 64, y: 8, hp: 100, facing: 'S', color: '#f00',
  }]);
  w.attack('u1', 1, 0);
  for (let i = 0; i < 5 && w.snapshot().projectiles.length > 0; i++) w.tickProjectiles(0.05);
  const c1 = w.creatures.all().find((c) => c.id === 'c1');
  assert.equal(c1.hp, 80, 'creature must lose 20 (owner-scaled), not 10 (raw weapon.damage)');
});

test('a projectile keeps the damage it launched with when its owner is re-derived', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, invFor(5), undefined, 0, stat({ intelligence: 25 }));
  w.creatures.addCreatures([{
    id: 'c1', type: 'wolf', x: 64, y: 8, hp: 100, facing: 'S', color: '#f00',
  }]);
  w.attack('u1', 1, 0); // spawns with the boosted 20 damage snapshotted
  // Owner respecs back to base mid-flight; the in-flight shot must not change.
  w.applyDerivedStats('u1', BASE_STATS);
  for (let i = 0; i < 5 && w.snapshot().projectiles.length > 0; i++) w.tickProjectiles(0.05);
  const c1 = w.creatures.all().find((c) => c.id === 'c1');
  assert.equal(c1.hp, 80, 'in-flight projectile must still hit for the boosted 20, not 10');
});

test('DEX shortens the cooldown on BOTH the melee and the projectile path', () => {
  const w = armWorld();
  // dexterity 15 -> above base 10 -> cooldownMult = round4(1/(1+0.03*10)) = 0.7692
  const dexStats = stat({ dexterity: 15 });
  w.addPlayer('melee-u', { x: 100, y: 100 }, invFor(1), undefined, 0, dexStats); // blade, cooldown 0.5
  w.addPlayer('proj-u', { x: 300, y: 300 }, invFor(4), undefined, 0, dexStats); // bow, cooldown 0.6

  w.attack('melee-u', 1, 0);
  assert.equal(w.getPlayer('melee-u')._attackCd, 0.5 * 0.7692, 'melee cooldown must be scaled by DEX');

  w.attack('proj-u', 1, 0);
  assert.equal(w.getPlayer('proj-u')._attackCd, 0.6 * 0.7692, 'projectile cooldown must be scaled by DEX');
});

test('WIS scales the mana regen tick', () => {
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, BASE_STATS);
    const p = w.getPlayer('u1');
    p.mana = 0;
    w.tick(1);
    assert.equal(p.mana, 10, 'base WIS regen must be 10/s');
  }
  {
    const w = armWorld();
    // wisdom 25 -> above base 20 -> manaRegen = 10 + 0.5*20 = 20.
    w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, stat({ wisdom: 25 }));
    const p = w.getPlayer('u1');
    p.mana = 0;
    w.tick(1);
    assert.equal(p.mana, 20, 'wisdom 25 must regen 20/s');
  }
});

test('applyDerivedStats raises current hp by the delta and never heals to full', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, BASE_STATS); // maxHp 100
  const p = w.getPlayer('u1');
  p.hp = 30;
  w.applyDerivedStats('u1', stat({ constitution: 10 })); // maxHp 150
  assert.equal(p.maxHp, 150);
  assert.equal(p.hp, 80, 'hp must move by the +50 delta, not snap to the new max');
});

test('applyDerivedStats lowering maxHp cannot kill the player', () => {
  const w = armWorld();
  // constitution 15 -> above base 10 -> maxHp 100 + 10*10 = 200
  w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, stat({ constitution: 15 }));
  const p = w.getPlayer('u1');
  p.hp = 5;
  w.applyDerivedStats('u1', BASE_STATS); // maxHp back to 100, delta -100
  assert.equal(p.maxHp, 100);
  assert.equal(p.hp, 1, 'hp must clamp at 1, never reach 0 or below from a respec');
});

// Source-text guard. The two cooldown sites are the spec's named hazard, and
// a behavioural test only proves the paths it exercises. This proves there is
// no THIRD site: the weapon's cooldown field must be read exactly once in the
// file, inside applyAttackCooldown.
test('the weapon cooldown is read in exactly one place', () => {
  const src = fs.readFileSync(require.resolve('../src/authority/world.js'), 'utf8');
  const hits = src.match(/w\.cooldown/g) || [];
  assert.equal(hits.length, 1, `w.cooldown read at ${hits.length} sites; route them all through applyAttackCooldown`);
});
