// Task 4: derived player stats wired into the live authority simulation.
//
// The whole point of this suite is that a multiplier applied at SOME of the
// read sites looks correct, keeps everything else green, and silently leaves
// half the game unscaled. Every damage/cooldown assertion below checks
// BEHAVIOUR (hp actually lost, cooldown actually stamped) rather than a
// field, and the melee-vs-players / projectile / projectile-cooldown sites
// each get their own dedicated assertion because those are exactly the
// sites a partial wiring would miss.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { World } = require('../src/authority/world.js');
const { derivePlayerStats, DEFAULT_PROGRESSION } = require('../src/services/playerStats.js');

const BASE_STATS = derivePlayerStats(DEFAULT_PROGRESSION);

function stat(overrides) {
  return derivePlayerStats({ ...DEFAULT_PROGRESSION, ...overrides });
}

// All-grass map, same shape as the sibling authority-combat suite's armWorld().
function stubMap() {
  return {
    chunkSize: 8,
    isWalkable: () => true,
    speedAt: () => 1,
    getChunk: () => [],
  };
}

// Weapon catalog for this suite. reach/arc mirror the sibling suite's
// "halberd" fixture (wide + long enough to land on a target directly on the
// aim vector) so melee assertions don't have to fight geometry.
const TYPES = new Map([
  [1, {
    id: 1, name: 'blade', category: 'weapon', kind: 'melee', damage: 10, cooldown: 0.5,
    reach: 190, arc_width: 1.8, mana_cost: 0, element: null,
  }],
  [2, {
    id: 2, name: 'fire-blade', category: 'weapon', kind: 'melee', damage: 10, cooldown: 0.5,
    reach: 190, arc_width: 1.8, mana_cost: 0, element: 'fire',
  }],
  [3, {
    id: 3, name: 'physical-blade', category: 'weapon', kind: 'melee', damage: 10, cooldown: 0.5,
    reach: 190, arc_width: 1.8, mana_cost: 0, element: 'physical',
  }],
  [4, {
    id: 4, name: 'bow', category: 'weapon', kind: 'projectile', damage: 10, cooldown: 0.6,
    range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, element: null,
  }],
  [5, {
    id: 5, name: 'fire-bow', category: 'weapon', kind: 'projectile', damage: 10, cooldown: 0.6,
    range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, element: 'fire',
  }],
  // Magic-stones Task 5 ("replace semantics"): a weapon's own baked-in
  // element is vestigial once sockets exist -- fire-blade/fire-bow above KEEP
  // their element:'fire' columns (mirroring real converted-weapon data), but
  // combat only reads that element through a SOCKETED spell stone now. These
  // mirror weapons 2 and 5's own numbers exactly, so this suite's INT/STR
  // scaling assertions observe identical behavior to before sockets existed.
  [20, { id: 20, name: 'stone_of_fire-blade', category: 'stone', element: 'fire', mana_cost: 0, damage: 10, cooldown: 0.5 }],
  [21, { id: 21, name: 'stone_of_fire-bow', category: 'stone', element: 'fire', mana_cost: 0, damage: 10, cooldown: 0.6 }],
]);

const STONE_BY_WEAPON = { 2: 20, 5: 21 };

function invFor(typeId) {
  const socketedStoneTypeId = STONE_BY_WEAPON[typeId];
  return { items: [{ id: `i${typeId}`, typeId, socketedStoneTypeId }], equipment: { main_hand: `i${typeId}` } };
}

function armWorld() { return new World(stubMap(), TYPES, 1); }

test('a player joining with no progression behaves exactly as before A2', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 });
  const p = w.getPlayer('u1');
  assert.equal(p.hp, 100);
  assert.equal(p.maxHp, 100);
  assert.equal(p.mana, 100);
  assert.equal(p.maxMana, 100);
});

test('CON raises max hp and the player joins at full', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, stat({ constitution: 10 }));
  const p = w.getPlayer('u1');
  assert.equal(p.maxHp, 150);
  assert.equal(p.hp, 150);
});

test('STR scales melee damage against creatures AND against players', () => {
  const w = armWorld();
  // strength 25 -> above base 20 -> meleeMult 1 + 0.05*20 = 2.0
  w.addPlayer('u1', { x: 100, y: 100 }, invFor(1), undefined, 0, stat({ strength: 25 }));
  w.addPlayer('u2', { x: 150, y: 100 }); // east of u1, in arc
  w.creatures.addCreatures([{
    id: 'c1', type: 'wolf', x: 150, y: 108, hp: 50, facing: 'S', color: '#f00',
  }]);
  w.attack('u1', 1, 0);
  const c1 = w.creatures.all().find((c) => c.id === 'c1');
  assert.equal(c1.hp, 30, 'creature took 20 (10 base * 2.0 STR mult), not 10');
  const u2 = w.getPlayer('u2');
  assert.equal(u2.hp, u2.maxHp - 20, 'player-vs-player melee also took 20, not 10');
});

test('INT scales a magic weapon, STR does not', () => {
  // fire element, high STR / base INT -> spellMult 1.0 -> damage UNCHANGED at 10.
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, invFor(2), undefined, 0, stat({ strength: 25 }));
    w.creatures.addCreatures([{
      id: 'c1', type: 'wolf', x: 150, y: 108, hp: 50, facing: 'S', color: '#f00',
    }]);
    w.attack('u1', 1, 0);
    const c1 = w.creatures.all().find((c) => c.id === 'c1');
    assert.equal(c1.hp, 40, 'high STR must not scale a fire weapon');
  }
  // fire element, base STR / high INT -> spellMult 2.0 -> damage 20.
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, invFor(2), undefined, 0, stat({ intelligence: 25 }));
    w.creatures.addCreatures([{
      id: 'c1', type: 'wolf', x: 150, y: 108, hp: 50, facing: 'S', color: '#f00',
    }]);
    w.attack('u1', 1, 0);
    const c1 = w.creatures.all().find((c) => c.id === 'c1');
    assert.equal(c1.hp, 30, 'high INT must scale a fire weapon to 20 damage');
  }
  // Mirror image: element 'physical' is STR's lane, INT does not touch it.
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, invFor(3), undefined, 0, stat({ strength: 25 }));
    w.creatures.addCreatures([{
      id: 'c1', type: 'wolf', x: 150, y: 108, hp: 50, facing: 'S', color: '#f00',
    }]);
    w.attack('u1', 1, 0);
    const c1 = w.creatures.all().find((c) => c.id === 'c1');
    assert.equal(c1.hp, 30, 'high STR must scale a physical weapon to 20 damage');
  }
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, invFor(3), undefined, 0, stat({ intelligence: 25 }));
    w.creatures.addCreatures([{
      id: 'c1', type: 'wolf', x: 150, y: 108, hp: 50, facing: 'S', color: '#f00',
    }]);
    w.attack('u1', 1, 0);
    const c1 = w.creatures.all().find((c) => c.id === 'c1');
    assert.equal(c1.hp, 40, 'high INT must not scale a physical weapon');
  }
});

test('a projectile carries its owner-scaled damage', () => {
  const w = armWorld();
  // intelligence 25 -> spellMult 2.0 -> fire-bow's 10 damage snapshots as 20.
  w.addPlayer('u1', { x: 0, y: 0 }, invFor(5), undefined, 0, stat({ intelligence: 25 }));
  // Player center is (32,32); place the creature east of it, within the
  // projectile's capture radius after one substep.
  w.creatures.addCreatures([{
    id: 'c1', type: 'wolf', x: 64, y: 8, hp: 100, facing: 'S', color: '#f00',
  }]);
  w.attack('u1', 1, 0);
  for (let i = 0; i < 5 && w.snapshot().projectiles.length > 0; i++) w.tickProjectiles(0.05);
  const c1 = w.creatures.all().find((c) => c.id === 'c1');
  assert.equal(c1.hp, 80, 'creature must lose 20 (owner-scaled), not 10 (raw weapon.damage)');
});

