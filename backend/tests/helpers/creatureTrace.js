// Produces a deterministic trace of the creature sim, used by
// creature_behavior_golden.test.js to prove P2a changed no behaviour.
const { CreatureSim } = require('../../src/authority/creatures.js');

// Everything walkable, chunkSize 8 (chunk span 800px) -- the same stub the
// rest of the creature suite uses.
function stubMap() {
  return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 };
}

// A constant rng (`() => 0.05`) was tried first and rejected: 0.05 is both
// >= REDIRECT_CHANCE (0.02, so a redirect check never fires) AND produces
// the same _dir (floor(0.05*8) = 0, east) that addCreatures already seeds
// from that same constant. A regression that made redirects fire, or that
// changed REDIRECT_CHANCE, or that flipped the comparison, would recompute
// the identical _dir and the trace would be bit-identical -- the redirect
// branch (creatures.js's `if (this.rng() < REDIRECT_CHANCE) { c._dir = ... }`)
// would be entirely invisible to this fixture. mulberry32 below is a tiny
// self-contained seeded PRNG (no new dependency) so the roam branch's
// redirect logic and its `floor(rng()*8)` re-pick are genuinely exercised:
// real, varied output, but still 100% reproducible from a hardcoded seed --
// same sequence every call, in-process or across processes, forever.
//
// Regenerating the fixture from a new rng is safe HERE, and only here:
// backend/src/authority/creatures.js has not been touched by any P2a task
// yet, so this still captures pre-P2a behaviour. From Task 6 onward the
// fixture is a gate on code that has already moved -- do not regenerate it
// after that point; a fixture that adjusts itself to match new behaviour
// stops being able to catch a regression.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Picked by search (see task-1-report.md, fix round 1) over the scenario
// below: it is the smallest seed found where (a) `roamer` -- the one
// creature meant to stay isolated and just roam -- actually redirects at
// least once (proving REDIRECT_CHANCE is live), while (b) `raider`'s own
// redirect checks never fire before the guard kills it (a raider redirect
// mid-pursuit throws the guard off long enough that it can't close to
// contact range and land the second hit before the trace ends -- most
// seeds fail this, which is itself evidence the redirect branch now has
// real teeth). Changing RNG_SEED, the addCreatures order below, or any
// position requires re-deriving this by search, not by guessing -- the rng
// draws are consumed in creature-insertion order, one per creature at
// spawn (for _dir) plus one per roaming creature per tick thereafter, so
// everything downstream of the first draw shifts.
const RNG_SEED = 0xef;
function makeRng() { return mulberry32(RNG_SEED); }

// Two hostiles and one guard, exercising roam (with a genuine mid-run
// redirect), chase, contact damage, and the guard's post/leash/return
// behaviour in one run.
//
// Positions AND insertion order were chosen (not copied from a naive
// layout) so every actor's role is actually exercised across the 120-tick
// window instead of being pre-empted by an adjacent one:
//  - raider is added FIRST so it draws the rng's first value (a fixed fact
//    of this seed) and spawns facing due east, directly toward the guard's
//    post below.
//  - roamer sits far from the player (>400px, aggro's radius) and far from
//    the guard's post (>400px) for the whole run, so it never acquires a
//    target and stays in pure 'roam' -- it is the creature that visibly
//    redirects (see facings in the Step 4 report).
//  - chaser starts within the player's 400px aggro radius but outside the
//    guard's engage radius (leash 300px / aggro 400px from the guard's
//    post), so it chases and damages the PLAYER without the guard ever
//    intercepting it.
//  - sentry (guard) starts exactly at its own post with no hostile in range:
//    it settles into 'guard' within a few ticks, since a guard's home
//    comparison is center-to-corner and only converges below the
//    stand-still epsilon after a short walk-in.
//  - raider starts ~350px from the guard's post (outside the 300px leash,
//    inside the 400px aggro) and closes in via its own roam movement,
//    pulling the guard from 'guard' into 'chase', where it is killed —
//    after which the guard heads back ('return') toward its post.
// An earlier layout (all four creatures clustered near one another) let the
// guard snipe the player-chasing hostile within its very first tick and
// never left 'chase' the whole run — see task-1-report.md for the discarded
// trace. That fixture would have passed Step 4's raw ticks/ids check while
// exercising none of 'roam' or 'guard', so it was rejected.
function buildScenario() {
  const sim = new CreatureSim(stubMap(), makeRng());
  sim.addCreatures([
    { id: 'raider', type: 'Bat', x: 1050, y: 1400, hp: 40, facing: 'S', color: '#8e44ad', damage: 5, level: 1 },
    { id: 'roamer', type: 'Wolf', x: 900, y: 1200, hp: 30, facing: 'S', color: '#c0392b', damage: 5, level: 1 },
    { id: 'chaser', type: 'Skeleton', x: 300, y: 300, hp: 30, facing: 'S', color: '#dddddd', damage: 5, level: 1 },
    { id: 'sentry', type: 'Village Guard', x: 1400, y: 1400, hp: 60, facing: 'S', color: '#3498db',
      faction: 'guard', home_x: 1400, home_y: 1400, damage: 5, level: 1 },
  ]);
  const player = {
    userId: 'u1', x: 380, y: 300, width: 48, height: 48, hp: 200, mit: null,
  };
  return { sim, players: [player] };
}

// One trace row per tick: every creature's position, facing, mode and hp, plus
// the player's hp so contact damage is captured too.
function runTrace(ticks = 120, dt = 0.05) {
  const { sim, players } = buildScenario();
  const active = new Set(['0,0']);
  for (let cx = 0; cx <= 1; cx++) for (let cy = 0; cy <= 1; cy++) active.add(`${cx},${cy}`);
  const trace = [];
  for (let i = 0; i < ticks; i++) {
    sim.tick(dt, active, players, i * dt);
    trace.push({
      creatures: sim.all().map((c) => ({
        id: c.id,
        x: Number(c.x.toFixed(4)),
        y: Number(c.y.toFixed(4)),
        facing: c.facing,
        mode: c.mode,
        hp: Number(Number(c.hp).toFixed(4)),
      })),
      playerHp: Number(Number(players[0].hp).toFixed(4)),
    });
  }
  return trace;
}

module.exports = { runTrace };
