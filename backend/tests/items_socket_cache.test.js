const test = require('node:test');
const assert = require('node:assert');
const { activeWeaponType } = require('../src/authority/items.js');

test('activeWeaponType returns the socketed stone type when the equipped weapon has one', () => {
  const stoneType = { id: 99, category: 'stone', element: 'fire', mana_cost: 5 };
  const weaponType = { id: 5, category: 'weapon', element: 'physical', mana_cost: 0 };
  const itemTypes = new Map([[5, weaponType], [99, stoneType]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1, socketedStoneTypeId: 99 }],
  };
  const resolved = activeWeaponType(inv, itemTypes, 5);
  assert.equal(resolved.element, 'fire', 'must resolve to the STONE\'s element, not the weapon\'s own');
  assert.equal(resolved.mana_cost, 5);
});

test('activeWeaponType falls back to the weapon\'s own type when nothing is socketed', () => {
  const weaponType = { id: 5, category: 'weapon', element: 'physical', mana_cost: 0 };
  const itemTypes = new Map([[5, weaponType]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1 }], // no socketedStoneTypeId
  };
  const resolved = activeWeaponType(inv, itemTypes, 5);
  assert.equal(resolved.element, 'physical');
});

test('activeWeaponType ignores a socketed BUFF stone for attack resolution (buff stones do not touch attacks)', () => {
  const buffStoneType = { id: 77, category: 'stone', element: null, stat_bonus_stat: 'strength', stat_bonus_amount: 3 };
  const weaponType = { id: 5, category: 'weapon', element: 'physical', mana_cost: 0 };
  const itemTypes = new Map([[5, weaponType], [77, buffStoneType]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1, socketedStoneTypeId: 77 }],
  };
  const resolved = activeWeaponType(inv, itemTypes, 5);
  assert.equal(resolved.element, 'physical', 'a buff stone must not override the weapon attack');
});

// Regression coverage for a bug the plan's literal Step 3 snippet would have
// shipped: returning the socketed stone's item_types row WHOLESALE (rather
// than merging just its spell fields onto the weapon) loses every weapon
// mechanic a stone row doesn't carry -- reach/arc_width/kind included. A
// melee weapon with a spell stone socketed must still be a MELEE weapon with
// its own reach/arc, dealing the STONE's damage and on the STONE's cooldown
// -- see 1714440167000_convert_magic_weapons_to_stones.js's comment
// enumerating element/mana_cost/damage/cooldown as the complete "spell",
// with reach/arc_width/kind/knockback/etc. staying weapon mechanics.
test('activeWeaponType with a spell stone socketed keeps the weapon\'s own combat-mechanic fields (reach, arc, kind)', () => {
  const stoneType = { id: 99, category: 'stone', element: 'fire', mana_cost: 5, damage: 40, cooldown: 300 };
  const weaponType = {
    id: 5, category: 'weapon', element: 'physical', mana_cost: 0,
    kind: 'melee', reach: 80, arc_width: 1.2, damage: 10, cooldown: 500, knockback: 0,
  };
  const itemTypes = new Map([[5, weaponType], [99, stoneType]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1, socketedStoneTypeId: 99 }],
  };
  const resolved = activeWeaponType(inv, itemTypes, 5);
  assert.equal(resolved.kind, 'melee', 'a melee weapon with a stone socketed must stay melee, not fall through to the projectile branch');
  assert.equal(resolved.reach, 80, 'reach is a weapon mechanic, not a spell field -- must come from the weapon');
  assert.equal(resolved.arc_width, 1.2, 'arc_width is a weapon mechanic, not a spell field -- must come from the weapon');
  assert.equal(resolved.damage, 40, 'damage IS one of the four spell fields -- must come from the stone');
  assert.equal(resolved.cooldown, 300, 'cooldown IS one of the four spell fields -- must come from the stone');
});

// SOMET-245 Task 7: activeWeaponType must also surface the socketed stone's
// OWN player_items.id (distinct from socketedStoneTypeId, the CATALOG type
// id) so a caller resolving the active weapon for combat -- world.js's
// attack() -- can award XP to the exact stone instance that lands a hit,
// without a second DB round trip keyed off the host item.
test('activeWeaponType exposes the socketed stone\'s own player_items id as stoneItemId', () => {
  const stoneType = { id: 99, category: 'stone', element: 'fire', mana_cost: 5, damage: 40, cooldown: 300 };
  const weaponType = { id: 5, category: 'weapon', element: 'physical', mana_cost: 0, kind: 'melee' };
  const itemTypes = new Map([[5, weaponType], [99, stoneType]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{
      id: 'weapon-instance-1', typeId: 5, quantity: 1,
      socketedStoneTypeId: 99, socketedStoneItemId: 'stone-instance-77',
    }],
  };
  const resolved = activeWeaponType(inv, itemTypes, 5);
  assert.equal(resolved.stoneItemId, 'stone-instance-77', 'must be the STONE\'s own instance id, not its type id (99) or the weapon\'s own id');
});

