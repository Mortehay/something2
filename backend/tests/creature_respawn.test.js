const test = require('node:test');
const assert = require('node:assert');
const {
  isClearOfPlayers, RESPAWN_DELAY_MS, CREATURE_SWEEP_MS, RESPAWN_MIN_PLAYER_DISTANCE,
} = require('../src/services/creatureRespawn');

test('an empty world is clear everywhere', () => {
  assert.equal(isClearOfPlayers(0, 0, []), true);
});

test('a position exactly at the minimum distance is clear', () => {
  // 1000 world px = 10 tiles at MAP_TILE_SIZE 100. Hand-typed, NOT derived
  // from RESPAWN_MIN_PLAYER_DISTANCE -- a test that reads the constant it is
  // testing passes for any value of that constant.
  assert.equal(isClearOfPlayers(1000, 0, [{ x: 0, y: 0 }]), true);
});

test('a position inside the minimum distance is not clear', () => {
  assert.equal(isClearOfPlayers(999, 0, [{ x: 0, y: 0 }]), false);
});

test('distance is measured diagonally, not per-axis', () => {
  // (700,700) is 700 away on each axis but 989.9 away in a straight line,
  // which is inside 1000. A per-axis check would wrongly call this clear.
  assert.equal(isClearOfPlayers(700, 700, [{ x: 0, y: 0 }]), false);
});

test('one nearby player is enough to reject, however many are far away', () => {
  const players = [{ x: 9000, y: 9000 }, { x: 50, y: 50 }, { x: -9000, y: 0 }];
  assert.equal(isClearOfPlayers(0, 0, players), false);
});

test('the shipped constants are the values the design settled on', () => {
  assert.equal(RESPAWN_DELAY_MS, 30000);
  assert.equal(CREATURE_SWEEP_MS, 10000);
  assert.equal(RESPAWN_MIN_PLAYER_DISTANCE, 1000);
});

const { respawnDueCreatures } = require('../src/services/creatureRespawn');

// A pool double. `queries` records every SQL string so a test can assert on
// what the sweep actually asked the database, and `handler` decides each
// reply. connect() hands back the same object so BEGIN/COMMIT are recorded in
// the same list as everything else.
function fakePool(handler) {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return handler(sql, params) || { rows: [], rowCount: 0 };
    },
    release() { this.released = true; },
    released: false,
  };
  return {
    queries,
    client,
    query: client.query,
    connect: async () => client,
  };
}

const DUE_ROW = {
  id: 'row-1', world_id: 'w1', type: 'Wolf', x: 500, y: 500, level: 3,
};
const WOLF_TYPE = {
  id: 7, name: 'Wolf', hp: 20, defense: 2, resistances: null,
};

test('a row whose world is not loaded stays due and spawns nothing', async () => {
  const pool = fakePool((sql) => {
    if (sql.includes('FROM creature_respawns')) return { rows: [DUE_ROW], rowCount: 1 };
    return null;
  });

  const spawned = await respawnDueCreatures(pool, {
    // The world was loaded when the pass started (so its rows are in the
    // window) and is gone by the time the row is actioned -- the eviction race
    // the getWorld null-check exists for.
    loadedWorldIds: ['w1'],
    getWorld: () => null,
    getPlayers: () => [],
  });

  assert.equal(spawned, 0);
  // The whole point: no DELETE, so the row is retried on a later sweep.
  assert.equal(pool.queries.some((q) => q.sql.includes('DELETE FROM creature_respawns')), false);
});

test('a row whose creature type is gone from the catalog is deleted, not retried', async () => {
  const pool = fakePool((sql) => {
    if (sql.includes('FROM creature_respawns')) return { rows: [DUE_ROW], rowCount: 1 };
    if (sql.includes('FROM entity_types')) return { rows: [], rowCount: 0 };
    return null;
  });

  const spawned = await respawnDueCreatures(pool, {
    loadedWorldIds: ['w1'],
    getWorld: () => ({ tileTypes: [{ name: 'grass' }], width: 96, height: 96, levelMin: 1, levelMax: 5 }),
    getPlayers: () => [],
  });

  assert.equal(spawned, 0);
  // Retrying forever would pin a permanently-failing row at the head of every
  // sweep, starving the rows behind it.
  assert.equal(pool.queries.some((q) => q.sql.includes('DELETE FROM creature_respawns')), true);
  assert.equal(pool.queries.some((q) => q.sql.includes('INSERT INTO world_creatures')), false);
});

