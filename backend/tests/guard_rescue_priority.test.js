// SOMET-291 — a guard picks the hostile that is on a player, not the nearest
// one it happens to see.
//
// Two halves, deliberately: the helper in isolation (where the ordering rule
// lives) and the live tick (where the rule has to survive target RETENTION,
// which is what would have made the helper change inert -- a guard already
// locked onto a slime never re-selects).
const test = require('node:test');
const assert = require('node:assert');
const {
  CreatureSim, selectGuardTarget, engagingAPlayer,
  GUARD_AGGRO_RADIUS,
} = require('../src/authority/creatures.js');

// --- helper-level fixtures ---------------------------------------------------

// selectGuardTarget reads x/y/width/height (via center), faction, hp, _target,
// _targetKind and behavior. Built by hand here rather than through a sim, which
// is what lets a case place two candidates at exact distances.
function hostile(id, x, y, over = {}) {
  return {
    id, x, y, width: 48, height: 48, hp: 100, faction: 'hostile',
    _target: null, _targetKind: null, behavior: { chaseStyle: 'charge' }, ...over,
  };
}
const POST = { x: 1000, y: 1000 };
function guard() {
  return { id: 'g', x: POST.x - 24, y: POST.y - 24, width: 48, height: 48, faction: 'guard', home: { ...POST } };
}
// A player map of the shape tick() builds: userId -> player.
function players(...ids) { return new Map(ids.map((id) => [id, { userId: id }])); }

const RANGE = { aggroRadius: GUARD_AGGRO_RADIUS, leashRadius: 600 };

// --- 1. the rule ------------------------------------------------------------

test('a further hostile fighting a player beats a nearer one that is not', () => {
  const idle = hostile('idle', POST.x + 100 - 24, POST.y - 24);
  const onPlayer = hostile('rescue', POST.x + 350 - 24, POST.y - 24, { _target: 7 });
  const pick = selectGuardTarget({
    guard: guard(), creatures: [idle, onPlayer], ...RANGE, playersById: players(7),
  });
  assert.equal(pick && pick.id, 'rescue',
    'the guard swatted the nearest wanderer while a player was being killed 350px away');
});

// --- 2. distance still decides among equals ---------------------------------

test('between two hostiles both on players, the nearer one wins', () => {
  const near = hostile('near', POST.x + 100 - 24, POST.y - 24, { _target: 7 });
  const far = hostile('far', POST.x + 350 - 24, POST.y - 24, { _target: 8 });
  const pick = selectGuardTarget({
    guard: guard(), creatures: [far, near], ...RANGE, playersById: players(7, 8),
  });
  assert.equal(pick && pick.id, 'near',
    'the rescue key replaced the distance ordering instead of outranking it');
});

// --- 3. the old behaviour, unchanged, for every caller without a player map --

test('with no players map the nearest hostile still wins, exactly as before', () => {
  const near = hostile('near', POST.x + 100 - 24, POST.y - 24);
  // Holding a _target that LOOKS like a rescue: without a players map there is
  // nothing to resolve it against, and a predicate that trusted the field alone
  // would pick this one.
  const far = hostile('far', POST.x + 350 - 24, POST.y - 24, { _target: 7 });
  const pick = selectGuardTarget({ guard: guard(), creatures: [near, far], ...RANGE });
  assert.equal(pick && pick.id, 'near');
});

// --- 4. never a player, and never a friend ----------------------------------

test('a guard still refuses every non-hostile candidate, rescue key or not', () => {
  const g = guard();
  // A player object dropped into the candidate list, and a second guard --
  // neither is faction 'hostile'. The rescue key must not be a way back in.
  const asPlayer = { id: 'p', userId: 7, x: POST.x - 24, y: POST.y - 24, width: 64, height: 64, hp: 100, _target: 7 };
  const other = hostile('otherguard', POST.x + 50 - 24, POST.y - 24, { faction: 'guard', _target: 7 });
  assert.equal(selectGuardTarget({
    guard: g, creatures: [asPlayer, other], ...RANGE, playersById: players(7),
  }), null, 'a guard acquired something that was not a hostile');
});

// --- 5. a guard-styled candidate's creature target is not a rescue -----------

test('a candidate whose _target is a CREATURE id is not treated as a rescue', () => {
  // The id collision this guards against is real: creature ids and player
  // userIds are drawn from different tables and can be the same integer. The
  // discriminator has to be _targetKind, never the value.
  const idle = hostile('idle', POST.x + 100 - 24, POST.y - 24);
  const onCreature = hostile('oncreature', POST.x + 350 - 24, POST.y - 24,
    { _target: 7, _targetKind: 'creature' });
  const pick = selectGuardTarget({
    guard: guard(), creatures: [idle, onCreature], ...RANGE, playersById: players(7),
  });
  assert.equal(pick && pick.id, 'idle',
    'a creature fighting another CREATURE was mistaken for a player being rescued');
});

