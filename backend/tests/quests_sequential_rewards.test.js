const { test } = require('node:test');
const assert = require('node:assert');
const { QUESTS } = require('../seeds/data/questsData.js');
const { dailyDue } = require('../src/services/questsService.js');

const MAIN = QUESTS.filter((q) => !q.is_side);
const SIDE = QUESTS.filter((q) => q.is_side);

test('questsData has objective, target_count, and prerequisite_key for all 29 main quests', () => {
  assert.strictEqual(MAIN.length, 29);
  // The storyline stays the first 29 rows: ids (and the implicit ordering) follow insertion.
  assert.deepStrictEqual(QUESTS.slice(0, 29), MAIN);

  assert.strictEqual(MAIN[0].key, 'act1_core_whisper');
  assert.strictEqual(MAIN[0].prerequisite_key, null);
  assert.ok(MAIN[0].objective);
  assert.strictEqual(MAIN[0].target_count, 1);

  assert.strictEqual(MAIN[1].key, 'act1_dustroad_bandits');
  assert.strictEqual(MAIN[1].prerequisite_key, 'act1_core_whisper');
  assert.ok(MAIN[1].objective);

  for (let i = 1; i < MAIN.length; i++) {
    const q = MAIN[i];
    assert.ok(q.prerequisite_key, `Quest ${q.key} should have a prerequisite_key`);
    assert.strictEqual(q.prerequisite_key, MAIN[i - 1].key, `Quest ${q.key} prerequisite should be ${MAIN[i - 1].key}`);
    assert.ok(q.objective, `Quest ${q.key} should have an objective description`);
    assert.ok(q.target_count >= 1, `Quest ${q.key} target_count should be at least 1`);
  }
});

test('side quests are outside the chain, and repeat_kind is a known value', () => {
  assert.ok(SIDE.length >= 3);
  assert.ok(SIDE.some((q) => q.repeat_kind === 'daily'), 'at least one daily');
  const keys = new Set(QUESTS.map((q) => q.key));
  assert.strictEqual(keys.size, QUESTS.length, 'quest keys are unique');
  for (const q of SIDE) {
    assert.strictEqual(q.prerequisite_key, null, `${q.key}: a side quest has no prerequisite`);
    assert.ok(['none', 'daily'].includes(q.repeat_kind), `${q.key}: repeat_kind`);
    assert.ok(q.objective && q.target_count >= 1, `${q.key}: objective and target_count`);
    assert.notStrictEqual(q.objective_type, 'manual', `${q.key}: side quests must be trackable`);
  }
});

test('dailyDue resets only a completed daily from an earlier UTC day', () => {
  const now = new Date('2026-10-31T10:00:00Z');
  const daily = { repeat_kind: 'daily' };
  assert.strictEqual(dailyDue(daily, '2026-10-30T23:59:00Z', now), true);
  assert.strictEqual(dailyDue(daily, '2026-10-31T00:00:01Z', now), false);
  assert.strictEqual(dailyDue(daily, null, now), false);
  assert.strictEqual(dailyDue({ repeat_kind: 'none' }, '2026-01-01T00:00:00Z', now), false);
});
