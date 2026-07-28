const test = require('node:test');
const assert = require('node:assert');
const { loadBiomes } = require('../src/services/biomes');

function poolReturning(rows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows }; },
  };
}

const MEADOW = { id: 1, name: 'Meadow', terrain_tiles: ['grass'], flora_types: [], creature_types: [], palette: [], art_style: '', exclusions: '', color: '#5aa84f' };
const DUNES = { id: 3, name: 'Arid Dunes', terrain_tiles: ['sand'], flora_types: [], creature_types: [], palette: [], art_style: '', exclusions: '', color: '#c9a227' };

test('returns records in the CALLER-supplied name order, not row order', async () => {
  // Postgres hands rows back in whatever order it likes; the world's declared
  // biome order is what decides banding, so the loader must reorder. Rows are
  // deliberately returned id-ascending while the caller asks for the reverse.
  const pool = poolReturning([MEADOW, DUNES]);
  const out = await loadBiomes(pool, ['Arid Dunes', 'Meadow']);
  assert.deepEqual(out.map((b) => b.name), ['Arid Dunes', 'Meadow']);
});

test('drops names with no matching row', async () => {
  const pool = poolReturning([MEADOW]);
  const out = await loadBiomes(pool, ['Meadow', 'Atlantis']);
  assert.deepEqual(out.map((b) => b.name), ['Meadow']);
});

test('de-duplicates repeated names', async () => {
  const pool = poolReturning([MEADOW]);
  const out = await loadBiomes(pool, ['Meadow', 'Meadow']);
  assert.deepEqual(out.map((b) => b.name), ['Meadow']);
});

test('short-circuits without querying when there are no names', async () => {
  const pool = poolReturning([MEADOW]);
  assert.deepEqual(await loadBiomes(pool, []), []);
  assert.deepEqual(await loadBiomes(pool, null), []);
  assert.deepEqual(await loadBiomes(pool, undefined), []);
  assert.equal(pool.calls.length, 0, 'must not hit the DB for an empty biome set');
});

test('parameterises the name list (no interpolation)', async () => {
  const pool = poolReturning([MEADOW]);
  await loadBiomes(pool, ['Meadow']);
  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0].params, [['Meadow']]);
  assert.ok(!pool.calls[0].sql.includes('Meadow'), 'name must not be interpolated into SQL');
});

test('selects every column the generator and prompt composer need', async () => {
  const pool = poolReturning([MEADOW]);
  await loadBiomes(pool, ['Meadow']);
  const { sql } = pool.calls[0];
  for (const col of ['name', 'terrain_tiles', 'flora_types', 'creature_types', 'palette', 'art_style', 'exclusions', 'color']) {
    assert.match(sql, new RegExp(`\\b${col}\\b`), `SELECT must include ${col}`);
  }
});
