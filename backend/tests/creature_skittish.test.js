const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim, shoveCreature, isEngagingPlayer } = require('../src/authority/creatures.js');
const {
  applyDamage, isProvokedBy, playerKey, PROVOKE_MEMORY_MS,
} = require('../src/authority/damage.js');

// Same harness the other behaviour suites use (authority_creature_styles.test.js,
// authority_creatures.test.js): an all-walkable stub map unless a scenario needs
// a wall, and an rng of 0.05 -- ABOVE the tick's REDIRECT_CHANCE of 0.02, and
// the redirect fires on `rng() < REDIRECT_CHANCE`, so a roaming creature never
// changes direction on its own. `isWalkable` is a parameter here rather than a
// boolean flag because the cornered case needs ONE blocked face, not a blocked
// world.
function stubMap(isWalkable = () => true) {
  return { isWalkable, speedAt: () => 1, chunkSize: 8 };
}
const noRedirect = () => 0.05;

// `dt` is SECONDS and `now` is the world clock in MILLISECONDS -- world.js
// advances `this.now += dt * 1000` and hands that to CreatureSim.tick. Spelled
// out as two constants because SOMET-290's provocation memory expires against
// that clock (PROVOKE_MEMORY_MS): a test that fed `now` in seconds would be
// exercising a memory a thousand times longer than the live one and could not
// tell an expiry that works from one that never fires.
const DT = 0.05;
const MS = DT * 1000;

// Copied from authority_creature_styles.test.js -- an override naming an attack
// field has to land on the ability rather than on the behaviour (SOMET-253).
const ABILITY_KEYS = new Set([
  'slot', 'attackKind', 'attackRange', 'attackCooldown',
  'projectileSpeed', 'projectileRadius', 'element', 'damageMult', 'knockback',
]);

function behavior(over = {}) {
  const ability = {
    slot: 1, name: 'Attack', attackKind: 'melee', attackRange: 60, attackCooldown: 1,
    projectileSpeed: 0, projectileRadius: 0, element: null, damageMult: 1, knockback: 0,
  };
  const bh = {
    name: 'T', aggroRadius: 400, leashRadius: 800,
    chaseStyle: 'charge', preferredRange: 0, moveSpeedMult: 1, damageOverride: null,
  };
  for (const [k, v] of Object.entries(over)) {
    if (ABILITY_KEYS.has(k)) ability[k] = v; else bh[k] = v;
  }
  return { ...bh, abilities: [ability] };
}

// The Skittish profile as Task 1's migration authored it, plus its Nip ability.
// Spelled out here rather than read from the catalog: this is the INPUT to the
// behaviour under test, and a test that read the same row the tick reads could
// not tell a correct tick from one that ignores the profile entirely.
function skittish(over = {}) {
  return behavior({
    name: 'Skittish', chaseStyle: 'skittish',
    aggroRadius: 300, leashRadius: 500, preferredRange: 150, moveSpeedMult: 1.15,
    attackKind: 'melee', attackRange: 60, attackCooldown: 1.2,
    ...over,
  });
}

// Creature box at (2000,2000) -> centre (2024,2024). Deliberately FAR from the
// origin: chunkOf floors, so a creature fleeing west past x=0 lands in chunk -1
// and the tick would silently freeze it (skipped as inactive), which would make
// every retreat assertion below pass for the wrong reason.
const BOX = 2000;
const CX = 2024, CY = 2024;

function activeChunks() {
  const s = new Set();
  for (let cx = -1; cx <= 5; cx++) for (let cy = -1; cy <= 5; cy++) s.add(`${cx},${cy}`);
  return s;
}

// Player placed by its CENTRE on the x axis, level with the creature, so every
// scenario below is one-dimensional and `vy` is exactly 0.
function player(userId, centerX, centerY = CY) {
  return {
    userId, x: centerX - 24, y: centerY - 24,
    width: 48, height: 48, hp: 500, mit: null,
  };
}

