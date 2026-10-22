const test = require('node:test');
const assert = require('node:assert');
const { generateChunk, generateChunkDecorations } = require('../src/services/mapService');
const { DEFS, CASES } = require('./helpers/sceneryOracleCases');
const expected = require('./fixtures/scenery_oracle.json');

// The fixture was captured from the generator before the per-call eligibility
// cache (a7fa51ba). The cache is a pure speed-up, so picks, order and offsets
// must match it exactly.
const tuple = (d) => [d.name, d.row, d.col, d.ox, d.oy, d.blocking ? 1 : 0, d.radius, d.layer === 'cover' ? 1 : 0];

for (const c of CASES) {
  test(`oracle: ${c.name} matches the pre-cache generator`, () => {
    const tiles = generateChunk(c.world, c.cx, c.cy);
    for (const [key, cover] of [['cover', true], ['features', false]]) {
      const got = generateChunkDecorations(c.world, c.cx, c.cy, tiles, DEFS, { cover }).map(tuple);
      assert.ok(got.length > 0, `${c.name}/${key} produced nothing, so it proves nothing`);
      assert.deepStrictEqual(got, expected[c.name][key]);
    }
  });
}

test('oracle fixture exercises cover on more than one type', () => {
  const names = new Set(expected['single meadow'].cover.filter((t) => t[7] === 1).map((t) => t[0]));
  assert.ok(names.size >= 3, [...names].join());
});
