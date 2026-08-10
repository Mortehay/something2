const test = require('node:test');
const assert = require('node:assert');

const { mayJoin } = require('../src/services/joinPolicy.js');

// The pure half of the join authorization rule (Plan B slice 3). Every leg is
// asserted in BOTH directions -- a rule that only ever gets tested with inputs
// that satisfy it is indistinguishable from `return { allowed: true }`.

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
  // crossing. It is the second half of a trip the server already approved, and
  // it is the ONLY leg that works when the fire-and-forget recordVisit
  // alongside that transition fails -- otherwise a bookkeeping error becomes
  // "you may not enter the room you just walked into".
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

test('fast travel needs BOTH visited and the flag', () => {
  assert.equal(decide({ facts: { visited: true, allowsFastTravel: true } }).reason, 'fast-travel');
  // visited alone is the portal-guard bypass the flag exists to prevent: a
  // character that once walked through a dungeon room could teleport back into
  // it at any level, and the guard creature becomes decorative.
  assert.equal(decide({ facts: { visited: true, allowsFastTravel: false } }).allowed, false);
  // the flag alone would let a character skip to a hub it has never seen.
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
