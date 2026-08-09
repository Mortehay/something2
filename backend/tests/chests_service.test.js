const test = require('node:test');
const assert = require('node:assert');
const { insertVaultChest } = require('../src/services/chests.js');

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
