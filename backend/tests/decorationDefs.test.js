const test = require('node:test');
const assert = require('node:assert');
const { loadDecorationDefs } = require('../src/services/decorationDefs');
const { generateChunk, generateChunkDecorations } = require('../src/services/mapService');

// Contract: the ONE shared decoration-def loader (imported by both
// index.js's /chunk handler and authority/server.js's loadWorld) must query
// with a stable ORDER BY. generateChunkDecorations resolves overlapping defs
// by array order (first spawn_tiles match wins, via `break`), so an
// unordered query lets Postgres row order -- which is NOT guaranteed stable,
// and can be perturbed by unrelated UPDATEs to the same heap -- silently
// change which def wins on a shared tile between the REST preview and the
// authority's cached copy. See services/decorationDefs.js for the full story.
test('loadDecorationDefs queries with a stable ORDER BY id', async () => {
  let capturedSql = null;
  const pool = {
    query: async (sql) => {
      capturedSql = sql;
      return { rows: [] };
    },
  };
  await loadDecorationDefs(pool);
  assert.ok(capturedSql, 'loadDecorationDefs must call pool.query');
  assert.match(capturedSql, /ORDER BY id/i);
});

// A small single-terrain world so every tile in the chunk is a candidate.
function world(overrides = {}) {
  return {
    seed: 12345, chunkSize: 8, width: 8, height: 8,
    tileTypes: { grass: { walkable: true, speed: 1 } },
    ...overrides,
  };
}

// Two defs that both always match 'grass' (chance: 1 => threshold 0) but
// disagree on walkable. Whichever def comes FIRST in the array wins for
// every eligible tile in generateChunkDecorations (break-on-first-match).
// `id` mirrors the DB column loadDecorationDefs sorts by.
const BLOCKER = { id: 1, name: 'Blocker', walkable: false, spawn_tiles: ['grass'], chance: 1 };
const PASSABLE = { id: 2, name: 'Passable', walkable: true, spawn_tiles: ['grass'], chance: 1 };

test('def order changes which walkable flag wins on an overlapping tile (documents the bug)', () => {
  const w = world();
  const tiles = generateChunk(w, 0, 0);

  const blockerFirst = generateChunkDecorations(w, 0, 0, tiles, [BLOCKER, PASSABLE]);
  const passableFirst = generateChunkDecorations(w, 0, 0, tiles, [PASSABLE, BLOCKER]);

  assert.ok(blockerFirst.length > 0, 'fixture should place at least one decoration');
  assert.ok(passableFirst.length > 0, 'fixture should place at least one decoration');

  // Same tiles get decorated either way (fill-check is per-tile, not per-def)...
  const keyOf = (d) => `${d.row},${d.col}`;
  assert.deepEqual(blockerFirst.map(keyOf).sort(), passableFirst.map(keyOf).sort());

  // ...but EVERY one of them disagrees on name/blocking depending on array order.
  assert.ok(blockerFirst.every((d) => d.name === 'Blocker' && d.blocking === true));
  assert.ok(passableFirst.every((d) => d.name === 'Passable' && d.blocking === false));
  assert.notDeepEqual(blockerFirst, passableFirst);
});

test('sorting both def arrays by id (what ORDER BY id gives the callers) normalizes the result', () => {
  const w = world();
  const tiles = generateChunk(w, 0, 0);

  const byId = (a, b) => a.id - b.id;
  const fromBlockerFirst = generateChunkDecorations(
    w, 0, 0, tiles, [BLOCKER, PASSABLE].slice().sort(byId),
  );
  const fromPassableFirst = generateChunkDecorations(
    w, 0, 0, tiles, [PASSABLE, BLOCKER].slice().sort(byId),
  );

  assert.deepEqual(fromBlockerFirst, fromPassableFirst);
});
