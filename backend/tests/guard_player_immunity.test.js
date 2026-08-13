// SOMET-285 — a player's damage cannot reach a village guard.
//
// WHY THIS IS THE HALF THAT CLOSES THE TICKET. Level 150 (the other half, see
// village_guard_level_scaling.test.js) does not stop a player killing a guard,
// it only lengthens the grind: applyDamage floors every hit at MIN_DAMAGE (1)
// no matter how far the target's defence exceeds the raw damage, so a knife
// still takes exactly `hp` swings. A guard never targets a player
// (selectGuardTarget takes hostiles only), so it never retaliates, and
// world_creatures carries no respawn path for one — the kill is riskless and
// permanent. The fix is to remove the player from the guard's damage graph.
//
// EVERY player→creature damage path is covered here, each driven through the
// real call site rather than through the predicate:
//   1. melee arc            World.attack -> meleeArcTargets/applyMeleeArc
//   2. melee status rider   the same swing's applyElementEffect
//   3. melee knockback      the same swing's shove loop
//   4. projectile direct    ProjectileSim.step swept-collision branch
//   5. projectile AoE       ProjectileSim.step -> _detonate
//   6. applyAttack          the (currently unwired) player melee primitive
//
// And the four things that must NOT change, each with its own test, because a
// filter applied one level too deep (inside applyDamage or
// damageCreatureById) would silently take all of them out with it:
//   * a guard still damages and kills a hostile;
//   * a hostile still damages a player;
//   * a hostile's shot still damages a guard (the deliberate decision — see
//     projectileHitsCreature's own comment);
//   * a PORTAL guard (services/dungeonGuards.js: an ordinary hostile entity
//     type given a home anchor) is still killable, or its portal never opens.
//
// SOMET-286 added the other half of the story: the refusal is now LEGIBLE. The
// immunity assertions above are untouched — a guard still takes nothing from
// any player path — but a swing or a shot that reaches one now emits a blocked
// impact (`b: true`, no effect name) that the client draws as a shield glint.
// The tests for that live beside the immunity ones deliberately: they are two
// halves of one rule, and a future change that quietly drops either should
// fail here.

const test = require('node:test');
const assert = require('node:assert');

const { World } = require('../src/authority/world.js');
const { ProjectileSim } = require('../src/authority/projectiles.js');
const {
  CreatureSim, CREATURE_SIZE, immuneToPlayerDamage, isGuardCreature,
} = require('../src/authority/creatures.js');

const openMap = () => ({
  chunkSize: 128, isWalkable: () => true, speedAt: () => 1, getChunk: () => [],
});
const KEYS = new Set(['0,0']);
const noRedirect = () => 0.5;

// The live knife row (item_types): the cheapest weapon in the game, i.e. the
// worst case for a grind — shortest cooldown, lowest damage, most swings.
const KNIFE = {
  id: 1, name: 'knife', category: 'weapon', kind: 'melee',
  damage: 6, cooldown: 0.25, reach: 70, arc_width: 0.6,
  mana_cost: 0, stamina_cost: 0, element: null, knockback: 30,
};
// The same weapon with an element, for the status-rider path.
const FIREBRAND = { ...KNIFE, id: 2, name: 'firebrand', element: 'fire' };
const BOW = {
  id: 3, name: 'bow', category: 'weapon', kind: 'ranged',
  damage: 40, cooldown: 0.5, range: 700, projectile_speed: 900,
  projectile_radius: 8, pierce: 1, element: null, knockback: 0,
  mana_cost: 0, stamina_cost: 0,
};
const FIREBALL = {
  ...BOW, id: 4, name: 'fireball staff', kind: 'magic',
  element: 'fire', aoe_radius: 150, damage: 60,
};
const TYPES = new Map([[1, KNIFE], [2, FIREBRAND], [3, BOW], [4, FIREBALL]]);

const HOME = { x: 3250, y: 2950 };

// A guard exactly as server.js loads one: faction 'guard', a home post, and no
// behaviour profile of its own — resolveInstanceBehavior resolves that to
// GUARD_DEFAULT_BEHAVIOR (chaseStyle 'guard'), which is what the immunity
// keys on. Stats are the live level-150 block.
function guardRow(over = {}) {
  return {
    id: 'g', type: 'Village Guard',
    x: HOME.x - CREATURE_SIZE / 2, y: HOME.y - CREATURE_SIZE / 2,
    hp: 7005, level: 150, damage: 397.5, defense: 84.5, faction: 'guard',
    home_x: HOME.x, home_y: HOME.y,
    ...over,
  };
}

