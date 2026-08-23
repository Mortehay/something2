const test = require('node:test');
const assert = require('node:assert');
const { openChest } = require('../src/authority/chestLoot');

// Stub client: openChest runs a fixed sequence of statements, so each is
// matched on the leading shape of its SQL. `inserts` records the item type id
// of every player_items INSERT, which is what the overflow assertions read —
// counting grants rather than trusting the returned array is the point, since
// a bug that returned fewer items while still inserting all of them would
// otherwise look correct.
function stubPool({ rolled }) {
  const inserts = [];
  const client = {
    inserts,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rowCount: 1, rows: [] };
      if (s.startsWith('SELECT id, state, kind')) {
        return {
          rowCount: 1,
          rows: [{ id: 'chest-1', state: 'unlocked', kind: 'vault', guard_creature_ids: [], guard_level: 1 }],
        };
      }
      if (s.startsWith("UPDATE world_chests SET state = 'opened'")) {
        return { rowCount: 1, rows: [{ id: 'chest-1', opened_at: '2026-08-23T00:00:00Z' }] };
      }
      if (s.startsWith('SELECT item_type_id, chance')) {
        return {
          rowCount: rolled.length,
          rows: rolled.map((id) => ({ item_type_id: id, chance: 1, min_qty: 1, max_qty: 1 })),
        };
      }
      if (s.startsWith('INSERT INTO player_items')) {
        inserts.push(params[1]);
        return { rowCount: 1, rows: [{ id: `new-${inserts.length}`, item_type_id: params[1], quantity: 1 }] };
      }
      if (s.includes('player_progression')) {
        return { rowCount: 1, rows: [{ character_id: 7, level: 1, experience: 0, stat_points: 0 }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return { connect: async () => client, _client: client };
}

test('a chest grants only what fits and reports the overflow', async () => {
  const pool = stubPool({ rolled: [11, 12, 13, 14] });
  const r = await openChest(pool, 'chest-1', 7, { rng: () => 0, freeSlots: 2 });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.items.length, 2);
  assert.deepStrictEqual(pool._client.inserts, [11, 12]);
  assert.deepStrictEqual(r.overflowTypeIds, [13, 14]);
});

test('a chest with room grants everything and overflows nothing', async () => {
  const pool = stubPool({ rolled: [11, 12] });
  const r = await openChest(pool, 'chest-1', 7, { rng: () => 0, freeSlots: 48 });

  assert.strictEqual(r.items.length, 2);
  assert.deepStrictEqual(pool._client.inserts, [11, 12]);
  assert.deepStrictEqual(r.overflowTypeIds, []);
});

test('an omitted freeSlots grants everything, so existing callers are unchanged', async () => {
  const pool = stubPool({ rolled: [11, 12, 13] });
  const r = await openChest(pool, 'chest-1', 7, { rng: () => 0 });

  assert.strictEqual(r.items.length, 3);
  assert.deepStrictEqual(r.overflowTypeIds, []);
});

test('a full inventory grants nothing and overflows the whole roll', async () => {
  const pool = stubPool({ rolled: [11, 12] });
  const r = await openChest(pool, 'chest-1', 7, { rng: () => 0, freeSlots: 0 });

  assert.strictEqual(r.ok, true, 'the chest still opens — it is already CAS-opened and cannot be re-opened');
  assert.deepStrictEqual(pool._client.inserts, []);
  assert.deepStrictEqual(r.overflowTypeIds, [11, 12]);
});
