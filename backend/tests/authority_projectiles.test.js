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

test('a projectile hitting an armored player goes through the shared mitigation path', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 20 } });
  const target = { userId: 'u2', x: 62, y: -32, width: 64, height: 64, hp: 100,
    mit: { defense: 5, resistances: {} } };
  sim.step(0.12, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.equal(target.hp, 85, '20 raw - 5 defense = 15');
});

test('a projectile element is resisted by the target', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 20, element: 'arcane' } });
  const target = { userId: 'u2', x: 62, y: -32, width: 64, height: 64, hp: 100,
    mit: { defense: 0, resistances: { arcane: 0.5 } } };
  sim.step(0.12, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.equal(target.hp, 90, '20 raw * (1 - 0.5) = 10');
});

test('a player with no mit field takes unmitigated damage (no crash)', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 20 } });
  const target = { userId: 'u2', x: 62, y: -32, width: 64, height: 64, hp: 100 };
  sim.step(0.12, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.equal(target.hp, 80);
});

// --- AoE detonation (slice 3b-3b, task 6) -----------------------------------
// Geometry note for the tests below: the projectile spawns at (0,0) heading +x
// at 100 px/s with dt=1, so it advances in MAX_SUB(16) px sub-steps. It
// detonates at the FIRST sub-step position where it contacts something, NOT at
// the target's centre — so the blast point is what the assertions are built on.

const STAFF = { damage: 20, range: 200, projectile_speed: 100, projectile_radius: 4, pierce: 1, aoe_radius: 100, element: null };

// A player whose CENTRE is at (cx, cy) — the sim damages by centre distance.
function mkPlayer(userId, cx, cy, extra = {}) {
  return { userId, x: cx - 32, y: cy - 32, width: 64, height: 64, hp: 100, maxHp: 100, ...extra };
}
// A creature whose CENTRE is at (cx, cy).
function mkCreature(id, cx, cy, hp = 100) {
  return { id, x: cx - 24, y: cy - 24, width: 48, height: 48, hp };
}

test('AoE: a blast damages a target in radius with clear terrain', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: STAFF });
  const target = mkPlayer('u2', 60, 0);
  sim.step(1, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.ok(target.hp < target.maxHp, 'target in radius took no damage');
});

// The pair IS the test. Either half alone proves nothing: a "blast damages
// target" test passes even with no LOS check at all.
test('AoE: a blast does NOT damage the same target through a wall', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: STAFF });
  const target = mkPlayer('u2', 60, 0);
  // Wall spanning x in [30,55]: the projectile detonates on it at x=32, and the
  // target at x=60 sits on the far side.
  const blocked = { isWalkable: (x) => x < 30 || x > 55 };
  sim.step(1, { creatures: creaturesStub([]), players: [target], map: blocked });
  assert.equal(target.hp, target.maxHp, 'blast damaged a target through a wall');
});

test('AoE: a creature behind a wall is not damaged by the blast', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: STAFF });
  const c = mkCreature('c1', 60, 0);
  const creatures = creaturesStub([c]);
  const blocked = { isWalkable: (x) => x < 30 || x > 55 };
  const out = sim.step(1, { creatures, players: [], map: blocked });
  assert.equal(c.hp, 100, 'blast damaged a creature through a wall');
  assert.deepEqual(out.killedCreatureIds, []);
});

test('AoE: a creature in radius with clear terrain is damaged by the blast', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, damage: 500 } });
  const c = mkCreature('c1', 60, 0);
  const out = sim.step(1, { creatures: creaturesStub([c]), players: [], map: WALK_ALL });
  assert.deepEqual(out.killedCreatureIds, ['c1']);
});

test('AoE: blast damage falls off with distance', () => {
  const near = mkPlayer('near', 30, 0);
  const far = mkPlayer('far', 90, 0);
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, damage: 40 } });
  sim.step(1, { creatures: creaturesStub([]), players: [near, far], map: WALK_ALL });
  assert.ok(near.maxHp - near.hp > far.maxHp - far.hp,
    'a nearer target must take strictly more than a further one');
});