// The control in every player-damage test: an ordinary hostile standing where
// the guard stands, so a green assertion cannot come from the swing missing.
function hostileRow(over = {}) {
  return {
    id: 'h', type: 'Slime',
    x: HOME.x - CREATURE_SIZE / 2, y: HOME.y - CREATURE_SIZE / 2,
    hp: 7005, defense: 84.5, faction: 'hostile',
    ...over,
  };
}

function armedWorld(rows, weaponId = 1) {
  const w = new World(openMap(), TYPES, weaponId);
  w.addPlayer('u1', { x: 0, y: 0 }, {
    items: [{ id: 'w1', typeId: weaponId }], equipment: { main_hand: 'w1' },
  });
  w.creatures.addCreatures(rows);
  return w;
}

// Stand the player 40px west of the target (inside the knife's 70px reach) and
// swing due east. Returns the attack result so the descriptor can be read.
function swingAt(w, id) {
  const c = w.creatures.creatures.get(id);
  const p = w.getPlayer('u1');
  p.x = c.x + c.width / 2 - 40 - p.width / 2;
  p.y = c.y + c.height / 2 - p.height / 2;
  return w.attack('u1', 1, 0);
}

// --- 1/2/3: the melee arc, its rider and its shove -------------------------

test('a player melee swing leaves a guard\'s hp untouched (and the same swing hurts a hostile)', () => {
  const w = armedWorld([guardRow(), hostileRow()]);
  for (let i = 0; i < 50; i++) { swingAt(w, 'g'); w.tick(0.3); }
  const g = w.creatures.creatures.get('g');
  assert.equal(g.hp, 7005, `50 knife swings must leave a guard at full hp, got ${g.hp}`);

  // Control: the identical loop against a hostile with the identical defence.
  const w2 = armedWorld([hostileRow()]);
  for (let i = 0; i < 50; i++) { swingAt(w2, 'h'); w2.tick(0.3); }
  const h = w2.creatures.creatures.get('h');
  assert.ok(h.hp < 7005,
    'sanity: the same swings must damage a hostile, or this test proves nothing');
  // And specifically: MIN_DAMAGE per swing is exactly the grind SOMET-285 kills.
  assert.equal(h.hp, 7005 - 50, 'the floor still applies to a hostile: 1 damage a swing');
});

test('a player melee swing does not shove a guard either', () => {
  // The knife carries knockback 30 and world.js's shove loop iterates
  // meleeArcTargets, so excluding the guard from that list removes the impulse
  // as well as the damage. A shove with no damage would still let a player
  // walk a structural gate defender off the gate aperture at will.
  const w = armedWorld([guardRow()]);
  const g = w.creatures.creatures.get('g');
  const { x, y } = g;
  for (let i = 0; i < 20; i++) { swingAt(w, 'g'); w.tick(0.3); w.tickCreatures(0.3, KEYS); }
  assert.strictEqual(g.x, x, `a guard must not be displaced by a player's swing, x ${x} -> ${g.x}`);
  assert.strictEqual(g.y, y, `a guard must not be displaced by a player's swing, y ${y} -> ${g.y}`);
});

test('a player\'s elemental swing applies no status rider to a guard', () => {
  // The rider is applied INSIDE applyMeleeArc's loop, so it falls away with
  // the target. This matters on its own: a burn that ticked would kill a guard
  // through world.js's stepEffects even with the direct damage removed — the
  // same total, paid a tick at a time, and credited to the player who applied
  // it.
  //
  // Driven through applyMeleeArc rather than World.attack because a player's
  // element comes from a socketed spell stone (SOMET-245 converted the magic
  // weapons); items.js's activeWeaponType normalizes a bare weapon's element
  // to 'physical', so the world-level swing above cannot supply one. This is
  // the exact function that swing calls, with the element the stone would have
  // merged in.
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([guardRow(), hostileRow({ id: 'h', x: HOME.x + 10, y: HOME.y - CREATURE_SIZE / 2 })]);
  s.applyMeleeArc(HOME.x - 40, HOME.y, 1, 0, 200, 1.5, 6, 'fire', 1000, 'u1');

  const g = s.creatures.get('g');
  assert.ok(!g.effects || g.effects.size === 0,
    'a guard must carry no burn from a player\'s fire swing');
  assert.equal(g.hp, 7005, 'and must take no direct damage from it either');

  const h = s.creatures.get('h');
  assert.ok(h.effects && h.effects.size > 0,
    'sanity: the same fire swing must still burn a hostile');
});

