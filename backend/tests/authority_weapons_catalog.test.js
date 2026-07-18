const test = require('node:test');
const assert = require('node:assert');
const { loadWeaponTypes, resolveDefaultWeaponId } = require('../src/authority/weapons.js');

function fakePool(rows) {
  return { query: async (sql) => {
    assert.match(sql, /FROM weapon_types/i);
    return { rows };
  } };
}

const ROWS = [
  { id: 1, name: 'dagger', kind: 'melee', damage: '8', cooldown: '0.3', reach: '80', arc_width: '0.6',
    range: null, projectile_speed: null, projectile_radius: null, pierce: null, mana_cost: '0', element: null },
  { id: 3, name: 'bow', kind: 'projectile', damage: '12', cooldown: '0.6', reach: null, arc_width: null,
    range: '700', projectile_speed: '900', projectile_radius: '8', pierce: 1, mana_cost: '0', element: null },
];

test('loadWeaponTypes maps rows by id, coercing numbers and keeping nulls', async () => {
  const m = await loadWeaponTypes(fakePool(ROWS));
  assert.equal(m.size, 2);
  const dagger = m.get(1);
  assert.equal(dagger.kind, 'melee');
  assert.strictEqual(dagger.damage, 8);
  assert.strictEqual(dagger.reach, 80);
  assert.strictEqual(dagger.arc_width, 0.6);
  assert.strictEqual(dagger.range, null);
  const bow = m.get(3);
  assert.strictEqual(bow.projectile_speed, 900);
  assert.strictEqual(bow.pierce, 1);
  assert.strictEqual(bow.reach, null);
});

test('resolveDefaultWeaponId returns the dagger id, else the first', async () => {
  const m = await loadWeaponTypes(fakePool(ROWS));
  assert.equal(resolveDefaultWeaponId(m), 1);
  const noDagger = await loadWeaponTypes(fakePool([ROWS[1]]));
  assert.equal(resolveDefaultWeaponId(noDagger), 3); // first (only) id
});
