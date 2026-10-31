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

test('no main-story quest is left on the turn-in-only "manual" type', () => {
  const left = QUESTS.filter((q) => !q.is_side && q.objective_type === 'manual').map((q) => q.key);
  assert.deepStrictEqual(left, [], `still manual: ${left.join(', ')}`);
});

test('interact quests name a node group that exists, and the world offers enough nodes', () => {
  const { GROUPS, CATALOG } = require('../src/services/questNodes.js');
  const supply = new Map();
  for (const hosts of Object.values(CATALOG)) {
    for (const [group, count] of hosts) supply.set(group, (supply.get(group) || 0) + count);
  }
  for (const q of QUESTS.filter((x) => x.objective_type === 'interact')) {
    assert.ok(GROUPS[q.target_key], `${q.key}: unknown node group ${q.target_key}`);
    assert.ok((supply.get(q.target_key) || 0) >= q.target_count,
      `${q.key}: needs ${q.target_count} ${q.target_key} nodes, catalog hosts ${supply.get(q.target_key) || 0}`);
  }
});

test('the floor quest asks for no more floors than the Spire spec has', () => {
  const spec = require('../seeds/maps/spire-of-trials.map.json');
  const floors = spec.worlds.filter((w) => /^Spire of Trials: Floor \d+$/.test(w.name));
  assert.strictEqual(floors.length, spec.worlds.length);
  const q = QUESTS.find((x) => x.objective_type === 'floor');
  assert.ok(q && q.target_count <= floors.length);
  assert.strictEqual(spec.worlds.filter((w) => w.is_entry).length, 1);
});

test('floorFromWorldName reads only Spire floors', () => {
  const { floorFromWorldName } = require('../src/services/questsService.js');
  assert.strictEqual(floorFromWorldName('Spire of Trials: Floor 12'), 12);
  assert.strictEqual(floorFromWorldName('The Catacombs: Entry'), null);
  assert.strictEqual(floorFromWorldName(null), null);
});

test('villageQuestNodes places distinct tiles, skips post tiles, and hosts only catalogued villages', () => {
  const { villageQuestNodes } = require('../src/services/questNodes.js');
  const v = {
    specKey: 'ashen_oasis', minCol: 10, minRow: 10, width: 6, height: 4,
    merchantX: 1250, merchantY: 1150, spawnX: 1350, spawnY: 1150,
  };
  const nodes = villageQuestNodes(v);
  assert.strictEqual(nodes.length, 8, 'crystal + 3 prisms + 4 obelisks');
  const tiles = new Set(nodes.map((n) => `${Math.floor(n.x / 100)},${Math.floor(n.y / 100)}`));
  assert.strictEqual(tiles.size, nodes.length, 'no two nodes share a tile');
  assert.ok(!tiles.has('12,11'), 'not on the merchant tile');
  assert.strictEqual(new Set(nodes.map((n) => n.key)).size, nodes.length, 'keys are unique');
  assert.deepStrictEqual(villageQuestNodes({ ...v, specKey: 'sunspire' }), []);
});

test('recordNode is one atomic statement carrying group and node key', async () => {
  const { recordNode } = require('../src/services/questsService.js');
  const seen = [];
  const pool = { async query(sql, params) { seen.push({ sql, params }); return { rows: [] }; } };
  assert.deepStrictEqual(await recordNode(pool, 3, 'obelisk', 'ashen_oasis:obelisk:0'), []);
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(seen[0].params, [3, 'obelisk', 'ashen_oasis:obelisk:0']);
  assert.match(seen[0].sql, /ON CONFLICT DO NOTHING/);
});

test('choice quests refuse to complete without a legacy choice', async () => {
  const log = [];
  const client = {
    async query(sql) {
      log.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM quests WHERE key/.test(sql)) return { rows: [{ id: 9, title: 'New Dawn', act: 4, objective_type: 'choice', target_count: 1 }] };
      if (/FROM character_quests WHERE character_id/.test(sql)) return { rows: [{ status: 'active', progress_count: 0 }] };
      return { rows: [] }; // no stored legacy choice
    },
    release() {},
  };
  const pool = { connect: async () => client };
  await assert.rejects(
    () => completeQuest(pool, 1, 'act4_new_dawn', null),
    (e) => e instanceof QuestError && /Choose a legacy/.test(e.message),
  );
  assert.ok(!log.some((q) => /UPDATE (users|player_progression)/.test(q)), 'nothing was paid');
});

test('every quest item reward names a real item type, and only milestones carry one', () => {
  const items = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'seeds', 'sync', 'items.json'), 'utf8'));
  const names = new Set();
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') { if (typeof v.name === 'string') names.add(v.name); Object.values(v).forEach(walk); }
  }(items));
  const rewarded = QUESTS.filter((q) => q.item_reward);
  assert.ok(rewarded.length >= 4, 'milestone quests pay an item');
  for (const q of rewarded) assert.ok(names.has(q.item_reward), `${q.key}: unknown item "${q.item_reward}"`);
  assert.ok(rewarded.length <= 12, 'item rewards stay milestones, not every quest');
});

test('completeQuest marks the item reward as owed, and the ledger helpers are guarded', async () => {
  const { pendingRewardItems, clearRewardPending } = require('../src/services/questsService.js');
  const seen = [];
  const client = {
    async query(sql, params) {
      seen.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [] };
      if (/FROM quests WHERE key/.test(sql)) return { rows: [{ id: 5, key: 'k', title: 'T', act: 1, target_count: 1, objective_type: 'kill', gold_reward: 0, exp_reward: 0, passive_points_reward: 0, item_reward: 'iron-band' }] };
      if (/FROM character_quests WHERE character_id/.test(sql)) return { rows: [{ status: 'active', progress_count: 1 }] };
      if (/FROM player_progression/.test(sql)) return { rows: [{ experience: 0, level: 1, passive_points: 0 }] };
      return { rows: [] };
    },
    release() {},
  };
  const res = await completeQuest({ connect: async () => client }, 1, 'k');
  assert.strictEqual(res.rewards.item, 'iron-band');
  const mark = seen.find((s) => /SET status = 'completed'/.test(s.sql));
  assert.match(mark.sql, /reward_item_pending = \$3/);
  assert.deepStrictEqual(mark.params, [1, 5, true]);

  const pool = { async query(sql) { return /JOIN quests q/.test(sql) ? { rows: [{ quest_id: 5, key: 'k', item: 'iron-band' }] } : { rowCount: 1, rows: [] }; } };
  assert.deepStrictEqual(await pendingRewardItems(pool, 1), [{ questId: 5, key: 'k', item: 'iron-band' }]);
  assert.strictEqual(await clearRewardPending(pool, 1, 5), true);
});
