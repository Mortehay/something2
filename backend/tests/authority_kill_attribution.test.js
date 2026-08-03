// Task 5: every creature-kill channel now reports `kills: [{ id, killerUserId }]`
// instead of `killedCreatureIds: [id]`. Pure plumbing — no XP is awarded here,
// this file only proves the RIGHT player (or null) is credited for each kill,
// through each of the four channels independently.
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { BURN_TICK_MS } = require('../src/authority/effects.js');

// Weapon catalog shared by this file's tests. `dagger` one-shots the low-hp
// creatures used below so a melee test's kill is unambiguous; `flame-dagger`
// deals only 5 (creature hp is set to 500) so the SWING never kills — only
// the resulting burn does, which is the whole point of the burn tests below.
const TYPES = new Map([
  [1, {
    id: 1, name: 'dagger', category: 'weapon', kind: 'melee', damage: 100,
    cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: null,
  }],
  [2, {
    id: 2, name: 'bow', category: 'weapon', kind: 'projectile', damage: 100,
    cooldown: 0.3, range: 700, projectile_speed: 900, projectile_radius: 8,
    pierce: 1, mana_cost: 0, element: null,
  }],
  [3, {
    id: 3, name: 'flame-dagger', category: 'weapon', kind: 'melee', damage: 5,
    cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: 'fire',
  }],
]);
const DEFAULT_ID = 1;
const bowInv = () => ({ items: [{ id: 'b1', typeId: 2 }], equipment: { main_hand: 'b1' } });
const flameInv = () => ({ items: [{ id: 'f1', typeId: 3 }], equipment: { main_hand: 'f1' } });

function armWorld() {
  const map = {
    chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [],
  };
  return new World(map, TYPES, DEFAULT_ID);
}

test('a melee kill is credited to the attacker', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }); // centre 132,132; default dagger, reach 80
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 150, y: 108, hp: 5, facing: 'S', color: '#c00' }]);
  const { kills } = w.attack('u1', 1, 0);
  assert.deepEqual(kills, [{ id: 'c1', killerUserId: 'u1' }]);
});

test('a projectile kill is credited to the projectile owner, not the last attacker', () => {
  const w = armWorld();
  // A fires a bow east from (0,0) -> centre (32,32); the projectile travels
  // along y=32 toward a creature placed on that line.
  w.addPlayer('A', { x: 0, y: 0 }, bowInv());
  // B stands far away, aimed at nothing — a genuine miss, not a kill B could
  // be mistaken for.
  w.addPlayer('B', { x: 500, y: 500 });
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 40, y: 8, hp: 1, facing: 'S', color: '#f00' }]); // centre 64,32
  w.attack('A', 1, 0); // spawns A's projectile
  const missResult = w.attack('B', 1, 0); // B swings, at nothing near it
  assert.deepEqual(missResult.kills, [],
    'B must not have killed anything itself — otherwise this test cannot distinguish attribution');
  let out = { kills: [], detonations: [] };
  for (let i = 0; i < 20 && out.kills.length === 0; i++) out = w.tickProjectiles(0.02);
  assert.deepEqual(out.kills, [{ id: 'c1', killerUserId: 'A' }],
    'the kill must be credited to A (the projectile owner), never to B (the player who most recently attacked)');
});

test('a burn-tick kill is credited to whoever applied the burn', () => {
  const w = armWorld();
  w.addPlayer('A', { x: 100, y: 100 }, flameInv());  // centre 132,132
  w.addPlayer('B', { x: 100, y: 300 });               // unrelated location, default dagger
  w.creatures.addCreatures([
    { id: 'c1', type: 'wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#f00' }, // A's target
    { id: 'c2', type: 'wolf', x: 150, y: 308, hp: 5, facing: 'S', color: '#f00' },   // B's target
  ]);
  // A's swing applies fire + burn but must NOT itself kill c1 (hp 500, dmg 5)
  // — everything that finishes c1 off must come from the burn tick below.
  const aHit = w.attack('A', 1, 0);
  assert.deepEqual(aHit.kills, [], 'the setup hit must not itself kill the creature');
  // Drive c1 down so the very next burn tick (magnitude BURN_MAGNITUDE) finishes it.
  w.creatures.creatures.get('c1').hp = 1;
  // A DIFFERENT player acts in between, and genuinely kills something else —
  // if burn credit were mistakenly "whoever attacked most recently" instead
  // of the effect's own sourceId, this is what would make it read B.
  const bKill = w.attack('B', 1, 0);
  assert.deepEqual(bKill.kills, [{ id: 'c2', killerUserId: 'B' }],
    'B must have actually killed something else — otherwise "acting in between" proves nothing');
  const r = w.tick(BURN_TICK_MS / 1000);
  assert.deepEqual(r.kills, [{ id: 'c1', killerUserId: 'A' }],
    'the burn kill must be credited to A, who applied the burn — not B, who attacked more recently');
});

test('a guard kill reports killerUserId null, not a stray id', () => {
  const w = new World({ chunkSize: 64, isWalkable: () => true, speedAt: () => 1 }, {}, null, 64);
  w.creatures.addCreatures([
    { id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 },
    { id: 'h', type: 'Slime', x: 140, y: 100, hp: 1 },
  ]);
  const out = w.tickCreatures(0.5, new Set(['0,0']));
  assert.deepEqual(out.kills, [{ id: 'h', killerUserId: null }]);
  // Exactly null, never merely falsy: a stray `undefined` or `0` must not
  // slip through as an accidental pass.
  assert.strictEqual(out.kills[0].killerUserId, null);
});

test('every kill channel reports the same { id, killerUserId } shape', () => {
  const wMelee = armWorld();
  wMelee.addPlayer('u1', { x: 100, y: 100 });
  wMelee.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 150, y: 108, hp: 5, facing: 'S', color: '#c00' }]);
  const meleeKill = wMelee.attack('u1', 1, 0).kills[0];

  const wProj = armWorld();
  wProj.addPlayer('u1', { x: 0, y: 0 }, bowInv());
  wProj.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 40, y: 8, hp: 1, facing: 'S', color: '#f00' }]);
  wProj.attack('u1', 1, 0);
  let projOut = { kills: [], detonations: [] };
  for (let i = 0; i < 20 && projOut.kills.length === 0; i++) projOut = wProj.tickProjectiles(0.02);
  const projKill = projOut.kills[0];

  const wBurn = armWorld();
  wBurn.addPlayer('u1', { x: 100, y: 100 }, flameInv());
  wBurn.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#f00' }]);
  wBurn.attack('u1', 1, 0);
  wBurn.creatures.creatures.get('c1').hp = 1;
  const burnKill = wBurn.tick(BURN_TICK_MS / 1000).kills[0];

  const wGuard = new World({ chunkSize: 64, isWalkable: () => true, speedAt: () => 1 }, {}, null, 64);
  wGuard.creatures.addCreatures([
    { id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 },
    { id: 'h', type: 'Slime', x: 140, y: 100, hp: 1 },
  ]);
  const guardKill = wGuard.tickCreatures(0.5, new Set(['0,0'])).kills[0];

  for (const k of [meleeKill, projKill, burnKill, guardKill]) {
    assert.ok(k, 'every channel must have actually produced a kill for this test to mean anything');
    assert.deepEqual(Object.keys(k).sort(), ['id', 'killerUserId']);
  }
});
