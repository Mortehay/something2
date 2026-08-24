// backend/tests/passive_tree_grants_combat.test.js
//
// SOMET-495. The four passive-tree grant kinds that reached nothing until this
// ticket -- `resource`, `damage`, `resist`, `status` -- 1419 of the tree's 2347
// grants, every one of them rendered on the character sheet and inert in play.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: nothing here asserts on
// `composeStats(...).modifiers`, and nothing greps a source file. The modifier
// list is what HID the defect for nine items of this epic -- it was populated
// correctly the entire time. So every test below drives the real path a player
// drives:
//
//     composeStats -> derivePlayerStats -> World.addPlayer / applyDerivedStats
//       -> World.attack -> applyMeleeArc / ProjectileSim -> applyDamage
//
// and asserts on the consequence: hp after a real swing, a real mitigation
// figure, a real status entry, a real pool. Every expected number is
// HAND-COMPUTED in a comment beside it, never re-derived from the constants the
// code uses.
const test = require('node:test');
const assert = require('node:assert');

const { World } = require('../src/authority/world.js');
const { composeStats } = require('../src/services/statComposition.js');
const { derivePlayerStats } = require('../src/services/playerStats.js');
const { hasEffect, canAct, BURN, CHILL, SHOCK } = require('../src/authority/effects.js');
const C = require('../src/services/progressionConstants.js');

// The base progression row every test starts from: level 1, all six stats at
// BASE_STAT, which playerStats.js guarantees is an identity on every formula.
// Written out rather than imported from DEFAULT_PROGRESSION so a future change
// to that default cannot silently move a hand-computed expectation here.
const BASE_ROW = {
  level: 1, experience: 0, passive_points: 0,
  strength: 5, dexterity: 5, constitution: 5,
  intelligence: 5, wisdom: 5, charisma: 5,
};

// THE production composition path, in the same order passiveTreeStore.js's
// composeProgression runs it: grants -> composeStats -> a progression row
// carrying the aggregates -> derivePlayerStats. A test that hand-built a
// `stats` object instead would prove the authority reads a field, not that an
// allocated node reaches it.
function statsFor(passives, classPools = null, row = BASE_ROW) {
  const composed = composeStats({ base: row, passives, gear: [] });
  const progression = {
    ...row,
    strength: composed.strength,
    dexterity: composed.dexterity,
    constitution: composed.constitution,
    intelligence: composed.intelligence,
    wisdom: composed.wisdom,
    charisma: composed.charisma,
    rules: composed.rules,
    pools: composed.pools,
    damageMult: composed.damageMult,
    resists: composed.resists,
    hitStatuses: composed.hitStatuses,
  };
  return derivePlayerStats(progression, classPools);
}