function scenario(bh, playerCenterX, opts = {}) {
  const s = new CreatureSim(stubMap(opts.isWalkable), opts.rng || noRedirect);
  s.addCreatures([{
    id: 'c', type: 'T', x: BOX, y: BOX, hp: 100, behavior: bh, damage: 5,
    ...(opts.creature || {}),
  }]);
  return { s, player: player('u1', playerCenterX), active: activeChunks(), c: s.all()[0] };
}

function apart(c, p) {
  return Math.hypot((c.x + c.width / 2) - (p.x + p.width / 2),
    (c.y + c.height / 2) - (p.y + p.height / 2));
}
function fromHome(c, home = { x: CX, y: CY }) {
  return Math.hypot((c.x + c.width / 2) - home.x, (c.y + c.height / 2) - home.y);
}
// The live damage funnel, named the way a real hit is: a player id and the
// world clock. Hand-setting `_provokedBy` would prove nothing about whether
// damage.js and the tick are one feature.
function hit(c, userId, now, dmg = 10) {
  applyDamage(c, dmg, 'physical', c.mit, now, playerKey(userId));
}
function angryAt(c, userId, now) { return isProvokedBy(c, playerKey(userId), now); }

// --- 1. WALK PAST UNHARMED ---------------------------------------------------

test('an unprovoked skittish creature never attacks, even standing on top of a player', () => {
  // 40px apart: INSIDE its own 60px Nip range, so every tick of this run is a
  // tick a charger would have opened with. Nothing but the behaviour is
  // stopping it.
  const { s, player: p, active, c } = scenario(skittish(), CX + 40);
  const hp0 = p.hp;
  let swings = 0;
  for (let i = 0; i < 80; i++) swings += s.tick(DT, active, [p], i * MS).attacks.length;
  assert.equal(swings, 0, 'a skittish creature stamped an attack at an unharmed player');
  assert.equal(p.hp, hp0, 'the player lost hp to a creature that was never provoked');
  // It had the player TARGETED the whole time -- not attacking was a decision,
  // not a creature that never noticed anyone.
  assert.equal(c.mode, 'chase');
});

// --- 2. RETREAT --------------------------------------------------------------

test('it backs away from a player inside its preferred range', () => {
  const { s, player: p, active, c } = scenario(skittish(), CX + 100); // 100 < preferredRange 150
  const samples = [apart(c, p)];
  for (let i = 0; i < 5; i++) {
    s.tick(0.1, active, [p], i * 100);
    samples.push(apart(c, p));
  }
  // The trend, not a coordinate: asserting an exact x would pin CREATURE_SPEED
  // and moveSpeedMult rather than the behaviour.
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i] > samples[i - 1],
      `tick ${i}: distance went ${samples[i - 1].toFixed(2)} -> ${samples[i].toFixed(2)}`);
  }
  // Fixture guard: the whole run must stay inside the flee band, or the trend
  // above would be measuring the stand-and-watch band instead.
  assert.ok(samples[samples.length - 1] < 150,
    `run left the flee band (${samples[samples.length - 1].toFixed(2)} >= 150)`);
});

// --- 3. STAND AND WATCH ------------------------------------------------------

test('it holds still for a player between preferred range and aggro radius', () => {
  const { s, player: p, active, c } = scenario(skittish(), CX + 200); // 150 < 200 < 300
  const x0 = c.x, y0 = c.y;
  for (let i = 0; i < 40; i++) s.tick(DT, active, [p], i * MS);
  assert.equal(c.x, x0, 'moved on x while watching');
  assert.equal(c.y, y0, 'moved on y while watching');
  // Standing still because it is WATCHING, not because it fell through to the
  // roam block with no target (which would have wandered anyway).
  assert.equal(c.mode, 'chase');
});

// --- 4. PROVOKED BY DAMAGE ---------------------------------------------------

test('once damaged it closes on the player and bites', () => {
  const { s, player: p, active, c } = scenario(skittish(), CX + 200);
  // Inert first, so the closing below is attributable to the hit and to nothing
  // else about the fixture.
  for (let i = 0; i < 10; i++) s.tick(DT, active, [p], i * MS);
  assert.equal(p.hp, 500, 'precondition: it must be calm before the hit');
  const before = apart(c, p);

  // The real Task-2 funnel, not a hand-set flag: this is the only thing that
  // makes damage.js and the tick one feature rather than two.
  hit(c, 'u1', 500);

  for (let i = 0; i < 120; i++) s.tick(DT, active, [p], 500 + i * MS);
  assert.ok(apart(c, p) < before,
    `provoked creature did not close (${before.toFixed(2)} -> ${apart(c, p).toFixed(2)})`);
  // Both halves: a creature that turns to face you and never swings is the
  // inert half of this bug.
  assert.ok(p.hp < 500, 'it closed on the player but never bit');
});

