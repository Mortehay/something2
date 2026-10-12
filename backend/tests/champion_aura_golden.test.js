// backend/tests/champion_aura_golden.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runChampionTrace, legacyBind, entityBind } = require('./helpers/championAuraTrace.js');

// Recorded with legacyBind on pre-S3 code. NEVER regenerate after Task 4 Step 2:
// a fixture that adjusts itself to new behaviour can no longer catch a regression.
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'champion_aura_golden.json'), 'utf8'));

test('entity-bound pack_leader reproduces the pre-S3 Champion trace exactly', () => {
  assert.deepStrictEqual(runChampionTrace(entityBind), golden);
});

test('the behaviour columns no longer drive auras (the old source is dead)', () => {
  assert.notDeepStrictEqual(runChampionTrace(legacyBind), golden,
    'a behaviour-carried aura still buffs -- something still reads behavior.aura*');
});