test('a projectile keeps the damage it launched with when its owner is re-derived', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, invFor(5), undefined, 0, stat({ intelligence: 25 }));
  w.creatures.addCreatures([{
    id: 'c1', type: 'wolf', x: 64, y: 8, hp: 100, facing: 'S', color: '#f00',
  }]);
  w.attack('u1', 1, 0); // spawns with the boosted 20 damage snapshotted
  // Owner respecs back to base mid-flight; the in-flight shot must not change.
  w.applyDerivedStats('u1', BASE_STATS);
  for (let i = 0; i < 5 && w.snapshot().projectiles.length > 0; i++) w.tickProjectiles(0.05);
  const c1 = w.creatures.all().find((c) => c.id === 'c1');
  assert.equal(c1.hp, 80, 'in-flight projectile must still hit for the boosted 20, not 10');
});

test('DEX shortens the cooldown on BOTH the melee and the projectile path', () => {
  const w = armWorld();
  // dexterity 15 -> above base 10 -> cooldownMult = round4(1/(1+0.03*10)) = 0.7692
  const dexStats = stat({ dexterity: 15 });
  w.addPlayer('melee-u', { x: 100, y: 100 }, invFor(1), undefined, 0, dexStats); // blade, cooldown 0.5
  w.addPlayer('proj-u', { x: 300, y: 300 }, invFor(4), undefined, 0, dexStats); // bow, cooldown 0.6

  w.attack('melee-u', 1, 0);
  assert.equal(w.getPlayer('melee-u')._attackCd, 0.5 * 0.7692, 'melee cooldown must be scaled by DEX');

  w.attack('proj-u', 1, 0);
  assert.equal(w.getPlayer('proj-u')._attackCd, 0.6 * 0.7692, 'projectile cooldown must be scaled by DEX');
});

test('WIS scales the mana regen tick', () => {
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, BASE_STATS);
    const p = w.getPlayer('u1');
    p.mana = 0;
    w.tick(1);
    assert.equal(p.mana, 10, 'base WIS regen must be 10/s');
  }
  {
    const w = armWorld();
    // wisdom 25 -> above base 20 -> manaRegen = 10 + 0.5*20 = 20.
    w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, stat({ wisdom: 25 }));
    const p = w.getPlayer('u1');
    p.mana = 0;
    w.tick(1);
    assert.equal(p.mana, 20, 'wisdom 25 must regen 20/s');
  }
});

test('applyDerivedStats raises current hp by the delta and never heals to full', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, BASE_STATS); // maxHp 100
  const p = w.getPlayer('u1');
  p.hp = 30;
  w.applyDerivedStats('u1', stat({ constitution: 10 })); // maxHp 150
  assert.equal(p.maxHp, 150);
  assert.equal(p.hp, 80, 'hp must move by the +50 delta, not snap to the new max');
});

test('applyDerivedStats lowering maxHp cannot kill the player', () => {
  const w = armWorld();
  // constitution 15 -> above base 10 -> maxHp 100 + 10*10 = 200
  w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, stat({ constitution: 15 }));
  const p = w.getPlayer('u1');
  p.hp = 5;
  w.applyDerivedStats('u1', BASE_STATS); // maxHp back to 100, delta -100
  assert.equal(p.maxHp, 100);
  assert.equal(p.hp, 1, 'hp must clamp at 1, never reach 0 or below from a respec');
});

// Strips block and line comments before a source-text guard counts anything.
// Deliberate: an unstripped scan counts prose too (this file's own doc
// comments had to be reworded around "w.cooldown" to avoid self-tripping the
// very guard below), which silently couples code comments to a regex the
// next editor won't know exists. Stripping first means comments are free to
// say whatever they want.
//
// `(^|[^:])\/\/.*$` (not a bare `//.*$`) is deliberate too: it avoids eating
// a `//` that appears inside a string/URL preceded by `:` (e.g. `'http://…'`),
// which this codebase doesn't currently have in these two files but a naive
// strip would silently mangle if one were added.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const worldSrc = fs.readFileSync(require.resolve('../src/authority/world.js'), 'utf8');
const projSrc = fs.readFileSync(require.resolve('../src/authority/projectiles.js'), 'utf8');
const worldCode = stripComments(worldSrc);
const projCode = stripComments(projSrc);

// Source-text guard, narrowed to CODE only (comments stripped -- see above).
// A raw-text scan has two problems: it counts comments/strings (coupling
// prose to the regex), and it has false negatives -- a third stamping site
// written as `const { cooldown } = w; p._attackCd = cooldown;` or
// `w['cooldown']` would sail through a `w.cooldown`-count check untouched.
// The second assertion below closes that gap by checking the INVARIANT
// (how many places ever assign `_attackCd`) rather than one particular
// spelling of a read.
//
// The count is 2, not 3: `_attackCd` is touched in three places in the
// source (addPlayer's initializer, tick()'s per-frame decrement, and
// applyAttackCooldown's stamp), but addPlayer's is an object-literal
// initializer (`_attackCd: 0,`, a colon) rather than an assignment
// (`_attackCd = ...`), so `/_attackCd\s*=/` does not match it. Verified
// against the current source before writing this assertion, not tuned to
// whatever number happened to pass.
test('the weapon cooldown is read in exactly one place, and _attackCd is assigned in exactly two', () => {
  const cooldownHits = worldCode.match(/w\.cooldown/g) || [];
  assert.equal(cooldownHits.length, 1, `w.cooldown read at ${cooldownHits.length} sites; route them all through applyAttackCooldown`);

  // SOMET-531 widened this pattern. It was /_attackCd\s*=/, which counts a
  // plain `=` and nothing else -- so rewriting tick()'s decrement as
  // `_attackCd -= dt` dropped the count to 1 and failed the gate for a change
  // that added no site at all. The same blind spot works in the dangerous
  // direction too: a NEW stamping site spelled `_attackCd += x` would have
  // been invisible to it, which is exactly what this gate exists to catch.
  //
  // The `(?!=)` is what keeps a comparison out of the count -- the old pattern
  // would happily have counted `_attackCd === 0` as an assignment, and only
  // the accident that world.js contains no such comparison kept it honest.
  const assignHits = worldCode.match(/_attackCd\s*[-+*/]?=(?!=)/g) || [];
  assert.equal(
    assignHits.length,
    2,
    `_attackCd assigned at ${assignHits.length} sites (expected 2: tick()'s decrement and applyAttackCooldown's stamp); `
    + 'a new stamping site -- however it spells the read -- must still route through applyAttackCooldown',
  );
});

// Damage's structural guard. The plan's damage-site count was revised UPWARD
// once already (two sites named, three actually existed -- see the
// projectile-vs-players branch this task added). Cooldown got a structural
// guard for its own named hazard; damage, the axis that was already
// miscounted once, had none -- the behavioural tests above only prove the
// paths they exercise, and a fourth damage site reading raw catalog damage
// later would break nothing they check. Comment-stripped for the same
// reason as the cooldown guard above.
test('weapon damage is read in exactly one place in world.js, and one in projectiles.js', () => {
  const worldHits = worldCode.match(/w\.damage/g) || [];
  assert.equal(worldHits.length, 1, `w.damage read at ${worldHits.length} sites in world.js; route them all through weaponDamage(p, w)`);

  const projHits = projCode.match(/weapon\.damage/g) || [];
  assert.equal(projHits.length, 1, `weapon.damage read at ${projHits.length} sites in projectiles.js; only spawn()'s damage ?? weapon.damage fallback should read it`);
});

