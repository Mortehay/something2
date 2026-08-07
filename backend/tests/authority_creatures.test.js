const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');

// Stub map: everything walkable at speed 1, chunkSize 8 (chunk span = 800 px).
function stubMap(blockAll = false) {
  return { isWalkable: () => !blockAll, speedAt: () => 1, chunkSize: 8 };
}
// Deterministic rng: never redirect (>=0.02), fixed dir index 0 (east).
const noRedirect = () => 0.05; // seeds initial _dir = floor(0.05*8) = 0 (east); 0.05 >= 0.02 so no redirect fires

test('addCreatures dedups by id', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10, facing: 'S', color: '#c0392b' }]);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 999, y: 999, hp: 10 }]);
  assert.equal(s.count(), 1);
  assert.equal(s.all()[0].x, 100); // second (same id) ignored
});

test('tick roams a creature whose chunk is active', () => {
  const s = new CreatureSim(stubMap(), noRedirect); // dir 0 = east
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  s.tick(0.1, new Set(['0,0'])); // (100,100)→chunk(0,0) active
  const c = s.all()[0];
  assert.ok(c.x > 100, 'moved east');
  assert.equal(c.facing, 'E');
  assert.deepEqual(s.getDirty().map((d) => d.id), ['a']);
});

test('tick freezes a creature whose chunk is NOT active', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  s.tick(0.1, new Set(['5,5'])); // (100,100)→chunk(0,0) NOT active
  assert.equal(s.all()[0].x, 100);
  assert.equal(s.getDirty().length, 0);
});

test('blocked creature turns instead of moving', () => {
  const s = new CreatureSim(stubMap(true), noRedirect); // block everything
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  s.tick(0.1, new Set(['0,0']));
  assert.equal(s.all()[0].x, 100); // didn't move
});

test('pruneInactive drops non-dirty out-of-active creatures, keeps dirty', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([
    { id: 'clean', type: 'Wolf', x: 100, y: 100, hp: 10 },
    { id: 'dirty', type: 'Wolf', x: 120, y: 120, hp: 10 },
  ]);
  s.tick(0.1, new Set(['0,0'])); // both in chunk(0,0), both become dirty
  s.clearDirty(['clean']);       // only 'clean' confirmed persisted
  const dropped = s.pruneInactive(new Set(['9,9'])); // chunk(0,0) now inactive
  assert.equal(dropped, 1);
  assert.ok(!s.has('clean'));    // clean + inactive → dropped
  assert.ok(s.has('dirty'));     // dirty → kept
});

// --- Task 6: tick() reads the resolved behaviour, not the module constants ---

test('tick returns { killed, shots }', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  const out = s.tick(0.1, new Set(['0,0']));
  assert.ok(out && typeof out === 'object' && !Array.isArray(out),
    'tick must return an object, not a bare array');
  assert.ok(Array.isArray(out.killed));
  assert.ok(Array.isArray(out.shots));
});

test('a creature carries a resolved behaviour even with none supplied', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  const c = s.all()[0];
  assert.equal(c.behavior.chaseStyle, 'charge');
  assert.equal(c.behavior.aggroRadius, 400);
  assert.equal(c.attackElement, 'physical');
});

test('a supplied behaviour overrides the module constants', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{
    id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10,
    behavior: { name: 'Tight', attackKind: 'melee', attackRange: 60, attackCooldown: 1,
      projectileSpeed: 0, projectileRadius: 0, aggroRadius: 10, leashRadius: 20,
      chaseStyle: 'charge', preferredRange: 0, moveSpeedMult: 1, damageOverride: null },
  }]);
  // A player 200px away is far outside the 10px aggro radius, so the creature
  // must stay in roam. With the old hardcoded 400 it would chase.
  const player = { userId: 'u1', x: 300, y: 100, width: 48, height: 48, hp: 100 };
  s.tick(0.1, new Set(['0,0']), [player], 0);
  assert.equal(s.all()[0].mode, 'roam');
});

