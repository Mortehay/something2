const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { commitCreatureDeath, claimItem } = require('../src/authority/loot.js');

// Routes queries by SQL pattern and records every call, so a test can assert
// that a query NEVER ran — which is the point of the rowCount guard.
function scriptedPool(routes = []) {
  const calls = [];
  return {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, result] of routes) {
        if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function armEntry() {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  return {
    worldId: 'w1',
    world: new World(map, new Map(), null, 8),
    creatureTypeIds: new Map([['Wolf', 42]]),
  };
}

const DROP_ROW = { item_type_id: 7, chance: '1', min_qty: 1, max_qty: 1 };
const always = () => 0; // rng: always rolls under chance, always min qty

test('a death whose DELETE affects no row rolls NO drops', async () => {
  const entry = armEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [], rowCount: 0 }], // already finalized elsewhere
    [/FROM creature_drops/i, { rows: [DROP_ROW], rowCount: 1 }],
  ]);

  await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000 });

  assert.strictEqual(pool.matching(/FROM creature_drops/i).length, 0, 'must not even look up the drop table');
  assert.strictEqual(pool.matching(/INSERT INTO world_items/i).length, 0, 'must not spawn loot');
  assert.strictEqual(entry.world.groundItems.count(), 0);
});

test('a death whose DELETE affects one row drops loot at the corpse position', async () => {
  const entry = armEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [{ type: 'Wolf', x: 500, y: 600 }], rowCount: 1 }],
    [/FROM creature_drops/i, { rows: [DROP_ROW], rowCount: 1 }],
    [/INSERT INTO world_items/i, (p) => ({
      rows: [{ id: 'g1', item_type_id: p[1], x: p[2], y: p[3], expires_at: '2999-01-01T00:00:00Z' }],
      rowCount: 1,
    })],
  ]);

  await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000 });

  const inserts = pool.matching(/INSERT INTO world_items/i);
  assert.strictEqual(inserts.length, 1);
  assert.deepStrictEqual(inserts[0].params.slice(0, 4), ['w1', 7, 500, 600]);
  assert.strictEqual(entry.world.groundItems.count(), 1, 'lands in the sim for the next broadcast');
  assert.deepStrictEqual(entry.world.groundItems.get('g1').x, 500);
});

test('an unknown creature type drops nothing and does not throw', async () => {
  const entry = armEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [{ type: 'Ghost', x: 0, y: 0 }], rowCount: 1 }],
  ]);
  await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000 });
  assert.strictEqual(pool.matching(/INSERT INTO world_items/i).length, 0);
});

test('removing the rowCount guard would double-drop on two damage sources reporting the same kill', async () => {
  // This does not call commitCreatureDeath twice (that would just prove the
  // guard's *effect*, not its necessity). It proves the SECOND finalize
  // attempt on an already-deleted row cannot roll drops at all, by scripting
  // the second call's DELETE to behave the way Postgres actually behaves:
  // rowCount 0, empty rows. If the `r.rowCount !== 1` guard in loot.js were
  // removed outright so `r.rows[0]` is read unconditionally, this test
  // fails — either by throwing (rows[0] undefined) or by issuing the
  // creature_drops lookup it must not issue. It does NOT prove anything
  // about weakening the guard to `!r.rows.length`: for DELETE ... RETURNING,
  // rowCount === rows.length always, so this mock's empty rows/rowCount pair
  // makes that weakening behave identically here (verified: swapping in
  // `!r.rows.length` still passes all 4 tests in this file).
  const entry = armEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [], rowCount: 0 }],
    [/FROM creature_drops/i, { rows: [DROP_ROW], rowCount: 1 }],
    [/INSERT INTO world_items/i, () => { throw new Error('must never be reached'); }],
  ]);

  await assert.doesNotReject(commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000 }));

  assert.strictEqual(pool.matching(/FROM creature_drops/i).length, 0, 'second finalize must not roll drops');
  assert.strictEqual(entry.world.groundItems.count(), 0);
});

function armClaimEntry() {
  const entry = armEntry();
  entry.claiming = new Set();
  entry.world.addPlayer('u1', { x: 0, y: 0 }, { items: [], equipment: {} });
  entry.world.groundItems.add([{ id: 'g1', item_type_id: 7, x: 10, y: 10, expires_at: '2999-01-01T00:00:00Z' }]);
  return entry;
}

test('two claims of one item yield exactly one player_items INSERT', async () => {
  const entry = armClaimEntry();
  let deletes = 0;
  const pool = scriptedPool([
    // First DELETE wins, every later one finds the row already gone. This is
    // exactly what Postgres does when two sessions race the same row.
    [/DELETE FROM world_items/i, () => (++deletes === 1
      ? { rows: [{ item_type_id: 7 }], rowCount: 1 }
      : { rows: [], rowCount: 0 })],
    [/INSERT INTO player_items/i, { rows: [{ id: 'inst-1' }], rowCount: 1 }],
  ]);

  const first = await claimItem(pool, entry, 'u1', 'g1');
  const second = await claimItem(pool, entry, 'u1', 'g1');

  assert.deepStrictEqual(first, { id: 'inst-1', typeId: 7 });
  assert.strictEqual(second, null, 'the loser gets nothing');
  assert.strictEqual(pool.matching(/INSERT INTO player_items/i).length, 1, 'the item is granted exactly once');
  assert.strictEqual(entry.world.groundItems.get('g1'), null, 'gone from the sim either way');
});

test('a failed player_items INSERT destroys the item rather than duplicating it', async () => {
  const entry = armClaimEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_items/i, { rows: [{ item_type_id: 7 }], rowCount: 1 }],
    [/INSERT INTO player_items/i, () => { throw new Error('db down'); }],
  ]);

  const got = await claimItem(pool, entry, 'u1', 'g1');

  assert.strictEqual(got, null);
  assert.strictEqual(entry.world.groundItems.get('g1'), null, 'the world row is already gone; do not resurrect it');
  assert.strictEqual(entry.world.getPlayer('u1').inv.items.length, 0, 'and the player did not get it');
});

test('a successful claim adds the instance to the in-memory inventory', async () => {
  const entry = armClaimEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_items/i, { rows: [{ item_type_id: 7 }], rowCount: 1 }],
    [/INSERT INTO player_items/i, { rows: [{ id: 'inst-1' }], rowCount: 1 }],
  ]);
  await claimItem(pool, entry, 'u1', 'g1');
  assert.deepStrictEqual(entry.world.getPlayer('u1').inv.items, [{ id: 'inst-1', typeId: 7 }]);
});
