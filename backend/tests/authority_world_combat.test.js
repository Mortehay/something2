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
  [1, { id: 1, name: 'dagger', category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: null, vfx: { attack: 'sweep_arc' } }],
  [2, { id: 2, name: 'halberd', category: 'weapon', kind: 'melee', damage: 18, cooldown: 0.9, reach: 190, arc_width: 1.8, mana_cost: 0, element: null, vfx: { attack: 'sweep_arc' } }],
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
  let out = { killedCreatureIds: [], detonations: [] };
  for (let i = 0; i < 20 && out.killedCreatureIds.length === 0; i++) out = w.tickProjectiles(0.02);
  assert.deepEqual(out.killedCreatureIds, ['c1']);
  assert.deepEqual(out.detonations, [], 'a bow is not an AoE weapon');
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
  assert.strictEqual(p.stamina, 60, '10 per second');
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

test('respawn restores stamina alongside hp and mana', () => {
  const w = new World(openMap(), TYPES, DEFAULT_ID);
  w.addPlayer('u1', { x: 0, y: 0 }, emptyInv());
  const p = w.getPlayer('u1');
  p.hp = 0; p.mana = 0; p.stamina = 0;
  w.resolveDeaths();
  assert.strictEqual(p.hp, p.maxHp);
  assert.strictEqual(p.mana, p.maxMana);
  assert.strictEqual(p.stamina, p.maxStamina, 'respawning unable to swing is not a revival');
});

// canAttack: the pure, side-effect-free half of attack()'s gating
// (cooldown/mana/stamina), exposed so a caller can check BEFORE spending
// something irreversible (ammo, in a later task). attack() keeps its own
// checks unchanged — these tests only cover the new read-only method.
test('canAttack reports false while the cooldown is running', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  w.attack('u1', 1, 0); // starts the cooldown
  assert.equal(w.canAttack('u1').ok, false);
});

test('canAttack reports false with insufficient stamina', () => {
  const w = armWorld();
  // The default dagger costs 0 stamina, so it would pass regardless of the
  // stamina pool — that would prove nothing. Equip the greatsword, which
  // actually costs stamina, so the denial is caused by the gate under test.
  w.addPlayer('u1', { x: 0, y: 0 }, heavyInv());
  w.getPlayer('u1').stamina = 0;
  const r = w.canAttack('u1');
  assert.equal(r.ok, false);
  assert.ok(r.weapon, 'still reports which weapon would have fired');
  assert.equal(r.weapon.id, heavyWeapon.id);
});

test('canAttack reports false with insufficient mana', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, { items: [{ id: 'i4', typeId: 4 }], equipment: { main_hand: 'i4' } }); // magic-bolt, cost 15
  w.getPlayer('u1').mana = 5;
  const r = w.canAttack('u1');
  assert.equal(r.ok, false);
  assert.equal(r.weapon.id, 4);
});

test('canAttack returns the active weapon when it can fire', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  const r = w.canAttack('u1');
  assert.equal(r.ok, true);
  assert.ok(r.weapon);
});

test('canAttack does not mutate state or consume the cooldown', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, heavyInv());
  const p = w.getPlayer('u1');
  const stamina = p.stamina, mana = p.mana, cd = p._attackCd;
  w.canAttack('u1');
  assert.strictEqual(p.stamina, stamina);
  assert.strictEqual(p.mana, mana);
  assert.strictEqual(p._attackCd, cd);
});

test('canAttack reports false for an unknown player', () => {
  const w = armWorld();
  assert.equal(w.canAttack('nobody').ok, false);
});

// --- elemental riders on the melee path (Task 5) ----------------------------

const { BURN, CHILL, BURN_DURATION_MS } = require('../src/authority/effects.js');

// Elemental melee weapons, added to the shared catalog above.
TYPES.set(6, { id: 6, name: 'flame-halberd', category: 'weapon', kind: 'melee', damage: 18, cooldown: 0.9, reach: 190, arc_width: 1.8, mana_cost: 0, element: 'fire' });
TYPES.set(7, { id: 7, name: 'frost-halberd', category: 'weapon', kind: 'melee', damage: 18, cooldown: 0.9, reach: 190, arc_width: 1.8, mana_cost: 0, element: 'ice' });

function elementalMeleeWorld(typeId) {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, { items: [{ id: 'e1', typeId }], equipment: { main_hand: 'e1' } });
  w.addPlayer('u2', { x: 150, y: 100 }); // center 182,132 — east, inside reach 190
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#f00' }]);
  return w;
}

test('a melee arc applies the weapon element to the creatures AND the players it hits', () => {
  const w = elementalMeleeWorld(6); // fire
  w.attack('u1', 1, 0);
  const u2 = w.getPlayer('u2');
  const c1 = w.creatures.creatures.get('c1');
  assert.equal(u2.effects.has(BURN), true, 'melee applied no rider to the player it damaged');
  assert.equal(u2.effects.size, 1, 'melee applied more than the weapon element rider');
  assert.equal(c1.effects.has(BURN), true, 'melee applied no rider to the creature it damaged');
  assert.equal(c1.effects.size, 1, 'melee applied more than the weapon element rider');
});

test('the melee rider follows the weapon element, not a hardcoded one', () => {
  const w = elementalMeleeWorld(7); // ice
  w.attack('u1', 1, 0);
  assert.equal(w.getPlayer('u2').effects.has(CHILL), true);
  assert.equal(w.getPlayer('u2').effects.size, 1);
  assert.equal(w.creatures.creatures.get('c1').effects.has(CHILL), true);
});

