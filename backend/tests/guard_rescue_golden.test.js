// SOMET-291 — the gate rescue, end to end, through the live tick.
//
// One run of CreatureSim.tick over a real village wall ring, with the SHIPPED
// Guard profile read out of the seed catalog, producing an ordered trace:
//
//   player flees -> crosses the gate -> the hostile follows it in ->
//   the guard leaves its post -> the hostile dies -> the guard walks home and
//   re-anchors
//
// Nothing here re-implements movement, targeting or damage: the test moves the
// PLAYER (which the authority does not simulate anyway -- players are driven by
// their own input frames) and reads everything else off the sim.
//
// The counterfactual at the bottom is what makes the leash migration
// falsifiable. Without it this trace would pass at any leash >= ~200 and the
// number in creature_behaviors would be unpinned by anything but a comment.
const test = require('node:test');
const assert = require('node:assert');
const {
  CreatureSim, GUARD_HOME_EPSILON, GUARD_LEASH_RADIUS, CREATURE_SPEED,
} = require('../src/authority/creatures.js');
const { resolveBehavior } = require('../src/services/creatureBehaviors.js');
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');
const { CREATURE_ABILITIES } = require('../seeds/data/creatureAbilities.js');
const { villageGatePosts, villageGatePoint } = require('../src/services/mapService.js');
const { guardRescueLeashTerms } = require('../src/services/villages.js');

const TILE = 100;

// ---------------------------------------------------------------------------
// The village: the WORST legal box, which is the one the leash was derived
// from. 7 wide x 3 tall with the gate on a short edge -- its interior is a
// single 5-tile row, both guard posts clamp onto the one interior tile beside
// the gate, and the far end of that row is 4 tiles (400px) from those posts.
// A village-sized hostile chase therefore fits entirely inside this fixture,
// which is exactly the case a 300px leash could not cover.
//
// Placed at row 28 / col 28 to match guardWallReturn.test.js's coordinates, so
// the two wall-ring fixtures read the same way.
// ---------------------------------------------------------------------------
const VILLAGE = { minRow: 28, minCol: 28, width: 7, height: 3, gateEdge: 'E' };
const R_MAX = VILLAGE.minRow + VILLAGE.height - 1;  // 30
const C_MAX = VILLAGE.minCol + VILLAGE.width - 1;   // 34

const POSTS = villageGatePosts(VILLAGE);
const POST = POSTS[0];                     // (3350, 2950)
const GATE = villageGatePoint(VILLAGE);    // (3450, 2950)
// The far interior tile: the west end of the single interior row. This is the
// corner a player runs to and a hostile follows them to.
const CORNER = { x: (VILLAGE.minCol + 1) * TILE + TILE / 2, y: POST.y };  // (2950, 2950)
// The village box in world pixels, for the "has it crossed the gate?" tests.
const BOX = {
  x0: VILLAGE.minCol * TILE, x1: (C_MAX + 1) * TILE,
  y0: VILLAGE.minRow * TILE, y1: (R_MAX + 1) * TILE,
};

test('fixture: this really is the box the leash was derived from', () => {
  // If either of these stops holding, the trace below is measuring some other
  // village and the counterfactual proves nothing about the shipped number.
  assert.equal(POSTS.length, 2);
  assert.deepEqual(POSTS[0], POSTS[1],
    'a 7x3 clamps both posts onto one tile — that is what makes it the worst case');
  assert.equal(Math.hypot(CORNER.x - POST.x, CORNER.y - POST.y),
    guardRescueLeashTerms().worstInterior.d,
    'the corner this trace uses is not the worst interior distance the leash was derived from');
  assert.ok(Math.hypot(CORNER.x - POST.x, CORNER.y - POST.y) > GUARD_LEASH_RADIUS,
    'the corner is inside the OLD leash — the counterfactual below would be vacuous');
});

function onRing(row, col) {
  if (row < VILLAGE.minRow || row > R_MAX || col < VILLAGE.minCol || col > C_MAX) return false;
  return row === VILLAGE.minRow || row === R_MAX || col === VILLAGE.minCol || col === C_MAX;
}
function walkableTile(row, col) {
  if (!onRing(row, col)) return true;
  // The gate is the ring's only opening.
  return row === Math.floor(GATE.y / TILE) && col === Math.floor(GATE.x / TILE);
}
const MAP = {
  chunkSize: 64,
  isWalkable: (x, y) => walkableTile(Math.floor(y / TILE), Math.floor(x / TILE)),
  speedAt: () => 1,
};
// chunkSize 64 tiles => chunk (0,0) covers x/y in [0, 6400): every coordinate
// in this file sits inside it, so one key keeps the whole fixture active.
const KEYS = new Set(['0,0']);