// --- 5. CORNERED -------------------------------------------------------------

test('a creature cornered against a wall turns and fights instead of jittering', () => {
  // One wall, along the west face of the creature's own tile. The player is to
  // the east, so every retreat step aims straight into it.
  const { s, player: p, active, c } = scenario(skittish(), CX + 100, { isWalkable: (x) => x >= BOX });

  s.tick(DT, active, [p], 0);
  assert.equal(c.x, BOX, 'precondition: the wall must actually refuse the retreat');
  assert.ok(angryAt(c, 'u1', 0), 'nowhere to run and it still did not fight');

  for (let i = 1; i < 120; i++) s.tick(DT, active, [p], i * MS);
  assert.ok(p.hp < 500, 'a cornered creature that never bites is just jittering in place');
});

// SOMET-290 follow-up (finding 4): the cornered rule's own comment says the
// refusal it acts on is a TERRAIN refusal "and only" a terrain refusal. There
// was a second way in with no wall and no damage anywhere near it.
test('a player standing exactly on top of one does not corner it', () => {
  // Centres coincide, so the flee vector is (0,0) -- and resolveMove
  // short-circuits a zero vector to `moved: false` before it ever consults the
  // map (collision.js's first line). Read as "cornered", that made a player who
  // walked onto a deer provoke it without a wall, without a leash and without
  // landing a single hit.
  const { s, player: p, active, c } = scenario(skittish(), CX);
  assert.equal(apart(c, p), 0, 'fixture: the centres must coincide exactly');

  for (let i = 0; i < 40; i++) s.tick(DT, active, [p], i * MS);

  assert.ok(!angryAt(c, 'u1', 40 * MS),
    'a player standing on it cornered it -- with no terrain involved');
  assert.equal(p.hp, 500, 'it bit a player who never touched it');
});

// --- 6. NOT HERDED -----------------------------------------------------------

// A player who never gives up: steps 1.5px (30px/s) toward the creature's
// current centre every tick, forever. Deliberately PURSUING rather than walking
// a fixed line west, because a player who walks past and keeps going leaves the
// 300px aggro radius and the creature drops its target. Pursuing keeps `mode` at
// 'chase' for the whole run, so the leash is provably the only thing limiting
// how far the creature gets from home.
function pursue(p, c, step = 1.5) {
  const px = p.x + p.width / 2;
  const cx = c.x + c.width / 2;
  if (px !== cx) p.x += Math.sign(cx - px) * step;
}

test('a creature with a home anchor cannot be herded past its leash', () => {
  // leashRadius 200 (rather than the profile's 500) purely to keep the run
  // short; the rule under test is the clamp, not the number.
  const bh = skittish({ leashRadius: 200 });
  const { s, player: p, active, c } = scenario(bh, CX + 200, { creature: { home_x: CX, home_y: CY } });

  // 30 seconds of pursuit -- long enough to walk the creature 900px off its
  // anchor if nothing stopped it.
  let herded = 0;
  let everRoamed = false;
  for (let i = 0; i < 600; i++) {
    pursue(p, c);
    s.tick(DT, active, [p], i * MS);
    herded = Math.max(herded, fromHome(c));
    everRoamed = everRoamed || c.mode !== 'chase';
  }

  assert.equal(everRoamed, false, 'fixture: it dropped its target, so this run measured roam');
  assert.ok(herded <= 200 + 1e-6, `herded ${herded.toFixed(2)}px from home, leash is 200`);
  // ...and it did reach the edge, so the clamp was actually exercised rather
  // than vacuously satisfied by a creature that never moved.
  assert.ok(herded > 150, `only reached ${herded.toFixed(2)}px from home: the clamp never bit`);
  // The map is entirely walkable here, so the ONLY thing that can refuse a
  // retreat step is the leash -- and a leash refusal must NOT provoke. See the
  // next case for why that distinction is the whole point of the clamp.
  assert.ok(!angryAt(c, 'u1', 600 * MS), 'the leash itself cornered it');
});

