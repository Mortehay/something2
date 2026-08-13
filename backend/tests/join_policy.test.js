const test = require('node:test');
const assert = require('node:assert');

const { mayJoin } = require('../src/services/joinPolicy.js');

// The pure half of the join authorization rule (Plan B slice 3, revised by
// SOMET-293). Every leg is asserted in BOTH directions -- a rule that only ever
// gets tested with inputs that satisfy it is indistinguishable from
// `return { allowed: true }`.
//
// SOMET-293 removed the `fast-travel` leg and added `waypoint-travel`. The
// removal is the risky half: it takes away shipped behaviour, so the legs that
// were supposed to be untouched (`transition`, `resume`, `first-join`) are
// re-asserted here rather than assumed, and there is a sweep at the bottom
// proving no fact combination can still produce the deleted reason.

const FACTS = {
  isEntry: false,
  allowsFastTravel: false,
  visited: false,
  hasHistory: true,
  lastWorldId: null,
};
const facts = (over) => ({ ...FACTS, ...over });
// `facts` is applied AFTER the spread of `over`, not before. Written the other
// way round, `over.facts` (a PARTIAL) overwrote the merged object and every
// unmentioned key arrived undefined -- so `hasHistory` read falsy and three of
// these tests were passing on the first-join leg instead of the one they name.
const decide = (over) => mayJoin({
  isAdmin: false, pendingWorldId: null, worldId: 'W', ...over, facts: facts(over.facts),
});

// A waypoint trip. `travel` present is what turns mayJoin's question from "may
// this character be in that world" into "may it travel there, now".
const TRAVEL = { standingOnActivatedWaypoint: true, destinationActivated: true };
const travelDecide = (over = {}) => decide({
  ...over, travel: { ...TRAVEL, ...(over.travel || {}) },
});

test('a player may not join a world it has no relationship with', () => {
  // The baseline the whole slice exists to establish. Before this rule, this
  // exact frame -- valid token, own character, real world id -- was a
  // successful join into any of the 86 worlds, including dungeon interiors
  // behind portal guards the character had never met.
  const v = decide({ facts: {} });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'not-reachable');
});

test('admins keep the world picker', () => {
  // Existing tooling: the admin picker joins arbitrary worlds by design.
  assert.equal(mayJoin({ isAdmin: true, worldId: 'W', facts: facts({}) }).allowed, true);
});

test('a nonexistent world is refused rather than crashing the rule', () => {
  // joinPolicyFacts returns null for a world id that does not resolve. The
  // handler checks that separately, but a policy that throws on null would turn
  // a refusal into a 'join failed' and a torn-down session.
  const v = mayJoin({ isAdmin: false, worldId: 'W', facts: null });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'unknown-world');
});

test('admin is decided before the facts are read', () => {
  // Ordering matters: an admin joining a world whose row was deleted between
  // the picker rendering and the click must not be refused by the null branch.
  assert.equal(mayJoin({ isAdmin: true, worldId: 'W', facts: null }).allowed, true);
});

test('a server-authorized transition is allowed, a claimed one is not', () => {
  // pendingArrivals is set by the tick loop when it commits a portal or doorway
  // crossing -- and, since SOMET-293, when it commits a waypoint trip. It is the
  // second half of a trip the server already approved, and it is the ONLY leg
  // that works when the fire-and-forget recordVisit alongside that transition
  // fails -- otherwise a bookkeeping error becomes "you may not enter the room
  // you just walked into".
  assert.equal(decide({ pendingWorldId: 'W', facts: {} }).reason, 'transition');
  // A pending arrival somewhere ELSE authorizes nothing here.
  assert.equal(decide({ pendingWorldId: 'OTHER', facts: {} }).allowed, false);
});

test('a null pending arrival never matches a null world id', () => {
  // Written as `pendingWorldId === worldId` this would be true for
  // (null, null) and hand a free pass to any join whose world id failed to
  // resolve. The handler resolves the world first, but the rule must not
  // depend on that to be safe.
  assert.equal(mayJoin({
    isAdmin: false, pendingWorldId: null, worldId: null, facts: facts({}),
  }).allowed, false);
});

