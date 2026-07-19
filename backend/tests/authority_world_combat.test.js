const test = require('node:test');
const assert = require('node:assert');
const { World, PLAYER_MAX_HP, PLAYER_MAX_MANA } = require('../src/authority/world.js');

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }

test('addPlayer starts at full hp; snapshot exposes hp/maxHp', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 100, y: 100 });
  const p = w.getPlayer('u1');
  assert.equal(p.hp, PLAYER_MAX_HP);
  assert.equal(p.maxHp, PLAYER_MAX_HP);
  const snap = w.snapshot();
  assert.equal(snap.players[0].hp, PLAYER_MAX_HP);
  assert.equal(snap.players[0].maxHp, PLAYER_MAX_HP);
});

test('a player at <=0 hp respawns at spawn with full hp', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 500, y: 500 });
  const p = w.getPlayer('u1');
  p.x = 900; p.y = 900; p.hp = -3; // simulate lethal damage away from spawn
  w.resolveDeaths(); // respawn now resolves here (moved out of tickCreatures in Task 5)
  assert.equal(p.hp, PLAYER_MAX_HP);
  assert.equal(p.x, 500);
  assert.equal(p.y, 500);
});

// attack() gained a weapon-catalog-driven arc + (userId, ax, ay) -> {killedCreatureIds}
// shape in Task 5; these two pre-existing tests are updated to that API (armWorld()
// is defined further down in this file — hoisted, safe to call here).
test('attack is cooldown-gated and kills an adjacent creature', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }); // center 132,132; default weapon = dagger (reach 80, arc 0.6)
  // Load a low-hp creature within the dagger's reach, aligned with due-east aim.
  w.creatures.addCreatures([{ id: 'x', type: 'Wolf', x: 150, y: 108, hp: 5, facing: 'S', color: '#c00' }]);
  const killed = w.attack('u1', 1, 0).killedCreatureIds;
  assert.deepEqual(killed, ['x']);
  // Immediate re-attack is on cooldown → no-op.
  w.creatures.addCreatures([{ id: 'y', type: 'Wolf', x: 150, y: 108, hp: 5, facing: 'S', color: '#c00' }]);
  assert.deepEqual(w.attack('u1', 1, 0).killedCreatureIds, []);
});

test('attack from an unknown player returns no kills', () => {
  const w = armWorld();
  assert.deepEqual(w.attack('nobody', 1, 0).killedCreatureIds, []);
});

// Weapon catalog shared by this file's World combat tests.
const TYPES = new Map([
  [1, { id: 1, name: 'dagger', category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: null }],
  [2, { id: 2, name: 'halberd', category: 'weapon', kind: 'melee', damage: 18, cooldown: 0.9, reach: 190, arc_width: 1.8, mana_cost: 0, element: null }],
  [3, { id: 3, name: 'bow', category: 'weapon', kind: 'projectile', damage: 12, cooldown: 0.6, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, element: null }],
  [4, { id: 4, name: 'magic-bolt', category: 'weapon', kind: 'projectile', damage: 14, cooldown: 0.7, range: 600, projectile_speed: 700, projectile_radius: 12, pierce: 1, mana_cost: 15, element: 'arcane' }],
  [5, { id: 5, name: 'greatsword', category: 'weapon', kind: 'melee', damage: 25, cooldown: 0.5, reach: 90, arc_width: 0.7, mana_cost: 0, stamina_cost: 20, element: null }],
]);
const DEFAULT_ID = 1;
const heavyWeapon = TYPES.get(5);
const emptyInv = () => ({ items: [], equipment: {} });
// halberd: reach 190 (> 150) and arc_width 1.8 rad, wide enough to cover a
// target directly on the aim vector (dot === 1 there regardless of width).
const longReachInv = () => ({ items: [{ id: 'h2', typeId: 2 }], equipment: { main_hand: 'h2' } });
// greatsword: melee, stamina_cost 20, reach 90 (> 60, the u1↔u2 gap used in
// the stamina-gate tests below).
const heavyInv = () => ({ items: [{ id: 'h5', typeId: 5 }], equipment: { main_hand: 'h5' } });

