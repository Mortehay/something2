// backend/tests/dungeon_boss_data_parity.test.js
// SOMET-609 (S9). The migration carries a FROZEN copy of the boss rows (a
// migration must not require a mutable data module), and seeds/data carries
// the copy seed-catalogs and the map fixtures read. They must agree, or a fresh
// DB (migration) and a restored DB (seeder) disagree about what a boss is.
const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../migrations/1714440701000_seed_dungeon_boss_entities.js');
const { DUNGEON_BOSSES } = require('../seeds/data/dungeonBosses.js');
const { AURA_EFFECTS } = require('../seeds/data/auraEffects.js');

test('migration boss rows equal seeds/data/dungeonBosses.js', () => {
  assert.deepEqual(migration.ROWS, DUNGEON_BOSSES);
});

test('migration aura rows equal their AURA_EFFECTS entries', () => {
  assert.equal(migration.AURAS.length, 3);
  assert.deepEqual(migration.AURAS.map((a) => a.name).sort(), ['cinder_brood', 'ossuary_dread', 'shade_veil']);
  for (const a of migration.AURAS) {
    assert.deepEqual(AURA_EFFECTS.find((x) => x.name === a.name), a, a.name);
  }
});

test('three End and three Elite bosses; every Elite has exactly one aura, every End none', () => {
  const end = DUNGEON_BOSSES.filter((b) => b.boss_tier === 'dungeon_end');
  const elite = DUNGEON_BOSSES.filter((b) => b.boss_tier === 'dungeon_elite');
  assert.equal(end.length, 3);
  assert.equal(elite.length, 3);
  for (const b of end) assert.deepEqual(b.auras, [], b.name);
  for (const b of elite) assert.equal(b.auras.length, 1, b.name);
});

test('every Elite aura exists in the aura floor and is ally-side with no DoT (S4 owns enemy side)', () => {
  for (const b of DUNGEON_BOSSES) {
    for (const name of b.auras) {
      const a = AURA_EFFECTS.find((x) => x.name === name);
      assert.ok(a, `${b.name} binds unknown aura ${name}`);
      assert.equal(a.target_side, 'allies', name);
      assert.ok(!a.dot_dps, `${name} must carry no DoT`);
    }
  }
});
