// backend/tests/map_spec_boss.test.js
// SOMET-609 (S9, spec §3.5). The per-world `boss` block. Every negative case is
// the valid fixture with exactly one thing broken.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMapSpec } = require('../seeds/mapSpec.js');

const BOSS_TIERS = new Map([
  ['zzEnd Boss', 'dungeon_end'], ['zzElite Boss', 'dungeon_elite'], ['zzWorld Boss', 'world'],
]);

const valid = () => ({
  name: 'fixture', topology: 'spine',
  worlds: [
    { key: 'a', name: 'The Zz: Entry', grid: [0, 0], seed: 1, width: 64, height: 64,
      chunk_size: 32, biomes: ['Meadow'], biome_cell: 32, allowed_creature_types: ['Slime'],
      is_entry: true, entry_spawn: { x: 3250, y: 3250 } },
    { key: 'b', name: 'The Zz: End', grid: [1, 0], seed: 2, width: 64, height: 64,
      chunk_size: 32, biomes: ['Meadow'], biome_cell: 32, allowed_creature_types: ['Wolf'],
      is_entry: false, boss: { entity: 'zzEnd Boss', x: 3250, y: 3850, respawn_s: 900 } },
  ],
  links: [{ from: 'a', edge: 'E', to: 'b' }],
});
const errs = (mutate, opts = { bossTiers: BOSS_TIERS }) => {
  const s = valid(); mutate(s); return validateMapSpec(s, opts);
};
const bossOf = (s) => s.worlds[1].boss;

test('a well-formed boss block validates, with and without the catalog', () => {
  assert.deepEqual(errs(() => {}), []);
  assert.deepEqual(errs(() => {}, {}), []);
});

test('boss is an accepted world key (not reported as unknown)', () => {
  assert.ok(!errs(() => {}).some((e) => /unknown key/.test(e)));
});

for (const [label, value] of [['null', null], ['an array', []], ['a string', 'zzEnd Boss']]) {
  test(`boss that is ${label} is rejected without throwing`, () => {
    const e = errs((s) => { s.worlds[1].boss = value; });
    assert.ok(e.some((m) => /world "b" boss must be an object/.test(m)), e.join('; '));
  });
}

test('an unknown key inside boss is rejected', () => {
  const e = errs((s) => { bossOf(s).level = 7; });
  assert.ok(e.some((m) => /world "b" boss has unknown key "level"/.test(m)), e.join('; '));
});

test('a non-boss entity is rejected (ordinary creature, world boss, unknown name)', () => {
  for (const name of ['Wolf', 'zzWorld Boss', 'zzNobody']) {
    const e = errs((s) => { bossOf(s).entity = name; });
    assert.ok(e.some((m) => m.includes(`entity "${name}" is not a dungeon boss`)), `${name}: ${e.join('; ')}`);
  }
});

test('an End world must use a dungeon_end boss, an Elite world a dungeon_elite boss', () => {
  const e1 = errs((s) => { bossOf(s).entity = 'zzElite Boss'; });
  assert.ok(e1.some((m) => /is dungeon_elite, but "The Zz: End" needs dungeon_end/.test(m)), e1.join('; '));
  const e2 = errs((s) => { s.worlds[1].name = 'The Zz: Elite'; });
  assert.ok(e2.some((m) => /is dungeon_end, but "The Zz: Elite" needs dungeon_elite/.test(m)), e2.join('; '));
});

test('a world with no End/Elite suffix may hold either dungeon tier', () => {
  assert.deepEqual(errs((s) => { s.worlds[1].name = 'Zz Hall'; bossOf(s).entity = 'zzElite Boss'; }), []);
});

test('the boss point must be integer pixels inside the world', () => {
  for (const [f, v, re] of [
    ['x', 6400, /boss x 6400 is outside the world \(0\.\.6399 px\)/],
    ['y', -1, /boss y -1 is outside the world/],
    ['x', 12.5, /boss x must be an integer/],
    ['y', '3850', /boss y must be an integer/],
  ]) {
    const e = errs((s) => { bossOf(s)[f] = v; });
    assert.ok(e.some((m) => re.test(m)), `${f}=${v}: ${e.join('; ')}`);
  }
});

test('respawn_s must be a positive integer', () => {
  for (const v of [0, -5, 1.5, '600', undefined]) {
    const e = errs((s) => { bossOf(s).respawn_s = v; });
    assert.ok(e.some((m) => /boss respawn_s must be a positive integer/.test(m)), `${v}: ${e.join('; ')}`);
  }
});

test('a missing entity is rejected', () => {
  const e = errs((s) => { delete bossOf(s).entity; });
  assert.ok(e.some((m) => /boss entity must be an entity type name/.test(m)), e.join('; '));
});
