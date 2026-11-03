const test = require('node:test');
const assert = require('node:assert');
const { QUESTS, EXPANSION_QUESTS } = require('../seeds/data/questsData.js');
const svc = require('../src/services/questsService.js');

const TYPES = ['collect', 'chest', 'reach', 'pick'];

test('no quest uses the removed skill objective', () => {
  assert.ok(!QUESTS.some((q) => q.objective_type === 'skill'));
});

test('the expansion covers every new objective type, class trials, weekly and a daily pool', () => {
  for (const t of TYPES) assert.ok(EXPANSION_QUESTS.some((q) => q.objective_type === t), `a ${t} quest exists`);
  assert.ok(EXPANSION_QUESTS.some((q) => q.repeat_kind === 'weekly'));
  assert.ok(EXPANSION_QUESTS.filter((q) => q.pool_group === 'daily_board').length > 3, 'pool bigger than the daily board');
  assert.ok(EXPANSION_QUESTS.some((q) => q.time_limit_sec > 0), 'a timed challenge');
  assert.ok(EXPANSION_QUESTS.some((q) => q.required_reputation > 0), 'a reputation-gated quest');
  const classes = new Set(EXPANSION_QUESTS.map((q) => q.required_class).filter(Boolean));
  for (const c of ['Warrior', 'Mage', 'Archer', 'Cultist', 'Druid', 'Monk']) assert.ok(classes.has(c), `${c} trial`);
  assert.strictEqual(new Set(QUESTS.map((q) => q.key)).size, QUESTS.length);
});

test('every pick quest offers choices with a key and a label', () => {
  for (const q of EXPANSION_QUESTS.filter((x) => x.objective_type === 'pick')) {
    assert.ok(Array.isArray(q.choices) && q.choices.length >= 2, q.key);
    for (const c of q.choices) assert.ok(c.key && c.label, `${q.key}: choice shape`);
    assert.strictEqual(new Set(q.choices.map((c) => c.key)).size, q.choices.length);
  }
});

test('chain prerequisites point at real quests', () => {
  const keys = new Set(QUESTS.map((q) => q.key));
  for (const q of EXPANSION_QUESTS) if (q.prerequisite_key) assert.ok(keys.has(q.prerequisite_key), q.key);
});

test('dailyPoolKeys picks a stable board that rotates across days', () => {
  const keys = EXPANSION_QUESTS.filter((q) => q.pool_group === 'daily_board').map((q) => q.key);
  const a = svc.dailyPoolKeys(keys, new Date('2026-11-01T01:00:00Z'));
  const a2 = svc.dailyPoolKeys(keys, new Date('2026-11-01T23:00:00Z'));
  assert.strictEqual(a.size, 3);
  assert.deepStrictEqual([...a].sort(), [...a2].sort(), 'same all day');
  const seen = new Set();
  for (let d = 1; d <= 20; d += 1) for (const k of svc.dailyPoolKeys(keys, new Date(Date.UTC(2026, 10, d)))) seen.add(k);
  assert.ok(seen.size > 3, 'the board rotates');
});

test('dailyDue handles weekly quests (Monday start)', () => {
  const weekly = { repeat_kind: 'weekly' };
  const now = new Date('2026-11-04T10:00:00Z'); // Wednesday
  assert.strictEqual(svc.dailyDue(weekly, '2026-11-02T08:00:00Z', now), false, 'this Monday: same week');
  assert.strictEqual(svc.dailyDue(weekly, '2026-11-01T23:00:00Z', now), true, 'previous Sunday: last week');
  assert.strictEqual(svc.dailyDue({ repeat_kind: 'none' }, '2020-01-01T00:00:00Z', now), false);
});

test('reputationTier labels standing', () => {
  assert.strictEqual(svc.reputationTier(0), 'Stranger');
  assert.strictEqual(svc.reputationTier(30), 'Friend');
  assert.strictEqual(svc.reputationTier(100), 'Honored');
  assert.strictEqual(svc.reputationTier(999), 'Revered');
});

test('the new recorders ignore empty input and carry the challenge clock', async () => {
  const seen = [];
  const pool = { async query(sql, params) { seen.push({ sql: sql.replace(/\s+/g, ' '), params }); return { rows: [] }; } };
  assert.deepStrictEqual(await svc.recordItem(pool, 1, 'x', 0), []);
  assert.deepStrictEqual(await svc.recordReach(pool, 1, ''), []);
  assert.strictEqual(seen.length, 0, 'no query for nothing');
  await svc.recordItem(pool, 1, 'loot_map', 2);
  await svc.recordChest(pool, 1);
  await svc.recordReach(pool, 1, 'The Catacombs: Deep');
  assert.strictEqual(seen.length, 3);
  for (const s of seen) assert.match(s.sql, /time_limit_sec IS NULL/, 'time-limited quests only advance inside the clock');
  assert.deepStrictEqual(seen[0].params, [1, 'loot_map', 2]);
});

test('getCharacterQuests locks class trials, applies the daily board and reports standing', async () => {
  const keys = ['daily_a', 'daily_b', 'daily_c', 'daily_d', 'daily_e'];
  const board = svc.dailyPoolKeys(keys);
  const rows = [
    { id: 1, key: 'warrior_only', act: 1, title: 'W', required_class: 'Warrior', objective_type: 'kill_any', target_count: 1, raw_status: null },
    { id: 2, key: 'rep_gate', act: 1, title: 'R', village_key: 'sunspire', required_reputation: 50, objective_type: 'kill_any', target_count: 1, is_side: true, raw_status: null },
    ...keys.map((k, i) => ({ id: 10 + i, key: k, act: 1, title: k, pool_group: 'g', repeat_kind: 'daily', objective_type: 'kill_any', target_count: 1, is_side: true, raw_status: null })),
  ];
  const pool = {
    async query(sql) {
      if (/^\s*DELETE FROM character_quests/.test(sql)) return { rows: [] };
      if (/FROM quests q/.test(sql)) return { rows };
      if (/legacy_choice/.test(sql)) return { rows: [] };
      if (/FROM characters c JOIN entity_types/.test(sql)) return { rows: [{ name: 'Mage' }] };
      if (/character_reputation/.test(sql)) return { rows: [{ village_key: 'sunspire', points: 40 }] };
      return { rows: [] };
    },
  };
  const out = await svc.getCharacterQuests(pool, 1);
  const by = Object.fromEntries(out.quests.map((q) => [q.key, q]));
  assert.strictEqual(by.warrior_only.status, 'locked');
  assert.strictEqual(by.warrior_only.locked_reason, 'Warrior only');
  assert.strictEqual(by.rep_gate.status, 'locked');
  assert.match(by.rep_gate.locked_reason, /50/);
  const shown = out.quests.filter((q) => q.pool_group === 'g').map((q) => q.key).sort();
  assert.deepStrictEqual(shown, [...board].sort());
  assert.deepStrictEqual(out.reputation, [{ village_key: 'sunspire', points: 40, tier: 'Friend' }]);
  assert.strictEqual(out.characterClass, 'Mage');
});