// --- 5b. a fleeing skittish creature is not an attacker ---------------------

test('a fleeing skittish creature holding a player target is not a rescue', () => {
  // SOMET-290's skittish creatures DO acquire a player and DO enter mode
  // 'chase' -- they have to, to know which way to run -- and they carry
  // faction 'hostile' like every other wild spawn. Read naively, a deer running
  // away from someone is indistinguishable from a wolf killing them, and the
  // guard would leave its gate to chase the deer.
  const idle = hostile('idle', POST.x + 100 - 24, POST.y - 24);
  const deer = hostile('deer', POST.x + 350 - 24, POST.y - 24,
    { _target: 7, behavior: { chaseStyle: 'skittish' } });
  assert.equal(engagingAPlayer(deer, players(7)), false,
    'a fleeing skittish creature reads as engaging the player it is running from');
  const pick = selectGuardTarget({
    guard: guard(), creatures: [idle, deer], ...RANGE, playersById: players(7),
  });
  assert.equal(pick && pick.id, 'idle', 'the guard abandoned its post to chase a fleeing deer');
});

test('the SAME skittish creature is a rescue once it has been provoked', () => {
  // The other half: a provoked skittish creature fights exactly like a charger,
  // so it must rank exactly like one. Without this the exclusion above would be
  // a blanket "skittish creatures are never a threat", which is false the
  // moment one is hit.
  const idle = hostile('idle', POST.x + 100 - 24, POST.y - 24);
  const angry = hostile('angry', POST.x + 350 - 24, POST.y - 24,
    { _target: 7, _provoked: true, behavior: { chaseStyle: 'skittish' } });
  assert.equal(engagingAPlayer(angry, players(7)), true);
  const pick = selectGuardTarget({
    guard: guard(), creatures: [idle, angry], ...RANGE, playersById: players(7),
  });
  assert.equal(pick && pick.id, 'angry');
});

// --- 5c. a stale target is not a rescue -------------------------------------

test('a hostile holding the id of a player who is gone is not a rescue', () => {
  const idle = hostile('idle', POST.x + 100 - 24, POST.y - 24);
  // _target 9 survives on the creature until its own next tick; the player map
  // is the only live statement of who is actually here.
  const stale = hostile('stale', POST.x + 350 - 24, POST.y - 24, { _target: 9 });
  const pick = selectGuardTarget({
    guard: guard(), creatures: [idle, stale], ...RANGE, playersById: players(7),
  });
  assert.equal(pick && pick.id, 'idle');
});

// --- the live tick ----------------------------------------------------------

const MAP = { chunkSize: 64, isWalkable: () => true, speedAt: () => 1 };
const KEYS = new Set(['0,0']);

// A guard on the profile SHAPE the catalog gives it (chaseStyle 'guard'), with
// the raised leash. Hand-built rather than read from the catalog because these
// cases are about ORDERING, not about the tuning -- guard_rescue_leash_db and
// the golden trace cover the shipped numbers.
function guardBehavior(over = {}) {
  return {
    name: 'Guard', chaseStyle: 'guard', aggroRadius: 400, leashRadius: 600,
    preferredRange: 0, moveSpeedMult: 1, damageOverride: null,
    abilities: [{
      slot: 1, name: 'Strike', attackKind: 'melee', attackRange: 60,
      attackCooldown: 1, projectileSpeed: 0, projectileRadius: 0,
      element: null, damageMult: 1, knockback: 0,
    }],
    ...over,
  };
}

// Two hostiles inside the guard's leash: `idle` NEARER, `chaser` further but
// close enough to a player to acquire one. The player is placed so it is inside
// `chaser`'s 400px aggro and outside `idle`'s, which is what makes the two
// hostiles differ ONLY in whether they are on a player.
//
// Both hostiles run the `hold` style (the catalog's Sentry rung: acquires a
// target, never moves). That freezes the whole geometry, which is what these
// cases need and what a `charge` fixture cannot give: a charging `chaser` walks
// toward the player, crosses the guard's 600px leash from the post, and is
// correctly dropped as a target -- so the run would measure the leash boundary
// rather than the ordering rule and read as the guard being "stolen back". The
// guard is the only thing that moves here.
//
// hp 1e9 and damage 0 on both: the point is which creature the guard picks over
// many ticks, and a fight that resolves would end the scenario early.
function holdBehavior() {
  return {
    name: 'Sentry', chaseStyle: 'hold', aggroRadius: 400, leashRadius: 800,
    preferredRange: 0, moveSpeedMult: 1, damageOverride: null,
    abilities: [{
      slot: 1, name: 'Strike', attackKind: 'melee', attackRange: 60,
      attackCooldown: 1, projectileSpeed: 0, projectileRadius: 0,
      element: null, damageMult: 1, knockback: 0,
    }],
  };
}

