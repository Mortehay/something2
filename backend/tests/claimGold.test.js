const test = require('node:test');
const assert = require('node:assert');
const { claimGold } = require('../src/authority/loot');

function entryWith(player) {
  const removed = [];
  return {
    claiming: new Set(),
    world: {
      groundItems: { remove: (id) => removed.push(id) },
      getPlayer: () => player,
    },
    _removed: removed,
  };
}

test('claimGold credits users.gold atomically and updates p.gold', async () => {
  const player = { gold: 10 };
  const entry = entryWith(player);
  const pool = { query: async (sql, params) => {
    assert.match(sql, /DELETE FROM world_items/, 'must delete the ground row');
    assert.match(sql, /UPDATE users SET gold = gold \+/, 'must credit the wallet');
    assert.deepEqual(params, ['g1', 'u1']);
    return { rowCount: 1, rows: [{ gold: 15 }] };
  } };
  const got = await claimGold(pool, entry, 'u1', 'g1');
  assert.deepEqual(got, { gold: 15 });
  assert.equal(player.gold, 15, 'in-memory wallet mirrors the DB');
  assert.deepEqual(entry._removed, ['g1'], 'ground item evicted from the sim');
});

test('claimGold returns null on a lost race (row already gone) and evicts the stale sim row', async () => {
  const entry = entryWith({ gold: 0 });
  const pool = { query: async () => ({ rowCount: 0, rows: [] }) };
  const got = await claimGold(pool, entry, 'u1', 'g1');
  assert.equal(got, null);
  assert.deepEqual(entry._removed, ['g1']);
});
