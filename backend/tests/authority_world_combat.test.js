const test = require('node:test');
const assert = require('node:assert');
const { World, PLAYER_MAX_HP, MELEE_RANGE, PLAYER_DAMAGE, PLAYER_ATTACK_COOLDOWN, PLAYER_MAX_MANA } = require('../src/authority/world.js');

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

// A weapon catalog Map + all-grass map for World combat tests.
function armWorld() {
  const map = {
    chunkSize: 8,
    isWalkable: () => true,
    speedAt: () => 1,
    getChunk: () => [],
  };
  const weapons = new Map([
    [1, { id: 1, name: 'dagger', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: null }],
    [2, { id: 2, name: 'halberd', kind: 'melee', damage: 18, cooldown: 0.9, reach: 190, arc_width: 1.8, mana_cost: 0, element: null }],
    [3, { id: 3, name: 'bow', kind: 'projectile', damage: 12, cooldown: 0.6, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, element: null }],
    [4, { id: 4, name: 'magic-bolt', kind: 'projectile', damage: 14, cooldown: 0.7, range: 600, projectile_speed: 700, projectile_radius: 12, pierce: 1, mana_cost: 15, element: 'arcane' }],
  ]);
  return new World(map, weapons, 1);
}

test('melee attack hits creatures AND other players in the arc', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 });          // center 132,132
  w.addPlayer('u2', { x: 150, y: 100 });          // center 182,132 — east, within halberd reach
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 10, facing: 'S', color: '#f00' }]);
  w.setWeapon('u1', 2);                            // halberd (reach 190, wide), damage 18
  const { killedCreatureIds } = w.attack('u1', 1, 0); // aim east
  assert.deepEqual(killedCreatureIds, ['c1']);     // c1 (hp 10) in-arc, killed by 18 dmg
  assert.equal(w.getPlayer('u2').hp, w.getPlayer('u2').maxHp - 18); // u2 in-arc, took melee damage
});

test('projectile attack spawns a projectile and deducts mana', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  w.setWeapon('u1', 4);                            // magic-bolt, cost 15
  const before = w.getPlayer('u1').mana;
  w.attack('u1', 1, 0);
  assert.equal(w.snapshot().projectiles.length, 1);
  assert.equal(w.getPlayer('u1').mana, before - 15);
});

test('projectile attack with insufficient mana is denied, no cooldown consumed', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  p.mana = 5; p.weaponId = 4;                      // below cost 15
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
  w.addPlayer('u1', { x: 0, y: 0 });
  // Player at (0,0) → center (32,32); a bow projectile spawns there and flies
  // east at y=32, so place the creature ON that line (center y=32).
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 40, y: 8, hp: 1, facing: 'S', color: '#f00' }]); // center 64,32
  w.setWeapon('u1', 3);                            // bow
  w.attack('u1', 1, 0);                            // aim east from center (32,32)
  // Advance until the fast projectile reaches the creature.
  let killed = [];
  for (let i = 0; i < 20 && killed.length === 0; i++) killed = w.tickProjectiles(0.02);
  assert.deepEqual(killed, ['c1']);
});

test('snapshot includes mana/maxMana/weaponId per player and a projectiles array', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  const snap = w.snapshot();
  const pl = snap.players[0];
  assert.equal(pl.mana, PLAYER_MAX_MANA);
  assert.equal(pl.maxMana, PLAYER_MAX_MANA);
  assert.equal(pl.weaponId, 1);                    // default (dagger)
  assert.ok(Array.isArray(snap.projectiles));
});

test('setWeapon ignores an unknown id', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  w.setWeapon('u1', 999);
  assert.equal(w.getPlayer('u1').weaponId, 1);     // unchanged
});