// A weapon can carry socketedStoneTypeId (older hydration, or a test fixture
// that only set the type) without socketedStoneItemId ever having been
// cached -- must not crash, and must not silently invent a wrong id.
test('activeWeaponType returns stoneItemId null when a stone is socketed but no instance id was ever cached', () => {
  const stoneType = { id: 99, category: 'stone', element: 'fire', mana_cost: 5 };
  const weaponType = { id: 5, category: 'weapon', element: 'physical', mana_cost: 0 };
  const itemTypes = new Map([[5, weaponType], [99, stoneType]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1, socketedStoneTypeId: 99 }], // no socketedStoneItemId
  };
  const resolved = activeWeaponType(inv, itemTypes, 5);
  assert.equal(resolved.stoneItemId, null);
});

test('activeWeaponType with no stone socketed does not carry a stoneItemId field bleeding in from a stale cache', () => {
  const weaponType = { id: 5, category: 'weapon', element: 'physical', mana_cost: 0 };
  const itemTypes = new Map([[5, weaponType]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1 }],
  };
  const resolved = activeWeaponType(inv, itemTypes, 5);
  assert.equal(resolved.stoneItemId, undefined, 'a bare weapon must not carry a stoneItemId at all');
});

// Design doc "Combat integration -- replace semantics", point 4: with no
// spell stone socketed, the weapon's own baked-in element/mana_cost become
// vestigial -- the weapon attacks as plain physical at zero mana cost, even
// if item_types still carries old magic-weapon data (e.g. a player unsocketed
// a converted weapon's spell stone, leaving the weapon's own vestigial
// columns from before this system existed).
//
// Important #3 fix (SOMET-245 final review, corrected after a re-review):
// damage must fall back, the same as element/mana_cost -- leaving it at the
// weapon's own magic-tuned value (25 here) gave an unsocketed magic weapon
// its full spell damage at ZERO mana cost, a permanent, un-costed power
// buff. The fallback is DEFAULT_WEAPON_NAME's ('dagger') own damage --
// itemTypes carries a SEPARATE dagger row (id 1) distinct from the magic
// weapon (id 5) so this test cannot pass by accident the way a fixture
// reusing one id for both would.
//
// cooldown must NOT fall back -- a first version of this fix replaced
// cooldown with the dagger's too, which a re-review caught as making the
// original bug WORSE: kind/range/aoe_radius stay the weapon's own (a
// long-range/AoE weapon), so giving it the dagger's fast melee attack RATE
// on top produced a free, ammo-less, rapid-fire AoE weapon that dominated
// ordinary ranged weapons. cooldown is weapon mechanics, the same category
// as kind/reach/range/arc_width -- it must stay `type.cooldown`, the
// weapon's own real, original attack rate.
const DAGGER_TYPE = { id: 1, category: 'weapon', name: 'dagger', element: null, mana_cost: 0, damage: 8, cooldown: 0.3 };

test('activeWeaponType forces plain physical/zero mana cost and dagger-baseline damage, but keeps the weapon\'s OWN cooldown, when the weapon\'s own item_types row still carries vestigial magic and nothing is socketed', () => {
  const weaponType = { id: 5, category: 'weapon', element: 'fire', mana_cost: 8, kind: 'melee', reach: 80, damage: 25, cooldown: 400 };
  const itemTypes = new Map([[5, weaponType], [1, DAGGER_TYPE]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1 }], // unsocketed -- no socketedStoneTypeId
  };
  const resolved = activeWeaponType(inv, itemTypes, 1); // defaultWeaponId=1 (dagger), DISTINCT from the magic weapon's own id 5
  assert.equal(resolved.element, 'physical', 'the weapon\'s own vestigial element must not drive combat once sockets exist');
  assert.equal(resolved.mana_cost, 0, 'the weapon\'s own vestigial mana_cost must not be charged once sockets exist');
  assert.equal(resolved.reach, 80, 'reach is unaffected -- it was never a spell field');
  assert.equal(resolved.damage, DAGGER_TYPE.damage, 'damage must fall back to the dagger baseline, not the weapon\'s own magic-tuned 25');
  assert.notEqual(resolved.damage, weaponType.damage, 'must not silently keep the magic weapon\'s own damage');
  assert.equal(resolved.cooldown, weaponType.cooldown, 'cooldown is weapon mechanics -- it must stay the weapon\'s OWN 400, not fall back to the dagger\'s 0.3');
});

// Same neutralization, reached via the OTHER trigger (nonzero mana_cost with
// a physical/null element) rather than a non-physical element -- pins that
// both branches of the `if` guard above get the same damage fallback and the
// same untouched cooldown.
test('activeWeaponType neutralizes mana_cost/damage but keeps cooldown for a weapon with vestigial mana_cost but a physical element', () => {
  const weaponType = { id: 5, category: 'weapon', element: 'physical', mana_cost: 6, kind: 'projectile', damage: 30, cooldown: 900 };
  const itemTypes = new Map([[5, weaponType], [1, DAGGER_TYPE]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1 }],
  };
  const resolved = activeWeaponType(inv, itemTypes, 1);
  assert.equal(resolved.mana_cost, 0);
  assert.equal(resolved.damage, DAGGER_TYPE.damage);
  assert.equal(resolved.cooldown, weaponType.cooldown, 'cooldown must stay the weapon\'s own 900, not the dagger\'s');
});