function field(opts = {}) {
  const s = new CreatureSim(MAP, () => 0.5);
  const home = { x: 1000, y: 1000 };
  s.addCreatures([
    {
      id: 'g', type: 'Village Guard', x: home.x - 24, y: home.y - 24, hp: 1e9,
      faction: 'guard', home_x: home.x, home_y: home.y,
      behavior: guardBehavior(), damage: 0,
    },
    { id: 'idle', type: 'Slime', x: home.x + 120 - 24, y: home.y - 24, hp: 1e9, damage: 0, behavior: holdBehavior() },
    { id: 'chaser', type: 'Slime', x: home.x + 400 - 24, y: home.y - 24, hp: 1e9, damage: 0, behavior: holdBehavior() },
  ]);
  // 700px east of the post: 300px from `chaser` (inside its 400 aggro) and
  // 580px from `idle` (outside it). Also outside `chaser`'s own 60px reach, so
  // nothing in this fixture ever damages the player -- which is what lets the
  // last case attribute a single lost hit point to the guard.
  const player = {
    userId: 7, x: home.x + 700 - 32, y: home.y - 32,
    width: 64, height: 64, hp: 1e9, mit: null,
  };
  return { s, player, home, ...opts };
}

test('the tick sends the guard after the hostile that is on a player, not the nearer one', () => {
  const { s, player } = field();
  // Ten ticks, not one: on tick 1 the hostiles have not resolved their own
  // targets yet (they are ticked in Map order alongside the guard), so an
  // assertion there would be pinning insertion order rather than the rule.
  for (let i = 0; i < 10; i++) s.tick(0.05, KEYS, [player], i * 0.05);
  const g = s.creatures.get('g');
  assert.equal(s.creatures.get('chaser')._target, 7, 'fixture: chaser must actually be on the player');
  assert.equal(s.creatures.get('idle')._target, null, 'fixture: idle must NOT be on the player');
  assert.equal(g._target, 'chaser', 'the guard went for the nearer wanderer');
  assert.equal(g._targetKind, 'creature');
});

test('a guard already locked onto a wanderer switches when a player is attacked', () => {
  const { s, player } = field();
  const g = s.creatures.get('g');
  // No players at all first: the guard locks onto the nearest hostile, which is
  // the state the retention rule would otherwise freeze it in forever.
  for (let i = 0; i < 10; i++) s.tick(0.05, KEYS, [], i * 0.05);
  assert.equal(g._target, 'idle', 'precondition: the guard must start on the wanderer');

  for (let i = 0; i < 20; i++) s.tick(0.05, KEYS, [player], 1 + i * 0.05);
  assert.equal(g._target, 'chaser',
    'the guard kept swatting a slime while a player was being attacked — held-target retention '
    + 'makes the selection rule inert without the upgrade');
});

test('a guard on a rescue is not stolen back by a nearer wanderer', () => {
  const { s, player } = field();
  const g = s.creatures.get('g');
  for (let i = 0; i < 10; i++) s.tick(0.05, KEYS, [player], i * 0.05);
  assert.equal(g._target, 'chaser', 'precondition: the guard must be on the rescue');

  // `idle` is permanently nearer, so if the rule re-selected on distance at any
  // point this run would catch it. 200 ticks = 10s.
  let stolen = 0;
  for (let i = 0; i < 200; i++) {
    s.tick(0.05, KEYS, [player], 1 + i * 0.05);
    if (g._target !== 'chaser') stolen++;
  }
  assert.equal(stolen, 0, `the guard was pulled off the rescue on ${stolen} ticks`);
});

test('through all of it the guard never targets or strikes the player', () => {
  // SOMET-285's exploit-closing rule, re-proved under the new selection: a
  // priority key over the candidate list is exactly the kind of change that
  // could smuggle a player back in.
  const { s, player } = field();
  const g = s.creatures.get('g');
  const hp0 = player.hp;
  let sawPlayerTarget = false;
  let guardHitPlayer = 0;
  for (let i = 0; i < 200; i++) {
    const { attacks, impacts } = s.tick(0.05, KEYS, [player], i * 0.05);
    if (g._target === player.userId || g._targetKind === 'player') sawPlayerTarget = true;
    // stampCreatureAttack pushes one entry to EACH array per landed contact
    // hit, so index i of one pairs with index i of the other. Attribution
    // matters here: an hp assertion alone would also go red for a hit landed
    // by one of the hostiles, which is a different bug entirely.
    attacks.forEach((a, k) => {
      if (a.a === 'c:g' && impacts[k] && impacts[k].t === `p:${player.userId}`) guardHitPlayer++;
    });
  }
  assert.equal(sawPlayerTarget, false, 'the guard targeted the player');
  assert.equal(guardHitPlayer, 0, 'the guard landed a hit on the player');
  assert.equal(player.hp, hp0, 'the player lost hp — nothing in this fixture can reach them');
});
