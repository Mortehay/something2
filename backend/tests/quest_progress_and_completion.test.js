const { test } = require('node:test');
const assert = require('node:assert');
const { QUESTS } = require('../seeds/data/questsData.js');
const { completeQuest, incrementQuestProgress, QuestError } = require('../src/services/questsService.js');

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

// A scripted pool: each query is matched by a regexp and answered with `rows`.
// Records every statement so a test can assert that nothing was paid out.
function scriptedPool(script) {
  const log = [];
  const client = {
    async query(sql) {
      log.push(sql.replace(/\s+/g, ' ').trim());
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [] };
      for (const [re, rows] of script) if (re.test(sql)) return { rows };
      return { rows: [] };
    },
    release() {},
  };
  return { log, connect: async () => client, query: client.query };
}

test('completeQuest refuses an unfinished objective and pays nothing', async () => {
  const pool = scriptedPool([
    [/FROM quests WHERE key/, [{ id: 10, key: 'act1_slime_cull', title: 'Slimes', target_count: 50, act: 1, required_level: 5 }]],
    [/FROM character_quests WHERE character_id/, [{ status: 'active', progress_count: 42 }]],
  ]);
  await assert.rejects(
    () => completeQuest(pool, 1, 'act1_slime_cull'),
    (err) => err instanceof QuestError && /42\/50/.test(err.message),
  );
  assert.ok(!pool.log.some(q => /UPDATE (users|player_progression)/.test(q)), 'no reward statement ran');
  assert.ok(pool.log.includes('ROLLBACK'));
});

test('completeQuest locks the character_quests row so a double click cannot pay twice', async () => {
  const pool = scriptedPool([
    [/FROM quests WHERE key/, [{ id: 10, key: 'k', title: 'T', target_count: 1, act: 1 }]],
    [/FROM character_quests WHERE character_id/, [{ status: 'completed', progress_count: 1 }]],
  ]);
  const res = await completeQuest(pool, 1, 'k');
  assert.strictEqual(res.alreadyCompleted, true);
  assert.ok(pool.log.some(q => /FROM character_quests .* FOR UPDATE/.test(q)), 'row is locked before the status check');
  assert.ok(!pool.log.some(q => /UPDATE users/.test(q)));
});

test('an unknown quest is a 404 QuestError, not a generic failure', async () => {
  const pool = scriptedPool([]);
  await assert.rejects(
    () => completeQuest(pool, 1, 'nope'),
    (err) => err instanceof QuestError && err.status === 404,
  );
});

test('incrementQuestProgress ignores non-positive or non-numeric amounts', async () => {
  const pool = scriptedPool([]);
  assert.strictEqual(await incrementQuestProgress(pool, 1, 'k', -5), null);
  assert.strictEqual(await incrementQuestProgress(pool, 1, 'k', 'x'), null);
  assert.strictEqual(pool.log.length, 0, 'no query for a bad amount');
});

test('every seeded quest has a valid objective type, and kill quests name a creature', () => {
  const TYPES = ['kill', 'kill_any', 'boss', 'manual'];
  for (const q of QUESTS) {
    assert.ok(TYPES.includes(q.objective_type), `${q.key}: bad objective_type ${q.objective_type}`);
    if (q.objective_type === 'kill') assert.ok(q.target_key, `${q.key}: kill needs a target_key`);
    else assert.strictEqual(q.target_key, null, `${q.key}: only kill quests carry a target_key`);
  }
  assert.ok(QUESTS.some(q => q.objective_type === 'kill'), 'at least one real kill quest');
});

test('recordKill advances active quests in one statement and passes the kill facts', async () => {
  const { recordKill } = require('../src/services/questsService.js');
  const seen = [];
  const pool = {
    async query(sql, params) {
      seen.push({ sql, params });
      return { rows: [{ key: 'act1_slime_cull', title: 'Slimes', target_count: 50, progress_count: 3 }] };
    },
  };
  const rows = await recordKill(pool, 7, { typeName: 'Slime', isBoss: false });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(seen.length, 1, 'a single UPDATE, no read-modify-write');
  assert.deepStrictEqual(seen[0].params, [7, 'Slime', false]);
  assert.match(seen[0].sql, /status = 'active'/);
  assert.match(seen[0].sql, /LEAST\(q\.target_count/);
});

test('abandonQuest only drops an active quest', async () => {
  const { abandonQuest } = require('../src/services/questsService.js');
  const mk = (rowCount) => ({
    async query(sql) {
      if (/FROM quests WHERE key/.test(sql)) return { rows: [{ id: 3, title: 'T' }] };
      assert.match(sql, /status = 'active'/);
      return { rowCount, rows: [] };
    },
  });
  assert.ok((await abandonQuest(mk(1), 1, 'k')).quest);
  await assert.rejects(() => abandonQuest(mk(0), 1, 'k'), (e) => e instanceof QuestError && e.status === 409);
});
