// SOMET-314 — a wild hostile must not ROAM onto the world's arrival spawn.
//
// The reported bug ("a level-2 Slime camps the entry spawn and kills level-1
// characters on sight, again on every respawn") is not a placement bug: the
// real placement pass never puts a hostile inside aggro range of an
// entry_spawn. Creatures WALK there and authority/server.js's creature flush
// persists it. These tests drive the roam step itself.
const test = require('node:test');
const assert = require('node:assert');
const {
  CreatureSim, roamsIntoSanctuary, spawnSanctuaryPoint,
  SPAWN_SANCTUARY_MARGIN, AGGRO_RADIUS,
} = require('../src/authority/creatures.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
const { ServerMap } = require('../src/authority/collision.js');

const SPAWN = { x: 4650, y: 4550 };

// A map the creature can walk anywhere on, carrying a world config the way the
// real ServerMap does (collision.js keeps buildWorldGenConfig's object on
// `.world`, and that object carries entry_spawn).
function stubMap(entrySpawn = SPAWN) {
  return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8, world: { entry_spawn: entrySpawn } };
}

// rng() < REDIRECT_CHANCE (0.02) is what re-rolls the roam direction; 0.5 never
// re-rolls, so a creature keeps whatever _dir addCreatures gave it. addCreatures
// picks that direction with the SAME rng, so 0.5 -> DIRS[4] === [-1, 0], i.e.
// due WEST. Every roamer below therefore walks in a straight line toward a
// spawn point placed to its west, with no randomness left in the test.
const dueWest = () => 0.5;

function behavior(over = {}) {
  return {
    name: 'T', aggroRadius: AGGRO_RADIUS, leashRadius: 800, chaseStyle: 'charge',
    preferredRange: 0, moveSpeedMult: 1, damageOverride: null,
    abilities: [{
      slot: 1, name: 'Attack', attackKind: 'melee', attackRange: 60, attackCooldown: 1,
      projectileSpeed: 0, projectileRadius: 0, element: null, damageMult: 1, knockback: 0,
    }],
    ...over,
  };
}

const ACTIVE = new Set();
for (let cx = -4; cx <= 12; cx++) for (let cy = -4; cy <= 12; cy++) ACTIVE.add(`${cx},${cy}`);

function distToSpawn(c) {
  return Math.hypot(c.x + c.width / 2 - SPAWN.x, c.y + c.height / 2 - SPAWN.y);
}

// Roam for `seconds` of simulated time with NO players present, so the creature
// is never in `chase` and every step goes through the roam clamp.
//
// Returns the CLOSEST it ever got, sampled every tick, not where it ended up.
// The end position is the wrong measure and would make these tests vacuous in
// both directions: the clamp answers a refused step with "turn" (like a wall),
// so a creature stopped at the boundary walks off along it and finishes far
// away -- and an UNCLAMPED creature walks straight through the spawn and out
// the other side, also finishing far away. Only the minimum distinguishes them.
// dt is 0.5, not the 0.1 the live server ticks at, purely to keep these files
// cheap: node --test runs test FILES in parallel, and at 0.1 these loops burn
// enough CPU to push provider_discovery.test.js's latency assertions over their
// threshold on a loaded machine -- measured, not guessed. The simulated time is
// unchanged; only the step granularity coarsens, from 4px to 20px per step,
// which the assertions have far more slack than.
function roamFor(sim, seconds, dt = 0.5) {
  let min = Infinity;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    sim.tick(dt, ACTIVE, [], 0);
    const d = distToSpawn(sim.all()[0]);
    if (d < min) min = d;
  }
  return { creature: sim.all()[0], min };
}

test('a roaming wild hostile never enters its own aggro radius of the entry spawn', () => {
  const sim = new CreatureSim(stubMap(), dueWest);
  // Due east of the spawn and well outside the sanctuary, walking west into it.
  sim.addCreatures([{
    id: 'c', type: 'Slime', x: SPAWN.x + 1200, y: SPAWN.y, hp: 35,
    behavior: behavior(), damage: 5.5, level: 2,
  }]);
  const start = distToSpawn(sim.all()[0]);
  // Long enough to cross the whole 1200px at CREATURE_SPEED 40px/s several
  // times over, so "it never got there" cannot be "it did not have time".
  const { min } = roamFor(sim, 120);

  assert.ok(min < start - 500,
    `creature must actually have walked toward the spawn (start ${Math.round(start)}, closest ${Math.round(min)})`);
  assert.ok(min >= AGGRO_RADIUS + SPAWN_SANCTUARY_MARGIN,
    `roamer closed to ${Math.round(min)}px of the spawn; the sanctuary is `
    + `${AGGRO_RADIUS + SPAWN_SANCTUARY_MARGIN}px`);
  // The point of the radius, stated as the property it buys rather than as a
  // restatement of the number above: a player standing on the spawn is outside
  // this creature's aggro radius, so it can never acquire them by wandering.
  assert.ok(min > AGGRO_RADIUS,
    `a player on the spawn would be inside aggro (${Math.round(min)}px <= ${AGGRO_RADIUS}px)`);
});

