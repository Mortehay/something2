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

// Two defs that both always match 'grass' but disagree on walkable.
// generateChunkDecorations resolves a shared tile with a seeded WEIGHTED pick
// that iterates the defs in ARRAY ORDER (cumulative subtraction), so which def
// wins a given tile depends on that order — which is why the two callers must
// query with the same ORDER BY. `id` mirrors the DB column it sorts by.
const BLOCKER = { id: 1, name: 'Blocker', walkable: false, spawn_tiles: ['grass'], chance: 1 };
const PASSABLE = { id: 2, name: 'Passable', walkable: true, spawn_tiles: ['grass'], chance: 1 };

test('def order changes which type wins on a shared tile (parity needs a stable order)', () => {
  const w = world();
  const tiles = generateChunk(w, 0, 0);

  const blockerFirst = generateChunkDecorations(w, 0, 0, tiles, [BLOCKER, PASSABLE]);
  const passableFirst = generateChunkDecorations(w, 0, 0, tiles, [PASSABLE, BLOCKER]);

  assert.ok(blockerFirst.length > 0, 'fixture should place at least one decoration');
  assert.ok(passableFirst.length > 0, 'fixture should place at least one decoration');

  // Same tiles get decorated either way (the density + fill gates are
  // order-independent; only the type PICK depends on def order)...
  const keyOf = (d) => `${d.row},${d.col}`;
  assert.deepEqual(blockerFirst.map(keyOf).sort(), passableFirst.map(keyOf).sort());

  // ...but the weighted pick is order-sensitive: at least one tile disagrees on
  // name/blocking between the two orders. So the /chunk and authority callers
  // MUST query with the same ORDER BY or client-render and server-collision
  // would diverge (rubber-banding). This is what services/decorationDefs.js fixes.
  const bfByKey = new Map(blockerFirst.map((d) => [keyOf(d), d]));
  const disagreements = passableFirst.filter((d) => bfByKey.get(keyOf(d)).name !== d.name);
  assert.ok(disagreements.length > 0, 'expected def order to change at least one tile\'s pick');
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
