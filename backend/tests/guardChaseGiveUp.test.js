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
  GUARD_CHASE_STALL_TICKS, GUARD_CHASE_BLOCKED_FRACTION,
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

// The case the first version of this fix shipped without and the running game
// caught within minutes: the hostile ROAMS. Both Windwatch guards spent 15s
// pinned at y=2500 sliding a few px/s along the inside of their own north wall,
// following a slime that kept moving, and were dragged from 203px to 288px off
// station. Every tick they "moved", so a give-up keyed on the guard's own
// displacement never fired. A wall-slide is movement that gets the guard
// nowhere, and only the delivered-fraction test can tell the two apart.
test('a guard does not follow a MOVING unreachable hostile along its own wall', () => {
  const { s, g, h } = scene({ hostile: { x: POST_N.x, y: POST_N.y - 350 } });
  // Driven rather than left to roam: the hostile patrols east-west parallel to
  // the wall, which is what keeps re-aiming the guard and regenerating the
  // tangential component. Random roam would make this test's outcome depend on
  // the rng seed.
  let dir = 1;
  const PATROL = 250;                     // px either side of where it started
  const startX = h.x;
  let maxOff = 0, gaveUpAt = -1;
  for (let i = 0; i < 900; i++) {
    h.x += dir * 40 * DT;
    if (Math.abs(h.x - startX) > PATROL) dir = -dir;
    s.tick(DT, KEYS, [], 1000 + i * 50);
    maxOff = Math.max(maxOff, distTo(g, POST_N));
    if (gaveUpAt < 0 && g._target === null) gaveUpAt = i;
  }
  assert.ok(gaveUpAt > 0, 'the guard followed a moving unreachable hostile for the whole run');
  assert.ok(maxOff < 250,
    `the guard was dragged ${maxOff.toFixed(0)}px off its post along the wall before giving up`);
  assert.ok(distTo(g, POST_N) <= GUARD_HOME_EPSILON,
    `guard ended ${distTo(g, POST_N).toFixed(0)}px from its post`);
  // The hostile is still there, still moving, still in range: the guard did not
  // recover because the problem walked away.
  assert.ok(h.hp > 0 && distTo(h, POST_N) <= GUARD_BH.leashRadius,
    'the hostile must still be alive and inside the leash, or this proves nothing');
});

// The scene that actually falsified the first version of this fix, reproduced
// from the running game rather than from a fixture designed to be catchable.
//
// The grid, the posts and the coordinates below were read out of Windwatch Pass
// (world 371454ed) in the browser on 2026-08-13: a 7x4 village whose gate is on
// the SOUTH edge, with a Slime roaming due north of the gateless north wall.
// The guard's step there was not refused outright -- it delivered 0.072px of
// its 2px request, a 3.6% creep along the wall -- which is why a give-up keyed
// on "did the guard move" never fired and both guards were dragged 200px+ off
// station. A test whose guard comes to a DEAD stop cannot tell the two rules
// apart; this one creeps, exactly as the live one did.
const WINDWATCH = {
  20: '...........#.', 21: '.............', 22: '.............',
  23: '.#...........', 24: '.#######.....', 25: '.##....#.....',
  26: '..#....#.....', 27: '..###.##.....', 28: '.............',
};
const WW_COL0 = 36;
const WW_MAP = {
  chunkSize: 32,
  isWalkable: (x, y) => {
    const row = WINDWATCH[Math.floor(y / TILE)];
    if (row === undefined) return true;
    const ch = row[Math.floor(x / TILE) - WW_COL0];
    return ch === undefined ? true : ch === '.';
  },
  speedAt: () => 1,
};
const WW_KEYS = new Set(['0,0', '1,0', '0,1', '1,1']);
const WW_POST = { x: 4050, y: 2650 };