// SOMET-286 replaced this test's original assertion (`impacts` deepEqual []),
// which pinned the NO-feedback behaviour deliberately so whoever added the cue
// would see it fail rather than discover the intent by archaeology. The refusal
// is unchanged — no damage, no kill, hit:false — but it is no longer silent.
test('a swing at a guard is refused, and says so: hit:false plus a BLOCKED impact', () => {
  const w = armedWorld([guardRow()]);
  const r = swingAt(w, 'g');
  assert.equal(r.attacks[0].hit, false, 'the swing still did not land: no damage, so no hit');
  assert.deepEqual(r.kills, []);
  assert.equal(r.impacts.length, 1, 'and it is no longer silent');
  const b = r.impacts[0];
  assert.equal(b.t, 'c:g');
  assert.equal(b.b, true, 'the blocked marker the client draws its shield glint from');
  assert.equal(b.v, undefined,
    'no effect NAME: the cue is built into the client so no vfx_effects edit can delete it');
  // On the GUARD, not on the attacker (the weapon's own miss flourish is drawn
  // at the attacker's centre) -- that separation is what makes the two
  // distinguishable on screen.
  assert.equal(b.x, HOME.x);
  assert.equal(b.y, HOME.y);
  // Facing back down the aim vector, i.e. at the attacker, so the shield can
  // be drawn on the struck side.
  assert.equal(b.nx, -1);
  assert.equal(b.ny, 0);

  // THE comparison the ticket is about: swinging at empty ground produces
  // nothing at all. If this ever matches the guard case again, the bug is back.
  const air = armedWorld([]);
  const rAir = air.attack('u1', 1, 0);
  assert.equal(rAir.attacks[0].hit, false, 'a swing at air also reports hit:false...');
  assert.deepEqual(rAir.impacts, [], '...but carries no impact, which is the difference');

  // And a real hit is still a real hit: named effect, no blocked marker.
  const w2 = armedWorld([hostileRow()]);
  const r2 = swingAt(w2, 'h');
  assert.equal(r2.attacks[0].hit, true, 'sanity: a hostile in the same spot is a hit');
  assert.equal(r2.impacts.length, 1);
  assert.equal(r2.impacts[0].b, undefined, 'an ordinary impact carries no blocked marker');
  // The two descriptors are different SHAPES, not the same shape with a flag:
  // an ordinary impact always carries the resolved-name and element keys (null
  // here only because this fixture's knife binds no impact effect), a blocked
  // one carries neither, because there is no library row behind it to name.
  assert.ok(Object.hasOwn(r2.impacts[0], 'v') && Object.hasOwn(r2.impacts[0], 'el'));
  assert.equal(Object.hasOwn(b, 'el'), false);
});

test('a swing that reaches a guard AND a hostile damages one and blocks the other', () => {
  // The mixed case, which a per-swing boolean could not express: the arc
  // resolves normally for the hostile and the guard still contributes only a
  // cue. Both ride the ONE impacts list, told apart by `b`.
  // Hostile centre 20px east of the guard's: 60px from the swing origin, so
  // inside the knife's 70px reach and on the same aim axis.
  const w = armedWorld([guardRow(), hostileRow({ x: HOME.x + 20 - CREATURE_SIZE / 2 })]);
  const r = swingAt(w, 'g');
  assert.equal(r.attacks[0].hit, true, 'the hostile in the same arc still makes this a landed swing');
  const blocked = r.impacts.filter((i) => i.b === true).map((i) => i.t);
  const landed = r.impacts.filter((i) => i.b !== true).map((i) => i.t);
  assert.deepEqual(blocked, ['c:g']);
  assert.deepEqual(landed, ['c:h']);
  assert.equal(w.creatures.creatures.get('g').hp, 7005, 'the guard still took nothing');
});

