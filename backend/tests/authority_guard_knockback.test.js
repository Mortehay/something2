// SOMET-283 — a village guard must not be displaceable off its post by
// knockback.
//
// The bug these tests pin was found in live data: both of Vale Crossing's
// guards were persisted 1685px and 3755px from their 300px posts. The guard's
// own return step was measured and cleared (it is monotone — see SOMET-154 and
// guardWallReturn.test.js), so the displacement came from a shove, and the
// shove sites had neither a faction filter nor a leash clamp.
//
// What makes it a free conveyor rather than a fair mechanic:
//   * every melee weapon in the catalog carries knockback 30;
//   * a guard never targets a player (selectGuardTarget takes hostiles only),
//     so it never fights back;
//   * a Village Guard's defense is 10, above the damage of every starter
//     weapon, so applyDamage's MIN_DAMAGE floor caps a knife at 1 damage per
//     swing — 300 free swings against a 300hp guard, 30px each.
// That is a ~9000px displacement budget against a 300px leash.
//
// Test 1 reproduces exactly that: a chasing player with a knife, driven
// through the REAL World.attack path, not through the primitive.
//
// SOMET-285 UPDATE: the player-melee entry point into this shove is now closed
// upstream — meleeArcTargets skips guards, so a player's swing neither damages
// nor displaces one, and test 1 asserts that directly. The clamp itself is
// NOT dead code and is still pinned here by the tests that drive
// shoveCreature directly and by the creature-owned-projectile test at the
// bottom, which is the one live shove source that can still reach a guard.
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { ProjectileSim } = require('../src/authority/projectiles.js');
const {
  CreatureSim, CREATURE_SIZE, GUARD_LEASH_RADIUS, shoveCreature,
} = require('../src/authority/creatures.js');

// chunkSize 128 tiles => chunk (0,0) covers x/y in [0, 12800). Wide enough
// that an UNCLAMPED guard punted thousands of px still stays inside the one
// active chunk and keeps being ticked — otherwise the pre-fix run would stop
// simulating the guard's walk home partway through and the red failure would
// be measuring the wrong thing.
const openMap = () => ({
  chunkSize: 128, isWalkable: () => true, speedAt: () => 1, getChunk: () => [],
});
const KEYS = new Set(['0,0']);
const noRedirect = () => 0.5;

// A knife, verbatim from the live item_types row (SELECT name, kind, damage,
// cooldown, reach, knockback FROM item_types WHERE name='knife'): the cheapest
// weapon in the game and therefore the worst case — the shortest cooldown and
// the lowest damage, i.e. the most shoves per second and the most swings before
// the guard dies.
const KNIFE = {
  id: 1, name: 'knife', category: 'weapon', kind: 'melee',
  damage: 6, cooldown: 0.25, reach: 70, arc_width: 0.6,
  mana_cost: 0, stamina_cost: 0, element: null, knockback: 30,
};
const TYPES = new Map([[1, KNIFE]]);

// Vale Crossing's northern gate post — the exact home_x/home_y of the row that
// was persisted 3755px away.
const HOME = { x: 3250, y: 2950 };

function guardRow(over = {}) {
  return {
    id: 'g', type: 'Village Guard',
    x: HOME.x - CREATURE_SIZE / 2, y: HOME.y - CREATURE_SIZE / 2,
    hp: 300, defense: 10, faction: 'guard',
    home_x: HOME.x, home_y: HOME.y,
    ...over,
  };
}

function centreOf(c) { return { x: c.x + c.width / 2, y: c.y + c.height / 2 }; }
function distHome(c, home = HOME) {
  const p = centreOf(c);
  return Math.hypot(p.x - home.x, p.y - home.y);
}

// One "swing" of the live exploit: stand the player 40px west of the target's
// current centre (inside the knife's 70px reach), swing due east, then let the
// world tick — which decays the attack cooldown AND runs the creature sim, so
// the guard gets its walk-home step back between every swing. Repositioning the
// player each round is what a chasing attacker does with their movement keys;
// nothing here bypasses a cooldown or writes a creature position directly.
function chaseAndSwing(w, targetId, rounds, dt = 0.3) {
  for (let i = 0; i < rounds; i++) {
    const c = w.creatures.creatures.get(targetId);
    if (!c) return i;
    const cc = centreOf(c);
    const p = w.getPlayer('u1');
    p.x = cc.x - 40 - p.width / 2;
    p.y = cc.y - p.height / 2;
    w.attack('u1', 1, 0);
    w.tick(dt);
    w.tickCreatures(dt, KEYS);
  }
  return rounds;
}