// --- SOMET-249 fix round 1: prove the catalog reaches a REAL spawn, not just
// a hand-built `.behavior` object. server.js's per-chunk spawn loader hands
// addCreatures the raw joined row shape (behavior_name, chase_style,
// aggro_radius, ... as plain snake_case columns, exactly like a pg row),
// never a pre-resolved camelCase object. The previous test above passes
// `.behavior` directly and would keep passing even if resolveInstanceBehavior
// never looked at a raw row at all -- it does not exercise the loader's
// actual output shape. This one does, and fails against the pre-fix code:
// before resolveInstanceBehavior existed, addCreatures only ever checked
// `c.behavior`, so a raw row like this fell straight through to the Line
// fallback (aggroRadius 400) regardless of what the row said.
test('a creature spawned from a raw joined DB row (server.js\'s shape) ticks with its own profile, not the Line fallback', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{
    id: 'archer', type: 'Archer', x: 100, y: 100, hp: 20, faction: 'hostile',
    // Exactly the column names/aliases server.js's SELECT now produces --
    // snake_case, no `.behavior` object anywhere.
    behavior_name: 'Ranged', attack_kind: 'ranged', attack_range: 340,
    attack_cooldown: 1.8, projectile_speed: 520, projectile_radius: 6,
    aggro_radius: 460, leash_radius: 800, chase_style: 'kite',
    preferred_range: 240, move_speed_mult: 1, damage_override: null,
    attack_element: 'physical',
  }]);
  const c = s.all()[0];
  assert.equal(c.behavior.chaseStyle, 'kite', 'the raw row\'s profile must reach c.behavior');
  assert.equal(c.behavior.aggroRadius, 460);
  assert.equal(c.attackElement, 'physical');

  // The Ranged profile's 460px aggro radius reaches a player at 430px; the
  // Line fallback's 400px does not. If resolveInstanceBehavior silently
  // ignored the raw row and fell back to Line, this creature would stay
  // 'roam' instead of acquiring the player.
  const player = { userId: 'u1', x: 530, y: 100, width: 48, height: 48, hp: 100 };
  s.tick(0.1, new Set(['0,0']), [player], 0);
  assert.equal(s.all()[0].mode, 'chase',
    'a 430px player is inside the Ranged profile\'s 460px aggro radius (and outside Line\'s 400px) -- '
    + 'staying in roam here means the profile never reached the tick');
});

test('a guard-faction row with NO assigned profile (behavior_id NULL) still guards, not chases', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{
    id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 60, faction: 'guard',
    home_x: 100, home_y: 100,
    // Shaped like server.js's LEFT JOIN when behavior_id IS NULL: the
    // columns are present (a real query asked for them) but every value is
    // null, exactly what pg returns for an unmatched LEFT JOIN row.
    behavior_name: null, attack_kind: null, attack_range: null,
    attack_cooldown: null, aggro_radius: null, leash_radius: null,
    chase_style: null, damage_override: null,
  }]);
  const c = s.all()[0];
  assert.equal(c.behavior.chaseStyle, 'guard',
    'a NULL-profile guard-faction row must still fall back to guard behaviour, not Line\'s charge');
  assert.equal(c.behavior.leashRadius, 300);
  assert.equal(c.behavior.damageOverride, 25);
});

// --- SOMET-249 fix round 2 ---

// Every moveSpeedMult in the rest of the suite (and the golden trace) is 1,
// so movedWith's scaled branch (`resolveMove(map, { ...c, speed: c.speed *
// mult }, ...)`) was reachable in code but exercised by nothing -- and
// commit 2 of this task is precisely what lets a non-1 multiplier (8 of the
// 12 seeded profiles carry one, e.g. Swarm 1.2, Heavy 0.6) reach a live
// creature. Two things must hold: the scaling must actually apply (not just
// "the creature moved"), and c.speed itself must never be mutated, since a
// persisted multiplier would compound every tick -- the exact failure mode
// movedWith exists to prevent.
test('moveSpeedMult scales roam distance and never mutates c.speed', () => {
  const fullBehavior = (mult) => ({
    name: 'X', attackKind: 'melee', attackRange: 60, attackCooldown: 1,
    projectileSpeed: 0, projectileRadius: 0, aggroRadius: 400, leashRadius: 800,
    chaseStyle: 'charge', preferredRange: 0, moveSpeedMult: mult, damageOverride: null,
  });
  const s = new CreatureSim(stubMap(), noRedirect); // fixed dir 0 (east) for both
  s.addCreatures([
    { id: 'slow', type: 'Wolf', x: 100, y: 100, hp: 10, behavior: fullBehavior(1) },
    { id: 'fast', type: 'Wolf', x: 100, y: 100, hp: 10, behavior: fullBehavior(2) },
  ]);
  s.tick(0.1, new Set(['0,0']));
  const slow = s.all().find((c) => c.id === 'slow');
  const fast = s.all().find((c) => c.id === 'fast');
  const dSlow = Math.hypot(slow.x - 100, slow.y - 100);
  const dFast = Math.hypot(fast.x - 100, fast.y - 100);
  assert.ok(dSlow > 0, 'the mult:1 creature must actually move (a zero baseline makes the ratio meaningless)');
  assert.ok(Math.abs(dFast / dSlow - 2) < 1e-9,
    `moveSpeedMult:2 must travel ~2x as far as moveSpeedMult:1 in one tick -- got ratio ${dFast / dSlow}`);

  // Run it out further and confirm c.speed itself never changed: a mutation
  // would compound (each tick's scaled speed becoming the next tick's base),
  // producing runaway acceleration invisible to a single-tick check.
  for (let i = 0; i < 50; i++) s.tick(0.1, new Set(['0,0']));
  assert.equal(slow.speed, 40, 'c.speed must stay at the base CREATURE_SPEED, mult:1');
  assert.equal(fast.speed, 40, 'c.speed must stay at the base CREATURE_SPEED even under mult:2 -- '
    + 'movedWith must scale at the resolveMove call site, never by writing c.speed');
});