// Weapon catalog for this file. Deliberately small and deliberately explicit
// about `element`: the whole point of a `damage` grant is that it keys off the
// element, and of a `status` grant that it does NOT.
//
// ELEMENTS COME FROM SOCKETED SPELL STONES, never from a weapon's own `element`
// column. items.js's activeWeaponType neuters an UNSOCKETED elemental weapon to
// physical at the default weapon's damage ("replace semantics", SOMET-245), so
// a hand-built `element: 'fire'` weapon here would silently swing as a 20-damage
// physical dagger and every elemental assertion below would be measuring the
// wrong thing. That is exactly how this file's first draft produced four
// confidently wrong numbers.
const TYPES = new Map([
  // A PHYSICAL melee weapon. The status-rider tests use this one: a tree burn
  // riding a plain steel blade is exactly what "your hits burn" promises, and a
  // fire weapon would prove nothing (the element applies burn on its own).
  [1, { id: 1, name: 'blade', category: 'weapon', kind: 'melee', damage: 20, cooldown: 0.3, reach: 200, arc_width: 2.0, mana_cost: 0, element: null }],
  // A bare melee host for a spell stone. Its own damage is vestigial: the
  // socketed stone replaces element/damage/cooldown/mana_cost.
  [2, { id: 2, name: 'host blade', category: 'weapon', kind: 'melee', damage: 1, cooldown: 9, reach: 200, arc_width: 2.0, mana_cost: 0, element: null }],
  // A bare projectile host, same idea.
  [3, { id: 3, name: 'host bow', category: 'weapon', kind: 'projectile', damage: 1, cooldown: 9, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, element: null }],
  // A plain PHYSICAL bow, for the projectile status rider (no stone needed).
  [4, { id: 4, name: 'plainbow', category: 'weapon', kind: 'projectile', damage: 20, cooldown: 0.3, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, element: null }],
  // Armour. `resistances` is on the FRACTION scale item_types uses: 0.3 is 30%.
  [10, { id: 10, name: 'ice ward', category: 'armor', slot: 'chest', defense: 10, resistances: { ice: 0.3 } }],
  [11, { id: 11, name: 'ember mail', category: 'armor', slot: 'chest', defense: 0, resistances: { fire: 0.1 } }],
  // A stamina-hungry weapon, for the stamina pool.
  [12, { id: 12, name: 'maul', category: 'weapon', kind: 'melee', damage: 5, cooldown: 0, reach: 200, arc_width: 2.0, mana_cost: 0, stamina_cost: 20, element: null }],
  // Spell stones. Zero mana cost so nothing below is gated on a mana pool.
  [40, { id: 40, name: 'stone of fire', category: 'stone', element: 'fire', mana_cost: 0, damage: 20, cooldown: 0.3 }],
  [41, { id: 41, name: 'stone of ice', category: 'stone', element: 'ice', mana_cost: 0, damage: 100, cooldown: 0.3 }],
]);

function armWorld() {
  return new World({
    chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [],
  }, TYPES, 1);
}

const invWith = (...typeIds) => ({
  items: typeIds.map((t, i) => ({ id: `i${i}`, typeId: t })),
  equipment: typeIds.reduce((eq, t, i) => {
    const type = TYPES.get(t);
    eq[type.category === 'weapon' ? 'main_hand' : type.slot] = `i${i}`;
    return eq;
  }, {}),
});

// A weapon with a spell stone socketed, plus optional armour. The stone is what
// gives the swing its element — see the catalog note above.
const socketed = (weaponTypeId, stoneTypeId, ...armorTypeIds) => {
  const inv = invWith(weaponTypeId, ...armorTypeIds);
  inv.items[0].socketedStoneTypeId = stoneTypeId;
  return inv;
};

// ---------------------------------------------------------------------------
// AC1 -- `resource`: a flat pool bonus that moves the real pool.
// ---------------------------------------------------------------------------

test('a resource grant raises maxHp ON TOP of the class base and the CON scaling', () => {
  // HAND-COMPUTED, for a Ranger-shaped class base of 85 with CON 8:
  //   class base            85
  //   + HP_PER_CON x (8-5)  +30   (10 per point above base, three points)
  //   + the tree's +10 hp   +10
  //   = 125
  // Each term is a different mechanism, and the grant is the LAST of the three.
  // A wiring that replaced the class base, or that was applied before the stat
  // scaling, would land on 95 or on 115 respectively.
  const row = { ...BASE_ROW, constitution: 8 };
  const stats = statsFor([{ type: 'resource', pool: 'hp', value: 10, label: 'Constitution' }],
    { maxHp: 85, maxMana: 60 }, row);
  assert.strictEqual(stats.maxHp, 125);

  // ...and without the grant, the same character is 115. The DIFFERENCE is what
  // the node is worth; asserting only 125 would stay green if the class base
  // had silently moved to 95.
  const bare = statsFor([], { maxHp: 85, maxMana: 60 }, row);
  assert.strictEqual(bare.maxHp, 115);
  assert.strictEqual(stats.maxHp - bare.maxHp, 10);
});

