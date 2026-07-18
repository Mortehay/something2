const test = require('node:test');
const assert = require('node:assert');
const { ProjectileSim } = require('../src/authority/projectiles.js');

const WALK_ALL = { isWalkable: () => true };
const BOW = { damage: 12, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, element: null };

// Minimal creatures stub backed by a plain array.
function creaturesStub(list) {
  const byId = new Map(list.map((c) => [c.id, c]));
  return {
    all: () => [...byId.values()],
    damageCreatureById(id, dmg) {
      const c = byId.get(id);
      if (!c) return false;
      c.hp -= dmg;
      if (c.hp <= 0) { byId.delete(id); return true; }
      return false;
    },
    _byId: byId,
  };
}

test('spawn sets velocity from aim*speed and remaining=range', () => {
  const sim = new ProjectileSim();
  const id = sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: BOW });
  assert.equal(typeof id, 'string');
  const p = sim.snapshot()[0];
  assert.equal(p.id, id);
  assert.equal(sim.count(), 1);
});

test('step advances position and decrements range, despawns at range end', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, range: 100, projectile_speed: 1000 } });
  // dt=0.05 → 50px/step. After 2 steps traveled 100 → remaining 0 → despawn.
  sim.step(0.05, { creatures: creaturesStub([]), players: [], map: WALK_ALL });
  assert.equal(sim.count(), 1);
  sim.step(0.05, { creatures: creaturesStub([]), players: [], map: WALK_ALL });
  assert.equal(sim.count(), 0);
});

test('step despawns a projectile on an unwalkable tile', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: BOW });
  sim.step(0.05, { creatures: creaturesStub([]), players: [], map: { isWalkable: () => false } });
  assert.equal(sim.count(), 0);
});

test('step hits a creature in range: damages it, returns killed id, despawns (pierce 1)', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 100 } });
  const creatures = creaturesStub([{ id: 'c1', x: 30, y: -24, width: 48, height: 48, hp: 10 }]); // center 54,0
  const out = sim.step(0.1, { creatures, players: [], map: WALK_ALL }); // moves to x=90 → passes center 54
  assert.deepEqual(out.killedCreatureIds, ['c1']);
  assert.equal(sim.count(), 0);
});

test('step hits a player (not the owner), reduces hp', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 20 } });
  const target = { userId: 'u2', x: 62, y: -32, width: 64, height: 64, hp: 100 }; // center 94,0
  const owner = { userId: 'u1', x: -100, y: -32, width: 64, height: 64, hp: 100 };
  sim.step(0.12, { creatures: creaturesStub([]), players: [owner, target], map: WALK_ALL }); // x→108 passes 94
  assert.equal(target.hp, 80);
  assert.equal(owner.hp, 100); // owner never hit
  assert.equal(sim.count(), 0); // pierce:1 → despawned after the single player hit
});

test('a non-finite-velocity projectile is culled, not leaked', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: NaN, ny: 0, weapon: BOW });
  sim.step(0.05, { creatures: creaturesStub([]), players: [], map: WALK_ALL });
  assert.equal(sim.count(), 0);
});

test('pierce: a pierce-2 projectile hits two creatures before despawning', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 100, pierce: 2, range: 1000, projectile_speed: 2000 } });
  const creatures = creaturesStub([
    { id: 'c1', x: 20, y: -24, width: 48, height: 48, hp: 10 },  // center 44,0
    { id: 'c2', x: 60, y: -24, width: 48, height: 48, hp: 10 },  // center 84,0
  ]);
  const out = sim.step(0.05, { creatures, players: [], map: WALK_ALL }); // x→100, passes both
  assert.deepEqual(out.killedCreatureIds.sort(), ['c1', 'c2']);
});

test('a projectile never hits the same target twice', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 1, pierce: 5, range: 1000, projectile_speed: 200 } });
  const target = { userId: 'u2', x: 20, y: -32, width: 64, height: 64, hp: 100 }; // center 52,0
  // 10 steps at 4px/step keep the projectile inside the target's capture window
  // (x from 4..40, window x>=12) for many consecutive hit-checks; hitIds must
  // ensure exactly ONE hit → hp drops by 1 and the projectile survives (pierce 5).
  for (let i = 0; i < 10; i++) sim.step(0.02, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.equal(target.hp, 99);   // exactly one hit despite many in-range checks
  assert.equal(sim.count(), 1);  // still alive (pierce not consumed past 1)
});