// --- 6b. THE LEASH MUST NOT PROVOKE ------------------------------------------

test('a creature pinned against its own leash never converts and never leaves the leash', () => {
  // The regression this exists for: while a leash refusal counted as "cornered"
  // alongside a terrain refusal, enforcing the leash DESTROYED it. The refusal
  // provoked the creature, `fleeing` went false from the next tick, and the
  // clamp only ever applies to a flee step -- so the creature converted at its
  // own boundary and then chased the player straight out of the pen with
  // nothing holding it. flushAndPrune persists x/y, so the escape outlived the
  // process: a pen would drain permanently, one creature per player who
  // wandered in.
  //
  // Same fixture as case 6, run three times as long and starting from the
  // stand-and-watch band, so the run covers the approach, the retreat, the pin,
  // and 80 further seconds of a player standing on top of a pinned creature --
  // "however long the player keeps advancing".
  const bh = skittish({ leashRadius: 200 });
  const { s, player: p, active, c } = scenario(bh, CX + 250, { creature: { home_x: CX, home_y: CY } });

  let maxFromHome = 0;
  let everProvoked = false;
  let everRoamed = false;
  for (let i = 0; i < 1800; i++) {
    pursue(p, c);
    s.tick(DT, active, [p], i * MS);
    // Per-tick, not just at the end: a creature that escaped and was later
    // dragged back would pass an end-state check.
    maxFromHome = Math.max(maxFromHome, fromHome(c));
    everProvoked = everProvoked || angryAt(c, 'u1', i * MS);
    everRoamed = everRoamed || c.mode !== 'chase';
  }

  assert.equal(everRoamed, false, 'fixture: it dropped its target, so this run measured roam');
  assert.equal(everProvoked, false,
    'the leash edge provoked it -- the clamp converted the creature it exists to contain');
  assert.ok(maxFromHome <= 200 + 1e-6,
    `left its leash: reached ${maxFromHome.toFixed(2)}px from home, leash is 200`);
  // It really was pushed to the boundary, so the assertions above are not
  // vacuously true of a creature that never had to give ground.
  assert.ok(maxFromHome > 150,
    `only reached ${maxFromHome.toFixed(2)}px from home: it was never pinned`);
  // Still prey at the end of all that: pinned and calm is the intended
  // "you can walk up to one and hunt it" outcome, not a fight.
  assert.equal(p.hp, 500, 'a creature cornered only by its own leash bit the player');
});

// --- 7. UNANCHORED IS UNCONSTRAINED ------------------------------------------

test('the same creature with no home anchor is not clamped at all', () => {
  // Byte-identical to case 6 except for the missing home_x/home_y -- which is
  // every wild spawn in the world today.
  const bh = skittish({ leashRadius: 200 });
  const { s, player: p, active, c } = scenario(bh, CX + 200);
  assert.equal(c.home, null, 'precondition: this creature must have no anchor');

  const startX = c.x;
  for (let i = 0; i < 600; i++) {
    p.x -= 1.5;
    s.tick(DT, active, [p], i * MS);
  }

  const travelled = Math.abs(c.x - startX);
  assert.ok(travelled > 200, `only travelled ${travelled.toFixed(2)}px: the clamp bit a homeless creature`);
  // Nothing refused a step: on an open map with a null home there is nothing
  // that CAN refuse one, so a provoked creature here would mean the clamp is
  // treating "no home" as "pinned".
  assert.ok(!angryAt(c, 'u1', 600 * MS),
    'a homeless creature was cornered by something that does not exist');
  assert.equal(p.hp, 500, 'it fled the whole way, so it must never have attacked');
});

// --- 8. CALMS DOWN -----------------------------------------------------------