test('the extra life survives a REAL swing: two players, one node, 10 more hp left', () => {
  const w = armWorld();
  // The attacker: plain blade, 20 damage, no grants of its own.
  w.addPlayer('atk', { x: 0, y: 100 }, invWith(1), undefined, 0, statsFor([]));
  // Both victims stand due east of the attacker, inside the blade's arc.
  w.addPlayer('tough', { x: 120, y: 100 }, invWith(), undefined, 0,
    statsFor([{ type: 'resource', pool: 'hp', value: 10, label: 'Constitution' }]));
  w.addPlayer('plain', { x: 130, y: 110 }, invWith(), undefined, 0, statsFor([]));

  w.attack('atk', 1, 0);

  // HAND-COMPUTED: HP_BASE 100 (no class row) + 0 CON scaling, so
  //   tough: 100 + 10 (tree) - 20 (the swing) = 90
  //   plain: 100          - 20 (the swing) = 80
  // Both took the SAME hit through the SAME melee path; the 10 is the node.
  assert.strictEqual(w.getPlayer('tough').hp, 90);
  assert.strictEqual(w.getPlayer('plain').hp, 80);
});

test('a stamina grant buys a real extra swing of a stamina-hungry weapon', () => {
  // The maul costs 20 stamina and has no cooldown, so the pool is the only
  // thing that limits it: 100/20 = 5 swings, 130/20 = 6.
  const swingsWith = (passives) => {
    const w = armWorld();
    w.addPlayer('u1', { x: 0, y: 100 }, invWith(12), undefined, 0, statsFor(passives));
    let swings = 0;
    // 12 attempts: comfortably more than either budget allows, so the count is
    // set by the stamina gate and not by the loop.
    for (let i = 0; i < 12; i++) if (w.canAttack('u1').ok) { w.attack('u1', 1, 0); swings += 1; }
    return swings;
  };
  assert.strictEqual(swingsWith([]), 5, 'the base stamina pool buys 100/20 = 5 maul swings');
  assert.strictEqual(
    swingsWith([{ type: 'resource', pool: 'stamina', value: 30, label: 'Endurance' }]), 6,
    'a +30 stamina node must buy 130/20 = 6 swings, not 5 — the pool is inert',
  );
});

test('allocating a resource grant MID-SESSION moves the live pool by the delta, not to full', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 100 }, invWith(), undefined, 0, statsFor([]));
  const p = w.getPlayer('u1');
  p.hp = 40;                                   // wounded
  w.applyDerivedStats('u1', statsFor([{ type: 'resource', pool: 'hp', value: 40, label: 'Thick Skin' }]));
  // HAND-COMPUTED: max 100 -> 140, so current 40 -> 80. Healing to full here
  // would make allocating a point a free heal mid-fight.
  assert.strictEqual(p.maxHp, 140);
  assert.strictEqual(p.hp, 80);
});

// ---------------------------------------------------------------------------
// AC2 / AC3 -- `resist`: one scale with armour, and drawbacks that bite.
// ---------------------------------------------------------------------------

test('a resist grant and an armour resistance compose ON ONE SCALE through a real hit', () => {
  const w = armWorld();
  // 100-damage ice swing (host blade + stone of ice), no grants on the attacker.
  w.addPlayer('atk', { x: 0, y: 100 }, socketed(2, 41), undefined, 0, statsFor([]));
  // The victim wears the ice ward (defense 10, ice 0.30 = 30%) AND has a +6
  // ice resist node (6 percentage points = 0.06).
  w.addPlayer('vic', { x: 120, y: 100 }, invWith(10), undefined, 0,
    statsFor([{ type: 'resist', element: 'ice', value: 6, label: 'Warm Blood' }]));

  w.attack('atk', 1, 0);

  // HAND-COMPUTED:
  //   raw                       100
  //   - armour defense           -10  -> 90
  //   resistance 0.30 + 0.06 =  0.36
  //   90 x (1 - 0.36)          = 57.6 dealt
  //   100 hp - 57.6            = 42.4 left
  //
  // THE SCALE IS THE WHOLE TEST. Merge the tree's 6 unconverted and the
  // resistance is 6.30, capped at RESIST_CAP 0.8, so 90 x 0.2 = 18 dealt and
  // 82 hp left -- one node worth twenty full sets of armour.
  assert.strictEqual(Math.round(w.getPlayer('vic').hp * 100) / 100, 42.4,
    'expected 42.4 hp: 90 post-defense x (1 - 0.36). 82 means the tree grant was '
    + 'merged as 6.0 instead of 0.06 and hit the resistance cap');
});

