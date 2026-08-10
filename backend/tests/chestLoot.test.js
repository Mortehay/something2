const test = require('node:test');
const assert = require('node:assert');
const {
  rollChestLoot, xpForChest, openChest, FIELD_CHEST_RESPAWN_MS,
} = require('../src/authority/chestLoot.js');

function scriptedPool(rows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; },
  };
}

test('rollChestLoot queries chest_loot bounded by the guard level and rolls it through rollDrops', async () => {
  const row = { item_type_id: 9, chance: '1', min_qty: 1, max_qty: 1 };
  const pool = scriptedPool([row]);
  const always = () => 0;
  const out = await rollChestLoot(pool, 5, always);
  assert.deepEqual(out, [9]);
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /FROM chest_loot/i);
  assert.match(pool.calls[0].sql, /level_min <= \$1/i);
  assert.match(pool.calls[0].sql, /level_max >= \$1/i);
  assert.deepEqual(pool.calls[0].params, [5]);
});

test('rollChestLoot rolls nothing when the level band has no matching rows', async () => {
  const pool = scriptedPool([]);
  const out = await rollChestLoot(pool, 1, () => 0);
  assert.deepEqual(out, []);
});

test('xpForChest reuses xpForKill unchanged, applied to the guard level', () => {
  const { xpForKill } = require('../src/services/playerStats.js');
  assert.equal(xpForChest(10, 3), xpForKill(10, 3));
  assert.equal(xpForChest(1, 1), xpForKill(1, 1));
});

// openChest: guard-gating, CAS on world_chests.state, loot grant, XP award.

function scriptedRoutePool(routes) {
  const calls = [];
  function route(sql, params) {
    for (const [re, result] of routes) {
      if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
    }
    return { rows: [], rowCount: 0 };
  }
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
    connect: async () => ({
      query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
      release: () => {},
    }),
  };
}