test('a non-elemental melee weapon applies no rider', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, longReachInv()); // halberd, element null
  w.addPlayer('u2', { x: 150, y: 100 });
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#f00' }]);
  w.attack('u1', 1, 0);
  assert.ok(w.getPlayer('u2').hp < w.getPlayer('u2').maxHp, 'the swing must still have landed');
  assert.equal(w.getPlayer('u2').effects.size, 0);
  const c1 = w.creatures.creatures.get('c1');
  assert.equal(c1.effects ? c1.effects.size : 0, 0);
});

test('the melee rider is stamped with the world clock, so it expires on the world tick', () => {
  const w = elementalMeleeWorld(6);
  w.tick(0.5); // advance the world clock off zero first
  w.attack('u1', 1, 0);
  const u2 = w.getPlayer('u2');
  assert.equal(u2.effects.get(BURN).until, w.now + BURN_DURATION_MS,
    'the rider must use the world clock, not 0 — otherwise it is born expired');
});

test('a melee attack returns one descriptor carrying the real weapon geometry', () => {
  const w = armWorld();
  // Inventory is addPlayer's THIRD argument (see world.js addPlayer) — the
  // rest of this file passes it the same way. Assigning p.inv afterwards
  // would work too, but stay consistent with the file.
  w.addPlayer('u1', { x: 100, y: 100 }, longReachInv());  // centre 132,132; halberd reach 190, arc 1.8
  const { attacks } = w.attack('u1', 1, 0);               // aim due east

  assert.equal(attacks.length, 1);
  const a = attacks[0];
  assert.equal(a.a, 'p:u1');
  assert.equal(a.v, 'sweep_arc');
  assert.equal(a.x, 132);
  assert.equal(a.y, 132);
  assert.equal(a.nx, 1);
  assert.equal(a.ny, 0);
  // Geometry comes from the CATALOG, not from constants in the descriptor —
  // this is what makes a halberd and a knife look different.
  assert.equal(a.reach, 190);
  assert.equal(a.arc, 1.8);
});

test('the descriptor geometry tracks the equipped weapon', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 });           // no inv override -> default dagger
  const a = w.attack('u1', 1, 0).attacks[0];
  assert.equal(a.reach, 80);
  assert.equal(a.arc, 0.6);
  assert.notEqual(a.reach, 190, 'a dagger must not report the halberd reach');
});

test('the aim vector in the descriptor is normalized', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 });
  const a = w.attack('u1', 3, 4).attacks[0];       // length 5
  assert.ok(Math.abs(Math.hypot(a.nx, a.ny) - 1) < 1e-9, 'nx/ny must be a unit vector');
  assert.ok(Math.abs(a.nx - 0.6) < 1e-9);
  assert.ok(Math.abs(a.ny - 0.8) < 1e-9);
});

test('hit is true for a connected swing that kills nothing', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, longReachInv());
  // Same coordinates the file's proven in-arc dagger test uses (x 150, y 108
  // against a player centred 132,132 aiming east), so an arc-geometry change
  // cannot be what makes this test go red.
  w.creatures.addCreatures([{ id: 'tough', type: 'Wolf', x: 150, y: 108, hp: 9999, facing: 'S', color: '#c00' }]);
  const { killedCreatureIds, attacks } = w.attack('u1', 1, 0);
  assert.deepEqual(killedCreatureIds, [], 'nothing died');
  assert.equal(attacks[0].hit, true, 'a non-lethal connection is still a hit, not a whiff');
});

test('hit is false when the swing connects with nothing', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, longReachInv());
  assert.equal(w.attack('u1', 1, 0).attacks[0].hit, false);
});

test('hit is true when only another player is caught in the arc', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, longReachInv());  // centre 132,132
  w.addPlayer('u2', { x: 200, y: 100 }, emptyInv());      // centre 232,132 — 100px east, inside reach 190
  assert.equal(w.attack('u1', 1, 0).attacks[0].hit, true);
});

test('an unbound weapon emits a descriptor with a null name', () => {
  // The swing still happened; slice B gives it a kind-level default. It must
  // NOT be swallowed here — a missing descriptor and a null name are
  // different bugs and must stay distinguishable.
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, heavyInv());   // greatsword, no vfx binding
  const a = w.attack('u1', 1, 0).attacks[0];
  assert.equal(a.v, null);
  assert.equal(a.reach, 90);
});

test('a projectile attack emits no descriptor in slice A', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, { items: [{ id: 'b3', typeId: 3 }], equipment: { main_hand: 'b3' } });
  assert.deepEqual(w.attack('u1', 1, 0).attacks, [], 'projectile trails are slice D');
});

test('every refused attack still returns an attacks array', () => {
  // server.js destructures `attacks` unconditionally; an undefined on any
  // rejection path would throw inside the socket handler.
  const w = armWorld();
  assert.deepEqual(w.attack('nobody', 1, 0).attacks, []);   // unknown player
  w.addPlayer('u1', { x: 100, y: 100 });
  w.attack('u1', 1, 0);                                      // starts the cooldown
  assert.deepEqual(w.attack('u1', 1, 0).attacks, [], 'cooldown-refused');
});

test('a refused attack emits no descriptor at all', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, heavyInv());   // greatsword, stamina_cost 20
  w.getPlayer('u1').stamina = 0;
  assert.deepEqual(w.attack('u1', 1, 0).attacks, [],
    'a swing that never happened must not draw one');
});