test('meleeArcTargets never reports a guard, and meleeArcScan puts it in `blocked`', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([guardRow(), hostileRow({ id: 'h', x: HOME.x + 10, y: HOME.y - CREATURE_SIZE / 2 })]);
  const ids = s.meleeArcTargets(HOME.x - 40, HOME.y, 1, 0, 200, 1.5);
  assert.deepEqual(ids, ['h'], `the arc must see the hostile and only the hostile, got ${ids}`);

  // SOMET-286: the same call, split. `hit` must be byte-identical to the list
  // above (it is what applyMeleeArc iterates), and the guard must appear ONLY
  // on the other side.
  const scan = s.meleeArcScan(HOME.x - 40, HOME.y, 1, 0, 200, 1.5);
  assert.deepEqual(scan.hit, ['h']);
  assert.deepEqual(scan.blocked, ['g']);
});

test('a guard OUT of the arc produces no block cue at all', () => {
  // The cue must mean "your swing reached it and was refused", not "there is a
  // guard somewhere in this world" -- otherwise it is noise and stops reading
  // as feedback on the swing the player just made.
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([guardRow()]);
  // Same origin, aimed due WEST: the guard is behind the attacker.
  assert.deepEqual(s.meleeArcScan(HOME.x - 40, HOME.y, -1, 0, 200, 1.5).blocked, []);
  // And out of reach in the right direction.
  assert.deepEqual(s.meleeArcScan(HOME.x - 400, HOME.y, 1, 0, 200, 1.5).blocked, []);
});

// --- 4/5: player projectiles ------------------------------------------------

test('a player projectile direct hit leaves a guard untouched', () => {
  const sim = new ProjectileSim();
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([guardRow({ x: 100 - CREATURE_SIZE / 2, y: 100 - CREATURE_SIZE / 2 })]);
  sim.spawn({ ownerId: 'u1', x: 0, y: 100, nx: 1, ny: 0, weapon: BOW, damage: 40 });
  const out = sim.step(0.2, { creatures: s, players: [], map: openMap(), now: 1000 });
  assert.equal(s.creatures.get('g').hp, 7005, 'a player\'s arrow must not damage a guard');
  assert.deepEqual(out.kills, []);

  // Control: the same shot against a hostile in the same place.
  const s2 = new CreatureSim(openMap(), noRedirect);
  s2.addCreatures([hostileRow({ x: 100 - CREATURE_SIZE / 2, y: 100 - CREATURE_SIZE / 2 })]);
  const sim2 = new ProjectileSim();
  sim2.spawn({ ownerId: 'u1', x: 0, y: 100, nx: 1, ny: 0, weapon: BOW, damage: 40 });
  sim2.step(0.2, { creatures: s2, players: [], map: openMap(), now: 1000 });
  assert.ok(s2.creatures.get('h').hp < 7005, 'sanity: the same arrow must hit a hostile');
});

test('a player AoE detonation leaves a guard untouched, damage and rider alike', () => {
  const sim = new ProjectileSim();
  const s = new CreatureSim(openMap(), noRedirect);
  // Guard 40px off the flight line: well inside the 150px blast radius.
  s.addCreatures([guardRow({ x: 200 - CREATURE_SIZE / 2, y: 140 - CREATURE_SIZE / 2 })]);
  sim.spawn({
    ownerId: 'u1', x: 0, y: 100, nx: 1, ny: 0,
    weapon: { ...FIREBALL, range: 200 }, damage: 60,
  });
  const out = sim.step(1, { creatures: s, players: [], map: openMap(), now: 1000 });
  assert.equal(out.detonations.length, 1, 'sanity: the blast must have gone off');
  const g = s.creatures.get('g');
  assert.equal(g.hp, 7005, 'a player\'s blast must not damage a guard');
  assert.ok(!g.effects || g.effects.size === 0, 'nor apply its burn rider');

  const s2 = new CreatureSim(openMap(), noRedirect);
  s2.addCreatures([hostileRow({ x: 200 - CREATURE_SIZE / 2, y: 140 - CREATURE_SIZE / 2 })]);
  const sim2 = new ProjectileSim();
  sim2.spawn({
    ownerId: 'u1', x: 0, y: 100, nx: 1, ny: 0,
    weapon: { ...FIREBALL, range: 200 }, damage: 60,
  });
  sim2.step(1, { creatures: s2, players: [], map: openMap(), now: 1000 });
  assert.ok(s2.creatures.get('h').hp < 7005, 'sanity: the same blast must hit a hostile');
});