test('fixture: the wall ring is impassable except at the gate', () => {
  assert.equal(MAP.isWalkable(POST.x, POST.y), true, 'the post is inside and walkable');
  assert.equal(MAP.isWalkable(CORNER.x, CORNER.y), true, 'the far corner is walkable');
  assert.equal(MAP.isWalkable(GATE.x, GATE.y), true, 'the gate is open');
  assert.equal(MAP.isWalkable(GATE.x, GATE.y - TILE), false, 'the ring above the gate is wall');
  assert.equal(MAP.isWalkable(CORNER.x - TILE, CORNER.y), false, 'the west wall is wall');
  assert.equal(MAP.isWalkable(GATE.x + 4 * TILE, GATE.y), true, 'open ground east of the gate');
});

// ---------------------------------------------------------------------------
// The actors
// ---------------------------------------------------------------------------

// The SHIPPED Guard profile, assembled from the seed catalog through the same
// resolveBehavior the live loaders use. Deliberately NOT GUARD_DEFAULT_BEHAVIOR:
// that fallback still carries the legacy 300px leash (it exists to reproduce
// pre-catalog behaviour for an unprofiled creature), so a trace built on it
// would prove nothing about the tuning that actually ships.
function seededGuardBehavior(over = {}) {
  const row = CREATURE_BEHAVIORS.find((b) => b.name === 'Guard');
  assert.ok(row, 'Guard is missing from the seed catalog');
  const abilities = CREATURE_ABILITIES
    .filter((a) => a.behavior_name === 'Guard')
    .map(({ behavior_name: _n, ...cols }) => cols);
  assert.ok(abilities.length > 0, 'Guard has no seeded ability — it could not attack at all');
  return {
    ...resolveBehavior({
      behavior_name: row.name,
      aggro_radius: row.aggro_radius,
      leash_radius: row.leash_radius,
      chase_style: row.chase_style,
      preferred_range: row.preferred_range,
      move_speed_mult: row.move_speed_mult,
      damage_override: row.damage_override ?? null,
      abilities,
    }),
    ...over,
  };
}

// The hostile: an ordinary charger on the Line rung, i.e. the fallback profile
// every unprofiled creature in the game resolves to.
function lineBehavior() {
  const row = CREATURE_BEHAVIORS.find((b) => b.name === 'Line');
  const abilities = CREATURE_ABILITIES
    .filter((a) => a.behavior_name === 'Line')
    .map(({ behavior_name: _n, ...cols }) => cols);
  return resolveBehavior({
    behavior_name: row.name,
    aggro_radius: row.aggro_radius, leash_radius: row.leash_radius,
    chase_style: row.chase_style, preferred_range: row.preferred_range,
    move_speed_mult: row.move_speed_mult, abilities,
  });
}

// A guard's real per-instance damage is level-150 scaled (397.5), which
// one-shots anything in the catalog: the hostile would die on the first
// contact, several hundred pixels before the geometry under test mattered.
// This trace is about WHERE a guard may fight, not how hard it hits (that is
// village_guard_seed_durability.test.js's subject), so the guard is given a
// deliberately slow damage and the hostile enough hp to survive the walk in.
// Both numbers are named here rather than tuned inline so the run length below
// is auditable.
const GUARD_TRACE_DAMAGE = 10;
const HOSTILE_HP = 200;

const DT = 0.05;                 // the authority's own tick, near enough
// 50 px/s outruns the hostile's 40, which is the point: the player IS getting
// away, and the hostile follows them all the way in rather than killing them
// outside. The gap it opens (10 px/s over the ~41s run, so ~470px by the end)
// must stay under the hostile's own 800px leash-from-target, or the hostile
// would give up and this would stop being a chase.
const PLAYER_SPEED = 50;
// How far east of the gate the two start, on the gate's own row. Sized so the
// player is INSIDE the village before the hostile enters the guard's 400px
// aggro radius -- i.e. the guard leaves its post to answer a chase that has
// already reached the gate, which is the sequence the spec describes. Starting
// them closer produced a trace where the guard engaged 300px outside its own
// gate before the player had crossed it: still a rescue, but not this one.
const PLAYER_START_EAST = 1550;
const HOSTILE_START_EAST = PLAYER_START_EAST + 60;   // just inside contact range
// Long enough for the whole trace with slack: ~30s for the player to reach the
// corner, ~23s more for the hostile to arrive and be killed, ~10s for the
// guard to walk home. At DT that is ~1340 ticks.
const TRACE_TICKS = 1800;

