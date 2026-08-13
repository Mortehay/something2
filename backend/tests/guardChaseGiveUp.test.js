// SOMET-295 — a guard must not lock onto a hostile it cannot walk to.
//
// The companion to guardWallReturn.test.js. That file covers a guard with NO
// target walking home around its own wall ring; this one covers the case that
// file's machinery never sees, because a guard holding a target never reaches
// it: the chase itself jamming against the inside of a wall with no gate.
//
// The village is guardWallReturn's (6x4, gate E) and the Guard profile is the
// SHIPPED seed-catalog one assembled through resolveBehavior, the way
// guard_rescue_golden.test.js does it. Both are restated here rather than
// imported: neither of those files exports its fixture, and the alternative --
// exporting a test's fixture so another test can depend on it -- makes a change
// to one file's village silently retune a different file's assertions.
//
// The shipped GUARD_DEFAULT_BEHAVIOR fallback is deliberately NOT used: it
// still carries the legacy 300px leash, at which most of the placements below
// are refused outright and the jam cannot even be set up.
const test = require('node:test');
const assert = require('node:assert');
const {
  CreatureSim, GUARD_HOME_EPSILON,
  GUARD_CHASE_STALL_TICKS, GUARD_UNREACHABLE_MOVE,
} = require('../src/authority/creatures.js');
const { resolveBehavior } = require('../src/services/creatureBehaviors.js');
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');
const { CREATURE_ABILITIES } = require('../seeds/data/creatureAbilities.js');

const TILE = 100;
const DT = 0.05;                 // the authority's own 50ms tick
const VILLAGE = { minRow: 28, minCol: 28, width: 6, height: 4 };
const R_MAX = VILLAGE.minRow + VILLAGE.height - 1;  // 31
const C_MAX = VILLAGE.minCol + VILLAGE.width - 1;   // 33
const GATE = { row: 30, col: C_MAX };               // the ring's only opening
const POST_N = { x: 3250, y: 2950 };                // col 32, row 29
const POST_S = { x: 3250, y: 3050 };                // col 32, row 30

function onRing(row, col) {
  if (row < VILLAGE.minRow || row > R_MAX || col < VILLAGE.minCol || col > C_MAX) return false;
  return row === VILLAGE.minRow || row === R_MAX || col === VILLAGE.minCol || col === C_MAX;
}
const MAP = {
  chunkSize: 64,
  isWalkable: (x, y) => {
    const row = Math.floor(y / TILE), col = Math.floor(x / TILE);
    if (!onRing(row, col)) return true;
    return row === GATE.row && col === GATE.col;
  },
  speedAt: () => 1,
};
// chunkSize 64 tiles => chunk (0,0) covers x/y in [0, 6400). Every coordinate
// here sits inside it, so one key keeps the whole fixture active.
const KEYS = new Set(['0,0']);

function profile(name) {
  const row = CREATURE_BEHAVIORS.find((b) => b.name === name);
  assert.ok(row, `${name} is missing from the seed catalog`);
  const abilities = CREATURE_ABILITIES
    .filter((a) => a.behavior_name === name)
    .map(({ behavior_name: _n, ...cols }) => cols);
  return resolveBehavior({
    behavior_name: row.name, aggro_radius: row.aggro_radius, leash_radius: row.leash_radius,
    chase_style: row.chase_style, preferred_range: row.preferred_range,
    move_speed_mult: row.move_speed_mult, damage_override: row.damage_override ?? null,
    abilities,
  });
}
const GUARD_BH = profile('Guard');
const LINE_BH = profile('Line');
// The hostile is held still (moveSpeedMult 0) in the jam tests on purpose. A
// roaming hostile drifts out of the guard's 400px aggro on its own within a few
// seconds, which HIDES the defect: the pre-fix guard then recovers for a reason
// that has nothing to do with this fix, and the test would pass either way.
// Every "it stays put" case below is therefore the honest worst case, and it is
// also what the ticket reported seeing live.
const STILL_BH = { ...LINE_BH, moveSpeedMult: 0 };