function armedWorld(rows) {
  const w = new World(openMap(), TYPES, 1);
  w.addPlayer('u1', { x: 0, y: 0 }, { items: [{ id: 'k1', typeId: 1 }], equipment: { main_hand: 'k1' } });
  w.creatures.addCreatures(rows);
  return w;
}

test('a chasing player cannot punt a village guard off its post (SOMET-283)', () => {
  const w = armedWorld([guardRow()]);
  const ROUNDS = 200;
  chaseAndSwing(w, 'g', ROUNDS);

  const g = w.creatures.creatures.get('g');
  assert.ok(g, 'the guard must have survived — this test is about displacement, not death');
  // SOMET-285 changed what "landing" means here. Before it, each of these 200
  // swings dealt MIN_DAMAGE (knife damage 6 < defense 10) and delivered a 30px
  // shove that the SOMET-283 clamp then had to refuse; the assertion at this
  // point was `g.hp < 300` ("the swings must actually have been landing").
  // Now a player's swing does not reach a guard AT ALL: meleeArcTargets
  // excludes it, so there is no damage, no rider and no impulse to clamp. The
  // hp assertion is inverted rather than dropped, because it is still the
  // sanity check that the loop below is exercising a real swing path -- see
  // guard_player_immunity.test.js, which pins that the identical loop DOES
  // damage a hostile.
  assert.equal(g.hp, 300, 'a player\'s swings must not damage a guard at all (SOMET-285)');

  const d = distHome(g);
  assert.ok(
    d <= GUARD_LEASH_RADIUS,
    `a guard must never end up outside its ${GUARD_LEASH_RADIUS}px leash: `
    + `${ROUNDS} knife swings left it ${d.toFixed(1)}px from its post `
    + `at (${g.x.toFixed(1)}, ${g.y.toFixed(1)})`,
  );
});

test('the same swing still shoves an ordinary hostile the full distance (SOMET-253 unchanged)', () => {
  // Same world, same weapon, same chase loop — the ONLY difference is that the
  // target is a plain hostile with no post. If the clamp leaked into the
  // general case this hostile would stop being shoved, and knockback would be
  // silently dead for every creature in the game.
  const w = armedWorld([{ id: 'h', type: 'Slime', x: 1000 - CREATURE_SIZE / 2, y: 1000 - CREATURE_SIZE / 2, hp: 100000, behavior: { chaseStyle: 'hold' } }]);
  const start = centreOf(w.creatures.creatures.get('h')).x;
  chaseAndSwing(w, 'h', 50);
  const h = w.creatures.creatures.get('h');
  const travelled = centreOf(h).x - start;
  assert.ok(
    travelled > 50 * 30 * 0.9,
    `a hostile must still be knocked back ~30px per swing: 50 swings moved it only ${travelled.toFixed(1)}px`,
  );
});

test('one swing shoves a hostile EXACTLY the weapon knockback (the clamp is inert off a post)', () => {
  // The exact-equality form of the test above, so "still shoved" cannot be
  // satisfied by some other force nudging the target. Attacker centre and
  // target centre share y, and the map is open, so knockbackWithFallback lands
  // the full 30px on its first rung — an exact number, not an approximation.
  const w = armedWorld([{ id: 'h', type: 'Slime', x: 1000 - CREATURE_SIZE / 2, y: 1000 - CREATURE_SIZE / 2, hp: 1000, behavior: { chaseStyle: 'hold' } }]);
  const p = w.getPlayer('u1');
  p.x = 1000 - 40 - p.width / 2;
  p.y = 1000 - p.height / 2;
  w.attack('u1', 1, 0);
  const h = w.creatures.creatures.get('h');
  assert.strictEqual(h.x, 1000 - CREATURE_SIZE / 2 + 30, `expected a full 30px shove, got x=${h.x}`);
  assert.strictEqual(h.y, 1000 - CREATURE_SIZE / 2, 'y must be unchanged — the push is purely along x here');
});