function scene(guardOver = {}) {
  const s = new CreatureSim(MAP, () => 0.5);
  s.addCreatures([
    {
      id: 'g', type: 'Village Guard', x: POST.x - 24, y: POST.y - 24, hp: 100000,
      faction: 'guard', home_x: POST.x, home_y: POST.y,
      behavior: seededGuardBehavior(guardOver), damage: GUARD_TRACE_DAMAGE,
    },
    {
      // 850px east of the gate, on the gate's own row: beyond the guard's aggro
      // AND beyond its leash at either setting, so the guard cannot possibly
      // have engaged it before the chase begins.
      id: 'h', type: 'Slime', x: GATE.x + HOSTILE_START_EAST - 24, y: POST.y - 24, hp: HOSTILE_HP,
      behavior: lineBehavior(), damage: 5,
    },
  ]);
  const player = {
    userId: 7, x: GATE.x + PLAYER_START_EAST - 32, y: POST.y - 32,
    width: 64, height: 64, hp: 100000, mit: null,
  };
  return { s, player };
}

function centerOf(o) { return { x: o.x + o.width / 2, y: o.y + o.height / 2 }; }
function distPost(o) { const c = centerOf(o); return Math.hypot(c.x - POST.x, c.y - POST.y); }
function inBox(o) {
  const c = centerOf(o);
  return c.x >= BOX.x0 && c.x < BOX.x1 && c.y >= BOX.y0 && c.y < BOX.y1;
}

// Runs the scene and returns the trace. The player walks west until it reaches
// the far interior corner and then stands there — a cornered player, which is
// what the guards are for.
function runTrace(guardOver = {}, ticks = TRACE_TICKS) {
  const { s, player } = scene(guardOver);
  const g = s.creatures.get('g');
  const phases = {};       // name -> tick index of its FIRST occurrence
  const mark = (name, i) => { if (phases[name] === undefined) phases[name] = i; };

  let maxGuardStep = 0;
  let guardHitPlayer = 0;
  let guardTargetedPlayer = false;
  let killDistFromPost = null;

  for (let i = 0; i < ticks; i++) {
    const h = s.creatures.get('h');
    const before = { x: g.x, y: g.y };
    const { killed, attacks, impacts } = s.tick(DT, KEYS, [player], i * DT);
    maxGuardStep = Math.max(maxGuardStep, Math.hypot(g.x - before.x, g.y - before.y));

    // 1. ARMED — after the FIRST tick, not before it: addCreatures stamps
    //    mode 'roam' on every creature and only a tick resolves that to
    //    'guard', so checking at i === 0 pre-tick would be reading the
    //    constructor rather than the sim.
    //
    //    `h._target === player.userId` is load-bearing, not decoration. An
    //    earlier version of this fixture started the hostile 820px behind the
    //    player -- past its own 400px aggro -- so it never chased anyone and
    //    merely ROAMED west into the village by chance, and every later phase
    //    still fired. This is the assertion that the trace is a chase.
    if (i === 0 && g.mode === 'guard' && g._target === null
        && s.creatures.get('h')._target === player.userId
        && distPost(s.creatures.get('h')) > seededGuardBehavior().leashRadius) mark('armed', i);

    if (g._target === player.userId || g._targetKind === 'player') guardTargetedPlayer = true;
    // stampCreatureAttack pushes one entry to EACH array per landed contact
    // hit, so index k of one pairs with index k of the other.
    attacks.forEach((a, k) => {
      if (a.a === 'c:g' && impacts[k] && impacts[k].t === `p:${player.userId}`) guardHitPlayer++;
    });

    // 2. CROSSING — the player's centre is inside the village box.
    if (inBox(player)) mark('crossing', i);
    // 3. PURSUED — the hostile followed it in, still holding it as its target.
    //    (Spec §1: nothing stops a hostile at the region edge; that boundary is
    //    the design, and it is the moment guards exist for.)
    if (h && inBox(h) && h._target === player.userId) mark('pursued', i);
    // 4. ENGAGED — the guard is chasing the hostile and has left its post.
    if (g.mode === 'chase' && g._target === 'h' && distPost(g) > GUARD_HOME_EPSILON) mark('engaged', i);
    // 5. KILLED
    if (killed.includes('h')) {
      mark('killed', i);
      // Where the kill landed, which is the whole point of the leash number.
      killDistFromPost = distPost(g);
    }
    // 6. HOME — back on the post, standing guard, target released.
    if (phases.killed !== undefined && g.mode === 'guard'
        && distPost(g) <= GUARD_HOME_EPSILON && g._target === null) mark('home', i);

    // The player: west at PLAYER_SPEED until the far corner, then it stands.
    const pc = centerOf(player);
    if (pc.x > CORNER.x) player.x = Math.max(CORNER.x - player.width / 2, player.x - PLAYER_SPEED * DT);
  }

  return {
    phases, s, g, player, maxGuardStep, guardHitPlayer, guardTargetedPlayer, killDistFromPost,
    hostile: s.creatures.get('h'),
  };
}

