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

  const assignHits = worldCode.match(/_attackCd\s*=/g) || [];
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