const cen = (o) => ({ x: o.x + o.width / 2, y: o.y + o.height / 2 });
const distTo = (o, p) => Math.hypot(cen(o).x - p.x, cen(o).y - p.y);
const REACH = Math.max(...GUARD_BH.abilities.map((a) => a.attackRange));

// A guard that cannot kill its target. Every jam test needs the hostile to
// survive indefinitely, or "the guard came home" would be satisfied by it
// simply winning the fight.
function scene({ post = POST_N, hostile, hostileBh = STILL_BH, guardDamage = 0 } = {}) {
  const s = new CreatureSim(MAP, () => 0.5);
  s.addCreatures([
    {
      id: 'g', type: 'Village Guard', x: post.x - 24, y: post.y - 24, hp: 1e9,
      faction: 'guard', home_x: post.x, home_y: post.y, behavior: GUARD_BH, damage: guardDamage,
    },
    {
      id: 'h', type: 'Slime', x: hostile.x - 24, y: hostile.y - 24, hp: 1e9,
      behavior: hostileBh, damage: 0,
    },
  ]);
  return { s, g: s.creatures.get('g'), h: s.creatures.get('h'), post };
}

function run(s, ticks, onTick) {
  for (let i = 0; i < ticks; i++) {
    s.tick(DT, KEYS, [], 1000 + i * 50);
    if (onTick) onTick(i);
  }
}

// --- the fixture, before anything depends on it ------------------------------

test('fixture: the ring is impassable except at the gate, and both posts are inside', () => {
  assert.equal(MAP.isWalkable(3250, 2850), false, 'the N wall (row 28) must be solid');
  assert.equal(MAP.isWalkable(2850, 3050), false, 'the W wall (col 28) must be solid');
  assert.equal(MAP.isWalkable(3250, 3150), false, 'the S wall (row 31) must be solid');
  assert.equal(MAP.isWalkable(GATE.col * TILE + 50, GATE.row * TILE + 50), true, 'the gate is open');
  assert.equal(MAP.isWalkable(POST_N.x, POST_N.y), true);
  assert.equal(MAP.isWalkable(POST_S.x, POST_S.y), true);
});

// The jam only means something if the guard would really acquire this hostile.
// Without this, a fix that simply refused to acquire anything would pass every
// test below while leaving the village unguarded.
test('fixture: a hostile 350px due north of the N post is admitted by BOTH gates', () => {
  const h = { x: POST_N.x, y: POST_N.y - 350 };
  assert.ok(350 <= GUARD_BH.aggroRadius, `aggro ${GUARD_BH.aggroRadius} must admit it`);
  assert.ok(350 <= GUARD_BH.leashRadius, `leash ${GUARD_BH.leashRadius} must admit it`);
  assert.equal(MAP.isWalkable(h.x, h.y), true, 'it must stand on open ground');
  // ...and it really is on the far side of a wall with no gate: every tile on
  // the straight line between them is blocked somewhere.
  let blocked = false;
  for (let y = POST_N.y; y > h.y; y -= 10) if (!MAP.isWalkable(POST_N.x, y)) blocked = true;
  assert.ok(blocked, 'the N wall must actually stand between the post and the hostile');

  const { s, g } = scene({ hostile: h });
  s.tick(DT, KEYS, [], 1000);
  assert.equal(g._target, 'h', 'the guard must acquire it — otherwise the jam tests prove nothing');
  assert.equal(g.mode, 'chase');
});

// --- the defect --------------------------------------------------------------

test('a guard jammed on an unreachable hostile drops it and returns to its post', () => {
  const { s, g, h } = scene({ hostile: { x: POST_N.x, y: POST_N.y - 350 } });

  // Long enough for the 2s stall window, the walk home, and a wide margin --
  // but far short of the 5-minute ban expiry, so this measures the give-up and
  // not a retry cycle.
  run(s, 600);

  assert.equal(g._target, null, 'the guard is still holding a hostile it cannot reach');
  assert.equal(g.mode, 'guard', `guard ended in mode '${g.mode}', not back on station`);
  assert.ok(distTo(g, POST_N) <= GUARD_HOME_EPSILON,
    `guard ended ${distTo(g, POST_N).toFixed(0)}px from its post`);
  // The hostile is untouched and still in aggro range: the guard did not
  // "recover" by killing it or by it wandering off.
  assert.ok(h.hp > 0 && distTo(h, POST_N) <= GUARD_BH.aggroRadius,
    'the hostile must still be alive and in range, or this proves nothing');
});

