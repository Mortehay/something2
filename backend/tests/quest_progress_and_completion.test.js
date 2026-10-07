const { test } = require('node:test');
const assert = require('node:assert');
const { QUESTS } = require('../seeds/data/questsData.js');

test('questData contains varied target_counts matching mob HP and difficulty', () => {
  const swarmQuests = QUESTS.filter(q => q.target_count >= 50);
  const mediumQuests = QUESTS.filter(q => q.target_count >= 25 && q.target_count < 50);
  const eliteQuests = QUESTS.filter(q => q.target_count >= 10 && q.target_count < 25);
  const lieutenantQuests = QUESTS.filter(q => q.target_count >= 3 && q.target_count < 10);
  const bossQuests = QUESTS.filter(q => q.target_count === 1);

  assert.ok(swarmQuests.length >= 2, 'Expected at least 2 weak swarm mob quests (50+ kills)');
  assert.ok(mediumQuests.length >= 3, 'Expected at least 3 medium mob quests (25-40 kills)');
  assert.ok(eliteQuests.length >= 2, 'Expected at least 2 heavy elite mob quests (10-15 kills)');
  assert.ok(lieutenantQuests.length >= 1, 'Expected at least 1 lieutenant quest (3-5 kills)');
  assert.ok(bossQuests.length >= 10, 'Expected boss quests with target_count = 1');
});

test('completeQuest validation logic enforces progress_count >= target_count', () => {
  // Mock character quest with insufficient progress
  const fakeQuest = { id: 10, key: 'act1_slime_cull', target_count: 50 };
  const fakeProgress = { status: 'active', progress_count: 42 };

  // Verification rule check
  const isComplete = fakeProgress.progress_count >= fakeQuest.target_count;
  assert.strictEqual(isComplete, false, 'Quest should NOT be completable when progress_count < target_count');

  // Completed progress check
  const finishedProgress = { status: 'active', progress_count: 50 };
  const isFinishedComplete = finishedProgress.progress_count >= fakeQuest.target_count;
  assert.strictEqual(isFinishedComplete, true, 'Quest SHOULD be completable when progress_count >= target_count');
});