test('the sanctuary scales with the creature\'s own aggro radius', () => {
  // Apex: aggro 600, the widest in the shipped creature_behaviors catalog. A
  // flat radius tuned for a 400px Slime would let this one see the spawn.
  const sim = new CreatureSim(stubMap(), dueWest);
  sim.addCreatures([{
    id: 'c', type: 'Apex', x: SPAWN.x + 1600, y: SPAWN.y, hp: 200,
    behavior: behavior({ aggroRadius: 600 }), damage: 20, level: 9,
  }]);
  const { min } = roamFor(sim, 160);
  assert.ok(min >= 600 + SPAWN_SANCTUARY_MARGIN,
    `Apex closed to ${Math.round(min)}px; its sanctuary is ${600 + SPAWN_SANCTUARY_MARGIN}px`);
  // And it is genuinely WIDER than a Slime's, not just "some barrier": a flat
  // 500px radius would satisfy the assertion above only by accident.
  assert.ok(min > AGGRO_RADIUS + SPAWN_SANCTUARY_MARGIN,
    'the Apex sanctuary must exceed the default-aggro one');
});

test('a creature already inside the sanctuary can roam back OUT', () => {
  // The reflecting-barrier half of the monotone rule. Creatures are persisted
  // inside the sanctuary today (the flush this rule is about put them there);
  // an absorbing barrier would freeze them on the spawn tile forever, which is
  // the reported bug made permanent.
  //
  // Walking EAST here, away from a spawn point to its west, so the step is
  // outward. rng 0.1 -> DIRS[0] === [1, 0].
  const dueEast = () => 0.1;
  const sim = new CreatureSim(stubMap(), dueEast);
  sim.addCreatures([{
    id: 'c', type: 'Slime', x: SPAWN.x + 40, y: SPAWN.y, hp: 35,
    behavior: behavior(), damage: 5.5, level: 2,
  }]);
  const start = distToSpawn(sim.all()[0]);
  const { creature } = roamFor(sim, 60);
  const end = distToSpawn(creature);
  assert.ok(end > start + 500,
    `a creature starting inside must be able to leave (start ${Math.round(start)}, end ${Math.round(end)})`);
  assert.ok(end >= AGGRO_RADIUS + SPAWN_SANCTUARY_MARGIN,
    'and having left, it must be outside the sanctuary');
});

test('a CHASE is never clamped -- a hostile follows a player onto the spawn', () => {
  // Deliberate, and the same line services/safeRegion.js draws for placement:
  // safety is a property of the doormat, not of the player. A hostile that has
  // acquired someone must be able to follow them home, or the sanctuary is an
  // invisible wall and the village guards have nothing to rescue anyone from.
  const sim = new CreatureSim(stubMap(), dueWest);
  sim.addCreatures([{
    id: 'c', type: 'Slime', x: SPAWN.x + 300, y: SPAWN.y, hp: 35,
    behavior: behavior(), damage: 5.5, level: 2,
  }]);
  // A player standing on the spawn, inside the creature's 400px aggro radius.
  const player = { userId: 'u1', x: SPAWN.x - 32, y: SPAWN.y - 32, width: 64, height: 64, hp: 100 };
  const start = distToSpawn(sim.all()[0]);
  for (let i = 0; i < 50; i++) sim.tick(0.2, ACTIVE, [player], 0);
  const c = sim.all()[0];
  assert.equal(c.mode, 'chase', 'creature must have acquired the player');
  assert.ok(distToSpawn(c) < start - 100,
    `a chasing creature must close on the spawn (start ${Math.round(start)}, `
    + `end ${Math.round(distToSpawn(c))})`);
});

test('an ANCHORED hostile still paces a post that sits ON the spawn', () => {
  // dungeonGuards.js's portal packs and SOMET-289's penned creatures are
  // ordinary hostile types with a home_x. They stand where an author put them,
  // not where they wandered, so the wanderer rule must not touch them.
  //
  // The post is ON the spawn point and the creature starts 150px out from it,
  // walking back in. Only the LEASH may constrain it. Without the `|| anchor`
  // gate the monotone sanctuary rule would refuse every inward step, and this
  // creature could never again get closer to its own post than wherever it
  // happened to be -- so the closest-approach measure is what separates the
  // two, and asserting "it stayed near its post" would not (the leash alone
  // guarantees that, which is exactly what made an earlier draft of this test
  // survive deleting the gate).
  const sim = new CreatureSim(stubMap(), dueWest);
  sim.addCreatures([{
    id: 'c', type: 'Umbral Line', x: SPAWN.x + 150, y: SPAWN.y, hp: 100,
    behavior: behavior({ leashRadius: 200 }), damage: 8, level: 5,
    home_x: SPAWN.x, home_y: SPAWN.y,
  }]);
  const { min } = roamFor(sim, 60);
  assert.ok(min < 50,
    `an anchored creature must be able to walk back onto its post, but got no `
    + `closer than ${Math.round(min)}px`);
});

