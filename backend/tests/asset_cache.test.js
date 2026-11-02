const test = require('node:test');
const assert = require('node:assert/strict');
const { assetCacheControl } = require('../src/assetCache');

const SHA = 'a'.repeat(64);

test('content-addressed seedsync art is cached immutably', () => {
  assert.equal(
    assetCacheControl(`sprites/seedsync/${SHA}/textures_entities_Ranger.png`),
    'public, max-age=31536000, immutable',
  );
  assert.equal(
    assetCacheControl(`seedsync/${SHA.toUpperCase()}/x.json`),
    'public, max-age=31536000, immutable',
  );
});

test('anything that could be replaced under the same key keeps the short lifetime', () => {
  assert.equal(assetCacheControl('textures/character-appearances/Mage_2.png'), 'public, max-age=300');
  assert.equal(assetCacheControl('audio/music/abc.ogg'), 'public, max-age=300');
  // Not a full sha256 segment, so not provably content-addressed.
  assert.equal(assetCacheControl('sprites/seedsync/abc123/x.png'), 'public, max-age=300');
  assert.equal(assetCacheControl(`sprites/seedsync/${SHA}x/x.png`), 'public, max-age=300');
  assert.equal(assetCacheControl(undefined), 'public, max-age=300');
});
