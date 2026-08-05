// backend/tests/dungeon_guards.test.js
const test = require('node:test');
const assert = require('node:assert');
const { insertPortalGuards } = require('../src/services/dungeonGuards.js');

function fakeDb() {
  const inserted = [];
  return {
    inserted,
    async query(sql, params) {
      if (/^\s*INSERT INTO world_creatures/i.test(sql)) {
        const [worldId, type, x, y, hp, facing, homeX, homeY, blocksPortalId] = params;
        inserted.push({ worldId, type, x, y, hp, facing, homeX, homeY, blocksPortalId });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test('inserts exactly `count` guards, each anchored to the portal tile', async () => {
  const db = fakeDb();
  await insertPortalGuards(db, 'world-1', 'link-1', 1050, 1050, 'Orc', 3);
  assert.equal(db.inserted.length, 3);
  for (const row of db.inserted) {
    assert.equal(row.worldId, 'world-1');
    assert.equal(row.type, 'Orc');
    assert.equal(row.homeX, 1050);
    assert.equal(row.homeY, 1050);
    assert.equal(row.blocksPortalId, 'link-1');
  }
});

test('a single guard is placed exactly on the portal tile', async () => {
  const db = fakeDb();
  await insertPortalGuards(db, 'world-1', 'link-1', 1050, 1050, 'Orc', 1);
  assert.equal(db.inserted.length, 1);
  assert.equal(db.inserted[0].x, 1050);
  assert.equal(db.inserted[0].y, 1050);
});

test('a pack of guards is spread around the portal tile, not stacked on it', async () => {
  const db = fakeDb();
  await insertPortalGuards(db, 'world-1', 'link-1', 1050, 1050, 'Orc', 3);
  const positions = new Set(db.inserted.map((r) => `${r.x},${r.y}`));
  assert.equal(positions.size, 3, 'a pack must not spawn stacked on the identical tile');
});
