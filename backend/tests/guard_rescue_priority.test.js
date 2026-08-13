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
const { applyDamage } = require('../src/authority/damage.js');

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

// --- the live tick: the three exclusions ------------------------------------
//
// The half above proves a rescue is ORDERED first. This half proves the three
// things that are NOT rescues, through the same tick.
//
// It exists because the helper cases (5, 5b, 5c) are exactly the kind that can
// go inert: each one calls engagingAPlayer and selectGuardTarget directly, so a
// tick that stopped passing `playersById` at all, or a `_target` the tick never
// actually writes in the shape the fixture assumes, would leave every one of
// them green. Only a run of tick() can say the exclusions hold against the
// fields the tick really writes -- and against target RETENTION, which turns a
// single wrong pick into a guard that is off its post for good.

// The Skittish profile as SOMET-290's migration authored it, plus its Nip
// ability. Spelled out rather than read from the catalog for the reason
// creature_skittish.test.js spells it out: this is the INPUT to the behaviour
// under test, and a fixture that read the same row the tick reads could not
// tell a correct tick from one that ignores the profile entirely.
function skittishBehavior() {
  return {
    name: 'Skittish', chaseStyle: 'skittish', aggroRadius: 300, leashRadius: 500,
    preferredRange: 150, moveSpeedMult: 1.15, damageOverride: null,
    abilities: [{
      slot: 1, name: 'Nip', attackKind: 'melee', attackRange: 60,
      attackCooldown: 1.2, projectileSpeed: 0, projectileRadius: 0,
      element: null, damageMult: 1, knockback: 0,
    }],
  };
}

// Everything in this field is a live hostile inside BOTH the guard's 400px
// aggro and its 600px leash for the whole run, so the only thing that can
// decide the guard's target is the rescue predicate:
//
//   idle    120px E of the post. Nearest, and the player is 480px away -- out
//           of its 400px aggro -- so it holds nobody and is never a rescue.
//   deer    350px E, Skittish, with a player 250px further east: inside its
//           300px aggro (so the tick really does write _target = 7) and outside
//           its 150px preferred range (so it stands and watches, which is what
//           keeps the geometry frozen for the whole run).
//   warden  300px N, guard-STYLED but carrying faction 'hostile', locked onto
//           creature 7 -- whose id is the same integer as the player's userId.
//   c7      200px N, that creature.
//
// The warden is the one shape here the shipped catalog does not produce (every
// Guard row is faction 'guard'). It is in the fixture because selectGuardTarget
// admits candidates by FACTION while the tick routes branches by BEHAVIOUR, so
// nothing but data discipline keeps the two aligned -- and because a candidate
// carrying `_targetKind: 'creature'` is only reachable through the guard branch,
// which is the only writer of that field.
//
// hp 1e9 and damage 0 everywhere, for the same reason the field above uses
// them: these cases are about who the guard picks over many ticks, and a fight
// that resolved would end the run early.
function exclusionField() {
  const s = new CreatureSim(MAP, () => 0.5);
  const home = { x: 1000, y: 1000 };
  s.addCreatures([
    {
      id: 'g', type: 'Village Guard', x: home.x - 24, y: home.y - 24, hp: 1e9,
      faction: 'guard', home_x: home.x, home_y: home.y,
      behavior: guardBehavior(), damage: 0,
    },
    { id: 'idle', type: 'Slime', x: home.x + 120 - 24, y: home.y - 24, hp: 1e9, damage: 0, behavior: holdBehavior() },
    { id: 'deer', type: 'Deer', x: home.x + 350 - 24, y: home.y - 24, hp: 1e9, damage: 0, behavior: skittishBehavior() },
    {
      id: 'warden', type: 'Rogue Guard', x: home.x - 24, y: home.y - 300 - 24, hp: 1e9, damage: 0,
      faction: 'hostile', home_x: home.x, home_y: home.y - 300, behavior: guardBehavior(),
    },
    // Numeric id, and the SAME integer as the player's userId below: creature
    // ids and userIds come from different tables, so this collision is a fact
    // about the data and not a contrivance.
    { id: 7, type: 'Slime', x: home.x - 24, y: home.y - 200 - 24, hp: 1e9, damage: 0, behavior: holdBehavior() },
  ]);
  const player = {
    userId: 7, x: home.x + 600 - 32, y: home.y - 32,
    width: 64, height: 64, hp: 1e9, mit: null,
  };
  return { s, player, home };
}

