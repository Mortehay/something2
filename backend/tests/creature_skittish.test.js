const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');
const { applyDamage } = require('../src/authority/damage.js');

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
function scenario(bh, playerCenterX, opts = {}) {
  const s = new CreatureSim(stubMap(opts.isWalkable), noRedirect);
  s.addCreatures([{
    id: 'c', type: 'T', x: BOX, y: BOX, hp: 100, behavior: bh, damage: 5,
    ...(opts.creature || {}),
  }]);
  const player = {
    userId: 'u1', x: playerCenterX - 24, y: CY - 24,
    width: 48, height: 48, hp: 500, mit: null,
  };
  return { s, player, active: activeChunks(), c: s.all()[0] };
}

function apart(c, p) {
  return Math.hypot((c.x + c.width / 2) - (p.x + p.width / 2),
    (c.y + c.height / 2) - (p.y + p.height / 2));
}
function fromHome(c) { return Math.hypot((c.x + c.width / 2) - CX, (c.y + c.height / 2) - CY); }

// --- 1. WALK PAST UNHARMED ---------------------------------------------------

test('an unprovoked skittish creature never attacks, even standing on top of a player', () => {
  // 40px apart: INSIDE its own 60px Nip range, so every tick of this run is a
  // tick a charger would have opened with. Nothing but the behaviour is
  // stopping it.
  const { s, player, active, c } = scenario(skittish(), CX + 40);
  const hp0 = player.hp;
  let swings = 0;
  for (let i = 0; i < 80; i++) swings += s.tick(0.05, active, [player], i * 0.05).attacks.length;
  assert.equal(swings, 0, 'a skittish creature stamped an attack at an unharmed player');
  assert.equal(player.hp, hp0, 'the player lost hp to a creature that was never provoked');
  // It had the player TARGETED the whole time -- not attacking was a decision,
  // not a creature that never noticed anyone.
  assert.equal(c.mode, 'chase');
});

// --- 2. RETREAT --------------------------------------------------------------

