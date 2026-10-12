// backend/tests/p5_spec_generated.test.js
// SOMET-609 (S9). p5-descent.map.json is GENERATED. Hand-patched values have
// been silently dropped on regeneration twice (allows_fast_travel, SOMET-306;
// village keys, SOMET-451). This pins the checked-in file to the generator so
// a hand-added `boss` block (or any other patch) fails here, not months later.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generateSpec } = require('../scripts/dungeon/gen-p5-map-content.js');

test('the checked-in p5-descent spec is exactly the generator output', () => {
  const expected = JSON.stringify(generateSpec(), null, 2) + '\n';
  const actual = fs.readFileSync(path.join(__dirname, '../seeds/maps/p5-descent.map.json'), 'utf8');
  assert.ok(actual === expected,
    'p5-descent.map.json differs from generateSpec(): edit scripts/dungeon/content.js or '
    + 'gen-p5-map-content.js and run `node scripts/dungeon/gen-p5-map-content.js`; never hand-edit the JSON');
});
