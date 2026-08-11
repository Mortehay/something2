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