// Pathological catalog (no default weapon resolvable at all): must not
// crash, and degrades to the OLD behavior (weapon's own damage) rather than
// inventing a number -- this should never happen in practice
// (DEFAULT_WEAPON_NAME's dagger is always seeded), but the fallback must be
// safe if it ever does. cooldown was never touched by this branch at all,
// so it is unaffected regardless of baseline resolution.
test('activeWeaponType leaves damage unchanged if the default weapon id does not resolve in the catalog (cooldown is always the weapon\'s own, baseline or not)', () => {
  const weaponType = { id: 5, category: 'weapon', element: 'fire', mana_cost: 8, damage: 25, cooldown: 400 };
  const itemTypes = new Map([[5, weaponType]]); // no entry for id 1
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1 }],
  };
  const resolved = activeWeaponType(inv, itemTypes, 1); // defaultWeaponId=1, not in itemTypes
  assert.equal(resolved.element, 'physical');
  assert.equal(resolved.mana_cost, 0);
  assert.equal(resolved.damage, 25, 'no baseline available -- must not crash, falls back to the weapon\'s own damage');
  assert.equal(resolved.cooldown, 400, 'cooldown is always the weapon\'s own value in this branch');
});

// Re-review regression (real catalog numbers, per the re-reviewer's own
// trace of 1714440016000_create_weapon_types.js /
// 1714440019000_weapon_catalog.js): a bare archmage staff must NOT become a
// faster-attacking weapon than it originally was, and must NOT out-DPS the
// bow. Before the correction, cooldown fell back to the dagger's 0.3s while
// kind/range/aoe_radius stayed the staff's own (800 range, projectile) --
// a free, ammo-less, 800-range AoE weapon firing 3.3x/s, strictly dominating
// the bow (12 damage / 0.6s cooldown = 20 dps, costs stamina + arrows).
test('a bare archmage staff keeps its OWN original attack rate and does not out-DPS the bow (re-review regression, real catalog numbers)', () => {
  const DAGGER = {
    id: 1, category: 'weapon', name: 'dagger', kind: 'melee', element: null, mana_cost: 0, damage: 8, cooldown: 0.3,
  };
  const BOW = {
    id: 2, category: 'weapon', name: 'bow', kind: 'projectile', element: null, mana_cost: 0, damage: 12, cooldown: 0.6,
  };
  // archmage staff, exact catalog row: damage 24, cooldown 1.10, range 800,
  // aoe_radius not modeled in this fixture set (irrelevant to this assertion
  // -- the point is attack rate, not aoe -- but kind/range are included to
  // prove they stay untouched too).
  const ARCHMAGE_STAFF = {
    id: 5, category: 'weapon', name: 'archmage staff', kind: 'projectile', two_handed: true,
    element: 'arcane', mana_cost: 32, damage: 24, cooldown: 1.10, range: 800, projectile_speed: 850,
  };
  const itemTypes = new Map([[1, DAGGER], [2, BOW], [5, ARCHMAGE_STAFF]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1 }], // unsocketed
  };
  const resolved = activeWeaponType(inv, itemTypes, 1); // defaultWeaponId=1 (dagger)

  assert.equal(resolved.cooldown, ARCHMAGE_STAFF.cooldown, 'attack rate must stay the staff\'s OWN original 1.10s, not the dagger\'s 0.3s');
  assert.equal(resolved.kind, 'projectile', 'kind stays the weapon\'s own -- unaffected by this branch');
  assert.equal(resolved.range, 800, 'range stays the weapon\'s own -- unaffected by this branch');
  assert.equal(resolved.damage, DAGGER.damage, 'damage still resets to the dagger baseline');

  const bareStaffDps = resolved.damage / resolved.cooldown;
  const bowDps = BOW.damage / BOW.cooldown;
  assert.ok(bareStaffDps < bowDps,
    `a bare (unsocketed) magic weapon must not out-DPS an ordinary ranged weapon of similar tier -- got staff ${bareStaffDps.toFixed(2)} dps vs bow ${bowDps.toFixed(2)} dps`);

  // And explicitly: attack rate must not have gotten FASTER than the
  // weapon's own original cooldown (the exact shape of the re-reviewer's
  // complaint -- "3.7x/s" would be 1/0.3 from the dagger fallback).
  const attacksPerSecond = 1 / resolved.cooldown;
  assert.ok(attacksPerSecond <= 1 / ARCHMAGE_STAFF.cooldown + 1e-9,
    'bare weapon must not attack faster than its own original rate');
});