// The give-up must not fire while the guard is still walking. 2s of stall at a
// 50ms tick is 40 ticks; a guard crossing a village takes far longer than that.
test('the give-up costs at most the stall window plus the walk back', () => {
  const { s, g } = scene({ hostile: { x: POST_N.x, y: POST_N.y - 350 } });
  let dropped = -1;
  run(s, 600, (i) => { if (dropped < 0 && g._target === null) dropped = i; });
  assert.ok(dropped > GUARD_CHASE_STALL_TICKS,
    `the guard gave up after ${dropped} ticks, which is inside its own ${GUARD_CHASE_STALL_TICKS}-tick `
    + 'stall window — it cannot have been walking for any of it');
  assert.ok(dropped < 200,
    `the guard took ${dropped} ticks (${(dropped * DT).toFixed(1)}s) to notice it was stuck`);
});

// Every placement the pre-fix sweep found jammed, in one test. 42 of them
// jammed permanently before this fix; the important part of this assertion is
// the COUNT of placements exercised, since a fix that broke acquisition would
// otherwise satisfy "nobody jams" trivially (the acquisition fixture above is
// what stops that).
test('no placement around either post leaves a guard jammed off-station', () => {
  const BEARINGS = [['N', 0, -1], ['S', 0, 1], ['W', -1, 0], ['E', 1, 0],
    ['NW', -0.7071, -0.7071], ['NE', 0.7071, -0.7071],
    ['SW', -0.7071, 0.7071], ['SE', 0.7071, 0.7071]];
  const jammed = [];
  let checked = 0;
  for (const post of [POST_N, POST_S]) {
    for (const [name, dx, dy] of BEARINGS) {
      for (const dist of [150, 200, 250, 300, 350, 390]) {
        const hostile = { x: post.x + dx * dist, y: post.y + dy * dist };
        if (!MAP.isWalkable(hostile.x, hostile.y)) continue;
        const { s, g, h } = scene({ post, hostile });
        // 1200 ticks = 60s: several times the stall window and the longest
        // walk home this village produces, still inside the ban's lifetime.
        let lastX = 0, lastY = 0, moved = 0;
        run(s, 1200, (i) => {
          if (i === 700) { lastX = g.x; lastY = g.y; }
          if (i > 700) moved = Math.max(moved, Math.hypot(g.x - lastX, g.y - lastY));
        });
        checked++;
        // A jam is: still chasing, out of its own strike range, and immobile.
        // A guard standing in contact with a hostile hitting it is NOT a jam --
        // that is a guard doing its job, and in this fixture it cannot finish
        // the job because guardDamage is 0.
        const reachable = Math.hypot(cen(g).x - cen(h).x, cen(g).y - cen(h).y) <= REACH;
        if (g.mode === 'chase' && !reachable && moved < 2) {
          jammed.push(`${name}@${dist} from (${post.x},${post.y})`);
        }
      }
    }
  }
  assert.equal(checked, 73, `expected 73 walkable placements, swept ${checked}`);
  assert.deepEqual(jammed, [], `${jammed.length} placements still jam a guard: ${jammed.join(', ')}`);
});

// --- what the give-up must NOT do --------------------------------------------

