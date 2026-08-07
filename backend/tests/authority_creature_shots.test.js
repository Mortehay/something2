const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');
const { World, MAX_CREATURE_PROJECTILES } = require('../src/authority/world.js');

function openMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
function walledMap() { return { isWalkable: () => false, speedAt: () => 1, chunkSize: 8 }; }
const noRedirect = () => 0.05;

function ranged(over = {}) {
  return {
    name: 'R', attackKind: 'ranged', attackRange: 340, attackCooldown: 1.8,
    projectileSpeed: 520, projectileRadius: 6, aggroRadius: 460, leashRadius: 800,
    chaseStyle: 'kite', preferredRange: 240, moveSpeedMult: 1, damageOverride: null,
    ...over,
  };
}

function sim(bh, mapFn = openMap, element = 'physical') {
  const s = new CreatureSim(mapFn(), noRedirect);
  s.addCreatures([{ id: 'c', type: 'R', x: 100, y: 100, hp: 100,
    behavior: bh, attackElement: element, damage: 7 }]);
  return s;
}
const active = new Set(['0,0', '0,1', '1,0', '1,1']);

test('a ranged creature emits a shot at a target in range', () => {
  const s = sim(ranged());
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 1);
  const shot = shots[0];
  assert.equal(shot.ownerId, 'c');
  assert.equal(shot.ownerFaction, 'hostile');
  assert.equal(shot.element, 'physical');
  assert.equal(shot.damage, 7);
  assert.equal(shot.speed, 520);
  // Aimed east, at the player.
  assert.ok(shot.nx > 0.9, `expected an eastward aim, got nx=${shot.nx}`);
  assert.ok(Math.abs(Math.hypot(shot.nx, shot.ny) - 1) < 1e-9, 'aim must be normalized');
});

test('a melee creature never emits a shot', () => {
  const s = sim(ranged({ attackKind: 'melee', attackRange: 400 }));
  const player = { userId: 'u1', x: 200, y: 100, width: 48, height: 48, hp: 500, mit: null };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 0);
});

test('no shot without line of sight', () => {
  const s = sim(ranged(), walledMap);
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 0, 'must not shoot through a wall');
});

test('no shot at a target beyond attack range', () => {
  const s = sim(ranged({ attackRange: 100, aggroRadius: 460 }));
  const player = { userId: 'u1', x: 400, y: 100, width: 48, height: 48, hp: 500 };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 0);
});

test('the cooldown gates the rate of fire', () => {
  const s = sim(ranged({ attackCooldown: 1.0 }));
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  let total = 0;
  // 1.0s of ticks at 0.1s: one shot at t=0, and the cooldown is not yet clear
  // by the tenth tick.
  for (let i = 0; i < 10; i++) total += s.tick(0.1, active, [player], i * 0.1).shots.length;
  assert.equal(total, 1, `expected exactly one shot in 1.0s, got ${total}`);
});

test('a cast creature fires its own element, a ranged one always physical', () => {
  const cast = sim(ranged({ attackKind: 'cast' }), openMap, 'fire');
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  assert.equal(cast.tick(0.1, active, [player], 0).shots[0].element, 'fire');

  const arrow = sim(ranged({ attackKind: 'ranged' }), openMap, 'fire');
  assert.equal(arrow.tick(0.1, active, [player], 0).shots[0].element, 'physical',
    'a ranged rung fires physical even when the line has an element');
});

test('a hold creature fires without moving', () => {
  const s = sim(ranged({ chaseStyle: 'hold', attackRange: 380 }));
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 1);
  assert.equal(s.all()[0].x, 100, 'hold must not move');
  // The movement block (the only other place facing updates) never runs for
  // a hold creature, so the shot arm itself must set facing -- otherwise a
  // turret keeps whatever facing its row loaded with and visibly fires out
  // of its own back.
  assert.equal(s.all()[0].facing, 'E', 'a stationary shooter must still face its target');
});

// --- World-level wiring: tick's shots must actually become live projectiles
// in the world's OWN ProjectileSim, through the real field mapping in
// tickCreatures (speed -> projectile_speed, radius -> projectile_radius,
// etc). Every test above stops at CreatureSim.tick and would stay green even
// if that mapping were wrong -- e.g. a typo'd key would make spawn() compute
// vx = nx * undefined = NaN, and ProjectileSim silently culls a non-finite
// projectile on its very first step, so a creature that fires nothing.
function worldMap() { return { chunkSize: 8, isWalkable: () => true, speedAt: () => 1 }; }

test('World.tickCreatures spawns a ranged creature\'s shot into its own ProjectileSim, with the profile\'s own speed', () => {
  const w = new World(worldMap());
  // y=92 so the player's centre (32,32 offset) lands on the creature's
  // centre row (124,124) -- a pure eastward shot, easy to check.
  w.addPlayer('u1', { x: 380, y: 92 });
  w.creatures.addCreatures([{ id: 'c', type: 'R', x: 100, y: 100, hp: 100,
    behavior: ranged(), attackElement: 'physical', damage: 7 }]);
  w.tickCreatures(0.1, active);
  assert.equal(w.projectiles.count(), 1, 'the shot must have been spawned into world.projectiles');
  const p = w.projectiles.projectiles[0];
  const speed = Math.hypot(p.vx, p.vy);
  // Literal 520, the Ranged profile's own projectileSpeed above -- not a
  // value re-read from the behaviour object, which would let a mapping typo
  // pass unnoticed.
  assert.ok(Math.abs(speed - 520) < 1e-9, `expected projectile speed 520, got ${speed}`);
  assert.ok(p.vx > 0, `expected eastward velocity, got vx=${p.vx}`);
});

test('MAX_CREATURE_PROJECTILES caps concurrent creature shots -- the excess is dropped, not queued', () => {
  const w = new World(worldMap());
  w.addPlayer('u1', { x: 380, y: 92 });
  w.creatures.addCreatures([{ id: 'c', type: 'R', x: 100, y: 100, hp: 100,
    behavior: ranged(), attackElement: 'physical', damage: 7 }]);
  const fillerWeapon = {
    projectile_speed: 1, projectile_radius: 1, range: 1,
    pierce: 1, aoe_radius: 0, element: 'physical', damage: 1,
  };
  for (let i = 0; i < MAX_CREATURE_PROJECTILES; i++) {
    w.projectiles.spawn({
      ownerId: `filler${i}`, ownerKind: 'creature', ownerFaction: 'hostile',
      x: -1000, y: -1000, nx: 1, ny: 0, weapon: fillerWeapon, damage: 1,
    });
  }
  assert.equal(w.projectiles.count(), MAX_CREATURE_PROJECTILES);
  w.tickCreatures(0.1, active);
  assert.equal(w.projectiles.count(), MAX_CREATURE_PROJECTILES,
    'the creature\'s shot must be dropped once the cap is already full, not appended past it');
});