// ---------------------------------------------------------------------------
// SOMET-514: regenLifeShare, BEHAVIOURALLY.
//
// This rule named tick()'s mana-regen line as its consumer from the day it was
// introduced, and no such read existed -- so the MONK'S START NODE granted
// nothing, and ks_wis_clarity was an inert keystone. The tests below assert hp
// ACTUALLY MOVED across a tick, in the spirit of this suite's header: a rider
// applied at the wrong site, or not at all, looks identical from a field.
// ---------------------------------------------------------------------------

const { RULE_IDENTITIES } = require('../src/services/statComposition.js');

const withRules = (rules) => stat({ rules: { ...RULE_IDENTITIES, ...rules } });

test('regenLifeShare heals a share of the mana ACTUALLY regenerated', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, withRules({ regenLifeShare: 0.5 }));
  const p = w.getPlayer('u1');
  p.mana = 0;
  p.hp = 10;
  w.tick(1); // manaRegen is 10/s at base wisdom -> +10 mana -> +5 hp at 0.5
  assert.equal(p.mana, 10);
  assert.equal(p.hp, 15);
});

// The share rides the mana that actually landed, not the nominal rate. A Monk
// at full mana therefore gains nothing -- which is the difference between a
// regeneration rider and a second, free health regeneration.
test('a player at full mana gains no life from the rider', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, withRules({ regenLifeShare: 0.5 }));
  const p = w.getPlayer('u1');
  p.mana = p.maxMana;
  p.hp = 10;
  w.tick(1);
  assert.equal(p.hp, 10, 'no mana was regenerated, so no life may be restored');
});

// Partial regeneration: only 4 mana fits before the cap, so only 4 * share
// may be healed. A rider that used manaRegen * dt instead would heal 5.
test('the rider is capped by the mana that fit, not by the regen rate', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, withRules({ regenLifeShare: 0.5 }));
  const p = w.getPlayer('u1');
  p.mana = p.maxMana - 4;
  p.hp = 10;
  w.tick(1);
  assert.equal(p.mana, p.maxMana);
  assert.equal(p.hp, 12, 'only the 4 mana that fit may be shared, not the full 10/s rate');
});

test('a player with no such node allocated regenerates mana and no life', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, BASE_STATS);
  const p = w.getPlayer('u1');
  p.mana = 0;
  p.hp = 10;
  w.tick(1);
  assert.equal(p.mana, 10);
  assert.equal(p.hp, 10, 'the identity is 0 -- an unallocated player must be unmoved');
});

test('the rider never overheals past maxHp', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, undefined, undefined, 0, withRules({ regenLifeShare: 5 }));
  const p = w.getPlayer('u1');
  p.mana = 0;
  p.hp = p.maxHp - 1;
  w.tick(1);
  assert.equal(p.hp, p.maxHp);
});

// ---------------------------------------------------------------------------
// SOMET-519: attackSpeedMult / castSpeedMult.
//
// Two rules rather than one, branching on the WEAPON's kind. Both directions
// are asserted for each branch: a test that only checked "melee got faster"
// would pass just as well on a formula that ignored w.kind entirely and sped
// up everything, which is precisely the bug the split exists to prevent.
//
// blade (id 1) has cooldown 0.5; bow (id 4) has cooldown 0.6.
// ---------------------------------------------------------------------------

function cdAfterAttack(typeId, rules) {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, invFor(typeId), undefined, 0,
    rules ? withRules(rules) : BASE_STATS);
  w.attack('u1', 1, 0);
  return w.getPlayer('u1')._attackCd;
}

test('with no speed nodes the cooldown is exactly the weapon catalog value', () => {
  assert.equal(cdAfterAttack(1, null), 0.5);
  assert.equal(cdAfterAttack(4, null), 0.6);
});

test('attackSpeedMult speeds up melee and leaves projectiles alone', () => {
  assert.equal(cdAfterAttack(1, { attackSpeedMult: 2 }), 0.25);
  assert.equal(cdAfterAttack(4, { attackSpeedMult: 2 }), 0.6,
    'a melee attack-speed node must not accelerate a bow');
});

test('castSpeedMult speeds up projectiles and leaves melee alone', () => {
  assert.equal(cdAfterAttack(4, { castSpeedMult: 2 }), 0.3);
  assert.equal(cdAfterAttack(1, { castSpeedMult: 2 }), 0.5,
    'a cast-speed node must not accelerate a sword');
});

// items.js's activeWeaponType spreads `...type` and overrides only element,
// mana_cost, damage and cooldown -- so `kind` is ALWAYS the weapon's own and a
// stone-augmented sword stays melee. Weapon 2 is exactly that: a melee blade
// with a fire stone socketed. The weapon decides whether you swing or shoot.
test('a socketed spell stone on a melee weapon follows the MELEE branch', () => {
  assert.equal(cdAfterAttack(2, { attackSpeedMult: 2 }), 0.25,
    'the weapon is still melee, so attackSpeedMult applies');
  assert.equal(cdAfterAttack(2, { castSpeedMult: 2 }), 0.5,
    'a socketed stone does not make a sword a spell for attack-rate purposes');
});

// THE BOUND. cooldownMult arrives already floored, but floor/speed is
// unbounded below -- flooring one factor does not bound a product. At
// attackSpeedMult 4 the scaled multiplier (0.25) is under the 0.4 floor, so
// the floor must clamp it: 0.5 * 0.4 = 0.2, not 0.5/4 = 0.125.
test('no stack of speed nodes can drive the interval below the floor', () => {
  assert.equal(cdAfterAttack(1, { attackSpeedMult: 4 }), 0.2);
  assert.equal(cdAfterAttack(1, { attackSpeedMult: 100 }), 0.2);
});

// And the floor that clamps it is the PLAYER'S floor, not the bare constant.
// An Archer at cooldownFloor 0.32 keeps more of their haste.
test('the clamp honours a cooldownFloor node rather than the constant', () => {
  assert.equal(cdAfterAttack(1, { attackSpeedMult: 100, cooldownFloor: 0.32 }), 0.16);
});

test('a zero or missing speed multiplier is a no-op, never a division by zero', () => {
  for (const bad of [0, null, undefined, NaN, -1]) {
    assert.equal(cdAfterAttack(1, { attackSpeedMult: bad }), 0.5,
      `attackSpeedMult ${String(bad)} must leave the cooldown untouched`);
  }
});

// ---------------------------------------------------------------------------
// SOMET-520: meleeReachBonus / meleeArcBonus.
//
// blade (id 1) has reach 190 and arc_width 1.8 rad. A creature at distance d
// on the aim vector is hit iff d <= reach; one BEHIND the attacker is hit only
// once the arc opens past PI.
// ---------------------------------------------------------------------------

function swing(rules, creatures) {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, invFor(1), undefined, 0,
    rules ? withRules(rules) : BASE_STATS);
  w.creatures.addCreatures(creatures);
  const out = w.attack('u1', 1, 0); // aiming due EAST
  return { world: w, out };
}

// Places a creature so its CENTRE sits exactly `dx` from the player's centre on
// the aim vector. Both boxes are top-left anchored -- a creature is 48x48 and
// meleeArcScan measures centre-to-centre, so passing the raw offset puts the
// target 25px further out AND 24px off-axis, which is enough to miss for
// reasons that have nothing to do with the rule under test. (It did: the first
// draft of these tests failed here while the bonus was working correctly.)
const CREATURE_BOX = 48;
function eastOf(world, dx) {
  const p = world.getPlayer('u1');
  const half = CREATURE_BOX / 2;
  return { x: p.x + p.width / 2 + dx - half, y: p.y + p.height / 2 - half };
}