test('resume works regardless of the travel flag', () => {
  // Logging out deep inside an unflagged dungeon must not strand the character
  // outside it. This is the SOMET-256 promise and it outranks the flag.
  const v = decide({ facts: { lastWorldId: 'W', allowsFastTravel: false } });
  assert.equal(v.reason, 'resume');
  // ...but only for the world it actually logged out of.
  assert.equal(decide({ facts: { lastWorldId: 'ELSEWHERE' } }).allowed, false);
});

test('SOMET-293: retiring fast travel does not strand a character in a dungeon', () => {
  // The spec's stated risk for this slice, as its own case. A character logged
  // out deep in an unflagged, unvisited-by-the-visit-table dungeon room -- the
  // worst shape there is -- still gets back in, because `resume` never consulted
  // the flag that was just removed. If this ever goes red the retirement has
  // taken someone's only route home with it.
  const dungeon = decide({
    facts: {
      lastWorldId: 'W', allowsFastTravel: false, isEntry: false,
      visited: false, hasHistory: true,
    },
  });
  assert.equal(dungeon.allowed, true);
  assert.equal(dungeon.reason, 'resume');
});

test('SOMET-293: a visited, fast-travel-flagged world is now REFUSED', () => {
  // THE RETIREMENT, stated as the acceptance criterion states it. This exact
  // fact set returned { allowed: true, reason: 'fast-travel' } before this
  // slice: it is what the World Map's click-to-travel was authorized by. With
  // the leg gone, a world the character has visited and that is flagged is
  // reachable only by walking, resuming, or a waypoint it has lit.
  const v = decide({ facts: { visited: true, allowsFastTravel: true, hasHistory: true } });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'not-reachable');
  // Neither half is enough on its own either -- asserted so a partial
  // reinstatement of the leg cannot pass.
  assert.equal(decide({ facts: { visited: true, allowsFastTravel: false } }).allowed, false);
  assert.equal(decide({ facts: { visited: false, allowsFastTravel: true } }).allowed, false);
});

test('a brand-new character may reach the entry world, or a flagged one', () => {
  assert.equal(decide({ facts: { hasHistory: false, isEntry: true } }).reason, 'first-join');
  // is_entry has been lost from live data before (SOMET-265). A flagged world
  // is accepted alongside it so a seed-script regression cannot make new
  // characters unplayable -- flagged worlds are safe surface by construction.
  assert.equal(decide({ facts: { hasHistory: false, allowsFastTravel: true } }).reason, 'first-join');
});

test('the first-join allowance dies the moment the character has been anywhere', () => {
  // Otherwise it is not a first-join allowance at all, it is a permanent
  // "any flagged world, no visit required" rule.
  assert.equal(decide({ facts: { hasHistory: true, isEntry: true } }).allowed, false);
  assert.equal(decide({ facts: { hasHistory: true, allowsFastTravel: true } }).allowed, false);
});

test('first-join does not open unflagged, non-entry worlds', () => {
  // The dungeon case. A character with no history must not be able to name a
  // band 47-50 room and arrive in it.
  assert.equal(decide({ facts: { hasHistory: false } }).allowed, false);
});

// --- the waypoint-travel leg (SOMET-293) ----------------------------------

test('waypoint travel needs BOTH ends lit', () => {
  assert.equal(travelDecide({ facts: {} }).reason, 'waypoint-travel');

  // Standing on an unlit waypoint, or on no waypoint at all -- the handler
  // spells both as `standingOnActivatedWaypoint: false`, so travel from a place
  // you have not lit and travel from open ground refuse identically.
  assert.equal(travelDecide({
    facts: {}, travel: { standingOnActivatedWaypoint: false },
  }).allowed, false);

  // The destination is one the character can SEE but has never stood on. The
  // popup renders it distinctly and refuses to select it; this is the server
  // saying the same thing, which is the half that matters.
  assert.equal(travelDecide({
    facts: {}, travel: { destinationActivated: false },
  }).allowed, false);
});