test('openChest refuses a chest whose guards are still alive', async () => {
  const pool = scriptedRoutePool([
    [/SELECT .* FROM world_chests/i, { rows: [{ id: 'c1', state: 'locked', guard_creature_ids: ['g1'], guard_level: 5 }], rowCount: 1 }],
    [/SELECT count\(\*\) .* FROM world_creatures/i, { rows: [{ count: '1' }], rowCount: 1 }], // one guard still alive
  ]);
  const result = await openChest(pool, 'c1', 'user1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /guard/i);
});

test('openChest CAS: only the request that flips locked->opened grants loot and XP', async () => {
  const pool = scriptedRoutePool([
    [/SELECT .* FROM world_chests/i, { rows: [{ id: 'c1', state: 'unlocked', guard_creature_ids: [], guard_level: 5 }], rowCount: 1 }],
    [/UPDATE world_chests SET state = 'opened'/i, { rows: [{ id: 'c1' }], rowCount: 1 }], // CAS wins
    [/FROM chest_loot/i, { rows: [{ item_type_id: 3, chance: '1', min_qty: 1, max_qty: 1 }], rowCount: 1 }],
    [/INSERT INTO player_items/i, { rows: [{ id: 'pi1', item_type_id: 3, quantity: 1 }], rowCount: 1 }],
    [/FROM player_progression/i, { rows: [{ level: 2, experience: 100 }], rowCount: 1 }],
    [/UPDATE player_progression/i, { rows: [{ level: 2, experience: 150 }], rowCount: 1 }],
  ]);
  const result = await openChest(pool, 'c1', 'user1', { rng: () => 0 });
  assert.equal(result.ok, true);
  // Final-review fix (SOMET-244 Important #2): the full inserted
  // player_items row ({id, item_type_id, quantity}), matching claimItem's
  // own shape (loot.js:232) -- not a bare item_type_id. The `openchest`
  // handler needs the id/quantity to push each grant onto p.inv.items.
  assert.deepEqual(result.items, [{ id: 'pi1', item_type_id: 3, quantity: 1 }]);
  // Final-review fix (SOMET-244 Important #3): awardXp always computes a
  // `progression` object (even on a no-op award) -- openChest must hand it
  // back so the caller can call world.applyDerivedStats on a level-up,
  // mirroring the kill path (server.js:426-463).
  assert.equal(result.progression.level, 2);
  assert.equal(result.progression.experience, 150);
});

test('openChest CAS: a losing request (already opened) grants nothing', async () => {
  const pool = scriptedRoutePool([
    [/SELECT .* FROM world_chests/i, { rows: [{ id: 'c1', state: 'unlocked', guard_creature_ids: [], guard_level: 5 }], rowCount: 1 }],
    [/UPDATE world_chests SET state = 'opened'/i, { rows: [], rowCount: 0 }], // lost the CAS
  ]);
  const result = await openChest(pool, 'c1', 'user1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /already/i);
});

test('FIELD_CHEST_RESPAWN_MS is 2 hours', () => {
  assert.equal(FIELD_CHEST_RESPAWN_MS, 2 * 60 * 60 * 1000);
});

test('openChest schedules a respawn for a field chest and returns openedAt/respawnAt for the caller to sync in-memory state', async () => {
  const pool = scriptedRoutePool([
    [/SELECT .* FROM world_chests WHERE id = \$1 FOR UPDATE/i, {
      rows: [{
        id: 'c1', state: 'unlocked', kind: 'field', guard_creature_ids: [], guard_level: 5,
      }],
      rowCount: 1,
    }],
    [/UPDATE world_chests SET state = 'opened'/i, { rows: [{ id: 'c1', opened_at: '2026-08-10T00:00:00Z' }], rowCount: 1 }],
    [/UPDATE world_chests SET respawn_at/i, { rows: [{ respawn_at: '2026-08-10T02:00:00Z' }], rowCount: 1 }],
    [/FROM chest_loot/i, { rows: [], rowCount: 0 }],
    [/FROM player_progression/i, { rows: [{ level: 2, experience: 100 }], rowCount: 1 }],
    [/UPDATE player_progression/i, { rows: [{ level: 2, experience: 100 }], rowCount: 1 }],
  ]);
  const result = await openChest(pool, 'c1', 'user1', { rng: () => 0 });
  assert.equal(result.ok, true);
  assert.equal(result.openedAt, '2026-08-10T00:00:00Z');
  assert.equal(result.respawnAt, '2026-08-10T02:00:00Z');

  const respawnUpdate = pool.calls.find((c) => /UPDATE world_chests SET respawn_at/i.test(c.sql));
  assert.ok(respawnUpdate, 'a field chest open must schedule a respawn');
  assert.equal(respawnUpdate.params[0], FIELD_CHEST_RESPAWN_MS);
  assert.equal(respawnUpdate.params[1], 'c1');
});

test('openChest leaves respawn_at untouched for a vault chest', async () => {
  const pool = scriptedRoutePool([
    [/SELECT .* FROM world_chests WHERE id = \$1 FOR UPDATE/i, {
      rows: [{
        id: 'c1', state: 'unlocked', kind: 'vault', guard_creature_ids: [], guard_level: 5,
      }],
      rowCount: 1,
    }],
    [/UPDATE world_chests SET state = 'opened'/i, { rows: [{ id: 'c1', opened_at: '2026-08-10T00:00:00Z' }], rowCount: 1 }],
    [/FROM chest_loot/i, { rows: [], rowCount: 0 }],
    [/FROM player_progression/i, { rows: [{ level: 2, experience: 100 }], rowCount: 1 }],
    [/UPDATE player_progression/i, { rows: [{ level: 2, experience: 100 }], rowCount: 1 }],
  ]);
  const result = await openChest(pool, 'c1', 'user1', { rng: () => 0 });
  assert.equal(result.ok, true);
  assert.equal(result.openedAt, '2026-08-10T00:00:00Z');
  assert.equal(result.respawnAt, null);
  assert.ok(!pool.calls.some((c) => /UPDATE world_chests SET respawn_at/i.test(c.sql)), 'vault chest open must not schedule a respawn');
});