// --- SOMET-286: the refusal is legible on the projectile path too ----------
//
// A cue on melee only would be half a fix: a bow is the weapon a player is
// MOST likely to try a guard with, since nothing about an arrow suggests it
// should be refused.

test('a player\'s arrow through a guard reports ONE block, positioned on the guard', () => {
  const sim = new ProjectileSim();
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([guardRow({ x: 100 - CREATURE_SIZE / 2, y: 100 - CREATURE_SIZE / 2 })]);
  sim.spawn({ ownerId: 'u1', x: 0, y: 100, nx: 1, ny: 0, weapon: BOW, damage: 40 });
  const out = sim.step(0.2, { creatures: s, players: [], map: openMap(), now: 1000 });

  assert.equal(s.creatures.get('g').hp, 7005, 'the immunity is unchanged: still no damage');
  // Exactly one, not one per sub-step. A 900px/s bow crosses a guard's 32px
  // capture radius in FOUR of step()'s 16px sub-steps, so an undeduplicated
  // cue would stack four glints on one target for one arrow.
  assert.equal(out.blocks.length, 1, `one cue per shot per guard, got ${out.blocks.length}`);
  const b = out.blocks[0];
  assert.equal(b.t, 'c:g');
  assert.equal(b.b, true);
  assert.equal(b.v, undefined);
  assert.equal(b.x, 100, 'drawn on the guard, not at the arrow\'s sub-step position');
  assert.equal(b.y, 100);
  assert.equal(b.nx, -1, 'facing back along the arrow\'s flight, i.e. at the shooter');
  assert.equal(b.ny, 0);
});

test('a player\'s arrow that MISSES a guard reports no block', () => {
  // The cue has to mean "this shot would have hit"; a shot sailing past a
  // guard must look exactly like a shot sailing past anything else.
  const sim = new ProjectileSim();
  const s = new CreatureSim(openMap(), noRedirect);
  // 300px off the flight line: never inside the 32px capture radius.
  s.addCreatures([guardRow({ x: 100 - CREATURE_SIZE / 2, y: 400 - CREATURE_SIZE / 2 })]);
  sim.spawn({ ownerId: 'u1', x: 0, y: 100, nx: 1, ny: 0, weapon: BOW, damage: 40 });
  assert.deepEqual(sim.step(0.2, { creatures: s, players: [], map: openMap(), now: 1000 }).blocks, []);
});

test('a player\'s blast reports a block for a guard caught in it', () => {
  const sim = new ProjectileSim();
  const s = new CreatureSim(openMap(), noRedirect);
  // 40px off the flight line: outside the direct-hit radius, well inside the
  // 150px blast. So this asserts the _detonate branch specifically, not the
  // swept one the test above covers.
  s.addCreatures([guardRow({ x: 200 - CREATURE_SIZE / 2, y: 140 - CREATURE_SIZE / 2 })]);
  sim.spawn({
    ownerId: 'u1', x: 0, y: 100, nx: 1, ny: 0,
    weapon: { ...FIREBALL, range: 200 }, damage: 60,
  });
  const out = sim.step(1, { creatures: s, players: [], map: openMap(), now: 1000 });
  assert.equal(out.detonations.length, 1, 'sanity: the blast must have gone off');
  assert.equal(s.creatures.get('g').hp, 7005, 'the immunity is unchanged');
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].t, 'c:g');
  assert.equal(out.blocks[0].x, 200);
  assert.equal(out.blocks[0].y, 140);
  // The shot flew along y=100 and the guard stands at y=140, so wherever along
  // that line the blast actually went off, it is NORTH of the guard and the
  // shield must face it. Unit length matters too -- the renderer offsets the
  // glyph along this vector by a fixed world distance.
  assert.ok(out.blocks[0].ny < -0.9, `must face the blast, got ny=${out.blocks[0].ny}`);
  assert.ok(Math.abs(Math.hypot(out.blocks[0].nx, out.blocks[0].ny) - 1) < 1e-9,
    'the direction must be normalized');
});