test('it backs away from a player inside its preferred range', () => {
  const { s, player, active, c } = scenario(skittish(), CX + 100); // 100 < preferredRange 150
  const samples = [apart(c, player)];
  for (let i = 0; i < 5; i++) {
    s.tick(0.1, active, [player], i * 0.1);
    samples.push(apart(c, player));
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
  const { s, player, active, c } = scenario(skittish(), CX + 200); // 150 < 200 < 300
  const x0 = c.x, y0 = c.y;
  for (let i = 0; i < 40; i++) s.tick(0.05, active, [player], i * 0.05);
  assert.equal(c.x, x0, 'moved on x while watching');
  assert.equal(c.y, y0, 'moved on y while watching');
  // Standing still because it is WATCHING, not because it fell through to the
  // roam block with no target (which would have wandered anyway).
  assert.equal(c.mode, 'chase');
});

// --- 4. PROVOKED BY DAMAGE ---------------------------------------------------

test('once damaged it closes on the player and bites', () => {
  const { s, player, active, c } = scenario(skittish(), CX + 200);
  // Inert first, so the closing below is attributable to the hit and to nothing
  // else about the fixture.
  for (let i = 0; i < 10; i++) s.tick(0.05, active, [player], i * 0.05);
  assert.equal(player.hp, 500, 'precondition: it must be calm before the hit');
  const before = apart(c, player);

  // The real Task-2 funnel, not a hand-set `_provoked` flag: this is the only
  // thing that makes damage.js and the tick one feature rather than two.
  applyDamage(c, 10, 'physical', c.mit);

  for (let i = 0; i < 120; i++) s.tick(0.05, active, [player], 1 + i * 0.05);
  assert.ok(apart(c, player) < before,
    `provoked creature did not close (${before.toFixed(2)} -> ${apart(c, player).toFixed(2)})`);
  // Both halves: a creature that turns to face you and never swings is the
  // inert half of this bug.
  assert.ok(player.hp < 500, 'it closed on the player but never bit');
});

// --- 5. CORNERED -------------------------------------------------------------

test('a creature cornered against a wall turns and fights instead of jittering', () => {
  // One wall, along the west face of the creature's own tile. The player is to
  // the east, so every retreat step aims straight into it.
  const { s, player, active, c } = scenario(skittish(), CX + 100, { isWalkable: (x) => x >= BOX });

  s.tick(0.05, active, [player], 0);
  assert.equal(c.x, BOX, 'precondition: the wall must actually refuse the retreat');
  assert.equal(c._provoked, true, 'nowhere to run and it still did not fight');

  for (let i = 1; i < 120; i++) s.tick(0.05, active, [player], i * 0.05);
  assert.ok(player.hp < 500, 'a cornered creature that never bites is just jittering in place');
});

// --- 6. NOT HERDED -----------------------------------------------------------

test('a creature with a home anchor cannot be herded past its leash', () => {
  // leashRadius 200 (rather than the profile's 500) purely to keep the run
  // short; the rule under test is the clamp, not the number.
  const bh = skittish({ leashRadius: 200 });
  const { s, player, active, c } = scenario(bh, CX + 200, { creature: { home_x: CX, home_y: CY } });

  // A player who simply keeps walking at it, 30px/s, for 30 seconds -- faster
  // than the creature can be provoked into giving ground voluntarily and long
  // enough to walk it 900px off its anchor if nothing stopped it.
  let herded = 0;
  for (let i = 0; i < 600; i++) {
    player.x -= 1.5;
    const calm = !c._provoked;
    s.tick(0.05, active, [player], i * 0.05);
    // Only FLEE steps are clamped, so only distance reached while still calm
    // is evidence about the clamp.
    if (calm) herded = Math.max(herded, fromHome(c));
  }

  assert.ok(herded <= 200 + 1e-6, `herded ${herded.toFixed(2)}px from home, leash is 200`);
  // ...and it did reach the edge, so the clamp was actually exercised rather
  // than vacuously satisfied by a creature that never moved.
  assert.ok(herded > 150, `only reached ${herded.toFixed(2)}px from home: the clamp never bit`);
  // The map is entirely walkable here, so the ONLY thing that can refuse a
  // retreat step is the leash. Being provoked proves the refusal happened.
  assert.equal(c._provoked, true, 'pinned against its leash on open ground and never cornered');
});

// --- 7. UNANCHORED IS UNCONSTRAINED ------------------------------------------

test('the same creature with no home anchor is not clamped at all', () => {
  // Byte-identical to case 6 except for the missing home_x/home_y -- which is
  // every wild spawn in the world today.
  const bh = skittish({ leashRadius: 200 });
  const { s, player, active, c } = scenario(bh, CX + 200);
  assert.equal(c.home, null, 'precondition: this creature must have no anchor');

  const startX = c.x;
  for (let i = 0; i < 600; i++) {
    player.x -= 1.5;
    s.tick(0.05, active, [player], i * 0.05);
  }

  const travelled = Math.abs(c.x - startX);
  assert.ok(travelled > 200, `only travelled ${travelled.toFixed(2)}px: the clamp bit a homeless creature`);
  // Nothing refused a step: on an open map with a null home there is nothing
  // that CAN refuse one, so a provoked creature here would mean the clamp is
  // treating "no home" as "pinned".
  assert.ok(!c._provoked, 'a homeless creature was cornered by something that does not exist');
  assert.equal(player.hp, 500, 'it fled the whole way, so it must never have attacked');
});

// --- 8. CALMS DOWN -----------------------------------------------------------

test('provocation clears when the target is lost, so the next encounter starts skittish again', () => {
  const { s, player, active, c } = scenario(skittish({ leashRadius: 200 }), CX + 100);
  applyDamage(c, 10, 'physical', c.mit);
  s.tick(0.05, active, [player], 0);
  assert.equal(c._provoked, true, 'precondition: the hit must have provoked it');

  // The player walks out of the creature's leash (and out of its aggro radius,
  // so nothing re-acquires it in the same tick).
  player.x += 400;
  s.tick(0.05, active, [player], 0.05);
  assert.equal(c._target, null, 'precondition: the target must actually be dropped');
  assert.equal(c._provoked, false, 'it stayed angry forever after a single hit');

  // Next encounter, well inside preferred range: it must back off rather than
  // pick up where it left off.
  player.x = c.x + 100;
  player.y = c.y;
  const before = apart(c, player);
  const hp0 = player.hp;
  for (let i = 0; i < 20; i++) s.tick(0.05, active, [player], 1 + i * 0.05);
  assert.ok(apart(c, player) > before,
    `did not back off on the next encounter (${before.toFixed(2)} -> ${apart(c, player).toFixed(2)})`);
  assert.equal(player.hp, hp0, 'it attacked on the next encounter');
});

// --- 9. SNIPED FROM OUT OF RANGE ---------------------------------------------

test('a creature shot from beyond its aggro radius does not stay angry at a stranger', () => {
  // 400px: outside skittish aggro (300) and inside the reach of every ranged
  // weapon in the catalog (darts 350 ... arbalest 850), so this is the ORDINARY
  // way a deer gets hit, not an edge case. The creature never targets the
  // shooter, so a clear that only runs when a target is DROPPED never runs.
  const { s, player, active, c } = scenario(skittish(), CX + 400);
  s.tick(0.05, active, [player], 0);
  assert.equal(c._target, null, 'precondition: the shooter must be out of aggro range');

  applyDamage(c, 10, 'physical', c.mit);
  s.tick(0.05, active, [player], 0.05);
  assert.equal(c._provoked, false, 'stayed angry at a shooter it never even targeted');

  // A DIFFERENT player, who never touched it, walks up to it. They must be able
  // to walk past -- being shot by someone else must not arm the creature
  // against them.
  const bystander = { userId: 'u2', x: c.x + 100, y: c.y, width: 48, height: 48, hp: 500, mit: null };
  const before = apart(c, bystander);
  for (let i = 0; i < 20; i++) s.tick(0.05, active, [bystander], 1 + i * 0.05);
  assert.equal(bystander.hp, 500, 'charged a player who never touched it');
  assert.ok(apart(c, bystander) > before,
    `did not back off from the bystander (${before.toFixed(2)} -> ${apart(c, bystander).toFixed(2)})`);
});