test('the live Windwatch scene: a creeping wall-slide is not progress', () => {
  const s = new CreatureSim(WW_MAP, () => 0.5);
  s.addCreatures([
    { id: 'g', type: 'Village Guard', x: 4167.58, y: 2500.01, hp: 1e9,
      faction: 'guard', home_x: WW_POST.x, home_y: WW_POST.y, behavior: GUARD_BH, damage: 0, level: 150 },
    { id: 'h', type: 'Slime', x: 4158.23, y: 2242.41, hp: 1e9, behavior: STILL_BH, damage: 0, level: 4 },
  ]);
  const g = s.creatures.get('g');
  const h = s.creatures.get('h');
  assert.equal(WW_MAP.isWalkable(4150, 2450), false, 'fixture: the north wall must be solid');
  assert.equal(WW_MAP.isWalkable(4150, 2350), true, 'fixture: the hostile must stand on open ground');

  // The hostile drifts slowly, which is what keeps the guard's aim -- and so
  // its tangential component -- alive. 0.4px/tick, a fifth of the guard's step.
  const recent = [];        // per-tick delivered distance, most recent last
  let gaveUpAt = -1, creepAtGiveUp = null;
  for (let i = 0; i < 900; i++) {
    h.x -= 0.4;
    const bx = g.x, by = g.y;
    s.tick(DT, WW_KEYS, [], 1000 + i * 50);
    recent.push(Math.hypot(g.x - bx, g.y - by));
    if (recent.length > GUARD_CHASE_STALL_TICKS) recent.shift();
    if (gaveUpAt < 0 && g._target === null) {
      gaveUpAt = i;
      creepAtGiveUp = { min: Math.min(...recent), max: Math.max(...recent) };
    }
  }
  assert.ok(gaveUpAt > 0, 'the guard crept along the live north wall forever');

  // THE POINT OF THIS TEST. Every tick of the window that tripped the give-up
  // delivered a non-zero step: the guard was moving the whole time. A rule that
  // asks "did it move" therefore cannot produce this outcome, which is exactly
  // what the running game demonstrated when the first version of this fix left
  // both Windwatch guards sliding along this wall.
  assert.ok(creepAtGiveUp.min > 0,
    `the guard came to a dead stop before giving up (min step ${creepAtGiveUp.min}px over the `
    + 'window) — this scene must CREEP, or it does not distinguish the two stall rules');
  assert.ok(creepAtGiveUp.max < 2 * GUARD_CHASE_BLOCKED_FRACTION,
    `the guard was delivering ${creepAtGiveUp.max.toFixed(2)}px of its 2px step — that is `
    + 'walking, not creeping, and the fixture is not reproducing the live scene');

  assert.ok(Math.hypot(g.x + 24 - WW_POST.x, g.y + 24 - WW_POST.y) <= GUARD_HOME_EPSILON,
    `guard ended ${Math.hypot(g.x + 24 - WW_POST.x, g.y + 24 - WW_POST.y).toFixed(0)}px from its post`);
  assert.ok(h.hp > 0, 'the hostile must still be alive, or the guard simply won');
});

// --- what the give-up must NOT do --------------------------------------------

// A guard standing ON its target delivers nothing, every tick, for as long as
// the fight lasts: creatures do not collide, so the step vector is ~0 and
// resolveMove returns without moving it. That is a guard winning a fight, not a
// guard stuck on a wall, and it must never be given up on -- let alone BANNED,
// which would make it walk away from a hostile inside its own village.
//
// A long fight is the case that matters. Guard damage is 1 against 1e9 hp, so
// this runs for 400 ticks, ten times the stall window.
test('a guard standing on its target never gives up on it', () => {
  const { s, g, h } = scene({
    // Open floor inside the village, nothing to press against.
    hostile: { x: POST_N.x - 100, y: POST_N.y }, guardDamage: 1,
  });
  // Let it close, then confirm it really is on top of the hostile and stuck
  // there by its own arrival rather than by terrain.
  run(s, 120);
  const gap = Math.hypot(cen(g).x - cen(h).x, cen(g).y - cen(h).y);
  assert.ok(gap <= REACH, `fixture: the guard must have reached its target (gap ${gap.toFixed(0)}px)`);
  const hpBefore = h.hp;

  run(s, 400);

  assert.ok(h.hp < hpBefore, 'fixture: the guard must actually be hitting it');
  assert.equal(g._target, 'h',
    'the guard abandoned a hostile it was standing on and killing');
  assert.equal(g._unreachable == null || g._unreachable.size === 0, true,
    'the guard banned a hostile it was in contact with as "unreachable"');
});