test('a guard both flown through AND caught in the blast still gets ONE block', () => {
  const sim = new ProjectileSim();
  const s = new CreatureSim(openMap(), noRedirect);
  // Dead on the flight line and short of the range limit: the shot passes
  // through the guard (no detonation -- a guard is not a valid target) and
  // detonates at the end of its flight, with the guard still inside the blast.
  s.addCreatures([guardRow({ x: 100 - CREATURE_SIZE / 2, y: 100 - CREATURE_SIZE / 2 })]);
  sim.spawn({
    ownerId: 'u1', x: 0, y: 100, nx: 1, ny: 0,
    weapon: { ...FIREBALL, range: 200 }, damage: 60,
  });
  const out = sim.step(1, { creatures: s, players: [], map: openMap(), now: 1000 });
  assert.equal(out.detonations.length, 1, 'sanity: it did reach the end of its range');
  assert.equal(out.blocks.length, 1, `two moments, one cue, got ${out.blocks.length}`);
});

test('a player\'s shot at a HOSTILE reports no blocks', () => {
  const sim = new ProjectileSim();
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([hostileRow({ x: 100 - CREATURE_SIZE / 2, y: 100 - CREATURE_SIZE / 2 })]);
  sim.spawn({ ownerId: 'u1', x: 0, y: 100, nx: 1, ny: 0, weapon: BOW, damage: 40 });
  const out = sim.step(0.2, { creatures: s, players: [], map: openMap(), now: 1000 });
  assert.ok(s.creatures.get('h').hp < 7005, 'sanity: it landed');
  assert.deepEqual(out.blocks, []);
});

test('world.tickProjectiles hands the blocks out to the broadcast', () => {
  // The boundary server.js actually consumes (it pushes these onto the same
  // per-tick impacts stash a landed melee hit uses). Driven through World, not
  // ProjectileSim, because a step() that produced blocks nobody forwarded
  // would be exactly the inert-field failure this ticket exists to avoid.
  const w = armedWorld([guardRow({ x: 100 - CREATURE_SIZE / 2, y: 100 - CREATURE_SIZE / 2 })], 3);
  w.projectiles.spawn({ ownerId: 'u1', x: 0, y: 100, nx: 1, ny: 0, weapon: BOW, damage: 40 });
  const out = w.tickProjectiles(0.2);
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].t, 'c:g');
  assert.equal(out.blocks[0].b, true);
});

// --- 6: the unwired player-melee primitive ---------------------------------

test('applyAttack (the player melee primitive) skips guards too', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([guardRow(), hostileRow({ x: HOME.x + 10, y: HOME.y - CREATURE_SIZE / 2 })]);
  s.applyAttack(HOME.x, HOME.y, 200, 10000, 'physical', 0);
  assert.ok(s.creatures.has('g'), 'a guard must survive a 10000-damage player primitive');
  assert.equal(s.creatures.get('g').hp, 7005);
  assert.ok(!s.creatures.has('h'), 'sanity: the hostile in range must have died');
});

// --- what must NOT change ---------------------------------------------------

test('a guard still damages and kills a hostile', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([
    // The LIVE guard behaviour: 'Guard' with damage_override NULL, which is
    // what migration 1714440173000 wrote and what the per-chunk spawn loader
    // joins in. The unprofiled fallback (GUARD_DEFAULT_BEHAVIOR) still carries
    // the historical override of 25, which would shadow the row's own scaled
    // damage — using it here would measure the fallback, not the guard.
    guardRow({
      behavior: {
        name: 'Guard', aggroRadius: 400, leashRadius: 300,
        chaseStyle: 'guard', damageOverride: null,
      },
    }),
    // 40px east of the guard's centre: inside the default 60px contact range
    // and inside the 300px leash of the guard's post.
    { id: 'h', type: 'Slime', x: HOME.x + 40 - CREATURE_SIZE / 2, y: HOME.y - CREATURE_SIZE / 2,
      hp: 1086, defense: 37.5, faction: 'hostile' },
  ]);
  const first = s.tick(0.1, KEYS, [], 0);
  const h = s.creatures.get('h');
  assert.ok(h && h.hp < 1086, `a guard must damage a hostile, hp=${h && h.hp}`);
  // 397.5 - 37.5 = 360 a swing against 1086 hp: four swings.
  assert.equal(h.hp, 1086 - 360, 'the guard must land its full post-mitigation damage');
  assert.deepEqual(first.killed, []);

  // And it finishes the job: run the clock until the hostile dies.
  let killed = [];
  for (let i = 0; i < 200 && killed.length === 0; i++) {
    killed = s.tick(0.1, KEYS, [], 0).killed;
  }
  assert.deepEqual(killed, ['h'], 'a guard must still be able to kill a hostile');
});