test('one failing row does not stop later rows in the same pass', async () => {
  const rows = [
    { ...DUE_ROW, id: 'row-1' },
    { ...DUE_ROW, id: 'row-2' },
  ];
  let entityTypeCalls = 0;
  const pool = fakePool((sql) => {
    // NOTE: checked before the generic 'FROM creature_respawns' branch below --
    // "DELETE FROM creature_respawns ..." contains that substring too, so the
    // more specific DELETE check must come first or it never fires.
    if (sql.includes('DELETE FROM creature_respawns')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM creature_respawns')) return { rows, rowCount: 2 };
    if (sql.includes('FROM entity_types')) {
      entityTypeCalls += 1;
      if (entityTypeCalls === 1) throw new Error('transient DB error');
      return { rows: [WOLF_TYPE], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO world_creatures')) return { rows: [{ id: 'c-2' }], rowCount: 1 };
    return null;
  });

  const spawned = await respawnDueCreatures(pool, {
    loadedWorldIds: ['w1'],
    getWorld: () => ({ tileTypes: [{ name: 'grass' }], width: 96, height: 96, levelMin: 1, levelMax: 5 }),
    getPlayers: () => [],
  });

  assert.equal(spawned, 1);
});

test('a respawn reuses the recorded position when no player is near it', async () => {
  const pool = fakePool((sql) => {
    if (sql.includes('FROM creature_respawns')) return { rows: [DUE_ROW], rowCount: 1 };
    if (sql.includes('FROM entity_types')) return { rows: [WOLF_TYPE], rowCount: 1 };
    if (sql.includes('DELETE FROM creature_respawns')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO world_creatures')) return { rows: [{ id: 'c-1' }], rowCount: 1 };
    return null;
  });

  const seen = [];
  const spawned = await respawnDueCreatures(pool, {
    loadedWorldIds: ['w1'],
    getWorld: () => ({ tileTypes: [{ name: 'grass' }], width: 96, height: 96, levelMin: 1, levelMax: 5 }),
    getPlayers: () => [{ x: 9000, y: 9000 }],
    onSpawn: async (s) => { seen.push(s); },
  });

  assert.equal(spawned, 1);
  const insert = pool.queries.find((q) => q.sql.includes('INSERT INTO world_creatures'));
  // params: world_id, type, x, y, hp, facing, level, damage, defense
  assert.equal(insert.params[2], 500);
  assert.equal(insert.params[3], 500);
  assert.equal(insert.params[6], 3); // the recorded level, not a re-roll
  assert.deepEqual(seen, [{ worldId: 'w1', creatureId: 'c-1' }]);
});

test('the sweep claims each row with a gated DELETE inside a transaction', async () => {
  const pool = fakePool((sql) => {
    // NOTE: checked before the generic 'FROM creature_respawns' branch below --
    // "DELETE FROM creature_respawns ..." contains that substring too, so the
    // more specific DELETE check must come first or it never fires.
    // rowCount 0 = another sweep already claimed this row.
    if (sql.includes('DELETE FROM creature_respawns')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM creature_respawns')) return { rows: [DUE_ROW], rowCount: 1 };
    if (sql.includes('FROM entity_types')) return { rows: [WOLF_TYPE], rowCount: 1 };
    return null;
  });

  const spawned = await respawnDueCreatures(pool, {
    loadedWorldIds: ['w1'],
    getWorld: () => ({ tileTypes: [{ name: 'grass' }], width: 96, height: 96, levelMin: 1, levelMax: 5 }),
    getPlayers: () => [],
  });

  assert.equal(spawned, 0);
  // Losing the claim race must not insert a creature -- that is the
  // double-spawn this gate exists to prevent.
  assert.equal(pool.queries.some((q) => q.sql.includes('INSERT INTO world_creatures')), false);
  assert.equal(pool.queries.some((q) => q.sql === 'ROLLBACK'), true);
  assert.equal(pool.client.released, true);
});

// Final review, Critical C1. The due window is capped and ordered oldest-first,
// and a row whose world is not loaded is skipped WITHOUT being deleted. So if
// unactionable rows can enter the window they never leave it, and once `limit`
// of them exist the sweep spawns nothing anywhere, forever, with nothing
// logged. Only rows for currently-loaded worlds may be selected.
const ORPHAN_ROW = {
  id: 'row-orphan', world_id: 'w-unloaded', type: 'Wolf', x: 10, y: 10, level: 1,
};

test('a due row for an unloaded world does not consume the sweep window', async () => {
  const pool = fakePool((sql, params) => {
    // DELETE checked first: it contains 'FROM creature_respawns' too.
    if (sql.includes('DELETE FROM creature_respawns')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM creature_respawns')) {
      // Stands in for Postgres. The orphan is listed FIRST because it is the
      // older row and the query orders by respawn_at -- that is precisely the
      // position from which it would starve everything behind it. $1 is the
      // LIMIT; $2, if the query passes one, is the loaded-world filter.
      const loaded = params[1] || null;
      const all = [ORPHAN_ROW, DUE_ROW];
      const visible = loaded ? all.filter((r) => loaded.includes(r.world_id)) : all;
      const window = visible.slice(0, params[0]);
      return { rows: window, rowCount: window.length };
    }
    if (sql.includes('FROM entity_types')) return { rows: [WOLF_TYPE], rowCount: 1 };
    if (sql.includes('INSERT INTO world_creatures')) return { rows: [{ id: 'c-1' }], rowCount: 1 };
    return null;
  });

  // limit 1 = the whole window is one row. Unfiltered, the orphan takes it.
  const spawned = await respawnDueCreatures(pool, {
    limit: 1,
    loadedWorldIds: ['w1'],
    getWorld: (worldId) => (worldId === 'w1'
      ? { tileTypes: [{ name: 'grass' }], width: 96, height: 96, levelMin: 1, levelMax: 5 }
      : null),
    getPlayers: () => [],
  });

  assert.equal(spawned, 1);
  const insert = pool.queries.find((q) => q.sql.includes('INSERT INTO world_creatures'));
  assert.equal(insert.params[0], 'w1'); // the loaded world's row, not the orphan
});

test('the sweep does not query at all when no world is loaded', async () => {
  const pool = fakePool(() => null);

  const spawned = await respawnDueCreatures(pool, {
    loadedWorldIds: [],
    getWorld: () => null,
    getPlayers: () => [],
  });

  assert.equal(spawned, 0);
  // `world_id = ANY('{}')` matches nothing, so the query would be pure waste on
  // every 10s tick of an idle authority.
  assert.equal(pool.queries.length, 0);
});