test('the tick never sends the guard after a fleeing deer or a hostile fighting a creature', () => {
  const { s, player } = exclusionField();
  const g = s.creatures.get('g');
  const deer = s.creatures.get('deer');
  const deerX = deer.x, deerY = deer.y;

  // Per-tick counters rather than an end state: a guard that was pulled off its
  // post for twenty ticks and drifted back would pass a final-value check, and
  // twenty ticks is a dead player.
  let ticksOnDeer = 0, ticksOnWarden = 0;
  for (let i = 0; i < 60; i++) {
    s.tick(0.05, KEYS, [player], i * 0.05);
    if (g._target === 'deer') ticksOnDeer++;
    if (g._target === 'warden') ticksOnWarden++;
  }

  // The fixture really did put both refused shapes in front of the guard. Each
  // of these is what makes the counters above mean something: without them a
  // deer that never noticed the player, or a warden that never acquired
  // anything, would score 0 for the wrong reason.
  assert.equal(deer._target, 7, 'fixture: the deer must be holding the player it is watching');
  assert.equal(deer._targetKind, null, 'fixture: a non-guard creature leaves _targetKind unset');
  assert.ok(!deer._provoked, 'fixture: the deer must still be prey — nothing here hits it');
  assert.equal(deer.x, deerX, 'fixture: the deer must stand and watch, not drift out of range');
  assert.equal(deer.y, deerY, 'fixture: the deer must stand and watch, not drift out of range');
  const warden = s.creatures.get('warden');
  assert.equal(warden._target, 7, 'fixture: the warden must be locked onto creature 7');
  assert.equal(warden._targetKind, 'creature', 'fixture: the warden must be on a CREATURE');
  assert.equal(s.creatures.get('idle')._target, null, 'fixture: idle must hold nobody');

  assert.equal(ticksOnDeer, 0,
    `the guard abandoned its post to chase a fleeing deer on ${ticksOnDeer} of 60 ticks`);
  assert.equal(ticksOnWarden, 0,
    `the guard treated a hostile fighting a CREATURE as a rescue on ${ticksOnWarden} of 60 ticks`);
  assert.equal(g._target, 'idle', 'the guard ended the run on something other than the nearest hostile');
});

test('the tick sends the guard after the SAME deer the moment it is provoked', () => {
  // The other half, and the reason the case above is not simply "guards ignore
  // skittish creatures": a provoked deer fights like anything else, so the
  // exclusion has to lift the instant it does. Without this pair, deleting the
  // provocation term would leave a guard that never rescues anyone from an
  // angry animal.
  const { s, player } = exclusionField();
  const g = s.creatures.get('g');
  const deer = s.creatures.get('deer');
  for (let i = 0; i < 20; i++) s.tick(0.05, KEYS, [player], i * 0.05);
  assert.equal(g._target, 'idle', 'precondition: the guard must start on the nearest wanderer');

  // The real damage funnel, not a hand-set flag: applyDamage stamping
  // `_provoked` is the only thing that converts a skittish creature, and a
  // fixture that set the field itself could not tell the two apart.
  applyDamage(deer, 10, 'physical', deer.mit);

  // One tick is enough: the guard is ticked first, and the deer already holds
  // the player, so the upgrade has everything it needs on the very next pass.
  s.tick(0.05, KEYS, [player], 1);
  assert.equal(g._target, 'deer', 'a provoked deer mauling a player did not outrank a wandering slime');
  // ...and it stays there. 40 ticks = 2s, over which the deer closes at most
  // ~92px on the player and so stays well inside the 600px leash from the post:
  // this measures retention, not the leash boundary.
  let stolen = 0;
  for (let i = 0; i < 40; i++) {
    s.tick(0.05, KEYS, [player], 1.05 + i * 0.05);
    if (g._target !== 'deer') stolen++;
  }
  assert.equal(stolen, 0, `the guard was pulled off the provoked deer on ${stolen} ticks`);
});

test('a hostile still holding a departed player id does not pull the guard off its post', () => {
  // The stale-target exclusion, on the live path. The window is real and it is
  // exactly one tick wide: `_target` is only cleared by the holder's OWN tick,
  // and the guard is ticked before it.
  const { s, player, home } = field();
  const g = s.creatures.get('g');
  const chaser = s.creatures.get('chaser');
  // A second, live player, far west of everything: 1100px from the chaser and
  // 820px from `idle`, so nothing in the field can acquire them. Their only job
  // is to make the players map non-empty, so what refuses the stale rescue is
  // the IDENTITY of the held target rather than an empty world.
  const bystander = {
    userId: 8, x: home.x - 700 - 32, y: home.y - 32,
    width: 64, height: 64, hp: 1e9, mit: null,
  };

  for (let i = 0; i < 10; i++) s.tick(0.05, KEYS, [bystander], i * 0.05);
  assert.equal(g._target, 'idle', 'precondition: the guard must start on the nearest wanderer');
  assert.equal(chaser._target, null, 'precondition: nobody is being hunted yet');

  // Player 7 arrives for a single tick. The guard is ticked FIRST, so on this
  // tick it still reads a chaser that has acquired nobody -- the acquisition
  // happens later in this same loop.
  s.tick(0.05, KEYS, [bystander, player], 0.5);
  assert.equal(chaser._target, 7, 'fixture: the chaser must have acquired the arriving player');

  // ...and logs out. Entering this tick the chaser looks exactly like a rescue:
  // hostile, alive, inside the leash, holding a player id. The only thing that
  // says otherwise is that the id resolves to nobody.
  s.tick(0.05, KEYS, [bystander], 0.55);
  assert.equal(g._target, 'idle',
    'the guard left its post for a hostile whose player had already logged out');
  assert.equal(chaser._target, null, 'fixture: the stale window is exactly one tick wide');
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