// Each target gets its own window: a guard that has spent most of a stall
// window on one hostile must not inherit that count and abandon the next one on
// its first blocked tick.
test('a new target starts a fresh stall window', () => {
  const { s, g } = scene({ hostile: { x: POST_N.x, y: POST_N.y - 350 } });
  // Stop just short of the give-up.
  run(s, GUARD_CHASE_STALL_TICKS - 2);
  assert.equal(g._target, 'h', 'precondition: still chasing the first hostile');
  assert.ok(g._chaseStall > GUARD_CHASE_STALL_TICKS / 2,
    `precondition: the window must be nearly full, was ${g._chaseStall}`);

  // Swap it for a second hostile behind the SAME wall. Same wall on purpose:
  // the guard is already pressed against it, so the new chase is blocked from
  // its very first tick and an inherited counter would fire immediately. Put
  // h2 on the far side of the village instead and the guard turns round and
  // walks, which clears the counter incidentally and hides the defect.
  s.creatures.delete('h');
  s.addCreatures([{ id: 'h2', type: 'Slime', x: POST_N.x + 80 - 24, y: POST_N.y - 340 - 24,
    hp: 1e9, behavior: STILL_BH, damage: 0 }]);
  let acquired = -1, dropped = -1;
  for (let i = 0; i < 400 && dropped < 0; i++) {
    s.tick(DT, KEYS, [], 5000 + i * 50);
    if (acquired < 0 && g._target === 'h2') acquired = i;
    else if (acquired >= 0 && g._target === null) dropped = i;
  }
  assert.ok(acquired >= 0, 'the guard never acquired the second hostile at all');
  assert.ok(dropped > 0, 'the guard never gave up on the second, also-unreachable hostile');
  assert.ok(dropped - acquired >= GUARD_CHASE_STALL_TICKS,
    `the second hostile was abandoned ${dropped - acquired} ticks after it was acquired, inside `
    + `its own ${GUARD_CHASE_STALL_TICKS}-tick window — it inherited the first one's count`);
});

// The same rule on the way back in: a rescue that re-acquires a hostile the
// guard had already banned must get a full window of its own. Without it the
// guard drops the rescue on its first blocked tick, having inherited the very
// counter that banned the hostile in the first place -- SOMET-291 undone by a
// stale integer.
test('a re-acquired hostile starts a fresh stall window too', () => {
  const { s, g, h } = scene({ hostile: { x: POST_N.x, y: POST_N.y - 350 } });
  run(s, 600);
  assert.equal(g._target, null, 'precondition: the guard must have banned it first');

  // A player joins it outside the wall, so the ban lifts as a rescue while the
  // hostile is still exactly as unreachable as before.
  const player = { userId: 7, x: POST_N.x - 32, y: POST_N.y - 320 - 32,
    width: 64, height: 64, hp: 1e9, maxHp: 1e9 };
  let acquired = -1, dropped = -1;
  for (let i = 0; i < 400 && dropped < 0; i++) {
    s.tick(DT, KEYS, [player], 100000 + i * 50);
    if (acquired < 0 && g._target === 'h') acquired = i;
    else if (acquired >= 0 && g._target === null) dropped = i;
  }
  assert.ok(h._target === player.userId, 'fixture: the hostile never engaged the player');
  assert.ok(acquired >= 0, 'the guard never answered the rescue at all');
  assert.ok(dropped - acquired >= GUARD_CHASE_STALL_TICKS,
    `the guard abandoned the rescue ${dropped - acquired} ticks after answering it, inside its `
    + `own ${GUARD_CHASE_STALL_TICKS}-tick window — the give-up did not clear its counter`);
});

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

// The ban must not outrank a rescue. This is the SOMET-291 interaction, and it
// is the ONLY thing that lifts a ban early: a banned hostile that starts
// fighting a player is exactly what a guard exists for.
//
// The earlier version of this test asserted that any 48px of movement lifted
// the ban. That rule shipped and the running game refuted it within a minute --
// a roaming hostile clears 48px in about a second, so the guard re-acquired it
// forever. What replaced it is narrower and is the rule that was meant all
// along.
test('a banned hostile that starts fighting a player is acquired again at once', () => {
  const { s, g, h } = scene({ hostile: { x: POST_N.x, y: POST_N.y - 350 } });
  run(s, 600);
  assert.equal(g._target, null, 'precondition: the guard must have given up first');

  // Still banned while it is merely sitting there — and still banned after it
  // has wandered, which is the specific rule the live game taught.
  h.x += 120;
  run(s, 200);
  assert.equal(g._target, null,
    'the guard re-acquired a banned hostile that had only moved, not attacked');

  // Now it engages a player. The player is placed on the guard's own side of
  // the wall so that the hostile fighting them is genuinely worth answering.
  const player = { userId: 7, x: POST_N.x + 40, y: POST_N.y - 40, width: 64, height: 64, hp: 100, maxHp: 100 };
  h.x = POST_N.x + 60; h.y = POST_N.y - 60;   // beside the player, inside the walls
  for (let i = 0; i < 30; i++) s.tick(DT, KEYS, [player], 100000 + i * 50);
  assert.ok(h._target === player.userId,
    'fixture: the hostile never engaged the player, so no rescue was on offer');
  assert.equal(g._target, 'h',
    'the guard ignored a banned hostile that had started fighting a player');
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
