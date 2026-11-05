const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  loadingSceneFor, DEFAULT_LOADING_SCENE, SCENE_NAMES, BIOME_TO_SCENE,
} = require('../src/services/loadingScene.js');

// SOMET-742. The destination world's first biome picks the loading scene.

test('the first biome decides, later ones do not', () => {
  assert.strictEqual(loadingSceneFor(['Frostvault', 'Cavern']), 'snow');
  assert.strictEqual(loadingSceneFor(['Cavern', 'Frostvault']), 'cavern');
});

test('no biome, or an unmapped one, shows the default rather than failing', () => {
  for (const biomes of [null, undefined, [], 'Meadow', ['Not A Biome']]) {
    assert.strictEqual(loadingSceneFor(biomes), DEFAULT_LOADING_SCENE);
  }
});

test('every committed biome has a scene of its own family, not the fallback', () => {
  const { tables } = JSON.parse(fs.readFileSync(path.join(__dirname, '../seeds/sync/biomes.json'), 'utf8'));
  const names = tables.biomes.map((b) => b.name);
  assert.ok(names.length > 0, 'no biomes read: this guard would check nothing');
  assert.deepStrictEqual(names.filter((n) => !BIOME_TO_SCENE.has(n)), []);
});

test('every scene name has its SVG in the frontend', (t) => {
  const dir = path.join(__dirname, '../../frontend/public/loading-scenes');
  if (!fs.existsSync(dir)) return t.skip('frontend not mounted here');
  for (const scene of SCENE_NAMES) assert.ok(fs.existsSync(path.join(dir, `${scene}.svg`)), `${scene}.svg is missing`);
});
