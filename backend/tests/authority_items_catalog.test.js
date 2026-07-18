const test = require('node:test');
const assert = require('node:assert');
const { loadItemTypes, resolveDefaultWeaponId, SLOTS } = require('../src/authority/items.js');

function fakePool(rows) {
  return { query: async (sql) => { assert.match(sql, /FROM item_types/i); return { rows }; } };
}

const ROWS = [
  { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
    damage: '8', cooldown: '0.3', reach: '80', arc_width: '0.6', range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: null, resistances: null },
  { id: 2, name: 'halberd', category: 'weapon', slot: 'main_hand', two_handed: true, kind: 'melee',
    damage: '18', cooldown: '0.9', reach: '190', arc_width: '1.8', range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: null, resistances: null },
  { id: 5, name: 'leather-vest', category: 'armor', slot: 'chest', two_handed: false, kind: null,
    damage: '0', cooldown: '0', reach: null, arc_width: null, range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: '2', resistances: {} },
  { id: 6, name: 'arcane-ward', category: 'armor', slot: 'head', two_handed: false, kind: null,
    damage: '0', cooldown: '0', reach: null, arc_width: null, range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', element: null, defense: '1', resistances: { arcane: 0.3 } },
];

test('loadItemTypes maps weapons and armor, coercing numbers and defaulting resistances', async () => {
  const m = await loadItemTypes(fakePool(ROWS));
  assert.equal(m.size, 4);
  const dagger = m.get(1);
  assert.equal(dagger.category, 'weapon');
  assert.strictEqual(dagger.damage, 8);
  assert.strictEqual(dagger.reach, 80);
  assert.strictEqual(dagger.two_handed, false);
  assert.deepEqual(dagger.resistances, {});      // null -> {}
  const halberd = m.get(2);
  assert.strictEqual(halberd.two_handed, true);
  const vest = m.get(5);
  assert.equal(vest.category, 'armor');
  assert.equal(vest.slot, 'chest');
  assert.strictEqual(vest.defense, 2);
  const ward = m.get(6);
  assert.deepEqual(ward.resistances, { arcane: 0.3 });
});

test('resolveDefaultWeaponId returns the dagger weapon id', async () => {
  const m = await loadItemTypes(fakePool(ROWS));
  assert.equal(resolveDefaultWeaponId(m), 1);
});

test('resolveDefaultWeaponId falls back to the first WEAPON, never armor', async () => {
  const m = await loadItemTypes(fakePool(ROWS.filter((r) => r.name !== 'dagger')));
  assert.equal(resolveDefaultWeaponId(m), 2); // halberd, not leather-vest
});

test('SLOTS lists the eight paper-doll slots', () => {
  assert.deepEqual(SLOTS, ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2']);
});