// All-grass map for World combat tests.
function armWorld() {
  const map = {
    chunkSize: 8,
    isWalkable: () => true,
    speedAt: () => 1,
    getChunk: () => [],
  };
  return new World(map, TYPES, DEFAULT_ID);
}

test('melee attack hits creatures AND other players in the arc', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, { items: [{ id: 'i2', typeId: 2 }], equipment: { main_hand: 'i2' } }); // center 132,132; halberd (reach 190, wide), damage 18
  w.addPlayer('u2', { x: 150, y: 100 });          // center 182,132 — east, within halberd reach
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 10, facing: 'S', color: '#f00' }]);
  const { killedCreatureIds } = w.attack('u1', 1, 0); // aim east
  assert.deepEqual(killedCreatureIds, ['c1']);     // c1 (hp 10) in-arc, killed by 18 dmg
  assert.equal(w.getPlayer('u2').hp, w.getPlayer('u2').maxHp - 18); // u2 in-arc, took melee damage
});

test('projectile attack spawns a projectile and deducts mana', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, { items: [{ id: 'i4', typeId: 4 }], equipment: { main_hand: 'i4' } }); // magic-bolt, cost 15
  const before = w.getPlayer('u1').mana;
  w.attack('u1', 1, 0);
  assert.equal(w.snapshot().projectiles.length, 1);
  assert.equal(w.getPlayer('u1').mana, before - 15);
});

test('projectile attack with insufficient mana is denied, no cooldown consumed', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, { items: [{ id: 'i4', typeId: 4 }], equipment: { main_hand: 'i4' } }); // magic-bolt, cost 15
  const p = w.getPlayer('u1');
  p.mana = 5;                                      // below cost 15
  const out = w.attack('u1', 1, 0);
  assert.equal(w.snapshot().projectiles.length, 0);
  assert.equal(p.mana, 5);
  assert.equal(p._attackCd, 0);                    // not on cooldown → retryable
  assert.deepEqual(out.killedCreatureIds, []);
});

test('mana regenerates in tick up to max', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  p.mana = 50;
  w.tick(1.0);                                     // +PLAYER_MANA_REGEN
  assert.ok(p.mana > 50 && p.mana <= PLAYER_MAX_MANA);
  p.mana = PLAYER_MAX_MANA;
  w.tick(1.0);
  assert.equal(p.mana, PLAYER_MAX_MANA);           // no overflow
});

test('resolveDeaths respawns a player at spawn with full hp+mana', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 500, y: 500 });
  const p = w.getPlayer('u1');
  p.x = 999; p.y = 999; p.hp = 0; p.mana = 0;
  w.resolveDeaths();
  assert.equal(p.hp, p.maxHp);
  assert.equal(p.mana, p.maxMana);
  assert.equal(p.x, 500); assert.equal(p.y, 500);
});

test('tickProjectiles returns killed creature ids', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, { items: [{ id: 'i3', typeId: 3 }], equipment: { main_hand: 'i3' } }); // bow
  // Player at (0,0) → center (32,32); a bow projectile spawns there and flies
  // east at y=32, so place the creature ON that line (center y=32).
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 40, y: 8, hp: 1, facing: 'S', color: '#f00' }]); // center 64,32
  w.attack('u1', 1, 0);                            // aim east from center (32,32)
  // Advance until the fast projectile reaches the creature.
  let killed = [];
  for (let i = 0; i < 20 && killed.length === 0; i++) killed = w.tickProjectiles(0.02);
  assert.deepEqual(killed, ['c1']);
});