// ---------------------------------------------------------------------------
// The trace
// ---------------------------------------------------------------------------

test('golden trace: a player flees through the gate and the guard finishes the chaser', () => {
  const t = runTrace();
  // Exactly the spec's sentence: "player flees -> crosses the gate -> guard
  // disengages its post -> hostile dies -> guard walks home and re-anchors".
  const ORDER = ['armed', 'crossing', 'engaged', 'killed', 'home'];

  for (const name of ORDER) {
    assert.notEqual(t.phases[name], undefined,
      `phase "${name}" never happened. Trace: ${JSON.stringify(t.phases)}`);
  }
  // Ordered, not merely all-present: "the guard walked home" before "the
  // hostile died" is the pre-fix failure wearing the same set of phases.
  for (let i = 1; i < ORDER.length; i++) {
    assert.ok(t.phases[ORDER[i]] > t.phases[ORDER[i - 1]],
      `phase "${ORDER[i]}" (tick ${t.phases[ORDER[i]]}) did not follow "${ORDER[i - 1]}" `
      + `(tick ${t.phases[ORDER[i - 1]]}). Trace: ${JSON.stringify(t.phases)}`);
  }

  // The hostile followed the player through the gate rather than turning back
  // at the wall. Asserted separately from the chain above because WHEN it
  // crossed relative to the guard's sortie is incidental -- what matters is
  // that the village edge is not a barrier (spec §1: a hard barrier would make
  // the rescue a non-event).
  assert.notEqual(t.phases.pursued, undefined, 'the hostile never followed the player inside');
  assert.ok(t.phases.pursued > t.phases.crossing, 'the hostile was inside before the player was');

  // It WALKED home. SOMET-154's last-resort snap would satisfy "re-anchors"
  // with the guard never moving, and that is a different feature.
  const walkStep = CREATURE_SPEED * DT + 1;
  assert.ok(t.maxGuardStep <= walkStep,
    `the guard jumped ${t.maxGuardStep.toFixed(1)}px in one tick — it must walk, not snap`);
});

test('golden trace: the interception happens past the old leash', () => {
  // The tie between this trace and migration 1714440210000. If the kill landed
  // inside 300px of the post, the raise would be doing nothing here and the
  // counterfactual below would be measuring something else.
  const t = runTrace();
  assert.ok(t.killDistFromPost > GUARD_LEASH_RADIUS,
    `the guard finished the hostile ${t.killDistFromPost.toFixed(0)}px from its post, inside the `
    + `old ${GUARD_LEASH_RADIUS}px leash — this trace does not exercise the raise`);
});

test('golden trace: the guard never targets the player and never strikes one', () => {
  // SOMET-285's exploit closure, re-proved on the live path under the new
  // selection rule, with a player standing next to both the guard and its
  // target for most of the run.
  const t = runTrace();
  assert.equal(t.guardTargetedPlayer, false, 'the guard targeted the player it was rescuing');
  assert.equal(t.guardHitPlayer, 0, 'the guard landed a hit on the player it was rescuing');
});

// ---------------------------------------------------------------------------
// The counterfactual
// ---------------------------------------------------------------------------

test('golden trace: at the OLD 300px leash the same rescue fails', () => {
  // Byte-identical scenario, one field different: the guard's leash. This is
  // the defect the migration fixes, reproduced -- the guard chases to an
  // invisible line, the hostile walks past it to the far corner of the guard's
  // OWN village, the held-target check drops it for being outside the leash
  // from home, and the guard turns round and goes back to its post while the
  // player is eaten four tiles away.
  const t = runTrace({ leashRadius: GUARD_LEASH_RADIUS });

  assert.ok(t.hostile, 'the hostile died at the old leash — the raise fixes nothing');
  assert.equal(t.phases.killed, undefined, 'the hostile was killed at the old leash');
  assert.ok(t.hostile.hp > 0);
  // It did engage for a while -- the failure is a chase that cannot finish, not
  // a guard that never noticed.
  assert.notEqual(t.phases.engaged, undefined,
    'fixture: the guard must still have engaged at the old leash, or this is measuring aggro');
  // ...and it is back on its post with the threat still standing in its village.
  assert.equal(t.g.mode, 'guard', 'the guard did not give up and go home');
  assert.ok(distPost(t.hostile) > GUARD_LEASH_RADIUS,
    'fixture: the hostile must end up outside the old leash for this to be the defect');
  assert.ok(t.player.hp < 100000, 'fixture: the player must actually be under attack');
});
