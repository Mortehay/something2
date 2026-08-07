// Produces a deterministic trace of the creature sim, used by
// creature_behavior_golden.test.js to prove P2a changed no behaviour.
const { CreatureSim } = require('../../src/authority/creatures.js');

// Everything walkable, chunkSize 8 (chunk span 800px) -- the same stub the
// rest of the creature suite uses.
function stubMap() {
  return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 };
}

// Deterministic rng: 0.05 seeds _dir = floor(0.05*8) = 0 (east) and is >= the
// 0.02 redirect chance, so no creature ever redirects. The trace is therefore
// a pure function of the sim's movement and combat rules.
const fixedRng = () => 0.05;

// Two hostiles and one guard, exercising roam, chase, contact damage and the
// guard's post/leash/return behaviour in one run.
//
// Positions were chosen (not copied from a naive layout) so every actor's
// role is actually exercised across the 120-tick window instead of being
// pre-empted by an adjacent one:
//  - roamer sits far from the player (>400px, aggro's radius) and far from
//    the guard's post (>400px) for the whole run, so it never acquires a
//    target and stays in pure 'roam'.
//  - chaser starts within the player's 400px aggro radius but outside the
//    guard's engage radius (leash 300px / aggro 400px from the guard's
//    post), so it chases and damages the PLAYER without the guard ever
//    intercepting it.
//  - sentry (guard) starts exactly at its own post with no hostile in range:
//    it settles into 'guard' within a few ticks, since a guard's home
//    comparison is center-to-corner and only converges below the
//    stand-still epsilon after a short walk-in.
//  - raider starts ~330px from the guard's post (outside the 300px leash,
//    inside the 400px aggro) and closes in via its own roam movement,
//    pulling the guard from 'guard' into 'chase', where it is killed —
//    after which the guard heads back ('return') toward its post.
// An earlier layout (all four creatures clustered near one another) let the
// guard snipe the player-chasing hostile within its very first tick and
// never left 'chase' the whole run — see task-1-report.md for the discarded
// trace. That fixture would have passed Step 4's raw ticks/ids check while
// exercising none of 'roam' or 'guard', so it was rejected.
function buildScenario() {
  const sim = new CreatureSim(stubMap(), fixedRng);
  sim.addCreatures([
    { id: 'roamer', type: 'Wolf', x: 100, y: 950, hp: 30, facing: 'S', color: '#c0392b', damage: 5, level: 1 },
    { id: 'chaser', type: 'Skeleton', x: 300, y: 300, hp: 30, facing: 'S', color: '#dddddd', damage: 5, level: 1 },
    { id: 'sentry', type: 'Village Guard', x: 1400, y: 1400, hp: 60, facing: 'S', color: '#3498db',
      faction: 'guard', home_x: 1400, home_y: 1400, damage: 5, level: 1 },
    { id: 'raider', type: 'Bat', x: 1050, y: 1400, hp: 40, facing: 'S', color: '#8e44ad', damage: 5, level: 1 },
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
