const test = require('node:test');
const assert = require('node:assert');
const { awardStoneXp } = require('../src/authority/stoneXp.js');

function scriptedPool(row) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/UPDATE stone_instances/i.test(sql)) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('awardStoneXp adds xp and reports leveledUp when the level column actually changed', async () => {
  const pool = scriptedPool({ xp: 150, level: 2 });
  const result = await awardStoneXp(pool, 'stone-1', 50);
  assert.equal(result.leveledUp, true);
  assert.equal(result.level, 2);
  const upd = pool.calls.find((c) => /UPDATE stone_instances/i.test(c.sql));
  assert.match(upd.sql, /xp = xp \+ \$/i, 'must increment in SQL, not read-then-write in JS (race-safe)');
});

// The SELECT that reads beforeLevel returns rowCount 0 by scriptedPool's
// default branch (row not found), so beforeLevel falls back to 1 -- the
// brief's own test only exercises the found-and-leveled-up path; this covers
// the "did NOT level up" branch, which needs beforeLevel to be READ, not
// just defaulted, when the row genuinely already existed at that level.
test('awardStoneXp reports leveledUp:false when the level column did not change', async () => {
  const calls = [];
  const pool = {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT level FROM stone_instances/i.test(sql)) return { rows: [{ level: 3 }], rowCount: 1 };
      if (/UPDATE stone_instances/i.test(sql)) return { rows: [{ xp: 210, level: 3 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await awardStoneXp(pool, 'stone-2', 10);
  assert.equal(result.leveledUp, false);
  assert.equal(result.xp, 210);
  assert.equal(result.level, 3);
});

test('awardStoneXp returns null when the stone id does not exist (rowCount 0 on the UPDATE)', async () => {
  const pool = {
    query: async (sql) => {
      if (/UPDATE stone_instances/i.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await awardStoneXp(pool, 'nonexistent-stone', 10);
  assert.equal(result, null);
});

test('awardStoneXp passes stonePlayerItemId and amount as the UPDATE params, not the type id or a hardcoded value', async () => {
  const pool = scriptedPool({ xp: 10, level: 1 });
  await awardStoneXp(pool, 'stone-xyz', 25);
  const upd = pool.calls.find((c) => /UPDATE stone_instances/i.test(c.sql));
  assert.ok(upd.params.includes('stone-xyz'), 'the stone instance id must be a bound param');
  assert.ok(upd.params.includes(25), 'the amount must be a bound param, not baked into the SQL string');
});