test('a NEGATIVE resist grant genuinely takes MORE damage — drawbacks are not clamped away', () => {
  const w = armWorld();
  // A fire swing, 20 damage (host blade + stone of fire).
  w.addPlayer('atk', { x: 0, y: 100 }, socketed(2, 40), undefined, 0, statsFor([]));
  // The victim wears fire 0.10 armour and a -25 fire drawback: net -0.15.
  w.addPlayer('cursed', { x: 120, y: 100 }, invWith(11), undefined, 0,
    statsFor([{ type: 'resist', element: 'fire', value: -25, label: 'Pyre Pact' }]));
  // A control victim in the same armour with no drawback: net +0.10.
  w.addPlayer('safe', { x: 130, y: 110 }, invWith(11), undefined, 0, statsFor([]));

  w.attack('atk', 1, 0);

  // HAND-COMPUTED, defense 0 on the ember mail:
  //   cursed: 20 x (1 - (0.10 - 0.25)) = 20 x 1.15 = 23   -> 100 - 23 = 77
  //   safe:   20 x (1 -  0.10)         = 20 x 0.90 = 18   -> 100 - 18 = 82
  // Clamping the negative at 0 (the pre-495 rule) gives the cursed player 20
  // damage and 80 hp: the drawback silently refunded.
  assert.strictEqual(w.getPlayer('cursed').hp, 77,
    'a -25 fire drawback under +10 armour must take 1.15x. 80 hp means the '
    + 'negative resistance was clamped to 0 and the keystone is free');
  assert.strictEqual(w.getPlayer('safe').hp, 82);
});

test('a resist grant allocated mid-session reaches p.mit without touching the gear', () => {
  const w = armWorld();
  w.addPlayer('atk', { x: 0, y: 100 }, socketed(2, 41), undefined, 0, statsFor([]));
  w.addPlayer('vic', { x: 120, y: 100 }, invWith(10), undefined, 0, statsFor([]));

  // Allocate AFTER joining, exactly as clicking a node does. Nothing is
  // equipped or unequipped; if the rebuild only happened on an equip change,
  // the node would be inert until the player happened to swap a chestpiece.
  w.applyDerivedStats('vic', statsFor([{ type: 'resist', element: 'ice', value: 6, label: 'Warm Blood' }]));
  w.attack('atk', 1, 0);

  // Same 42.4 as the composed case above. 45.0 (90 x 0.70) means the grant
  // never reached the mitigation the swing was measured against.
  assert.strictEqual(Math.round(w.getPlayer('vic').hp * 100) / 100, 42.4);
});

// ---------------------------------------------------------------------------
// AC4 -- `damage`: percent, additive between grants, multiplicative on the hit.
// ---------------------------------------------------------------------------