test('snapshot includes mana/maxMana/equipment per player and a projectiles array', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  const snap = w.snapshot();
  const pl = snap.players[0];
  assert.equal(pl.mana, PLAYER_MAX_MANA);
  assert.equal(pl.maxMana, PLAYER_MAX_MANA);
  assert.deepEqual(pl.equipment, {});              // nothing equipped
  assert.equal(w.activeWeapon('u1').id, 1);        // falls back to the default (dagger)
  assert.ok(Array.isArray(snap.projectiles));
});

// Map stub with a vertical wall between x=90 and x=110.
function walledMap() {
  return {
    chunkSize: 8,
    isWalkable: (x) => !(x >= 90 && x <= 110),
    speedAt: () => 1,
    getChunk: () => [],
  };
}
function openMap() {
  return { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
}

test('melee does NOT hit a player through a wall', () => {
  const w = new World(walledMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, longReachInv());
  w.addPlayer('u2', { x: 150, y: 0 }, emptyInv());
  const before = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  assert.strictEqual(w.getPlayer('u2').hp, before, 'wall must block the swing');
});

test('the SAME swing DOES hit with clear terrain', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, longReachInv());
  w.addPlayer('u2', { x: 150, y: 0 }, emptyInv());
  const before = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  assert.ok(w.getPlayer('u2').hp < before, 'clear line must land — otherwise the block test is vacuous');
});

test('melee does NOT hit a creature through a wall', () => {
  const w = new World(walledMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, longReachInv());
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 150, y: 0, hp: 50, facing: 's' }]);
  w.attack('u1', 1, 0);
  assert.strictEqual(w.creatures.creatures.get('c1').hp, 50, 'wall must block the swing');
});

test('the SAME swing DOES hit a creature with clear terrain', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, longReachInv());
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 150, y: 0, hp: 50, facing: 's' }]);
  w.attack('u1', 1, 0);
  assert.ok(w.creatures.creatures.get('c1').hp < 50, 'clear line must land');
});

test('stamina regenerates and clamps to max', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, emptyInv());
  const p = w.getPlayer('u1');
  assert.strictEqual(p.stamina, p.maxStamina);
  p.stamina = 50;
  w.tick(1);
  assert.strictEqual(p.stamina, 62, '12 per second');
  p.stamina = p.maxStamina - 1;
  w.tick(1);
  assert.strictEqual(p.stamina, p.maxStamina, 'clamps, never exceeds max');
});

test('a stamina-costed attack deducts it', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, heavyInv()); // weapon with stamina_cost > 0
  const p = w.getPlayer('u1');
  const before = p.stamina;
  w.attack('u1', 1, 0);
  assert.strictEqual(p.stamina, before - heavyWeapon.stamina_cost);
});

test('insufficient stamina refuses the attack AND leaves the cooldown untouched', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, heavyInv());
  w.addPlayer('u2', { x: 60, y: 0 }, emptyInv());
  const p = w.getPlayer('u1');
  p.stamina = 0;
  const targetHp = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  assert.strictEqual(w.getPlayer('u2').hp, targetHp, 'no damage dealt');
  assert.strictEqual(p._attackCd, 0, 'a denied attack must NOT start the cooldown');
  // and once stamina is restored the very next attack works
  p.stamina = p.maxStamina;
  w.attack('u1', 1, 0);
  assert.ok(w.getPlayer('u2').hp < targetHp, 'attack lands once affordable');
});

test('a zero-cost weapon is unaffected by an empty stamina pool', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, emptyInv()); // default weapon, stamina_cost 0
  w.addPlayer('u2', { x: 60, y: 0 }, emptyInv());
  w.getPlayer('u1').stamina = 0;
  const targetHp = w.getPlayer('u2').hp;
  w.attack('u1', 1, 0);
  assert.ok(w.getPlayer('u2').hp < targetHp, 'free weapons always swing');
});

test('snapshot exposes stamina', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, emptyInv());
  const pl = w.snapshot().players[0];
  assert.strictEqual(pl.stamina, 100);
  assert.strictEqual(pl.maxStamina, 100);
});