test('a creature beyond the catalog reach is missed, and reached with the bonus', () => {
  // 220px east, centre to centre: outside blade's 190 reach, inside 190 + 64.
  const far = (world) => [{
    id: 'c1', type: 'wolf', ...eastOf(world, 220), hp: 50, facing: 'S', color: '#f00',
  }];
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, invFor(1), undefined, 0, BASE_STATS);
    w.creatures.addCreatures(far(w));
    w.attack('u1', 1, 0);
    assert.equal(w.creatures.all().find((c) => c.id === 'c1').hp, 50,
      'without the bonus a target at 220px is out of a 190px reach');
  }
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, invFor(1), undefined, 0,
      withRules({ meleeReachBonus: 64 }));
    w.creatures.addCreatures(far(w));
    w.attack('u1', 1, 0);
    assert.ok(w.creatures.all().find((c) => c.id === 'c1').hp < 50,
      'meleeReachBonus must extend the swing');
  }
});

// The Whirlwind node. blade's 1.8 rad arc reaches +-0.9 rad of the aim vector,
// nowhere near behind; a full turn reaches everything.
test('meleeArcBonus opens the swing to a full circle and hits behind the player', () => {
  const behind = (world) => [{
    id: 'c1', type: 'wolf', ...eastOf(world, -120), hp: 50, facing: 'S', color: '#f00',
  }];
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, invFor(1), undefined, 0, BASE_STATS);
    w.creatures.addCreatures(behind(w));
    w.attack('u1', 1, 0);
    assert.equal(w.creatures.all().find((c) => c.id === 'c1').hp, 50,
      'a 1.8 rad arc aimed east must not reach a target due west');
  }
  {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, invFor(1), undefined, 0,
      withRules({ meleeArcBonus: 5 })); // 1.8 + 5 clamps to TAU
    w.creatures.addCreatures(behind(w));
    w.attack('u1', 1, 0);
    assert.ok(w.creatures.all().find((c) => c.id === 'c1').hp < 50,
      'a circular swing must reach a target directly behind the attacker');
  }
});

// THE TEST THE TICKET WAS WRITTEN AROUND. The descriptor's reach/arc are what
// the CLIENT draws the swing with. If they carry the catalog values while the
// server hit-tested widened ones, the swing connects outside its own animation
// -- invisible to every other test here, and obvious to the first human who
// plays it.
test('the descriptor reports the SAME geometry the hit-test used', () => {
  const { out } = swing({ meleeReachBonus: 64, meleeArcBonus: 0.4 }, []);
  const d = out.attacks[0];
  assert.equal(d.reach, 190 + 64, 'the client must be told the widened reach');
  assert.equal(d.arc, 1.8 + 0.4, 'the client must be told the widened arc');
});

test('an unallocated player still gets exactly the catalog geometry', () => {
  const { out } = swing(null, []);
  assert.equal(out.attacks[0].reach, 190);
  assert.equal(out.attacks[0].arc, 1.8);
});

// Past a full turn a wider arc means nothing, but an unclamped value would
// keep growing and read as if further stacking still helped.
test('the arc is clamped at a full turn no matter how much is stacked', () => {
  for (const bonus of [5, 50, 1000]) {
    const { out } = swing({ meleeArcBonus: bonus }, []);
    assert.equal(out.attacks[0].arc, Math.PI * 2, `arc bonus ${bonus} must clamp to TAU`);
  }
});