test('repeated maximum knockback leaves a guard inside its leash (shoveCreature directly)', () => {
  // The primitive-level form: 500 shoves, always from the post side, so every
  // one of them points straight out. No cooldown, no walk home, no damage —
  // pure displacement. 500 x 30px = 15000px of shove offered.
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([guardRow()]);
  const g = s.creatures.get('g');
  for (let i = 0; i < 500; i++) {
    const c = centreOf(g);
    // Origin one pixel inside the guard on the home side => the shove is
    // directly away from home every single time.
    shoveCreature(openMap(), c.x - 1, c.y, g, 30);
  }
  const d = distHome(g);
  assert.ok(d <= GUARD_LEASH_RADIUS, `500 shoves left the guard ${d.toFixed(1)}px from its post`);
});

test('a guard already outside its leash cannot be pushed further from its post', () => {
  // The live rows were already stranded when this fix landed. A hard
  // "inside the leash" test would refuse to move them at all; the rule is
  // monotone instead, so what must hold is that they never get WORSE.
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([guardRow({ x: HOME.x + 3755 - CREATURE_SIZE / 2, y: HOME.y - CREATURE_SIZE / 2 })]);
  const g = s.creatures.get('g');
  const before = distHome(g);
  const c = centreOf(g);
  shoveCreature(openMap(), c.x - 1, c.y, g, 30); // push further out
  assert.strictEqual(distHome(g), before, `a stranded guard must not be pushed further out (${before} -> ${distHome(g)})`);
});

test('a guard already outside its leash can still be shoved TOWARD its post', () => {
  // The monotone rule must not freeze a stranded guard solid: a shove that
  // reduces its distance to the post is legal, since it cannot be an exploit.
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([guardRow({ x: HOME.x + 3755 - CREATURE_SIZE / 2, y: HOME.y - CREATURE_SIZE / 2 })]);
  const g = s.creatures.get('g');
  const before = distHome(g);
  const c = centreOf(g);
  shoveCreature(openMap(), c.x + 1, c.y, g, 30); // attacker on the far side => push homeward
  assert.strictEqual(distHome(g), before - 30, `expected a 30px homeward shove, ${before} -> ${distHome(g)}`);
});

test('a guard-style creature with no home anchor stays unconstrained', () => {
  // withinLeash's own rule ("a guard with no home anchor is unconstrained")
  // must hold here too — a pre-anchor-column row must not be silently frozen
  // in place by the clamp.
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([guardRow({ home_x: null, home_y: null })]);
  const g = s.creatures.get('g');
  const startX = g.x;
  shoveCreature(openMap(), centreOf(g).x - 1, centreOf(g).y, g, 30);
  assert.strictEqual(g.x, startX + 30, 'an unanchored guard must be shoved normally');
});

test('a creature-owned projectile cannot punt a guard off its post', () => {
  // projectiles.js's swept direct-hit site. No player weapon carries
  // projectile knockback today, but `shots[].knockback` does (Brute/Apex carry
  // 140/120) and projectileHitsCreature lets a hostile-owned shot hit a
  // guard-faction creature.
  const sim = new ProjectileSim();
  const s = new CreatureSim(openMap(), noRedirect);
  // Guard sitting 290px east of its post — inside the 300px leash, so it is a
  // legal position, but only 10px of headroom before the leash edge.
  s.addCreatures([guardRow({ x: HOME.x + 290 - CREATURE_SIZE / 2, y: HOME.y - CREATURE_SIZE / 2 })]);
  const g = s.creatures.get('g');
  const before = distHome(g);
  const creatures = {
    all: () => [g],
    damageCreatureById(id, dmg) { g.hp -= dmg; return g.hp <= 0; },
  };
  // Fired from the post side, due east, so its shove points straight out.
  sim.spawn({
    ownerKind: 'creature', ownerId: 'brute', ownerFaction: 'hostile',
    x: HOME.x + 200, y: HOME.y, nx: 1, ny: 0,
    weapon: {
      damage: 5, range: 700, projectile_speed: 900, projectile_radius: 8,
      pierce: 1, element: null, knockback: 140,
    },
  });
  sim.step(0.2, { creatures, players: [], map: openMap() });
  assert.ok(g.hp < 300, 'sanity: the shot must actually have hit the guard');
  assert.ok(
    distHome(g) <= GUARD_LEASH_RADIUS,
    `a 140px shot knockback must not push a guard past its leash (${before} -> ${distHome(g)})`,
  );
});
