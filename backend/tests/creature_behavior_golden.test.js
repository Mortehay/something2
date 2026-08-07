const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runTrace } = require('./helpers/creatureTrace.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'creature_tick_golden.json');

test('creature tick reproduces the frozen pre-P2a baseline', () => {
  const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepStrictEqual(runTrace(), golden);
});
