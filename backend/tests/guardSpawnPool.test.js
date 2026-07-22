// backend/tests/guardSpawnPool.test.js
//
// FIX 1: guard-faction types must never enter the wild random spawn pool.
// `Village Guard` is an is_creature=true entity type, so loadCreatureTypes'
// plain `creatureTypes` list includes it — and server.js's per-chunk roll on
// UNBOUNDED worlds used to hand that whole list to spawnChunkCreatures. A
// guard rolled there has no home_x/home_y (that anchor only exists on the
// world_creatures rows insertVillageGuards writes), so withinLeash's
// null-home fallback makes it an unleashed, 300hp, no-drop creature-hunter —
// unrecoverable because the guard-aware re-roll route rejects unbounded
// worlds outright.
//
// hostileCreatureTypes is the fix: a SEPARATE list, filtered to non-guard
// factions, for the wild-spawn roll only. creatureTypes and creatureTypeIds
// must stay COMPLETE — drops (spawnDrops) and name→id lookups still need to
// see guards.
const test = require('node:test');
const assert = require('node:assert');
const { loadCreatureTypes } = require('../src/authority/creatures');

test('loadCreatureTypes excludes guard faction from hostileCreatureTypes, keeps it in creatureTypes/creatureTypeIds', async () => {
  const pool = {
    query: async () => ({
      rows: [
        { id: 1, name: 'Slime', color: '#0f0', hp: 10, defense: 0, resistances: {}, faction: 'hostile' },
        { id: 2, name: 'Village Guard', color: '#3f6fb5', hp: 300, defense: 10, resistances: {}, faction: 'guard' },
      ],
    }),
  };
  const { creatureTypes, creatureTypeIds, hostileCreatureTypes } = await loadCreatureTypes(pool);

  // Full pool: unchanged, still complete (drops/name lookups depend on this).
  assert.ok(creatureTypes.some((t) => t.name === 'Village Guard'), 'creatureTypes must still carry the guard type');
  assert.ok(creatureTypes.some((t) => t.name === 'Slime'));
  assert.equal(creatureTypeIds.get('Village Guard'), 2, 'creatureTypeIds must still map the guard name to its id');

  // Wild-spawn pool: guard excluded, hostile kept.
  assert.ok(hostileCreatureTypes, 'loadCreatureTypes must return hostileCreatureTypes');
  assert.ok(hostileCreatureTypes.some((t) => t.name === 'Slime'), 'hostile types remain in the spawn pool');
  assert.ok(!hostileCreatureTypes.some((t) => t.name === 'Village Guard'),
    'the guard type must never enter the wild random spawn pool — it would spawn with no home anchor');
});

test('loadCreatureTypes defaults faction to hostile, so untyped creatures still spawn', async () => {
  const pool = {
    query: async () => ({
      rows: [{ id: 3, name: 'Goblin', color: '#a52', hp: 20, defense: 1, resistances: {}, faction: null }],
    }),
  };
  const { hostileCreatureTypes } = await loadCreatureTypes(pool);
  assert.equal(hostileCreatureTypes.length, 1);
  assert.equal(hostileCreatureTypes[0].name, 'Goblin');
});