test('two damage grants on one element stack ADDITIVELY, then multiply the hit', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 100 }, socketed(2, 40), undefined, 0, statsFor([
    { type: 'damage', element: 'fire', value: 35, label: 'Pyromancy' },
    { type: 'damage', element: 'fire', value: 5, label: 'Kindling' },
  ]));
  // hp far above the hit so nothing is floored or killed, and no mitigation.
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 120, y: 100, hp: 1000, facing: 'S', color: '#c00' }]);

  w.attack('u1', 1, 0);

  // HAND-COMPUTED:
  //   +35% and +5% sum to +40%, i.e. x1.40
  //   20 (weapon) x 1.0 (spellMult at base INT) x 1.40 = 28 dealt
  //   1000 - 28 = 972
  // Multiplying the two grants instead (1.35 x 1.05 = 1.4175) gives 28.35 and
  // 971.65 -- close enough to pass a tolerance, which is why this is exact.
  assert.strictEqual(w.creatures.get('c1').hp, 972,
    'expected 28 damage (x1.40). 971.65 means the grants were multiplied '
    + '(1.35 x 1.05) instead of summed; 980 means the grant is inert');
});

test('a damage grant applies ONLY to its own element', () => {
  const w = armWorld();
  // +50% ICE, swinging a FIRE weapon.
  w.addPlayer('u1', { x: 0, y: 100 }, socketed(2, 40), undefined, 0,
    statsFor([{ type: 'damage', element: 'ice', value: 50, label: 'Frostbite' }]));
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 120, y: 100, hp: 1000, facing: 'S', color: '#c00' }]);
  w.attack('u1', 1, 0);
  // HAND-COMPUTED: 20 dealt, unchanged. 1000 - 20 = 980.
  assert.strictEqual(w.creatures.get('c1').hp, 980,
    'an ice grant must not scale a fire weapon');
});

test('a physical damage grant scales a weapon with a NULL element', () => {
  const w = armWorld();
  // The blade's `element` column is null. applyDamage treats that as physical,
  // so the multiplier must too -- otherwise a bare weapon is boosted as one
  // element and mitigated as another.
  w.addPlayer('u1', { x: 0, y: 100 }, invWith(1), undefined, 0,
    statsFor([{ type: 'damage', element: 'physical', value: 25, label: 'Brutality' }]));
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 120, y: 100, hp: 1000, facing: 'S', color: '#c00' }]);
  w.attack('u1', 1, 0);
  // HAND-COMPUTED: 20 x 1.25 = 25 dealt -> 975.
  assert.strictEqual(w.creatures.get('c1').hp, 975);
});

test('a damage grant reaches a PROJECTILE, whose damage is snapshotted at launch', () => {
  const w = armWorld();
  // host bow + stone of fire: a 20-damage fire shot.
  w.addPlayer('u1', { x: 0, y: 100 }, socketed(3, 40), undefined, 0,
    statsFor([{ type: 'damage', element: 'fire', value: 40, label: 'Pyromancy' }]));
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 300, y: 108, hp: 1000, facing: 'S', color: '#c00' }]);

  w.attack('u1', 1, 0);
  for (let i = 0; i < 20 && w.creatures.get('c1').hp === 1000; i++) { w.tick(0.05); w.tickProjectiles(0.05); }

  // HAND-COMPUTED: 20 x 1.40 = 28 -> 972. The shot is resolved by
  // ProjectileSim, a completely different code path from the melee arc; a
  // multiplier wired into only one of the two is half a feature.
  assert.strictEqual(w.creatures.get('c1').hp, 972);
});

// ---------------------------------------------------------------------------
// AC5 -- `status`: on-hit riders, element-independent, and shock-safe.
// ---------------------------------------------------------------------------

test('a status grant makes a PHYSICAL weapon apply its status on a real swing', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 100 }, invWith(1), undefined, 0,
    statsFor([{ type: 'status', status: 'burn', value: 1, label: 'Venomous Bond' }]));
  w.addPlayer('u2', { x: 500, y: 500 }, invWith(1), undefined, 0, statsFor([]));  // no grant
  w.creatures.addCreatures([
    { id: 'c1', type: 'Wolf', x: 120, y: 100, hp: 1000, facing: 'S', color: '#c00' },
    { id: 'c2', type: 'Wolf', x: 560, y: 500, hp: 1000, facing: 'S', color: '#c00' },
  ]);

  w.attack('u1', 1, 0);
  w.attack('u2', 1, 0);

  // The blade's element is NULL. Only the tree can have applied this burn.
  assert.ok(hasEffect(w.creatures.get('c1'), BURN, w.now),
    'a "your hits burn" node must burn on a plain physical swing');
  assert.ok(!hasEffect(w.creatures.get('c2'), BURN, w.now),
    'the control attacker has no such node and must apply nothing');
});