test('provocation expires, so a later encounter starts skittish again', () => {
  // SOMET-290 follow-up (finding 3). This used to assert that provocation
  // cleared on the first tick with no target, which is what made a creature
  // shot from out of aggro range forget its attacker before it could ever
  // answer. Forgetting is a CLOCK now: the memory runs out, whether or not the
  // creature ever held a target.
  const { s, player: p, active, c } = scenario(skittish({ leashRadius: 200 }), CX + 100);
  hit(c, 'u1', 0);
  s.tick(DT, active, [p], MS);
  assert.ok(angryAt(c, 'u1', MS), 'precondition: the hit must have provoked it');

  // Nobody hits it again. The memory has to run out on its own.
  const after = PROVOKE_MEMORY_MS + MS;
  assert.ok(!angryAt(c, 'u1', after),
    `still angry ${(PROVOKE_MEMORY_MS / 1000).toFixed(0)}s after the only hit it took`);

  // Next encounter, well inside preferred range: it must back off rather than
  // pick up where it left off. Driven through the tick, not through the
  // predicate, so this is the sim agreeing with it and not a restatement.
  p.x = c.x + 100;
  p.y = c.y;
  const before = apart(c, p);
  const hp0 = p.hp;
  for (let i = 0; i < 20; i++) s.tick(DT, active, [p], after + i * MS);
  assert.ok(apart(c, p) > before,
    `did not back off on the next encounter (${before.toFixed(2)} -> ${apart(c, p).toFixed(2)})`);
  assert.equal(p.hp, hp0, 'it attacked on the next encounter');
});

// --- 9. SNIPED FROM BEYOND AGGRO RANGE ---------------------------------------

test('a creature shot from beyond its aggro radius comes after the shooter', () => {
  // 350px: OUTSIDE skittish aggro (300) and inside the reach of every ranged
  // weapon in the catalog (darts 350 ... arbalest 850), so this is the ORDINARY
  // way a deer is hit, not an edge case. Spec §3: it "switches to normal
  // retaliation permanently (for that engagement) once it takes damage".
  //
  // Before this fix a bow defeated the retaliation rule outright: the creature
  // never acquired the shooter (target selection is aggro-limited), so the
  // provocation was cleared on the very next tick and it died without a fight.
  const { s, player: p, active, c } = scenario(skittish(), CX + 350);
  s.tick(DT, active, [p], 0);
  assert.equal(c._target, null, 'precondition: the shooter must be out of aggro range');

  hit(c, 'u1', 0);
  const before = apart(c, p);
  for (let i = 1; i < 160; i++) s.tick(DT, active, [p], i * MS);

  assert.equal(c._target, 'u1', 'it never acquired the player who shot it');
  assert.ok(apart(c, p) < before,
    `it did not close on its shooter (${before.toFixed(2)} -> ${apart(c, p).toFixed(2)})`);
  assert.ok(p.hp < 500, 'it reached its shooter and still never bit');
});

test('a creature shot by one player still lets a different one walk past', () => {
  // The other half of the same missing fact. While provocation was a bare
  // boolean, a shot that landed while a SECOND player stood inside aggro range
  // armed the creature against the bystander -- it charged someone who had
  // never touched it. Attribution is what makes retaliation retaliation.
  const { s, active, c } = scenario(skittish());
  const shooter = player('u1', CX + 350);
  const bystander = player('u2', CX + 100); // inside aggro AND inside the flee band

  hit(c, 'u1', 0);

  for (let i = 1; i < 60; i++) {
    s.tick(DT, active, [shooter, bystander], i * MS);
  }
  // It picks the player who shot it over the one standing four times closer --
  // retaliation is against whoever hit you, not whoever is nearest.
  assert.equal(c._target, 'u1',
    'it targeted the bystander over the player who actually shot it');
  assert.equal(bystander.hp, 500,
    'it charged straight through a player who never touched it');

  // Now the shooter leaves the world (logs out, walks off the chunk) and only
  // the bystander is left, well inside the flee band. Still provoked -- the
  // memory has nowhere near expired -- but not against THEM, so it must go back
  // to being prey rather than transferring the grudge.
  bystander.x = c.x + 100;
  bystander.y = c.y;
  const before = apart(c, bystander);
  for (let i = 60; i < 120; i++) s.tick(DT, active, [bystander], i * MS);

  assert.ok(angryAt(c, 'u1', 120 * MS),
    'fixture: the memory must still be live, or this proves only that it expired');
  assert.equal(c._target, 'u2', 'fixture: the bystander must be the only target left');
  assert.equal(bystander.hp, 500, 'it bit a player who never touched it');
  assert.ok(apart(c, bystander) > before,
    `did not back off from the bystander (${before.toFixed(2)} -> ${apart(c, bystander).toFixed(2)})`);
});

