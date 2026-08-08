// SOMET-253 Task 6: wiring tests for combat knockback -- these exercise the
// actual call sites (creatures.js's two melee branches, and all four
// projectiles.js collision sites), not the knockback.js primitive itself
// (see authority_knockback.test.js for that). The brief flags the projectile
// threading as the likeliest place to miss a site, so each of the four gets
// its own test here rather than trusting a single hand check.
//
// Geometry technique used throughout: when the knockback origin and the
// target's centre share the same y (every scenario below is built that
// way), the push is pure +x and map.isWalkable is unconditionally true, so
// knockbackWithFallback always lands the FULL requested distance on the
// first try. That makes "post-hit centre x == pre-hit centre x + distance"
// an exact equality, not an approximation -- no need to hand-trace the
// projectile's sub-step arithmetic to know where impact happens.
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');
const { ProjectileSim } = require('../src/authority/projectiles.js');

const WALK_ALL = { isWalkable: () => true };

// =============================================================================
// Part A: creatures.js -- both melee attack branches
// =============================================================================

const openMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });
const noRedirect = () => 0.5;

function meleeBehavior({ chaseStyle = 'hold', knockback = 50, damageOverride = null } = {}) {
  return {
    name: 'M', aggroRadius: 400, leashRadius: 800, chaseStyle,
    preferredRange: 0, moveSpeedMult: 1, damageOverride,
    abilities: [{
      slot: 1, name: 'Bite', attackKind: 'melee', attackRange: 60, attackCooldown: 1,
      projectileSpeed: 0, projectileRadius: 0, element: null, damageMult: 1, knockback,
    }],
  };
}

test('a hostile creature knocks a surviving player away from its own centre', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  // Creature centre (124,124); player centre (164,124), 40px east -- within
  // the 60px attack range.
  s.addCreatures([{ id: 'c', type: 'T', x: 100, y: 100, hp: 100, behavior: meleeBehavior({ knockback: 50 }) }]);
  const player = { userId: 'u1', x: 132, y: 92, width: 64, height: 64, hp: 100, maxHp: 100 };
  s.tick(0.1, new Set(['0,0']), [player], 0);
  // Pure +x push (both centres share y=124): post centre x = pre centre x + 50.
  assert.strictEqual(player.x, 132 + 50, `expected the player shoved 50px east, got x=${player.x}`);
  assert.strictEqual(player.y, 92, 'y must be unchanged -- the push is purely along x here');
  assert.ok(player.hp < 100, 'sanity: the hit must actually have landed');
});

test('a hostile creature does NOT knock back a player it kills this swing', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([{
    id: 'c', type: 'T', x: 100, y: 100, hp: 100, damage: 500,
    behavior: meleeBehavior({ knockback: 50 }),
  }]);
  const player = { userId: 'u1', x: 132, y: 92, width: 64, height: 64, hp: 1, maxHp: 100 };
  s.tick(0.1, new Set(['0,0']), [player], 0);
  assert.ok(player.hp <= 0, 'sanity: the hit must have killed the player');
  assert.strictEqual(player.x, 132, 'a killed target must not be displaced');
  assert.strictEqual(player.y, 92, 'a killed target must not be displaced');
});

test('ability.knockback = 0 leaves the hit player exactly where it stood (matches the golden trace fixtures)', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([{ id: 'c', type: 'T', x: 100, y: 100, hp: 100, behavior: meleeBehavior({ knockback: 0 }) }]);
  const player = { userId: 'u1', x: 132, y: 92, width: 64, height: 64, hp: 100, maxHp: 100 };
  s.tick(0.1, new Set(['0,0']), [player], 0);
  assert.ok(player.hp < 100, 'sanity: the hit must actually have landed');
  assert.strictEqual(player.x, 132);
  assert.strictEqual(player.y, 92);
});

test('a guard knocks a surviving hostile creature target away from its own centre', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([
    {
      id: 'g', type: 'Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100,
      behavior: meleeBehavior({ chaseStyle: 'guard', knockback: 30, damageOverride: 5 }),
    },
    // Centre (164,124), 40px east of the guard's centre (124,124) -- within
    // the guard's 60px attack range, and hp survives a 5-damage strike.
    // chaseStyle 'hold' with no target-able players in this tick keeps 'h'
    // from ALSO roaming under its own turn in the same tick() call (creature
    // iteration order is insertion order, so 'h' is visited right after the
    // guard hits it) -- without this the position assertion below would be
    // fighting the target's own independent roam step, not just the shove.
    { id: 'h', type: 'Slime', x: 140, y: 100, hp: 100, behavior: { chaseStyle: 'hold' } },
  ]);
  s.tick(0.5, new Set(['0,0']), [], 1000);
  const h = s.creatures.get('h');
  assert.ok(h, 'target must have survived');
  assert.ok(h.hp < 100, 'sanity: the guard must have actually hit it');
  // Guard's own chase step may have moved it, but the target's push is keyed
  // off the guard's PRE-move centre (124,124) -- see the "cc is the pre-move
  // centre" comments in creatures.js next to both attack branches.
  assert.strictEqual(h.x, 140 + 30, `expected the target shoved 30px east, got x=${h.x}`);
  assert.strictEqual(h.y, 100, 'y must be unchanged -- the push is purely along x here');
  assert.strictEqual(h.dirty, true, 'a knocked-back creature target must be marked dirty');
});