test('a hostile still damages a player', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([{ id: 'c', type: 'Slime', x: 100, y: 100, hp: 100, damage: 25, faction: 'hostile' }]);
  const player = { userId: 'u1', x: 132, y: 92, width: 64, height: 64, hp: 100, maxHp: 100 };
  s.tick(0.1, KEYS, [player], 0);
  assert.ok(player.hp < 100, `a hostile must still hurt a player, hp=${player.hp}`);
});

test('a HOSTILE\'s projectile still damages a guard (the deliberate decision)', () => {
  // Not an oversight: this ticket removes the PLAYER from a guard's damage
  // graph, not everything. A hostile that could not scratch a guard would make
  // the one fight guards exist for entirely one-sided. It is no exploit route
  // either — see the assertion at the end.
  const sim = new ProjectileSim();
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([guardRow({ x: 100 - CREATURE_SIZE / 2, y: 100 - CREATURE_SIZE / 2 })]);
  sim.spawn({
    ownerId: 'shooter', ownerKind: 'creature', ownerFaction: 'hostile',
    x: 0, y: 100, nx: 1, ny: 0, weapon: { ...BOW, damage: 29.5 }, damage: 29.5,
  });
  const out = sim.step(0.2, { creatures: s, players: [], map: openMap(), now: 1000 });
  // SOMET-286: and it is a HIT, so it must carry no refusal cue — a shield
  // glint on a shot that actually damaged the guard would be a lie.
  assert.deepEqual(out.blocks, []);
  const g = s.creatures.get('g');
  assert.ok(g.hp < 7005, 'a hostile\'s shot must still reach a guard');
  // The strongest hostile in the game hits a level-150 guard for MIN_DAMAGE.
  assert.equal(g.hp, 7004, 'and lands on the damage floor: 7005 shots to fell a guard');
});

// --- the predicate itself ---------------------------------------------------

test('the guard predicate keys on the resolved behaviour, not the faction string', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([
    guardRow(),
    hostileRow({ id: 'h' }),
    // A PORTAL guard (services/dungeonGuards.js): an ordinary hostile entity
    // type, given a home anchor and a blocks_portal_id. It must stay killable
    // — a player who cannot kill it can never open the portal it gates.
    { id: 'p', type: 'Orc', x: 500, y: 500, hp: 200, faction: 'hostile',
      home_x: 500, home_y: 500, blocks_portal_id: 'link-1' },
  ]);
  assert.equal(isGuardCreature(s.creatures.get('g')), true);
  assert.equal(immuneToPlayerDamage(s.creatures.get('g')), true);
  assert.equal(immuneToPlayerDamage(s.creatures.get('h')), false);
  assert.equal(immuneToPlayerDamage(s.creatures.get('p')), false,
    'a portal guard is a hostile with a home, not a village guard — it must stay killable');
});

test('a portal guard is still killable by a player, through the real melee path', () => {
  const w = armedWorld([{
    id: 'p', type: 'Orc', x: HOME.x - CREATURE_SIZE / 2, y: HOME.y - CREATURE_SIZE / 2,
    hp: 10, faction: 'hostile', home_x: HOME.x, home_y: HOME.y, blocks_portal_id: 'link-1',
  }]);
  let killed = [];
  for (let i = 0; i < 20 && killed.length === 0; i++) {
    killed = swingAt(w, 'p').kills.map((k) => k.id);
    w.tick(0.3);
  }
  assert.deepEqual(killed, ['p'], 'a portal guard must still die to a player');
});