// --- 9c. FLEEING IS NOT ENGAGING ---------------------------------------------

test('isEngagingPlayer tells a creature fighting a player from one running from it', () => {
  // The contract slice D (SOMET-291) reads: "a guard prefers a hostile that
  // currently holds a player target". A skittish creature holds a player in
  // `_target` the entire time it is backing away from them -- it needs to know
  // who to back away from -- so a raw `_target` read would send guards chasing
  // wildlife while the actual attacker went unrescued.
  //
  // Driven through the tick rather than by hand-building a creature, so this
  // pins the state the sim actually produces.
  const { s, player: p, active, c } = scenario(skittish(), CX + 100);
  s.tick(DT, active, [p], 0);
  assert.equal(c._target, 'u1', 'fixture: it must hold the player as a target');
  assert.equal(isEngagingPlayer(c, MS), false,
    'a creature running away from a player was reported as fighting them');

  hit(c, 'u1', MS);
  s.tick(DT, active, [p], 2 * MS);
  assert.equal(isEngagingPlayer(c, 2 * MS), true,
    'a provoked creature chasing the player who shot it was not reported as engaging');

  // A charger is engaging whenever it holds a player, provoked or not -- the
  // predicate must not be a skittish-only special case that reads false for
  // everything else.
  const charger = scenario(behavior({ aggroRadius: 400 }), CX + 100);
  charger.s.tick(DT, charger.active, [charger.player], 0);
  assert.equal(isEngagingPlayer(charger.c, MS), true,
    'an ordinary charger holding a player target was not reported as engaging');
});

// --- 10. IT COMES HOME -------------------------------------------------------

test('a homed creature that chased a player out of its leash walks back', () => {
  // SOMET-290 follow-up (finding 2). A provoked chase is deliberately NOT
  // leash-clamped (clamping it would freeze the creature against its own
  // boundary with the player one step outside, which is the stuck-guard failure
  // the guard branch documents at length) -- so the leash can only hold a pen
  // if the creature comes back afterwards. Without a return step the creature
  // simply roamed on from wherever the chase ended, and flushAndPrune persists
  // x/y: the pen drained permanently, one creature per player who wandered in.
  const bh = skittish({ leashRadius: 200 });
  const { s, player: p, active, c } = scenario(bh, CX + 100, { creature: { home_x: CX, home_y: CY } });

  // Hit it, then walk east with it in tow. 30px/s: slower than the creature
  // (40 x 1.15), so it keeps up and stays engaged the whole way instead of
  // dropping its target at the leash and returning early.
  hit(c, 'u1', 0);
  for (let i = 1; i < 400; i++) {
    p.x += 1.5;
    s.tick(DT, active, [p], i * MS);
  }
  const dragged = fromHome(c);
  assert.ok(dragged > 400,
    `fixture: the chase must actually leave the pen, it only reached ${dragged.toFixed(2)}px`);

  // The player leaves the world entirely (logs out / walks off the chunk).
  for (let i = 400; i < 1400; i++) s.tick(DT, active, [], i * MS);

  assert.ok(fromHome(c) <= 200 + 1e-6,
    `it never came home: ${fromHome(c).toFixed(2)}px from its anchor, leash is 200`);
});