test('a guard does NOT knock back a creature target it kills this swing', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([
    {
      id: 'g', type: 'Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100,
      behavior: meleeBehavior({ chaseStyle: 'guard', knockback: 30, damageOverride: 500 }),
    },
    { id: 'h', type: 'Slime', x: 140, y: 100, hp: 1, behavior: { chaseStyle: 'hold' } },
  ]);
  const { killed } = s.tick(0.5, new Set(['0,0']), [], 1000);
  assert.deepStrictEqual(killed, ['h']);
  assert.strictEqual(s.creatures.has('h'), false, 'the dead target must leave the sim, not sit there knocked back');
});

// =============================================================================
// Part B: projectiles.js -- all FOUR collision sites (two discrete AoE
// detonation sites in _detonate, two swept direct-hit sites in step()).
// =============================================================================

const BOW = { damage: 5, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, element: null };
// Detonates at a known, fixed blast point: range 40 with projectile_speed 100
// runs out of range exactly at x=48 (MAX_SUB=16 sub-steps: 16, 32, 48) --
// pinned by the existing "AoE: the detonation carries the blast point"
// test in authority_projectiles.test.js.
const STAFF = { damage: 5, range: 40, projectile_speed: 100, projectile_radius: 4, pierce: 1, aoe_radius: 100, element: null };

function mkPlayer(userId, cx, cy, hp = 100) {
  return { userId, x: cx - 32, y: cy - 32, width: 64, height: 64, hp, maxHp: 100 };
}
function mkCreature(id, cx, cy, hp = 100) {
  return { id, x: cx - 24, y: cy - 24, width: 48, height: 48, hp };
}
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

test('site 1/4 (discrete AoE, creature): a surviving creature is knocked back from the blast centre', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, knockback: 30 } });
  // Blast at (48,0). Creature centre (90,0), 42px east -- inside the 100px
  // radius, and hp survives a small falloff-scaled hit.
  const c = mkCreature('c1', 90, 0, 100);
  const out = sim.step(1, { creatures: creaturesStub([c]), players: [], map: WALK_ALL });
  assert.strictEqual(out.detonations.length, 1, 'sanity: the projectile must have detonated');
  assert.ok(c.hp < 100, 'sanity: the blast must have actually hit it');
  assert.strictEqual(c.x, 90 - 24 + 30, `expected the creature shoved 30px east of the blast, got x=${c.x}`);
  assert.strictEqual(c.y, -24, 'y must be unchanged -- the blast centre shares the creature\'s y here');
});

test('site 2/4 (discrete AoE, player): a surviving player is knocked back from the blast centre', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...STAFF, knockback: 25 } });
  const target = mkPlayer('u2', 90, 0, 100);
  const out = sim.step(1, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.strictEqual(out.detonations.length, 1, 'sanity: the projectile must have detonated');
  assert.ok(target.hp < 100, 'sanity: the blast must have actually hit it');
  assert.strictEqual(target.x, 90 - 32 + 25, `expected the player shoved 25px east of the blast, got x=${target.x}`);
  assert.strictEqual(target.y, -32, 'y must be unchanged -- the blast centre shares the player\'s y here');
});

test('site 3/4 (swept direct hit, creature): a surviving creature is knocked back from the impact point', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 5, knockback: 40 } });
  // Same geometry as authority_projectiles.test.js's "step hits a creature in
  // range" test: centre (54,0), hit registers with dt=0.1.
  const c = mkCreature('c1', 54, 0, 50);
  sim.step(0.1, { creatures: creaturesStub([c]), players: [], map: WALK_ALL });
  assert.ok(c.hp < 50, 'sanity: the projectile must have actually hit it');
  assert.strictEqual(c.x, 54 - 24 + 40, `expected the creature shoved 40px east of the impact, got x=${c.x}`);
  assert.strictEqual(c.y, -24, 'y must be unchanged -- travel is due east (ny=0)');
});

test('site 4/4 (swept direct hit, player): a surviving player is knocked back from the impact point', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 20, knockback: 40 } });
  // Same geometry as authority_projectiles.test.js's "step hits a player"
  // test: centre (94,0), hit registers with dt=0.12.
  const target = mkPlayer('u2', 94, 0, 100);
  sim.step(0.12, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.strictEqual(target.hp, 80, 'sanity: the projectile must have actually hit it');
  assert.strictEqual(target.x, 94 - 32 + 40, `expected the player shoved 40px east of the impact, got x=${target.x}`);
  assert.strictEqual(target.y, -32, 'y must be unchanged -- travel is due east (ny=0)');
});

test('a projectile kill (any site) is never followed by a knockback -- there is nothing left to shove', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 100, knockback: 40 } });
  const c = mkCreature('c1', 54, 0, 10); // dies to a 100-damage hit
  const out = sim.step(0.1, { creatures: creaturesStub([c]), players: [], map: WALK_ALL });
  assert.deepStrictEqual(out.kills, [{ id: 'c1', killerUserId: 'u1' }]);
  // Nothing to assert about position: the creature is gone. The load-bearing
  // fact is that this does not throw (shoveTarget must never run against a
  // deleted creature) and the kill is still reported correctly.
});

test('spawn defaults knockback to 0 for a weapon-shaped object with no such field (every player weapon today)', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: BOW });
  const p = sim.projectiles[0];
  assert.strictEqual(p.knockback, 0);
});