// world.js must not read w.reach/w.arc_width anywhere below the one place the
// swing geometry is resolved -- a fifth site added later would silently use the
// catalog value and reintroduce exactly the mismatch above.
test('the swing geometry is resolved once, not re-read from the catalog', () => {
  const src = fs.readFileSync(require.resolve('../src/authority/world.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const reads = src.match(/w\.reach|w\.arc_width/g) || [];
  assert.equal(reads.length, 2,
    `w.reach/w.arc_width read at ${reads.length} sites (expected 2: the single reach and arc resolution)`);
});

// ---------------------------------------------------------------------------
// SOMET-521: projectileCount / projectileSpeedMult / pierceBonus.
//
// bow (id 4) has cooldown 0.6, projectile_speed 900, pierce 1, mana_cost 0.
// ---------------------------------------------------------------------------

function fire(rules, weaponId = 4) {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, invFor(weaponId), undefined, 0,
    rules ? withRules(rules) : BASE_STATS);
  w.attack('u1', 1, 0);
  return w;
}

test('one shot by default, 1 + projectileCount with the nodes', () => {
  assert.equal(fire(null).projectiles.projectiles.length, 1);
  assert.equal(fire({ projectileCount: 1 }).projectiles.projectiles.length, 2);
  // Volley plus both satellites: the full +3 the cluster is authored to reach.
  assert.equal(fire({ projectileCount: 3 }).projectiles.projectiles.length, 4);
});

// A single shot must fly EXACTLY where it was aimed -- the fan is symmetric
// about 0, so an unallocated player's shot is unchanged by this ticket.
test('an unallocated shot flies exactly on the aim vector', () => {
  const [shot] = fire(null).projectiles.projectiles;
  assert.equal(shot.vx, 900);
  assert.equal(shot.vy, 0);
});

// Three shots are centre/left/right, not three stacked on one line. The centre
// one keeps the aim vector; the outer two mirror each other.
test('a volley is fanned symmetrically about the aim vector', () => {
  const shots = fire({ projectileCount: 2 }).projectiles.projectiles;
  assert.equal(shots.length, 3);
  const [left, centre, right] = shots;
  assert.equal(centre.vy, 0, 'the middle shot keeps the aim vector');
  assert.ok(left.vy < 0 && right.vy > 0, 'the outer shots must diverge');
  assert.ok(Math.abs(left.vy + right.vy) < 1e-9, 'the fan must be symmetric');
  // All three keep the same speed -- fanning rotates, it must not rescale.
  for (const s of shots) {
    assert.ok(Math.abs(Math.hypot(s.vx, s.vy) - 900) < 1e-9, 'fanning must not change speed');
  }
});

// THE COST TEST. Moving the spawn into a loop is exactly the edit that sweeps
// spendResources in with it, and a volley that charged per projectile would
// make Volley a DOWNGRADE -- three shots for three times the cost.
//
// IT MEASURES STAMINA, NOT MANA, AND THAT IS LOAD-BEARING. items.js's
// activeWeaponType ZEROES mana_cost on an unsocketed weapon, so a fixture
// wand with mana_cost 20 is charged nothing at runtime. The first draft of
// this test did exactly that and passed against a deliberately broken build
// with spendResources moved inside the loop -- it was measuring a cost the
// game never charges. spendResources takes stamina unconditionally
// (world.js's own `const staminaCost = w.stamina_cost || 0`), so stamina is
// the pool that can actually witness a double-spend.
test('a volley costs one shot of resources and one cooldown, however many fly', () => {
  const costly = new Map(TYPES);
  costly.set(9, {
    id: 9, name: 'sling', category: 'weapon', kind: 'projectile', damage: 10, cooldown: 0.6,
    range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1,
    mana_cost: 0, stamina_cost: 20, element: null,
  });
  const run = (count) => {
    const w = new World(stubMap(), costly, 1);
    w.addPlayer('u1', { x: 100, y: 100 },
      { items: [{ id: 'i9', typeId: 9 }], equipment: { main_hand: 'i9' } },
      undefined, 0, withRules({ projectileCount: count }));
    w.attack('u1', 1, 0);
    const p = w.getPlayer('u1');
    return { stamina: p.stamina, cd: p._attackCd, shots: w.projectiles.projectiles.length };
  };
  const one = run(0);
  const four = run(3);
  assert.equal(one.shots, 1);
  assert.equal(four.shots, 4);
  // The fixture must actually cost something, or everything below is vacuous.
  assert.ok(one.stamina < 100, 'the fixture weapon must really charge stamina');
  assert.equal(four.stamina, one.stamina, 'four projectiles must cost one shot of stamina');
  assert.equal(four.cd, one.cd, 'four projectiles must stamp one cooldown');
});

test('projectileSpeedMult scales the shot, pierceBonus adds targets', () => {
  const [fast] = fire({ projectileSpeedMult: 1.5 }).projectiles.projectiles;
  assert.equal(Math.hypot(fast.vx, fast.vy), 1350);
  const [pierced] = fire({ pierceBonus: 2 }).projectiles.projectiles;
  assert.equal(pierced.pierceLeft, 3, 'bow pierce 1 + 2');
});

// spawn's merged-state clamp collapses a CONTACT detonator to pierce 1,
// because item_types_aoe_pierce_check ("a detonating projectile may not also
// pierce") is a row-level check that cannot see merged state. pierceBonus is
// applied BEFORE that clamp, so it cannot hand an AoE shot the pierce the
// constraint exists to forbid.
test('pierceBonus cannot restore pierce on a detonating projectile', () => {
  const boom = new Map(TYPES);
  boom.set(8, {
    id: 8, name: 'grenade-launcher', category: 'weapon', kind: 'projectile', damage: 10,
    cooldown: 0.6, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1,
    aoe_radius: 60, mana_cost: 0, element: null,
  });
  const w = new World(stubMap(), boom, 1);
  w.addPlayer('u1', { x: 100, y: 100 },
    { items: [{ id: 'i8', typeId: 8 }], equipment: { main_hand: 'i8' } },
    undefined, 0, withRules({ pierceBonus: 5 }));
  w.attack('u1', 1, 0);
  assert.equal(w.projectiles.projectiles[0].pierceLeft, 1,
    'a contact detonator must still collapse to a single target');
});

test('a zero or missing projectile rule leaves the shot untouched', () => {
  for (const bad of [0, null, undefined, NaN, -3]) {
    const w = fire({ projectileCount: bad, projectileSpeedMult: bad, pierceBonus: bad });
    assert.equal(w.projectiles.projectiles.length, 1, `count ${String(bad)}`);
    assert.equal(w.projectiles.projectiles[0].vx, 900, `speed ${String(bad)}`);
    assert.equal(w.projectiles.projectiles[0].pierceLeft, 1, `pierce ${String(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// SOMET-522: the leech aura.
//
// AURA_BASE_RADIUS 120, AURA_MAX_TARGETS 6, resolved once per second.
// It HEALS and never drains, so nothing here may lower hp.
// ---------------------------------------------------------------------------

function packWorld(rules, n, dist = 60) {
  const w = armWorld();
  w.addPlayer('u1', { x: 400, y: 400 }, undefined, undefined, 0,
    rules ? withRules(rules) : BASE_STATS);
  const p = w.getPlayer('u1');
  const cx = p.x + p.width / 2;
  const cy = p.y + p.height / 2;
  // Spread around the player on a circle of radius `dist`, all well inside the
  // base radius unless `dist` says otherwise.
  w.creatures.addCreatures(Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return {
      id: `c${i}`, type: 'wolf',
      x: cx + Math.cos(a) * dist - 24, y: cy + Math.sin(a) * dist - 24,
      hp: 50, facing: 'S', color: '#f00',
    };
  }));
  return { world: w, player: p };
}

test('a player with no aura node is entirely unaffected', () => {
  const { world, player } = packWorld(null, 4);
  player.hp = 10;
  world.tick(1);
  assert.equal(player.hp, 10);
  assert.equal(world.snapshot().players[0].aura, undefined,
    'no aura means no wire field at all');
});

test('the aura heals per hostile inside it, once a second', () => {
  const { world, player } = packWorld({ auraLeech: 2 }, 3);
  player.hp = 10;
  world.tick(1);
  assert.equal(player.hp, 16, '3 creatures * 2 life');
});

// Sub-second frames must accumulate rather than each firing a full second's
// worth -- otherwise the aura is sixty times stronger on a 60Hz server.
test('the aura is per second, not per frame', () => {
  const { world, player } = packWorld({ auraLeech: 2 }, 3);
  player.hp = 10;
  for (let i = 0; i < 10; i += 1) world.tick(0.1); // 1.0s total
  assert.equal(player.hp, 16, 'ten 0.1s frames must heal exactly one second');
});

// THE CAP. A world can hold 12-creature packs; uncapped this is unkillable
// sustain. The heal must stop rising past AURA_MAX_TARGETS.
test('the heal stops at the target cap', () => {
  const six = packWorld({ auraLeech: 2 }, 6);
  six.player.hp = 10;
  six.world.tick(1);
  const sixHeal = six.player.hp - 10;

  const twelve = packWorld({ auraLeech: 2 }, 12);
  twelve.player.hp = 10;
  twelve.world.tick(1);
  assert.equal(twelve.player.hp - 10, sixHeal,
    'twelve creatures must heal exactly what six do');
  assert.equal(sixHeal, 12, '6 capped creatures * 2 life');
});

test('creatures outside the radius do not count, and auraRadius extends it', () => {
  {
    const { world, player } = packWorld({ auraLeech: 2 }, 3, 160); // outside 120
    player.hp = 10;
    world.tick(1);
    assert.equal(player.hp, 10, 'creatures at 160px are outside the 120px base radius');
  }
  {
    const { world, player } = packWorld({ auraLeech: 2, auraRadius: 80 }, 3, 160);
    player.hp = 10;
    world.tick(1);
    assert.equal(player.hp, 16, 'auraRadius 80 must bring 160px inside');
  }
});

test('the aura never overheals and never lowers hp', () => {
  const { world, player } = packWorld({ auraLeech: 50 }, 6);
  player.hp = player.maxHp - 1;
  world.tick(1);
  assert.equal(player.hp, player.maxHp);
  const full = packWorld({ auraLeech: 50 }, 6);
  full.player.hp = full.player.maxHp;
  full.world.tick(1);
  assert.equal(full.player.hp, full.player.maxHp, 'a full player must not lose hp');
});

test('a dead player does not leech', () => {
  const { world, player } = packWorld({ auraLeech: 2 }, 3);
  player.hp = 0;
  world.tick(1);
  assert.equal(player.hp, 0);
});

// The ring the client draws must be the area that actually leeches -- one
// function feeds both, so they cannot disagree.
test('the wire reports the same radius the heal used', () => {
  const { world } = packWorld({ auraLeech: 2, auraRadius: 40 }, 1);
  assert.equal(world.snapshot().players[0].aura, 160, 'AURA_BASE_RADIUS 120 + 40');
});

// ---------------------------------------------------------------------------
// SOMET-527: melee shape variants.
//
// meleeArcBonus and meleeReachBonus are `sum`, so a shape node narrows or
// shortens a swing by authoring a NEGATIVE. That is the payoff for choosing
// `sum` in SOMET-520, and it needs floors: enough negatives otherwise give a
// swing that reaches nothing, or a negative half-angle, which makes inArc's
// cos(arc/2) test meaningless rather than merely tight.
//
// blade (id 1): reach 190, arc_width 1.8. Floors: reach 48, arc 0.3.
// ---------------------------------------------------------------------------

// A creature whose CENTRE sits `dist` from the player's, at `angle` radians
// off the aim vector (which is due east in these tests).
function creatureAt(world, dist, angle = 0) {
  const p = world.getPlayer('u1');
  const cx = p.x + p.width / 2;
  const cy = p.y + p.height / 2;
  const half = CREATURE_BOX / 2;
  return {
    id: 'c1', type: 'wolf',
    x: cx + Math.cos(angle) * dist - half,
    y: cy + Math.sin(angle) * dist - half,
    hp: 50, facing: 'S', color: '#f00',
  };
}

function swingAt(rules, dist, angle) {
  const w = armWorld();
  w.addPlayer('u1', { x: 400, y: 400 }, invFor(1), undefined, 0,
    rules ? withRules(rules) : BASE_STATS);
  w.creatures.addCreatures([creatureAt(w, dist, angle)]);
  const out = w.attack('u1', 1, 0);
  const c = w.creatures.all().find((x) => x.id === 'c1');
  return { hit: !c || c.hp < 50, hp: c ? c.hp : 0, descriptor: out.attacks[0] };
}

// Spearpoint: reach +64, arc -0.9. It must gain range AND lose coverage --
// asserting only the range would pass on a node that was a pure upgrade,
// which is the exact bug this ticket exists to fix.
test('Spearpoint trades arc for reach, and BOTH halves of the trade are real', () => {
  const spear = { meleeReachBonus: 64, meleeArcBonus: -0.9 };
  // Further out than the base 190 reach: base misses, Spearpoint connects.
  assert.equal(swingAt(null, 220, 0).hit, false, 'base reach must miss at 220px');
  assert.equal(swingAt(spear, 220, 0).hit, true, 'Spearpoint must reach 220px');
  // Off-axis at 0.7 rad: inside the base 1.8 arc (half-angle 0.9), outside
  // Spearpoint's 0.9 arc (half-angle 0.45).
  assert.equal(swingAt(null, 150, 0.7).hit, true, 'the base arc covers 0.7 rad off-axis');
  assert.equal(swingAt(spear, 150, 0.7).hit, false,
    'Spearpoint must GIVE UP the off-axis target -- otherwise it is a pure upgrade');
});

// Sweep: arc +2, reach -24. The mirror image.
test('Sweep trades reach for arc, and BOTH halves of the trade are real', () => {
  const sweep = { meleeArcBonus: 2, meleeReachBonus: -24 };
  // 1.3 rad off-axis: outside the base 1.8 arc, inside Sweep's 3.8.
  assert.equal(swingAt(null, 120, 1.3).hit, false, 'the base arc misses 1.3 rad off-axis');
  assert.equal(swingAt(sweep, 120, 1.3).hit, true, 'Sweep must cover 1.3 rad off-axis');
  // At 180px the base reach (190) connects and Sweep's (166) does not.
  assert.equal(swingAt(null, 180, 0).hit, true, 'base reach covers 180px');
  assert.equal(swingAt(sweep, 180, 0).hit, false,
    'Sweep must GIVE UP the distant target');
});

// THE FLOORS, asserted AT the floor rather than near it.
test('stacked negatives cannot produce an unusable or inverted swing', () => {
  const absurd = { meleeReachBonus: -10000, meleeArcBonus: -10000 };
  const d = swingAt(absurd, 40, 0).descriptor;
  assert.equal(d.reach, 48, 'reach floors at MIN_MELEE_REACH, never 0 or negative');
  assert.equal(d.arc, 0.3, 'arc floors at MIN_MELEE_ARC, never 0 or negative');
  // A floored swing is narrow and short, but it still WORKS: a creature
  // standing against the player is hit.
  assert.equal(swingAt(absurd, 40, 0).hit, true,
    'a floored swing must still hit a target pressed against the attacker');
});

// Whirlwind's price. Without this the circle is a strict upgrade, which is the
// balance risk SOMET-520 shipped with and this ticket closes.
test('meleeDamageMult is the price a wide swing pays, and it is real damage', () => {
  const base = swingAt(null, 100, 0);
  const penal = swingAt({ meleeDamageMult: 0.7 }, 100, 0);
  assert.ok(base.hit && penal.hit, 'both must connect, or the comparison is empty');
  assert.ok(penal.hp > base.hp,
    `a penalised swing must deal LESS: base left ${base.hp}, penalised left ${penal.hp}`);
  // blade damage 10 at meleeMult 1 -> 10; at 0.7 -> 7.
  assert.equal(base.hp, 40);
  assert.equal(penal.hp, 43);
});

// The penalty is for SWINGING, so it must not touch a bow. Same reading as
// applyAttackCooldown's branch; asserting only the melee side would pass on a
// formula that quietly nerfed every attack in the game.
test('meleeDamageMult does not touch a projectile', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 400, y: 400 }, invFor(4), undefined, 0,
    withRules({ meleeDamageMult: 0.5 }));
  w.attack('u1', 1, 0);
  assert.equal(w.projectiles.projectiles[0].damage, 10,
    'a bow is not swung, so the shape penalty must not apply');
});

// A stone-augmented sword is still a sword: the penalty follows the WEAPON's
// kind, not its element. Weapon 2 is a melee blade with a fire stone.
test('the penalty follows the weapon kind, not its element', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 400, y: 400 }, invFor(2), undefined, 0,
    withRules({ meleeDamageMult: 0.5 }));
  w.creatures.addCreatures([creatureAt(w, 100, 0)]);
  w.attack('u1', 1, 0);
  const c = w.creatures.all().find((x) => x.id === 'c1');
  assert.equal(c.hp, 45, 'fire blade 10 damage, halved by the shape penalty');
});

// ---------------------------------------------------------------------------
// SOMET-528: the lingering arc wave.
//
// WAVE_DURATION_S 2, WAVE_MAX_STACKS 3, WAVE_INTERVAL_S 1.
// blade (id 1): damage 10, reach 190, arc 1.8.
// ---------------------------------------------------------------------------

function waveWorld(rules) {
  const w = armWorld();
  w.addPlayer('u1', { x: 400, y: 400 }, invFor(1), undefined, 0, withRules(rules));
  return w;
}

test('no wave node means no wave at all', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 400, y: 400 }, invFor(1), undefined, 0, BASE_STATS);
  w.attack('u1', 1, 0);
  assert.equal(w.waves.length, 0);
  assert.equal(w.snapshot().waves, undefined, 'a quiet frame must carry no waves key');
});

// THE WHOLE FEATURE. A creature that was NOT there when the swing landed walks
// into the ground it swept and takes damage. A test that only checked the
// swing's own hit would prove nothing about lingering.
test('a wave damages a creature that arrives AFTER the swing', () => {
  const w = waveWorld({ meleeWaveShare: 0.5 });
  w.attack('u1', 1, 0);                       // swings at empty ground
  assert.equal(w.waves.length, 1);
  // Only now does something wander in.
  w.creatures.addCreatures([creatureAt(w, 120, 0)]);
  w.tick(1);
  const c = w.creatures.all().find((x) => x.id === 'c1');
  assert.ok(c.hp < 50, 'the wave must damage a creature that arrived after the swing');
});

// The wave is the ground the swing swept, frozen. Moving and turning away must
// not drag it along or re-aim it.
test("a wave keeps its own geometry when the owner moves and turns away", () => {
  const w = waveWorld({ meleeWaveShare: 0.5 });
  w.attack('u1', 1, 0);                       // aimed EAST
  const before = { ...w.waves[0] };
  const p = w.getPlayer('u1');
  // Walk far away and face the other way.
  p.x += 500;
  p.facing = 'w';
  w.setInput('u1', 1, -1, 0);
  w.tick(0.5);
  const after = w.waves[0];
  assert.equal(after.x, before.x, 'the wave must not follow its owner');
  assert.equal(after.y, before.y);
  assert.equal(after.nx, before.nx, 'the wave must not re-aim');
  assert.equal(after.reach, before.reach);
  assert.equal(after.arc, before.arc);
});

// BEHAVIOURAL, and it has to be. The test above checks the wave OBJECT's stored
// fields, which a build that reads the owner's LIVE position at damage time
// passes cleanly -- the stored fields are still frozen, they are just not the
// ones used. (Verified: that mutation passed the field test and only this one
// catches it.) Asserting on the damage is asserting on the geometry actually
// applied.
test('a wave damages the ground it swept, not the ground its owner is on now', () => {
  const w = waveWorld({ meleeWaveShare: 0.5 });
  // A creature standing in the swing's path, and one far away where the owner
  // is about to walk to.
  w.creatures.addCreatures([
    { ...creatureAt(w, 120, 0), id: 'inWave' },
    { id: 'atOwnerLater', type: 'wolf', x: 2000, y: 2000, hp: 50, facing: 'S', color: '#f00' },
  ]);
  w.attack('u1', 1, 0);
  const p = w.getPlayer('u1');
  // Teleport the owner next to the distant creature. A wave that read its
  // owner's live position would now cover THAT creature and not the first.
  p.x = 2000 - p.width / 2 - 120;
  p.y = 2000 + 24 - p.height / 2;
  const hp = (id) => (w.creatures.all().find((c) => c.id === id) || { hp: 0 }).hp;
  const inWaveBefore = hp('inWave');
  const distantBefore = hp('atOwnerLater');
  w.tick(1);
  assert.ok(hp('inWave') < inWaveBefore,
    'the creature standing in the swept ground must still be damaged');
  assert.equal(hp('atOwnerLater'), distantBefore,
    'a creature beside the owner\'s NEW position must not be touched -- the wave stayed put');
});

test('a wave expires', () => {
  const w = waveWorld({ meleeWaveShare: 0.5 });
  w.attack('u1', 1, 0);
  assert.equal(w.waves.length, 1);
  w.tick(1);
  assert.equal(w.waves.length, 1, 'still alive at 1s of a 2s wave');
  w.tick(1.5);
  assert.equal(w.waves.length, 0, 'gone past its duration');
});

// Per second, not per frame -- otherwise the authored share silently scales
// with tick rate. Same epsilon hazard the aura hit.
test('wave damage is per second, not per frame', () => {
  const w = waveWorld({ meleeWaveShare: 0.5 });
  w.creatures.addCreatures([creatureAt(w, 120, 0)]);
  w.attack('u1', 1, 0);
  const c = () => w.creatures.all().find((x) => x.id === 'c1');
  const afterSwing = c().hp;
  for (let i = 0; i < 10; i += 1) w.tick(0.1);  // exactly 1.0s
  assert.equal(afterSwing - c().hp, 5, 'ten 0.1s frames must apply exactly one second of wave');
});

// THE CAP, and it is asserted on DAMAGE rather than on wave count. A test that
// only checked `waves.length === 3` would pass on a build where each wave
// ticked independently and the damage compounded anyway.
test('the stack cap bounds DAMAGE, not just the number of waves', () => {
  const measure = (swings) => {
    const w = waveWorld({ meleeWaveShare: 0.5 });
    w.creatures.addCreatures([{
      ...creatureAt(w, 120, 0), hp: 100000,
    }]);
    // The cooldown is cleared directly rather than waited out. This test is
    // about the CAP, and letting real time pass between swings would expire
    // early waves and blur the thing being measured. Note the cooldown floor
    // (SOMET-514) already bounds swing rate at ~0.2s even at attackSpeedMult
    // 100, so waiting would also never reach the cap quickly.
    for (let i = 0; i < swings; i += 1) {
      w.getPlayer('u1')._attackCd = 0;
      w.attack('u1', 1, 0);
    }
    const c = () => w.creatures.all().find((x) => x.id === 'c1');
    const before = c().hp;
    w.tick(1);
    return { waves: w.waves.length, damage: before - c().hp };
  };
  const three = measure(3);
  const twenty = measure(20);
  assert.equal(three.waves, 3, 'three swings, three waves');
  assert.equal(twenty.waves, 3, 'twenty swings must still be three waves');
  assert.equal(twenty.damage, three.damage,
    `twenty swings dealt ${twenty.damage} where three dealt ${three.damage}; `
    + 'the cap must bound damage, not merely the wave count');
});

// The cap drops the STALEST wave rather than refusing the new one: a player who
// keeps swinging keeps their newest ground. Refusing instead would make a fast
// attacker's later swings silently inert, which reads as a bug.
test('the cap drops the oldest wave, so a new swing always lays ground', () => {
  const w = waveWorld({ meleeWaveShare: 0.5 });
  for (let i = 0; i < 3; i += 1) { w.getPlayer('u1')._attackCd = 0; w.attack('u1', 1, 0); }
  const oldest = w.waves[0];
  w.getPlayer('u1')._attackCd = 0;
  w.attack('u1', 1, 0);
  assert.equal(w.waves.length, 3);
  assert.ok(!w.waves.includes(oldest), 'the stalest wave must have been dropped');
});

// One player's cap must not eat another player's waves.
test('the cap is per owner', () => {
  const w = waveWorld({ meleeWaveShare: 0.5 });
  w.addPlayer('u2', { x: 900, y: 900 }, invFor(1), undefined, 0,
    withRules({ meleeWaveShare: 0.5 }));
  for (let i = 0; i < 5; i += 1) { w.getPlayer('u1')._attackCd = 0; w.attack('u1', 1, 0); }
  for (let i = 0; i < 2; i += 1) { w.getPlayer('u2')._attackCd = 0; w.attack('u2', 1, 0); }
  assert.equal(w.waves.filter((v) => v.ownerId === 'u1').length, 3);
  assert.equal(w.waves.filter((v) => v.ownerId === 'u2').length, 2,
    "one player's swinging must not evict another's waves");
});

test('the wire carries the resolved geometry, and no damage', () => {
  const w = waveWorld({ meleeWaveShare: 0.5 });
  w.attack('u1', 1, 0);
  const [wire] = w.snapshot().waves;
  assert.equal(wire.reach, w.waves[0].reach);
  assert.equal(wire.arc, w.waves[0].arc);
  assert.ok(wire.ms > 0 && wire.ms <= 2000);
  assert.equal(wire.damage, undefined, 'damage is not the client\'s business');
});

// ---------------------------------------------------------------------------
// SOMET-531: a speed bonus must not be swallowed by the tick.
//
// The authority only acts on ticks, so a cooldown can only EXPIRE on a tick
// boundary -- that much is unavoidable. What was avoidable is that tick()'s
// decrement clamped at zero, `Math.max(0, _attackCd - dt)`, THROWING AWAY
// however far past zero the countdown had gone. Every cooldown therefore
// restarted from a clean boundary and the effective interval was always
// `ceil(cd/mult/tick) * tick`, rounded UP, every time.
//
// The consequence was a dead passive node. Measured on the running dev stack
// before the fix, a Mage with a 0.7s wand: castSpeedMult 1.2 -> 601ms,
// 1.296 -> 552ms, 1.3997 -> 552ms. The second Quickcast satellite bought
// NOTHING. It is worst on the fastest weapons, where speed matters most: a
// 0.25s knife wasted three of the four Whirlwind satellites.
//
// WHY THESE TESTS MEASURE A RATE. A test that stamps one attack and reads
// `_attackCd` passes on the broken code -- applyAttackCooldown always wrote
// the correct number, and it was the DECREMENT that destroyed it. Only the
// interval between successive admitted attacks can see the defect.
//
// A first draft of this block asserted "each successive satellite changes the
// rate" using invented multipliers, and it PASSED against the broken build --
// the pairs it picked happened not to collide. The cases below are the real
// authored chains (Whirlwind x1.1 per satellite, Quickcast 1.2 then x1.08) on
// the real weapon cooldowns, and each colliding pair was confirmed to collide
// on the pre-fix code before being written down.
// ---------------------------------------------------------------------------

const TICK = 0.05; // the authority's real tick (server.js: tickMs = 50)

// The real catalog's extremes, which is where the defect lives: `knife` is the
// joint-fastest melee weapon in the game (0.25) and `wand` is the cooldown 12
// of the 20 projectile weapons share, including the one the live measurement
// used.
const SPEED_TYPES = new Map([
  [1, {
    id: 1, name: 'knife', category: 'weapon', kind: 'melee', damage: 4, cooldown: 0.25,
    reach: 60, arc_width: 0.6, mana_cost: 0, element: null,
  }],
  [2, {
    id: 2, name: 'wand', category: 'weapon', kind: 'projectile', damage: 7, cooldown: 0.7,
    range: 600, projectile_speed: 700, projectile_radius: 8, pierce: 1,
    mana_cost: 0, element: null,
  }],
]);

// Drive the sim, attacking on every tick the world will accept one, and return
// the mean gap in ms between admitted attacks. Attacking is attempted EVERY
// tick deliberately: that is the saturated-input case the live measurement
// used, and the only one where the cooldown alone sets the rate.
function meanGapMs(typeId, rules, seconds = 40) {
  const w = new World(stubMap(), SPEED_TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 },
    { items: [{ id: 'w1', typeId }], equipment: { main_hand: 'w1' } }, undefined, 0,
    rules ? withRules(rules) : BASE_STATS);
  const p = w.getPlayer('u1');
  const fired = [];
  for (let i = 0; i < Math.round(seconds / TICK); i++) {
    if (p._attackCd <= 0) { w.attack('u1', 1, 0); fired.push(i); }
    w.tick(TICK);
  }
  assert.ok(fired.length > 8, `only ${fired.length} shots fired; the measurement needs more`);
  return ((fired[fired.length - 1] - fired[0]) / (fired.length - 1)) * TICK * 1000;
}

// THE assertion, and the one that encodes the intent: over many shots the
// achieved rate is the rate the numbers promise. Individual gaps still land on
// tick boundaries -- they must -- but they no longer all round the same way.
test('SOMET-531: the achieved fire rate matches cooldown/mult for melee and projectiles', () => {
  const cases = [
    [1, 0.25, { attackSpeedMult: 1 }],
    [1, 0.25, { attackSpeedMult: 1.1 }],
    [1, 0.25, { attackSpeedMult: 1.1 ** 2 }],
    [1, 0.25, { attackSpeedMult: 1.1 ** 3 }],
    [2, 0.7, { castSpeedMult: 1 }],
    [2, 0.7, { castSpeedMult: 1.2 }],
    [2, 0.7, { castSpeedMult: 1.2 * 1.08 }],
    [2, 0.7, { castSpeedMult: 1.2 * 1.08 ** 2 }],
  ];
  for (const [typeId, cd, rules] of cases) {
    const mult = rules.attackSpeedMult || rules.castSpeedMult;
    const want = (cd / mult) * 1000;
    const got = meanGapMs(typeId, rules);
    assert.ok(Math.abs(got - want) < 6,
      `${SPEED_TYPES.get(typeId).name} at x${mult.toFixed(4)}: achieved ${got.toFixed(1)}ms, `
      + `intended ${want.toFixed(1)}ms -- the tick is swallowing the difference`);
  }
});

// The dead points themselves. Each pair below was verified to produce an
// IDENTICAL rate on the pre-fix code, so these cannot pass vacuously.
test('SOMET-531: satellite steps that used to be dead points now change the rate', () => {
  // knife 0.25: Whirlwind satellites 1 and 2 both measured 250ms before.
  const k1 = meanGapMs(1, { attackSpeedMult: 1.1 });
  const k2 = meanGapMs(1, { attackSpeedMult: 1.1 ** 2 });
  assert.ok(k1 - k2 > 10, `knife satellite 2 is still dead: ${k1.toFixed(1)} -> ${k2.toFixed(1)}ms`);
  // and satellites 3 and 4, which both measured 200ms before.
  const k3 = meanGapMs(1, { attackSpeedMult: 1.1 ** 3 });
  const k4 = meanGapMs(1, { attackSpeedMult: 1.1 ** 4 });
  assert.ok(k3 - k4 > 10, `knife satellite 4 is still dead: ${k3.toFixed(1)} -> ${k4.toFixed(1)}ms`);

  // wand 0.7: Quickcast satellites 2 and 3 both measured 550ms before -- this
  // is the exact pair measured on the live stack ("Practised Cadence").
  const w2 = meanGapMs(2, { castSpeedMult: 1.2 * 1.08 });
  const w3 = meanGapMs(2, { castSpeedMult: 1.2 * 1.08 ** 2 });
  assert.ok(w2 - w3 > 10, `wand satellite 3 is still dead: ${w2.toFixed(1)} -> ${w3.toFixed(1)}ms`);
});

// The guard on the fix, and it earned its keep. Carrying the overshoot forward
// is credit, and credit that accrues while idle would let a player bank a
// burst -- a worse bug than the one being fixed.
//
// A first version of the fix floored the countdown at -dt, which kept draining
// a cooldown that had ALREADY expired: a player standing still drifted to a
// full -dt and banked a tick they never earned. It passed a weaker version of
// this test (">= -TICK") and was caught instead by authority_server.test.js's
// `a refusal still costs nothing, cooldown included`, which asserts an
// equality. So this now pins the exact value rather than a bound -- an idle
// player has earned NOTHING, and the assertion says so.
test('SOMET-531: idling banks nothing -- an expired cooldown rests at zero', () => {
  const w = new World(stubMap(), SPEED_TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 },
    { items: [{ id: 'w1', typeId: 1 }], equipment: { main_hand: 'w1' } }, undefined, 0, BASE_STATS);
  const p = w.getPlayer('u1');
  for (let i = 0; i < 200; i++) w.tick(TICK); // 10s of standing still, never attacking
  assert.equal(p._attackCd, 0,
    `an untouched countdown must rest at exactly 0; it drifted to ${p._attackCd}, `
    + 'which is credit the player never earned');

  // And the first swing after idling pays full price -- no discount at all.
  w.attack('u1', 1, 0);
  assert.equal(p._attackCd, 0.25, 'the first shot after idling must pay the full cooldown');

  // The carry that IS earned is bounded by one tick, because tick() steps the
  // countdown only while it is positive and so rests on the first value at or
  // below zero.
  for (let i = 0; i < 200; i++) w.tick(TICK);
  assert.ok(p._attackCd > -TICK && p._attackCd <= 0,
    `a rested countdown must sit in (-dt, 0]; got ${p._attackCd}`);
});

// A weapon must never average FASTER than its own cooldown. The carry makes
// some individual gaps shorter than the rounded-up value on purpose, so this
// pins the direction: the fix removes a penalty, it does not add a buff.
test('SOMET-531: the achieved rate never undershoots the true cooldown', () => {
  for (const mult of [1, 1.1, 1.1 ** 3]) {
    const got = meanGapMs(1, { attackSpeedMult: mult });
    const floor = (0.25 / mult) * 1000;
    assert.ok(got >= floor - 1,
      `knife at x${mult.toFixed(3)} averaged ${got.toFixed(1)}ms, faster than its true ${floor.toFixed(1)}ms`);
  }
});