test('the burn a status grant applies actually TICKS damage, like any other burn', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 100 }, invWith(1), undefined, 0,
    statsFor([{ type: 'status', status: 'burn', value: 1, label: 'Venomous Bond' }]));
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 120, y: 100, hp: 1000, facing: 'S', color: '#c00' }]);
  w.attack('u1', 1, 0);
  const afterSwing = w.creatures.get('c1').hp;   // 1000 - 20 = 980
  assert.strictEqual(afterSwing, 980);

  // 1.5 world-seconds: BURN_TICK_MS is 1000, so exactly one tick has fired.
  for (let i = 0; i < 30; i++) w.tick(0.05);
  assert.ok(w.creatures.get('c1').hp < afterSwing,
    'the tree-applied burn never dealt damage — a status entry nothing ticks is '
    + 'the same inert feature one layer in');
});

test('a status grant rides a PROJECTILE and is snapshotted at launch', () => {
  const w = armWorld();
  // A PLAIN physical bow: only the tree can chill with this.
  w.addPlayer('u1', { x: 0, y: 100 }, invWith(4), undefined, 0,
    statsFor([{ type: 'status', status: 'chill', value: 1, label: 'Cryomancy' }]));
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 300, y: 108, hp: 1000, facing: 'S', color: '#c00' }]);

  w.attack('u1', 1, 0);
  for (let i = 0; i < 20 && w.creatures.get('c1').hp === 1000; i++) { w.tick(0.05); w.tickProjectiles(0.05); }

  assert.ok(hasEffect(w.creatures.get('c1'), CHILL, w.now),
    'a "your hits chill" node must chill on an ARROW too — a rider wired only '
    + 'into the melee arc leaves every bow and staff riderless');
});

// THE DANGEROUS ONE. SOMET-480 deliberately excluded shock from debuff affixes
// because an on-hit shock that refreshes is a permanent stunlock. The tree
// authors one anyway (`Jarring Blows`), and it is safe here for exactly one
// reason: applyHitStatuses routes shock through applyShockInterrupt's
// per-target, NON-REFRESHING immunity window.
//
// Same shape as SOMET-473's charm chain-lock test and effects.js's own three.
// This one is stronger in one respect: it drives the REAL World.attack path
// with the REAL cooldown gate, so it measures what a player can actually do to
// another player rather than what a hand-called effect helper does.
//
// IT GOES RED IF THE RIDER IS ROUTED THROUGH THE REFRESH PATH. Replace the
// stampRider call in applyHitStatuses with a bare applyEffect + a direct
// `target._interruptedUntil = now + SHOCK_INTERRUPT_MS`, and the victim below
// acts on ~0 of the sampled ticks.
test('a tree shock rider CANNOT chain-lock a player, even at a 0.3s weapon cooldown', () => {
  const w = armWorld();
  // The blade fires every 300ms -- nearly four times the storm staff's rate,
  // and the rider does not care that the blade is physical.
  w.addPlayer('atk', { x: 0, y: 100 }, invWith(1), undefined, 0,
    statsFor([{ type: 'status', status: 'shock', value: 1, label: 'Jarring Blows' }]));
  w.addPlayer('vic', { x: 120, y: 100 }, invWith(), undefined, 0, statsFor([]));
  const vic = w.getPlayer('vic');
  vic.hp = 1e9;                 // the fight lasts the whole ten seconds
  vic.maxHp = 1e9;

  let actedTicks = 0, totalTicks = 0, interrupted = 0;
  for (let ms = 0; ms < 10000; ms += 100) {
    w.tick(0.1);
    w.attack('atk', 1, 0);      // refused by the cooldown when it is not ready
    totalTicks += 1;
    if (canAct(vic, w.now)) actedTicks += 1; else interrupted += 1;
  }

  assert.ok(hasEffect(vic, SHOCK, w.now),
    'the rider never landed at all — this test would pass trivially');
  assert.ok(interrupted > 0,
    'the victim was never interrupted, so the rider is decorative and the '
    + 'chain-lock assertion below proves nothing');
  // The window guarantees (SHOCK_IMMUNITY_MS - SHOCK_INTERRUPT_MS) of control
  // per landed interrupt no matter the hit RATE: 2600 of every 3000ms, i.e.
  // ~87%. 50 of 100 sampled ticks is a wide floor under that.
  assert.ok(actedTicks > 50,
    `the victim could act on only ${actedTicks}/${totalTicks} sampled ticks of 10s under a `
    + '0.3s-cooldown weapon with a tree shock rider — the immunity window is being refreshed '
    + 'instead of running to completion, and one player can hold another permanently interrupted');
});