test('a homed creature never roams out of its leash, and a homeless one still roams free', () => {
  // The slower half of the same leak: the roam block is a pure random walk, so
  // even an untouched penned creature wanders out eventually. Both halves in
  // one test because the SECOND is what proves the first is a real clamp and
  // not a frozen creature -- the identical run with no anchor must travel far.
  //
  // A real (seeded) rng, so redirects actually fire: with the constant
  // no-redirect rng the creature walks one fixed direction forever and the
  // clamp would be exercised on exactly one bearing.
  let seed = 12345;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const penned = scenario(skittish({ leashRadius: 200 }), CX + 5000,
    { creature: { home_x: CX, home_y: CY }, rng });
  let maxOut = 0;
  let moved = 0;
  const startX = penned.c.x, startY = penned.c.y;
  for (let i = 0; i < 4000; i++) {
    penned.s.tick(DT, penned.active, [], i * MS);
    maxOut = Math.max(maxOut, fromHome(penned.c));
    moved = Math.max(moved, Math.hypot(penned.c.x - startX, penned.c.y - startY));
  }
  assert.ok(maxOut <= 200 + 1e-6,
    `roamed ${maxOut.toFixed(2)}px from its anchor, leash is 200`);
  assert.ok(moved > 50,
    `it did not roam at all (${moved.toFixed(2)}px): the clamp froze it instead of containing it`);

  seed = 12345;
  const wild = scenario(skittish({ leashRadius: 200 }), CX + 5000, { rng });
  assert.equal(wild.c.home, null, 'precondition: the control creature must have no anchor');
  let wildOut = 0;
  for (let i = 0; i < 4000; i++) {
    wild.s.tick(DT, wild.active, [], i * MS);
    wildOut = Math.max(wildOut, fromHome(wild.c));
  }
  assert.ok(wildOut > 200,
    `a homeless creature only roamed ${wildOut.toFixed(2)}px: the clamp leaked into wild spawns`);
});

// --- 11. DISPLACED, NOT ROOTED ----------------------------------------------

test('a knockback cannot punt a penned creature out of its pen', () => {
  // SOMET-290 follow-up (finding 5a). The leash-aware shove was keyed on
  // guard-STYLE, so a homed skittish creature went through the raw geometric
  // shove: every melee weapon in the catalog carries knockback 30, which is a
  // free conveyor for walking a penned creature out of its pen one hit at a
  // time.
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{
    id: 'c', type: 'T', x: BOX, y: BOX, hp: 100, damage: 5,
    behavior: skittish({ leashRadius: 200 }), home_x: CX, home_y: CY,
  }]);
  const c = s.all()[0];
  for (let i = 0; i < 100; i++) {
    // Origin one pixel inside the creature on the home side, so every shove
    // points straight away from the anchor. 100 x 30px = 3000px offered.
    shoveCreature(stubMap(), c.x + c.width / 2 - 1, c.y + c.height / 2, c, 30);
  }
  assert.ok(fromHome(c) <= 200 + 1e-6,
    `100 shoves left it ${fromHome(c).toFixed(2)}px from its anchor, leash is 200`);
  assert.ok(fromHome(c) > 0, 'it was not shoved at all: the clamp is refusing legal displacement');
});

test('a creature displaced outside its leash can still retreat toward home', () => {
  // SOMET-290 follow-up (finding 5b). The flee clamp was destination-only: for
  // a creature that starts OUTSIDE its leash, every destination is outside it
  // too, so every retreat was refused -- and a refused-by-leash step is not
  // cornered either, so it stood rooted AND calm while a player walked up to
  // it. The monotone rule (no further than the larger of the leash and where it
  // already was) is what shoveCreature has always used.
  const bh = skittish({ leashRadius: 200 });
  // Creature 400px east of its anchor, player a further 100px east: the flee
  // vector points WEST, i.e. straight back toward home.
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{
    id: 'c', type: 'T', x: BOX + 400, y: BOX, hp: 100, damage: 5,
    behavior: bh, home_x: CX, home_y: CY,
  }]);
  const c = s.all()[0];
  const p = player('u1', CX + 500);
  const active = activeChunks();
  const before = fromHome(c);
  assert.ok(before > 200, 'fixture: it must start outside its own leash');

  for (let i = 0; i < 40; i++) s.tick(DT, active, [p], i * MS);

  assert.ok(fromHome(c) < before,
    `rooted at its leash: ${before.toFixed(2)}px from home before, ${fromHome(c).toFixed(2)}px after`);
  assert.ok(!angryAt(c, 'u1', 40 * MS),
    'a creature that simply gave ground was treated as cornered');
});