test('a refused waypoint trip does not fall through to the join cascade', () => {
  // THE LOAD-BEARING CASE for the `travel` branch existing at all. Every fact
  // below would authorize a plain JOIN into this world -- it is where the
  // character logged out, it has visited it, it is flagged, and there is even a
  // pending arrival for it. A travel request with an unlit end must still be
  // refused, or `resume` decides the question instead.
  //
  // `resume` is not a hypothetical here: a player's newest world_players row is
  // the world they are standing in, so without this branch any unlit waypoint in
  // the player's OWN world would be a valid travel target -- exactly what the
  // popup's unactivated state exists to forbid.
  const permissive = {
    lastWorldId: 'W', visited: true, allowsFastTravel: true, isEntry: true, hasHistory: false,
  };
  for (const bad of [
    { standingOnActivatedWaypoint: false },
    { destinationActivated: false },
    { standingOnActivatedWaypoint: false, destinationActivated: false },
  ]) {
    const v = mayJoin({
      isAdmin: false, pendingWorldId: 'W', worldId: 'W',
      facts: facts(permissive), travel: { ...TRAVEL, ...bad },
    });
    assert.equal(v.allowed, false, `travel ${JSON.stringify(bad)} was allowed`);
    assert.equal(v.reason, 'not-reachable');
  }
});

test('a waypoint trip into a world the character has no other claim on is allowed', () => {
  // The inverse of the case above, and the whole point of the feature: a lit
  // waypoint is a claim in its own right. Nothing else here would let the
  // character in -- never logged out there, no pending arrival, unflagged,
  // unvisited, and it has history so first-join is dead.
  const v = mayJoin({
    isAdmin: false, pendingWorldId: null, worldId: 'W',
    facts: facts({ hasHistory: true }), travel: TRAVEL,
  });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'waypoint-travel');
});

test('a waypoint trip into a world that does not resolve is refused', () => {
  // Fail closed. joinPolicyFacts returns null when the destination world row is
  // gone, and a travel that skipped the null check would hand pendingArrivals a
  // world id nothing can load.
  const v = mayJoin({ isAdmin: false, worldId: 'W', facts: null, travel: TRAVEL });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'unknown-world');
});

test('no combination of facts can still produce the retired fast-travel leg', () => {
  // A deleted `if` is easy to re-add by accident in a merge, and this slice is
  // merging alongside three siblings that touch the same region. Sweep the whole
  // fact space and assert the reason token is simply not reachable any more.
  let checked = 0;
  for (const isEntry of [true, false]) {
    for (const allowsFastTravel of [true, false]) {
      for (const visited of [true, false]) {
        for (const hasHistory of [true, false]) {
          for (const lastWorldId of [null, 'W', 'OTHER']) {
            for (const pendingWorldId of [null, 'W', 'OTHER']) {
              for (const travel of [
                null,
                { standingOnActivatedWaypoint: true, destinationActivated: true },
                { standingOnActivatedWaypoint: true, destinationActivated: false },
                { standingOnActivatedWaypoint: false, destinationActivated: true },
                { standingOnActivatedWaypoint: false, destinationActivated: false },
              ]) {
                const v = mayJoin({
                  isAdmin: false, pendingWorldId, worldId: 'W', travel,
                  facts: { isEntry, allowsFastTravel, visited, hasHistory, lastWorldId },
                });
                checked += 1;
                assert.notEqual(v.reason, 'fast-travel',
                  `fast-travel reachable with ${JSON.stringify({ isEntry, allowsFastTravel, visited, hasHistory, lastWorldId, pendingWorldId, travel })}`);
                // Every verdict must carry one of the tokens this file knows
                // about; an unrecognized one means a leg was added without a
                // test, which is how the last one shipped untested.
                assert.ok(
                  ['transition', 'resume', 'first-join', 'waypoint-travel', 'not-reachable'].includes(v.reason),
                  `unknown reason token ${v.reason}`);
              }
            }
          }
        }
      }
    }
  }
  // The sweep is only evidence if it actually ran the whole space.
  assert.equal(checked, 2 * 2 * 2 * 2 * 3 * 3 * 5);
});
