const test = require('node:test');
const assert = require('node:assert');
const {
  insertVaultChest, spawnFieldChest, respawnDueFieldChests,
} = require('../src/services/chests.js');

function scriptedClient(entityTypeRow, creatureId, chestId) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM entity_types/i.test(sql)) return { rows: [entityTypeRow], rowCount: 1 };
      if (/INSERT INTO world_creatures/i.test(sql)) return { rows: [{ id: creatureId }], rowCount: 1 };
      if (/INSERT INTO world_chests/i.test(sql)) return { rows: [{ id: chestId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('insertVaultChest spawns a leashed guard at the chest position and inserts a locked vault chest referencing it', async () => {
  const entityType = { id: 12, hp: 40, defense: 3 };
  const client = scriptedClient(entityType, 'creature-1', 'chest-1');
  const result = await insertVaultChest(client, 'world-1', {
    x: 500, y: 600, guardCreatureType: 'Undead Line', level: 7,
  });

  assert.equal(result.id, 'chest-1');
  assert.equal(result.guardCreatureId, 'creature-1');

  const creatureIns = client.calls.find((c) => /INSERT INTO world_creatures/i.test(c.sql));
  assert.match(creatureIns.sql, /home_x/, 'guard must be leashed to its post like a village guard');
  assert.deepEqual(creatureIns.params.slice(0, 4), ['world-1', 'Undead Line', 500, 600]);

  const chestIns = client.calls.find((c) => /INSERT INTO world_chests/i.test(c.sql));
  assert.match(chestIns.sql, /'vault'/);
  assert.deepEqual(JSON.parse(chestIns.params[chestIns.params.length - 1]), ['creature-1']);
});

test('insertVaultChest rejects an unknown guard creature type rather than inserting a chest nobody guards', async () => {
  const client = {
    query: async (sql) => {
      if (/FROM entity_types/i.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(
    () => insertVaultChest(client, 'world-1', { x: 0, y: 0, guardCreatureType: 'Nope', level: 1 }),
    /unknown guard creature type/,
  );
});

// spawnFieldChest's world argument is what placeMapCreatures itself already
// requires elsewhere (worldPopulation.js, seed-map.js): a buildWorldGenConfig
// shape, not a raw `worlds` table row. A world with a walkable tile type but
// no width/height is UNBOUNDED (cfg.bounds is null), which is placeMapCreatures'
// own documented "nowhere legal" precondition -- not empty tileTypes (that
// throws a different error, `worldConfig: tileTypes is empty`, before ever
// reaching the bounds check).
function unboundedWorld() {
  return { levelMin: 1, levelMax: 5, tileTypes: { grass: { walkable: true, speed: 1 } } };
}

// A 10x10 bounded world, entirely walkable interior, no biomes/villages --
// any rngSeed places the single allowed type somewhere in [1,8]x[1,8].
function boundedWorld() {
  return {
    id: 'world-1', levelMin: 1, levelMax: 5, width: 10, height: 10,
    tileTypes: { grass: { walkable: true, speed: 1 } },
  };
}

function scriptedFieldClient({ entityTypeRows = [{ id: 7, name: 'Wolf', hp: 30, defense: 2, resistances: {} }], creatureId = 'guard-1', chestId = 'chest-1' } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM entity_types/i.test(sql)) return { rows: entityTypeRows, rowCount: entityTypeRows.length };
      if (/INSERT INTO world_creatures/i.test(sql)) return { rows: [{ id: creatureId }], rowCount: 1 };
      if (/INSERT INTO world_chests/i.test(sql)) {
        return {
          rows: [{
            id: chestId, world_id: params[0], x: params[1], y: params[2], kind: 'field',
            guard_entity_type_id: params[3], guard_level: params[4],
            guard_creature_ids: JSON.parse(params[5]), state: 'locked',
            opened_at: null, respawn_at: null, created_at: '2026-01-01T00:00:00Z',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('spawnFieldChest returns null when placeMapCreatures finds no legal tile', async () => {
  const client = scriptedFieldClient();
  const result = await spawnFieldChest(client, unboundedWorld(), ['Wolf'], 42);
  assert.equal(result, null);
  // Only the entity_types resolve should have run -- an unbounded world must
  // short-circuit before any INSERT is attempted.
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].sql, /FROM entity_types/i);
});

test('spawnFieldChest rejects when none of the allowed guard types exist', async () => {
  const client = scriptedFieldClient({ entityTypeRows: [] });
  await assert.rejects(
    () => spawnFieldChest(client, boundedWorld(), ['Nope'], 42),
    /none of the allowed guard types exist/,
  );
});

test('spawnFieldChest places a guard, inserts a locked field chest referencing it, and returns a fetchChests-shaped row', async () => {
  const client = scriptedFieldClient();
  const result = await spawnFieldChest(client, boundedWorld(), ['Wolf'], 42);

  assert.equal(result.id, 'chest-1');
  assert.equal(result.guardCreatureId, 'guard-1');
  // Same camelCase shape fetchChests produces -- entry.chests must never mix
  // shapes, since a field chest pushed straight from this call sits next to
  // vault chests loaded through fetchChests.
  assert.deepEqual(Object.keys(result.row).sort(), [
    'guardCreatureIds', 'guardEntityTypeId', 'guardLevel', 'id', 'kind', 'openedAt', 'respawnAt', 'state', 'x', 'y',
  ].sort());
  assert.equal(result.row.kind, 'field');
  assert.equal(result.row.state, 'locked');
  assert.deepEqual(result.row.guardCreatureIds, ['guard-1']);

  const creatureIns = client.calls.find((c) => /INSERT INTO world_creatures/i.test(c.sql));
  assert.doesNotMatch(creatureIns.sql, /resistances/, 'world_creatures has no resistances column');
  assert.equal(creatureIns.params[0], 'world-1');
  assert.equal(creatureIns.params[1], 'Wolf');

  const chestIns = client.calls.find((c) => /INSERT INTO world_chests/i.test(c.sql));
  assert.match(chestIns.sql, /'field'/);
});

// respawnDueFieldChests: sweeps past-due field chests back to locked with a
// fresh guard. `getWorld` stands in for server.js's real wiring, which only
// resolves currently-loaded worlds (see chests.js's header comment on this
// function) -- boundedWorld()/unboundedWorld() above already give this file
// the two world shapes needed to exercise "places fine" vs "no legal tile".

function scriptedRespawnClient({
  dueRows = [{
    id: 'c1', world_id: 'w1', x: 100, y: 100, guard_entity_type_id: 5,
  }],
  entityTypeRows = [{
    id: 5, name: 'Wolf', hp: 30, defense: 2, resistances: {},
  }],
  guardId = 'guard-2',
} = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT .* FROM world_chests WHERE kind = 'field'/i.test(sql)) {
        return { rows: dueRows, rowCount: dueRows.length };
      }
      if (/SELECT .* FROM entity_types WHERE id = \$1/i.test(sql)) {
        return { rows: entityTypeRows, rowCount: entityTypeRows.length };
      }
      if (/INSERT INTO world_creatures/i.test(sql)) return { rows: [{ id: guardId }], rowCount: 1 };
      if (/UPDATE world_chests SET state = 'locked'/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('respawnDueFieldChests resets a past-due field chest to locked with a fresh guard', async () => {
  const client = scriptedRespawnClient();
  const reset = await respawnDueFieldChests(client, { getWorld: async () => boundedWorld() });
  assert.equal(reset, 1);

  // The query filtering to due chests must scope to field chests only --
  // vault chests never carry a respawn_at, so this WHERE clause is what
  // "leaves vault chests alone" actually means (nothing app-level to check).
  const dueQuery = client.calls.find((c) => /FROM world_chests WHERE kind = 'field'/i.test(c.sql));
  assert.ok(dueQuery, 'must filter to field chests at the DB level');

  const guardIns = client.calls.find((c) => /INSERT INTO world_creatures/i.test(c.sql));
  assert.doesNotMatch(guardIns.sql, /resistances/, 'world_creatures has no resistances column');
  assert.equal(guardIns.params[0], 'w1');
  assert.equal(guardIns.params[1], 'Wolf');

  const update = client.calls.find((c) => /UPDATE world_chests SET state = 'locked'/i.test(c.sql));
  assert.match(update.sql, /opened_at = NULL/);
  assert.match(update.sql, /respawn_at = NULL/);
  assert.deepEqual(JSON.parse(update.params[0]), ['guard-2']);
  assert.equal(update.params[2], 'c1');
});

test('respawnDueFieldChests skips a due chest whose guard entity type was deleted from the catalog, leaving it for manual cleanup', async () => {
  const client = scriptedRespawnClient({ entityTypeRows: [] });
  const reset = await respawnDueFieldChests(client, { getWorld: async () => boundedWorld() });
  assert.equal(reset, 0);
  assert.ok(!client.calls.some((c) => /INSERT INTO world_creatures/i.test(c.sql)), 'no guard spawned for a deleted entity type');
});

test('respawnDueFieldChests leaves a chest past-due when no legal tile exists this pass, retried on a later sweep', async () => {
  const client = scriptedRespawnClient();
  const reset = await respawnDueFieldChests(client, { getWorld: async () => unboundedWorld() });
  assert.equal(reset, 0);
  assert.ok(!client.calls.some((c) => /INSERT INTO world_creatures/i.test(c.sql)));
});

test('respawnDueFieldChests skips a chest whose owning world is not currently loaded, retried on a later sweep', async () => {
  const client = scriptedRespawnClient();
  const reset = await respawnDueFieldChests(client, { getWorld: async () => null });
  assert.equal(reset, 0);
  assert.ok(!client.calls.some((c) => /INSERT INTO world_creatures/i.test(c.sql)));
});

test('respawnDueFieldChests is a no-op when nothing is past-due', async () => {
  const client = scriptedRespawnClient({ dueRows: [] });
  const reset = await respawnDueFieldChests(client, { getWorld: async () => boundedWorld() });
  assert.equal(reset, 0);
  assert.equal(client.calls.length, 1, 'only the initial due-chests query should run');
});

test('respawnDueFieldChests keeps resetting later chests after an earlier one in the same sweep throws', async () => {
  const dueRows = [
    { id: 'c1', world_id: 'w1', x: 100, y: 100, guard_entity_type_id: 5 },
    { id: 'c2', world_id: 'w1', x: 200, y: 200, guard_entity_type_id: 5 },
  ];
  const client = scriptedRespawnClient({ dueRows });
  let getWorldCalls = 0;
  const reset = await respawnDueFieldChests(client, {
    getWorld: async () => {
      getWorldCalls += 1;
      if (getWorldCalls === 1) throw new Error('boom');
      return boundedWorld();
    },
  });
  assert.equal(reset, 1, 'one failure must not abort the whole sweep');
});
