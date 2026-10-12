// backend/tests/creature_skills_wiring.test.js
// SOMET-608 (S6). Live-tick wiring, the same discipline
// creature_mechanics_wiring.test.js uses for abilities/auras: every test
// starts from a row shaped EXACTLY like the real per-chunk world_creatures
// SELECT would return it (snake_case, `skills` as SKILLS_LATERAL's json_agg
// array) and drives it through the REAL addCreatures/tick path -- never a
// hand-built `c.behavior` object. That seam (resolver vs. live tick) is
// where P2a's whole ability catalog once shipped inert with a green suite.
//
// `now` (world clock) is milliseconds and `dt` is seconds -- World.tick's
// own `dtMs = dt * 1000; this.now += dtMs` is what makes that true in
// production, and `cooldown_ms`/`telegraph_ms` are ms-denominated catalog
// columns. `tickBy` below keeps every call's `dt` and `now` jump in the
// same lockstep World itself keeps, so a cooldown genuinely measured in
// real elapsed time is what gets exercised -- a fixed small dt with large
// now jumps (an earlier draft's mistake) decrements `_skillCd` 1000x too
// slowly and makes every cooldown assertion vacuously true.
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');

function openMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
const noRedirect = () => 0.5; // > REDIRECT_CHANCE: no roam-direction noise
const active = new Set(['0,0', '0,1', '1,0', '1,1']);

function driver(s) {
  let now = 0;
  return (players, deltaMs, catalogRows) => {
    now += deltaMs;
    return s.tick(deltaMs / 1000, active, players, now, catalogRows);
  };
}

function skillRow(over = {}) {
  return {
    slot: 1, skill_id: 1, name: 'Ground Slam', kind: 'slam',
    telegraph_ms: 500, cooldown_ms: 4000, radius: 80, range: 200,
    damage_mult: 1, element: null, summon_entity: null, summon_count: 1,
    vfx: null, power_scale: 1,
    ...over,
  };
}

// A row shaped exactly like the real loader returns it (see
// creature_mechanics_wiring.test.js's own loaderCreatureRow for the
// non-skill columns this mirrors).
function loaderCreatureRow(over = {}) {
  return {
    id: over.id, type: over.type || 'T', x: over.x, y: over.y,
    hp: over.hp ?? 100, facing: over.facing || 'S',
    home_x: null, home_y: null,
    level: 1, damage: over.damage ?? 10, blocks_portal_id: null,
    defense: 0, color: '#fff', resistances: {},
    faction: 'hostile', attack_element: 'physical',
    behavior_name: over.behaviorName || 'T',
    aggro_radius: 400, leash_radius: 800,
    chase_style: over.chaseStyle || 'hold', preferred_range: 0,
    move_speed_mult: 1, damage_override: null,
    aura_names: null, aura_defs: [],
    behavior_gold_min: 0, behavior_gold_max: 0,
    abilities: over.abilities || [],
    skills: over.skills || [skillRow()],
  };
}

function player(over = {}) {
  return {
    userId: over.userId || 'u1', x: over.x ?? 0, y: over.y ?? 0,
    width: 64, height: 64, hp: over.hp ?? 1000, maxHp: 1000, _buff: undefined,
  };
}

// 'hold' chase style + aggroRadius 400 means the creature acquires and
// stands its ground at distance -- no movement noise to account for while
// asserting telegraph/resolve timing.
test('slam: no damage on cast, AoE damage to anyone in radius only once the telegraph elapses', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([loaderCreatureRow({ id: 'c1', x: 0, y: 0 })]);
  const tick = driver(s);
  const p1 = player({ x: 150, y: 0 }); // within range (200) and within slam radius (80) of itself
  tick([p1], 0);
  assert.equal(p1.hp, 1000, 'telegraph just started: no damage yet');
  tick([p1], 400); // before telegraph_ms (500) elapses
  assert.equal(p1.hp, 1000, 'still telegraphing: no damage yet');
  tick([p1], 100); // now=500: telegraph_ms elapses exactly
  assert.equal(p1.hp, 1000 - 10 * 1, 'resolved: base damage (10) * damage_mult (1)');
});