test('a world with no authored entry_spawn has no sanctuary at all', () => {
  // 81 of the 85 real worlds carry no entry_spawn. Their creatures must roam
  // byte-for-byte as they did before this rule existed.
  assert.equal(spawnSanctuaryPoint({ world: {} }), null);
  assert.equal(spawnSanctuaryPoint({ world: { entry_spawn: null } }), null);
  assert.equal(spawnSanctuaryPoint({}), null);
  assert.equal(spawnSanctuaryPoint(null), null);
  // A half-written spawn is NO spawn, not a spawn at NaN: every comparison
  // against NaN is false, so a NaN sanctuary would refuse nothing while
  // looking like it was protecting something.
  assert.equal(spawnSanctuaryPoint({ world: { entry_spawn: { x: 100 } } }), null);

  const sim = new CreatureSim(stubMap(null), dueWest);
  sim.addCreatures([{
    id: 'c', type: 'Slime', x: SPAWN.x + 300, y: SPAWN.y, hp: 35, behavior: behavior(), damage: 5,
  }]);
  const { min } = roamFor(sim, 60);
  assert.ok(min < 100,
    `with no entry_spawn the roamer must walk straight over the spawn point, `
    + `got no closer than ${Math.round(min)}px`);
});

test('entry_spawn survives the real loadWorld wiring into the sim map', () => {
  // The inertness guard, and the reason it uses the real builders instead of a
  // stub. This repo's recurring failure is a rule that is correct in isolation
  // and never reached in production because the field it needs was dropped one
  // layer up -- safe_road_radius and safe_rects both shipped that way
  // (authority/server.js's own comment on the loadWorld SELECT says so). The
  // chain below is exactly what server.js's loadWorld builds:
  // row -> buildWorldGenConfig -> new ServerMap({...cfg, decorationDefs}) ->
  // new World(map) -> CreatureSim(map). If any link stops carrying entry_spawn,
  // the sanctuary silently protects nothing and every other test here still
  // passes, because they all hand CreatureSim a hand-built map.
  const row = {
    seed: 12345, chunk_size: 64, width: 96, height: 96,
    entry_spawn: { x: 4650, y: 4550 },
    level_min: 1, level_max: 2, safe_road_radius: 0, safe_rects: [], authored_roads: [],
    biome_cell: null,
  };
  const cfg = buildWorldGenConfig({
    row, tileTypes: { grass: { walkable: true, speed: 1 } }, doorways: [], villages: [], biomes: [],
  });
  const map = new ServerMap({ ...cfg, decorationDefs: [] });
  assert.deepEqual(spawnSanctuaryPoint(map), { x: 4650, y: 4550 },
    'entry_spawn must reach the creature sim through the real load chain');

  // And the sim built on that map actually clamps -- not just that the field
  // arrived. Asserting only the field would pass with the clamp deleted.
  const sim = new CreatureSim(map, dueWest);
  sim.addCreatures([{
    id: 'c', type: 'Slime', x: SPAWN.x + 1000, y: SPAWN.y, hp: 35, behavior: behavior(), damage: 5.5,
  }]);
  let min = Infinity;
  for (let i = 0; i < 240; i++) {
    sim.tick(0.5, ACTIVE, [], 0);
    const c = sim.all()[0];
    // The real ServerMap generates terrain, so a creature can also be stopped
    // by a wall. Only a step it was ALLOWED to take counts; the assertion is on
    // the closest approach either way, which a wall can only help.
    min = Math.min(min, Math.hypot(c.x + c.width / 2 - SPAWN.x, c.y + c.height / 2 - SPAWN.y));
  }
  assert.ok(min >= AGGRO_RADIUS + SPAWN_SANCTUARY_MARGIN,
    `on a real ServerMap the roamer closed to ${Math.round(min)}px`);
});

test('roamsIntoSanctuary is monotone and falls back to the default aggro radius', () => {
  const spawn = { x: 0, y: 0 };
  const R = AGGRO_RADIUS + SPAWN_SANCTUARY_MARGIN;
  // Outside -> inside: refused.
  assert.equal(roamsIntoSanctuary(spawn, { aggroRadius: AGGRO_RADIUS }, R + 10, 0, R - 10, 0), true);
  // Outside -> outside: allowed.
  assert.equal(roamsIntoSanctuary(spawn, { aggroRadius: AGGRO_RADIUS }, R + 10, 0, R + 20, 0), false);
  // Inside -> further in: refused.
  assert.equal(roamsIntoSanctuary(spawn, { aggroRadius: AGGRO_RADIUS }, 200, 0, 100, 0), true);
  // Inside -> outward: allowed, even though the destination is still inside.
  assert.equal(roamsIntoSanctuary(spawn, { aggroRadius: AGGRO_RADIUS }, 100, 0, 200, 0), false);
  // A behaviour with no aggroRadius must NOT disable the rule. Without the
  // fallback this is `NaN + 100`, every comparison is false, and the step is
  // silently allowed.
  assert.equal(roamsIntoSanctuary(spawn, {}, R + 10, 0, R - 10, 0), true);
  assert.equal(roamsIntoSanctuary(spawn, { aggroRadius: 'wide' }, R + 10, 0, R - 10, 0), true);
});