test('AoE: a target beyond the radius takes nothing', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, aoe_radius: 40 } });
  const inside = mkPlayer('u2', 50, 0);   // blast at x=32 → d=18 < 40
  const outside = mkPlayer('u3', 32, 300); // d=300 > 40
  sim.step(1, { creatures: creaturesStub([]), players: [inside, outside], map: WALK_ALL });
  assert.ok(inside.hp < inside.maxHp);
  assert.equal(outside.hp, outside.maxHp);
});

test('AoE: the caster takes no damage from their own blast', () => {
  const owner = mkPlayer('u1', 10, 0);
  const sim = new ProjectileSim();
  // range 40 → the projectile runs out of range at x=48 and detonates there;
  // the owner at x=10 is 38 px away, well inside the 100 px radius.
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, damage: 40, range: 40 } });
  const r = sim.step(1, { creatures: creaturesStub([]), players: [owner], map: WALK_ALL });
  assert.equal(r.detonations.length, 1, 'the projectile must actually have detonated near the caster');
  assert.equal(owner.hp, owner.maxHp);
});

test('AoE: a projectile that runs out of range still detonates', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, range: 40 } });
  const r = sim.step(1, { creatures: creaturesStub([]), players: [], map: WALK_ALL });
  assert.equal(r.detonations.length, 1);
  assert.equal(sim.count(), 0);
});

test('AoE: a projectile that hits terrain detonates once', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: STAFF });
  const r = sim.step(1, { creatures: creaturesStub([]), players: [], map: { isWalkable: (x) => x < 30 } });
  assert.equal(r.detonations.length, 1);
  assert.equal(sim.count(), 0);
});

test('AoE: an AoE projectile does not survive its detonation', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, range: 500, damage: 10, aoe_radius: 60 } });
  const r = sim.step(1, { creatures: creaturesStub([]), players: [mkPlayer('u2', 50, 0)], map: WALK_ALL });
  assert.equal(sim.count(), 0);
  assert.equal(r.detonations.length, 1);
});

test('AoE: detonating on a player replaces the single-target hit, not adds to it', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, damage: 100, aoe_radius: 100 } });
  const target = mkPlayer('u2', 32, 0);
  sim.step(1, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  // First contact is at x=16 (capture radius 4+32=36 reaches the centre at 32),
  // so the blast point is 16 px away: 100 * (1 - 16/100) = 84, no mitigation.
  // If the direct hit were ALSO applied the target would be at -84, not 16.
  assert.equal(target.hp, 16, 'the target must take the blast OR the direct hit, not both');
});

test('AoE: the detonation carries the blast point, radius and element', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, range: 40, element: 'fire' } });
  const r = sim.step(1, { creatures: creaturesStub([]), players: [], map: WALK_ALL });
  assert.deepEqual(r.detonations, [{ x: 48, y: 0, radius: 100, element: 'fire' }]);
});

test('AoE: the blast goes through the shared mitigation path', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, damage: 100, aoe_radius: 100 } });
  const target = mkPlayer('u2', 32, 0, { mit: { defense: 10, resistances: {} } });
  sim.step(1, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  // Blast at x=16, d=16 → 100 * 0.84 = 84 raw, then -10 defense = 74 dealt.
  assert.equal(target.hp, 26, 'falloff scales the RAW damage, defense applies after');
});

test('AoE: a projectile with no aoe_radius reports no detonations', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, range: 500, damage: 10, aoe_radius: null } });
  const r = sim.step(1, { creatures: creaturesStub([]), players: [mkPlayer('u2', 50, 0)], map: WALK_ALL });
  assert.equal(r.detonations.length, 0);
});

test('AoE: aoe_radius of 0 behaves as a plain point-collision projectile', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, damage: 10, aoe_radius: 0 } });
  const target = mkPlayer('u2', 50, 0);
  const r = sim.step(1, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.equal(r.detonations.length, 0);
  assert.equal(target.hp, 90, 'a zero radius must fall back to the single-target hit, not divide by zero');
});
