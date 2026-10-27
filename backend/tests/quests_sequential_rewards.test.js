const { test } = require('node:test');
const assert = require('node:assert');
const { QUESTS } = require('../seeds/data/questsData.js');

test('questsData has objective, target_count, and prerequisite_key for all 29 quests', () => {
  assert.strictEqual(QUESTS.length, 29);

  // Check 1st quest
  assert.strictEqual(QUESTS[0].key, 'act1_core_whisper');
  assert.strictEqual(QUESTS[0].prerequisite_key, null);
  assert.ok(QUESTS[0].objective);
  assert.strictEqual(QUESTS[0].target_count, 1);

  // Check 2nd quest
  assert.strictEqual(QUESTS[1].key, 'act1_dustroad_bandits');
  assert.strictEqual(QUESTS[1].prerequisite_key, 'act1_core_whisper');
  assert.ok(QUESTS[1].objective);

  // Check sequential prerequisite chain
  for (let i = 1; i < QUESTS.length; i++) {
    const q = QUESTS[i];
    assert.ok(q.prerequisite_key, `Quest ${q.key} should have a prerequisite_key`);
    assert.strictEqual(q.prerequisite_key, QUESTS[i - 1].key, `Quest ${q.key} prerequisite should be ${QUESTS[i - 1].key}`);
    assert.ok(q.objective, `Quest ${q.key} should have an objective description`);
    assert.ok(q.target_count >= 1, `Quest ${q.key} target_count should be at least 1`);
  }
});
