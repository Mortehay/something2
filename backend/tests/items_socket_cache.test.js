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
test('activeWeaponType forces plain physical/zero mana cost when the weapon\'s own item_types row still carries vestigial magic and nothing is socketed', () => {
  const weaponType = { id: 5, category: 'weapon', element: 'fire', mana_cost: 8, kind: 'melee', reach: 80, damage: 25, cooldown: 400 };
  const itemTypes = new Map([[5, weaponType]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1 }], // unsocketed -- no socketedStoneTypeId
  };
  const resolved = activeWeaponType(inv, itemTypes, 5);
  assert.equal(resolved.element, 'physical', 'the weapon\'s own vestigial element must not drive combat once sockets exist');
  assert.equal(resolved.mana_cost, 0, 'the weapon\'s own vestigial mana_cost must not be charged once sockets exist');
  assert.equal(resolved.reach, 80, 'reach is unaffected -- it was never a spell field');
  assert.equal(resolved.damage, 25, 'damage stays the weapon\'s own physical damage when nothing is socketed');
});