// services/creatureBehaviors.js's own header states the resolver's entire
// purpose: "CreatureSim never sees a partial or malformed behaviour."
// resolveInstanceBehavior must uphold that same guarantee for a
// hand-assembled `.behavior` object, not just for a DB-row-shaped one
// (resolveBehavior already normalizes those). A `.behavior` missing
// moveSpeedMult gives `c.speed * undefined` = NaN in movedWith -- with a real
// map (unlike this file's always-true stub), NaN coordinates read as
// unwalkable and the move is refused every tick, forever, with no error and
// no log. Missing attackRange makes the contact-range comparison always
// false, so the creature acquires a target but can never land a hit. Task 7
// and Task 9 both construct behaviour objects, so this was one task away
// from being live.
test('a behaviour missing moveSpeedMult and attackRange still moves and attacks (no silent freeze)', () => {
  const partial = { chaseStyle: 'charge', aggroRadius: 400, leashRadius: 800, attackCooldown: 1 };

  const roamer = new CreatureSim(stubMap(), noRedirect);
  roamer.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10, behavior: partial }]);
  roamer.tick(0.1, new Set(['0,0']));
  const c = roamer.all()[0];
  assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y),
    'a behaviour missing moveSpeedMult must not produce NaN coordinates (c.speed * undefined)');
  assert.ok(c.x !== 100 || c.y !== 100, 'a behaviour missing moveSpeedMult must not freeze roam movement');

  const attacker = new CreatureSim(stubMap(), noRedirect);
  attacker.addCreatures([{ id: 'b', type: 'Wolf', x: 100, y: 100, hp: 10, damage: 5, behavior: partial }]);
  const player = { userId: 'u1', x: 110, y: 100, width: 48, height: 48, hp: 100 };
  attacker.tick(0.05, new Set(['0,0']), [player], 0);
  assert.ok(player.hp < 100,
    'a behaviour missing attackRange must not silently disable the attack (NaN comparison is always false)');
});

test('snapshotForNeighborhood filters by current chunk and shape', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([
    { id: 'near', type: 'Wolf', x: 100, y: 100, hp: 10, facing: 'S', color: '#c0392b' },
    { id: 'far', type: 'Wolf', x: 5000, y: 5000, hp: 10 }, // chunk(6,6)
  ]);
  const snap = s.snapshotForNeighborhood(new Set(['0,0']));
  assert.equal(snap.length, 1);
  assert.equal(snap[0].id, 'near');
  assert.deepEqual(Object.keys(snap[0]).sort(), ['color', 'facing', 'hp', 'id', 'level', 'maxHp', 'mode', 'type', 'x', 'y']);
});

// --- Task 9: creature status effects reach the client ---

test('snapshotForNeighborhood carries a chilled creature\'s effect keys, gated on the passed clock', () => {
  const { applyElementEffect, CHILL } = require('../src/authority/effects.js');
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([
    { id: 'a', type: 'Slime', x: 100, y: 100, hp: 10, maxHp: 10 },
    { id: 'b', type: 'Wolf', x: 100, y: 100, hp: 10, maxHp: 10 },
  ]);
  const rowFor = (id, now) => s.snapshotForNeighborhood(['0,0'], now).find((r) => r.id === id);

  assert.equal(rowFor('a', 0).effects, undefined,
    'an unaffected creature must not carry an effects field at all');

  applyElementEffect(s.all().find((c) => c.id === 'a'), 'ice', 0, 'u1');
  assert.deepEqual(rowFor('a', 100).effects, [CHILL],
    'a chilled creature broadcast no chill — the client cannot tint what it is never told about');
  assert.equal(rowFor('b', 100).effects, undefined,
    'the unaffected creature was tinted too — the effect keys are not per-creature');

  // Gated on the clock the CALLER passes, not one this module reads: at a
  // `now` past the chill's expiry the field must be gone even though the map
  // entry has never been swept by a tick.
  assert.equal(rowFor('a', 999999).effects, undefined,
    'an expired chill is still broadcast — snapshotForNeighborhood ignored the clock it was given');
});