test('a player OUTSIDE the telegraphed radius takes no damage; one standing just inside it does', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([loaderCreatureRow({ id: 'c1', x: 0, y: 0 })]);
  const tick = driver(s);
  const near = player({ userId: 'near', x: 150, y: 0 }); // target, inside 80px radius of itself
  const far = player({ userId: 'far', x: 150, y: 500 }); // far from the slam's own origin
  tick([near, far], 0);
  tick([near, far], 500);
  assert.equal(near.hp, 990);
  assert.equal(far.hp, 1000, 'outside the slam radius: untouched');
});

test('cooldown is stamped at TELEGRAPH START, not at resolve, and blocks a re-cast until it elapses', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([loaderCreatureRow({ id: 'c1', x: 0, y: 0 })]);
  const tick = driver(s);
  const p1 = player({ x: 150, y: 0 });
  tick([p1], 0);     // now=0: telegraph starts, cooldown (4000ms) stamped NOW
  tick([p1], 500);   // now=500: resolves, hp drops by 10
  assert.equal(p1.hp, 990);
  tick([p1], 3400);  // now=3900: 3400ms of real cooldown time elapsed since the stamp -- 600ms left
  assert.equal(p1.hp, 990, 'still on cooldown: no second cast');
  tick([p1], 700);   // now=4600: cooldown (4000ms since the t=0 stamp) has elapsed -- a second telegraph starts
  tick([p1], 500);   // now=5100: resolves
  assert.equal(p1.hp, 980, 'cooldown elapsed: a second slam landed');
});

test('a creature mid-telegraph is STOPPED: no second telegraph starts while one is already pending', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  // A short cooldown (100ms): if skill re-selection ran while the first
  // telegraph was still pending, this would make it refire immediately --
  // the `continue` for a pending skill is what this test actually pins.
  s.addCreatures([loaderCreatureRow({
    id: 'c1', x: 0, y: 0,
    skills: [skillRow({ cooldown_ms: 100 })],
  })]);
  const tick = driver(s);
  const p1 = player({ x: 150, y: 0 });
  tick([p1], 0);    // now=0: telegraph starts (500ms)
  tick([p1], 150);  // now=150: well past the 100ms cooldown, but STILL mid-telegraph
  assert.equal(p1.hp, 1000, 'no second telegraph/cast fired while the first is still pending');
  tick([p1], 350);  // now=500: the first one finally resolves
  assert.equal(p1.hp, 990);
});

test('power_scale scales a slam\'s damage_mult AND radius together', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([loaderCreatureRow({
    id: 'c1', x: 0, y: 0,
    skills: [skillRow({ damage_mult: 2, radius: 100, power_scale: 1.5 })],
  })]);
  const tick = driver(s);
  // 130px out: inside the SCALED radius (100*1.5=150) but outside the
  // UNSCALED one (100) -- proves radius itself was scaled, not just damage.
  const p1 = player({ x: 130, y: 0 });
  tick([p1], 0);
  tick([p1], 500);
  // base damage 10 * damage_mult (2*1.5=3) = 30
  assert.equal(p1.hp, 1000 - 30);
});

test('nova: damages a player near the CASTER\'s own position, locked at telegraph start', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([loaderCreatureRow({
    id: 'c1', x: 0, y: 0, // centre (24,24)
    skills: [skillRow({ kind: 'nova', radius: 60, range: 500 })],
  })]);
  const tick = driver(s);
  // The TARGET that triggers acquisition sits far from the caster (inside
  // the default 400px aggro radius so it is acquired at all, and the
  // skill's own 500px range so it is selectable), but nova's own damage
  // area is centred on the CASTER, not the target -- so only a player near
  // the caster's own position should take damage.
  const target = player({ userId: 'target', x: 350, y: 0 });
  const bystander = player({ userId: 'bystander', x: 10, y: 10 }); // near the caster
  tick([target, bystander], 0);
  tick([target, bystander], 500);
  assert.equal(target.hp, 1000, 'nova is centred on the caster, not the far-away target');
  assert.equal(bystander.hp, 990, 'a bystander standing next to the CASTER takes the nova hit');
});

test('projectile: a telegraphed shot spawns only once the telegraph elapses, aimed at the live target', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([loaderCreatureRow({
    id: 'c1', x: 0, y: 0,
    skills: [skillRow({ kind: 'projectile', radius: 6, range: 400, element: 'fire' })],
  })]);
  const tick = driver(s);
  const p1 = player({ x: 300, y: 0 });
  const r0 = tick([p1], 0);
  assert.equal(r0.shots.length, 0, 'no shot while telegraphing');
  const r1 = tick([p1], 499);
  assert.equal(r1.shots.length, 0, 'still telegraphing');
  const r2 = tick([p1], 1); // now=500
  assert.equal(r2.shots.length, 1, 'shot spawns the instant the telegraph elapses');
  const shot = r2.shots[0];
  assert.equal(shot.element, 'fire');
  assert.equal(shot.radius, 6);
  assert.ok(shot.nx > 0.9, 'aimed toward the target, roughly along +x');
});

