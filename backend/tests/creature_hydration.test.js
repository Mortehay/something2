// backend/tests/creature_hydration.test.js
// SOMET-603 (S1, spec §4.1): ONE function turns a DB row into what
// addCreatures reads, for the chunk loader, the guard/respawn injector and the
// world boss manager alike -- so boss_tier/element/hitbox_size/auras arrive
// one way only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim, hydrateCreatureRow } = require('../src/authority/creatures.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });

// Shaped like ENTITY_CATALOG_SELECT: a TYPE row, so `name`, not `type`.
const catalogRow = {
  id: 7, name: 'zzCatalog Boss', color: '#123456', hp: 9000, max_hp: 9000, defense: 20,
  resistances: {}, faction: 'hostile', attack_element: 'ice', vfx: null,
  boss_tier: 'world', element: 'ice', hitbox_size: 96, auras: ['zz_aura', 7, ''],
  behavior_name: null, abilities: null,
};

test('a catalog row plus instance fields hydrates into a boss creature', () => {
  const c = hydrateCreatureRow(catalogRow, { id: 'b1', x: 10, y: 20, level: 100, damage: 42 });
  assert.equal(c.id, 'b1');
  assert.equal(c.type, 'zzCatalog Boss', 'a type row\'s name becomes the instance type');
  assert.equal(c.name, 'zzCatalog Boss');
  assert.equal(c.bossTier, 'world');
  assert.equal(c.element, 'ice');
  assert.equal(c.hitboxSize, 96);
  assert.deepEqual(c.auras, ['zz_aura'], 'non-string and empty aura names are dropped');
  assert.equal(c.damage, 42);
  assert.equal(c.attack_element, 'ice', 'raw columns addCreatures reads stay on the object');
});

test('an instance row (CREATURE_JOINED_SELECT shape) keeps its own type as the name', () => {
  const c = hydrateCreatureRow({ id: 'u-1', type: 'Wolf', x: 0, y: 0, hp: 30, boss_tier: null,
    element: null, hitbox_size: null, auras: null });
  assert.equal(c.type, 'Wolf');
  assert.equal(c.name, 'Wolf');
  assert.equal(c.bossTier, null);
  assert.equal(c.hitboxSize, null);
  assert.equal(c.auras, null);
});

test('an unknown boss_tier or a junk hitbox hydrates to null, never passes through', () => {
  const c = hydrateCreatureRow({ ...catalogRow, boss_tier: 'raid', hitbox_size: 0, element: '' });
  assert.equal(c.bossTier, null);
  assert.equal(c.hitboxSize, null);
  assert.equal(c.element, null);
});

// Controller ruling P1: base_damage -> damage lives HERE and nowhere else.
// WorldBossManager (Task 6) reads the hydrated .damage and must not re-derive it.
test('a type row\'s base_damage becomes the creature damage; without it the row damage stays', () => {
  const s = new CreatureSim(stubMap(), () => 0.05);
  const boss = hydrateCreatureRow({ ...catalogRow, base_damage: 42 }, { id: 'bd1', x: 0, y: 0 });
  assert.equal(boss.damage, 42);
  const plain = hydrateCreatureRow({ id: 'p1', type: 'Wolf', x: 0, y: 0, hp: 30, damage: 9 });
  assert.equal(plain.damage, 9, 'an instance row with no base_damage keeps wc.damage');
  s.addCreatures([boss]);
  assert.equal(s.get('bd1').damage, 42, 'addCreatures keeps the hydrated damage');
});

test('hydrated rows go through addCreatures with the catalog hitbox', () => {
  const s = new CreatureSim(stubMap(), () => 0.05);
  s.addCreatures([hydrateCreatureRow(catalogRow, { id: 'b1', x: 0, y: 0 })]);
  const c = s.get('b1');
  assert.equal(c.width, 96);
  assert.equal(c.bossTier, 'world');
  assert.equal(c.maxHp, 9000);
});
