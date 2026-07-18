const test = require('node:test');
const assert = require('node:assert');
const { canEquip, mitigation, activeWeaponType, equip, unequip } = require('../src/authority/items.js');

const TYPES = new Map([
  [1, { id: 1, name: 'dagger',       category: 'weapon', slot: 'main_hand', two_handed: false, damage: 8, resistances: {}, defense: 0 }],
  [2, { id: 2, name: 'halberd',      category: 'weapon', slot: 'main_hand', two_handed: true,  damage: 18, resistances: {}, defense: 0 }],
  [5, { id: 5, name: 'leather-vest', category: 'armor',  slot: 'chest',     two_handed: false, defense: 2, resistances: {} }],
  [6, { id: 6, name: 'arcane-ward',  category: 'armor',  slot: 'head',      two_handed: false, defense: 1, resistances: { arcane: 0.3 } }],
]);

// u1 owns: i1 dagger, i2 halberd, i5 vest, i6 ward
const inv = () => ({
  items: [{ id: 'i1', typeId: 1 }, { id: 'i2', typeId: 2 }, { id: 'i5', typeId: 5 }, { id: 'i6', typeId: 6 }],
  equipment: {},
});

test('canEquip rejects an item the user does not own', () => {
  const r = canEquip(inv(), TYPES, 'nope', 'main_hand');
  assert.equal(r.ok, false);
  assert.match(r.reason, /own/i);
});

test('canEquip rejects a slot/category mismatch', () => {
  assert.equal(canEquip(inv(), TYPES, 'i5', 'main_hand').ok, false); // chest armor into main_hand
  assert.equal(canEquip(inv(), TYPES, 'i1', 'head').ok, false);      // weapon into head
  assert.equal(canEquip(inv(), TYPES, 'i6', 'chest').ok, false);     // head armor into chest
});

test('canEquip allows a one-handed weapon in either hand, armor in its own slot', () => {
  assert.equal(canEquip(inv(), TYPES, 'i1', 'main_hand').ok, true);
  assert.equal(canEquip(inv(), TYPES, 'i1', 'off_hand').ok, true);
  assert.equal(canEquip(inv(), TYPES, 'i5', 'chest').ok, true);
});

test('canEquip refuses a two-handed weapon in the off hand', () => {
  assert.equal(canEquip(inv(), TYPES, 'i2', 'off_hand').ok, false);
});

test('canEquip refuses filling off_hand while a two-handed weapon is held', () => {
  const i = inv();
  i.equipment = { main_hand: 'i2' }; // halberd (two-handed)
  const r = canEquip(i, TYPES, 'i1', 'off_hand');
  assert.equal(r.ok, false);
  assert.match(r.reason, /two[- ]handed/i);
});

test('mitigation sums equipped armor defense and merges resistances', () => {
  const i = inv();
  i.equipment = { chest: 'i5', head: 'i6', main_hand: 'i1' };
  const m = mitigation(i, TYPES);
  assert.equal(m.defense, 3);                   // 2 + 1 (weapon contributes none)
  assert.deepEqual(m.resistances, { arcane: 0.3 });
});

test('mitigation of an empty paper-doll is zero', () => {
  const m = mitigation(inv(), TYPES);
  assert.equal(m.defense, 0);
  assert.deepEqual(m.resistances, {});
});

test('activeWeaponType resolves main_hand, else the default', () => {
  const i = inv();
  i.equipment = { main_hand: 'i2' };
  assert.equal(activeWeaponType(i, TYPES, 1).id, 2);
  assert.equal(activeWeaponType(inv(), TYPES, 1).id, 1); // empty -> default
});

// --- DB-backed behaviour ---
function fakePool() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
}

test('equip writes through and updates the in-memory inventory', async () => {
  const pool = fakePool(); const i = inv();
  const r = await equip(pool, 'u1', i, TYPES, 'i1', 'main_hand');
  assert.equal(r.ok, true);
  assert.equal(i.equipment.main_hand, 'i1');
  assert.ok(pool.calls.some((c) => /INSERT INTO player_equipment/i.test(c.sql)));
});

test('equipping a two-handed weapon clears the off hand', async () => {
  const pool = fakePool(); const i = inv();
  i.equipment = { off_hand: 'i1' };
  const r = await equip(pool, 'u1', i, TYPES, 'i2', 'main_hand'); // halberd
  assert.equal(r.ok, true);
  assert.equal(i.equipment.main_hand, 'i2');
  assert.equal(i.equipment.off_hand, undefined, 'off hand cleared by two-handed');
});

test('equipping an already-equipped instance moves it between slots', async () => {
  const pool = fakePool(); const i = inv();
  i.equipment = { main_hand: 'i1' };
  await equip(pool, 'u1', i, TYPES, 'i1', 'off_hand');
  assert.equal(i.equipment.off_hand, 'i1');
  assert.equal(i.equipment.main_hand, undefined, 'vacated the previous slot');
});

test('a rejected equip changes nothing', async () => {
  const pool = fakePool(); const i = inv();
  i.equipment = { main_hand: 'i1' };
  const r = await equip(pool, 'u1', i, TYPES, 'i5', 'main_hand'); // armor into main_hand
  assert.equal(r.ok, false);
  assert.equal(i.equipment.main_hand, 'i1');
  assert.ok(!pool.calls.some((c) => /INSERT INTO player_equipment/i.test(c.sql)));
});

test('unequip clears the slot and deletes the row', async () => {
  const pool = fakePool(); const i = inv();
  i.equipment = { chest: 'i5' };
  await unequip(pool, 'u1', i, 'chest');
  assert.equal(i.equipment.chest, undefined);
  assert.ok(pool.calls.some((c) => /DELETE FROM player_equipment/i.test(c.sql)));
});