test('a tree shock rider still applies the shock ENTRY, so its vulnerability and drain work', () => {
  // The interrupt is gated; the rest of shock is not, and must not be. This is
  // the other half of "shock is safe here" -- a rider that landed nothing at
  // all would also pass the chain-lock test.
  const w = armWorld();
  w.addPlayer('atk', { x: 0, y: 100 }, invWith(1), undefined, 0,
    statsFor([{ type: 'status', status: 'shock', value: 1, label: 'Jarring Blows' }]));
  w.creatures.addCreatures([{ id: 'c1', type: 'Wolf', x: 120, y: 100, hp: 1000, facing: 'S', color: '#c00' }]);
  w.attack('atk', 1, 0);
  assert.ok(hasEffect(w.creatures.get('c1'), SHOCK, w.now));
});

// ---------------------------------------------------------------------------
// The seam between the authored scale and the runtime scale.
// ---------------------------------------------------------------------------

test('composeStats converts percentage points to the runtime scales, exactly', () => {
  // The ONE place the authored scale meets the runtime scale, pinned against
  // literals. Everything above measures the consequence; this measures the
  // conversion, so a failure says WHICH of the two is wrong.
  const r = composeStats({
    base: BASE_ROW,
    passives: [
      { type: 'resist', element: 'ice', value: 6 },
      { type: 'resist', element: 'ice', value: 8 },
      { type: 'resist', element: 'fire', value: -15 },
      { type: 'damage', element: 'lightning', value: 12 },
      { type: 'resource', pool: 'stamina', value: 8 },
      { type: 'resource', pool: 'stamina', value: 30 },
    ],
  });
  assert.strictEqual(r.resists.ice, 0.14, '6 + 8 percentage points is the 0.14 armour scale');
  assert.strictEqual(r.resists.fire, -0.15, 'a drawback survives the conversion with its sign');
  assert.strictEqual(r.damageMult.lightning, 1.12);
  assert.strictEqual(r.damageMult.physical, 1, 'an ungranted element is the identity, never undefined');
  assert.strictEqual(r.pools.stamina, 38, 'pools are FLAT and summed as authored, never scaled');
});

test('STAMINA_BASE is the pool a player with no stamina grant actually joins with', () => {
  // world.js's PLAYER_MAX_STAMINA is now an alias for this constant rather than
  // a second copy of 100. Asserted through a joined player, not by comparing
  // the two constants to each other -- that comparison would stay green if both
  // moved and the player still joined at something else.
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, invWith(), undefined, 0, statsFor([]));
  assert.strictEqual(w.getPlayer('u1').maxStamina, C.STAMINA_BASE);
  assert.strictEqual(w.getPlayer('u1').stamina, C.STAMINA_BASE);
});