// The regression this fix could most easily cause, and the reason the stall
// window watches the guard's OWN displacement rather than its closure on the
// target: a guard trailing a hostile it never catches is doing exactly what
// SOMET-291's gate rescue needs, and must never be given up on.
test('a guard trailing a hostile it never closes on keeps chasing', () => {
  // Open ground well away from the village walls, so nothing here is about
  // pathing: the guard is simply slower than what it is following.
  const post = { x: 1000, y: 1000 };
  const s = new CreatureSim({ ...MAP, isWalkable: () => true }, () => 0.5);
  s.addCreatures([
    { id: 'g', type: 'Village Guard', x: post.x - 24, y: post.y - 24, hp: 1e9,
      faction: 'guard', home_x: post.x, home_y: post.y, behavior: GUARD_BH, damage: 0 },
    { id: 'h', type: 'Slime', x: post.x + 176, y: post.y - 24, hp: 1e9,
      behavior: STILL_BH, damage: 0 },
  ]);
  const g = s.creatures.get('g');
  const h = s.creatures.get('h');
  // The hostile is dragged east at exactly the speed the guard walks, so the
  // gap never closes by a single pixel — the case a closure-based stall test
  // would call "stuck" and this one must not. Held inside the leash so the
  // chase is never ended by the leash rule instead.
  const step = 40 * DT * GUARD_BH.moveSpeedMult;
  const HELD = GUARD_CHASE_STALL_TICKS * 4;   // 4x the window: no doubt left
  let minGap = Infinity, maxGap = 0;
  for (let i = 0; i < HELD; i++) {
    h.x += step;
    s.tick(DT, KEYS, [], 1000 + i * 50);
    const gap = Math.hypot(cen(g).x - cen(h).x, cen(g).y - cen(h).y);
    minGap = Math.min(minGap, gap); maxGap = Math.max(maxGap, gap);
    assert.ok(distTo(h, post) <= GUARD_BH.leashRadius,
      'fixture: the hostile left the leash — the chase would end for the wrong reason');
  }
  assert.ok(maxGap - minGap < 4,
    `fixture: the gap moved ${(maxGap - minGap).toFixed(1)}px — this must be a chase that closes NOTHING`);
  assert.ok(minGap > REACH, 'fixture: the guard got within strike range, so nothing was proved');
  assert.equal(g._target, 'h',
    `the guard gave up on a hostile it was actively following for ${HELD} ticks`);
  assert.equal(g.mode, 'chase');
});

// The ban must not outlive the situation that earned it. A hostile that walks
// away from where the guard gave up is a different problem from the one that
// was refused, and SOMET-291's rescue depends on this: a hostile chasing a
// player is moving by construction, so it clears its own ban within a few ticks.
test('a hostile that moves clears its own unreachable ban', () => {
  const { s, g, h } = scene({ hostile: { x: POST_N.x, y: POST_N.y - 350 } });
  run(s, 600);
  assert.equal(g._target, null, 'precondition: the guard must have given up first');

  // Still banned while it sits there.
  run(s, 200);
  assert.equal(g._target, null, 'the guard re-acquired a hostile it had just refused');

  // Now walk it round to the gate side, further than the lift threshold.
  h.x += GUARD_UNREACHABLE_MOVE + 2;
  run(s, 20);
  assert.equal(g._target, 'h',
    'the guard is still refusing a hostile that has moved since it gave up');
});

// A guard must still engage a DIFFERENT hostile while one is banned: the ban is
// per-target, not a general stand-down. Without this, one unreachable slime
// parked outside the north wall would disarm the gate entirely.
test('a banned target does not stop the guard engaging another hostile', () => {
  const { s, g } = scene({ hostile: { x: POST_N.x, y: POST_N.y - 350 } });
  run(s, 600);
  assert.equal(g._target, null, 'precondition: the guard must have given up first');

  // A second hostile, inside the village on open floor, plainly reachable.
  s.addCreatures([{
    id: 'h2', type: 'Slime', x: 3050 - 24, y: POST_N.y - 24, hp: 1e9,
    behavior: STILL_BH, damage: 0,
  }]);
  run(s, 5);
  assert.equal(g._target, 'h2', 'the guard ignored a reachable hostile inside its own village');
  run(s, 200);
  assert.ok(Math.hypot(cen(g).x - 3050, cen(g).y - POST_N.y) <= REACH,
    'the guard never got into strike range of the reachable hostile');
});