test('telegraphs: a started telegraph is reported in tick()\'s own return, with resolved geometry', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([loaderCreatureRow({ id: 'c1', x: 0, y: 0 })]);
  const tick = driver(s);
  const p1 = player({ x: 150, y: 0 });
  const r = tick([p1], 0);
  assert.equal(r.telegraphs.length, 1);
  assert.deepEqual(
    { skill: r.telegraphs[0].skill, radius: r.telegraphs[0].radius, telegraphMs: r.telegraphs[0].telegraphMs },
    { skill: 'Ground Slam', radius: 80, telegraphMs: 500 },
  );
  // No second telegraph is reported on a later tick while the first is
  // still pending -- telegraphs is "started THIS tick", not "currently active".
  const r2 = tick([p1], 250);
  assert.equal(r2.telegraphs.length, 0);
});

test('summon: hydrates summon_count creatures from the supplied catalog, capped, never duplicated while alive', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([loaderCreatureRow({
    id: 'caster', x: 0, y: 0,
    skills: [skillRow({ kind: 'summon', summon_entity: 'Fire Elemental Guard', summon_count: 2 })],
  })]);
  const tick = driver(s);
  const catalog = new Map([['Fire Elemental Guard', {
    name: 'Fire Elemental Guard', hp: 50, color: '#f00', resistances: {}, faction: 'hostile',
    attack_element: 'fire', behavior_name: null, abilities: [],
  }]]);
  const p1 = player({ x: 150, y: 0 });
  tick([p1], 0);                 // telegraph starts
  tick([p1], 500, catalog);      // resolves: summons land
  const summonIds = [...s.creatures.keys()].filter((id) => id.startsWith('skillsummon:'));
  assert.equal(summonIds.length, 2, 'exactly summon_count creatures, no more');
  // Past the 4000ms cooldown (stamped at t=0): the skill fires again. The
  // ALREADY-ALIVE summons must not be duplicated (same deterministic ids).
  tick([p1], 4100);              // now=4600
  tick([p1], 500, catalog);      // now=5100: resolves
  const summonIdsAfter = [...s.creatures.keys()].filter((id) => id.startsWith('skillsummon:'));
  assert.equal(summonIdsAfter.length, 2, 'no duplicates: the cap holds across a second successful cast');
  assert.deepEqual(new Set(summonIds), new Set(summonIdsAfter), 'the SAME two ids, not two new ones');
});

test('summon: an unknown summon_entity name is a no-op, not a crash (same posture as an unknown vfx/aura binding)', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([loaderCreatureRow({
    id: 'caster', x: 0, y: 0,
    skills: [skillRow({ kind: 'summon', summon_entity: 'Not A Real Entity', summon_count: 2 })],
  })]);
  const tick = driver(s);
  const p1 = player({ x: 150, y: 0 });
  assert.doesNotThrow(() => {
    tick([p1], 0);
    tick([p1], 500, new Map()); // empty catalog -- name is simply not in it
  });
  const summonIds = [...s.creatures.keys()].filter((id) => id.startsWith('skillsummon:'));
  assert.equal(summonIds.length, 0);
});

test('a creature with no live target never starts a telegraph, and never throws', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([loaderCreatureRow({ id: 'c1', x: 0, y: 0 })]);
  assert.doesNotThrow(() => {
    const r = s.tick(0.05, active, [], 0); // no players at all
    assert.equal(r.telegraphs.length, 0);
  });
});

test('a behaviour with no skills bound behaves exactly as before -- bh.skills is [], never undefined', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([loaderCreatureRow({ id: 'c1', x: 0, y: 0, skills: [] })]);
  const p1 = player({ x: 50, y: 0 }); // within the backfilled default ability's 60px melee range
  const r = s.tick(0.05, active, [p1], 0);
  assert.equal(r.telegraphs.length, 0);
  assert.ok(p1.hp < 1000, 'the ordinary default melee ability still fires with no skills bound');
});
