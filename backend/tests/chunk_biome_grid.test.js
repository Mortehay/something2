const test = require('node:test');
const assert = require('node:assert');
const { chunkBiomeGrid, sampleBiomeRegion, worldConfig } = require('../src/services/mapService');

function cfgWithBiomes() {
  return worldConfig({
    seed: 12345, chunkSize: 64, width: 400, height: 400, biomeCell: 40,
    tileTypes: { grass: { walkable: true }, sand: { walkable: true } },
    biomes: [{ name: 'forest', terrain_tiles: ['grass'] }, { name: 'desert', terrain_tiles: ['sand'] }],
  });
}

test('chunkBiomeGrid matches sampleBiomeRegion at each cell centre', () => {
  const cfg = cfgWithBiomes();
  const grid = chunkBiomeGrid(cfg, 2, 1, 64, 8);
  assert.equal(grid.length, 8);
  assert.equal(grid[0].length, 8);
  for (const [r, c] of [[0, 0], [3, 5], [7, 7]]) {
    const expected = sampleBiomeRegion(cfg, 1 * 64 + r * 8 + 4, 2 * 64 + c * 8 + 4);
    assert.equal(grid[r][c], expected ? expected.name : null);
  }
  const names = new Set(grid.flat());
  assert.ok([...names].every((n) => n === 'forest' || n === 'desert'));
});

test('chunkBiomeGrid is null for a world without biomes', () => {
  const cfg = worldConfig({ seed: 1, chunkSize: 64, tileTypes: { grass: { walkable: true } } });
  assert.equal(chunkBiomeGrid(cfg, 0, 0, 64), null);
});
