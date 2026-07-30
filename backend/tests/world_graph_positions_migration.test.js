const test = require('node:test');
const assert = require('node:assert');

// Records the DDL calls node-pg-migrate would make, so the migration's shape
// is asserted without a live database (same pattern as
// migration_worlds_name_unique.test.js / bounded_worlds_migration.test.js).
function fakePgm() {
  const calls = { addColumns: [], dropColumns: [] };
  return {
    calls,
    addColumns: (table, cols) => calls.addColumns.push({ table, cols }),
    dropColumns: (table, cols) => calls.dropColumns.push({ table, cols }),
  };
}

const mig = require('../migrations/1714440044000_world_graph_positions.js');

test('up adds graph_x/graph_y as nullable double precision columns on worlds, and nothing else', () => {
  const pgm = fakePgm();
  mig.up(pgm);

  assert.equal(pgm.calls.addColumns.length, 1);
  const { table, cols } = pgm.calls.addColumns[0];
  assert.equal(table, 'worlds');
  assert.deepEqual(Object.keys(cols).sort(), ['graph_x', 'graph_y']);
  for (const col of ['graph_x', 'graph_y']) {
    assert.equal(cols[col].type, 'double precision');
    assert.equal(cols[col].notNull, false);
  }

  assert.equal(pgm.calls.dropColumns.length, 0);
});

test('down drops exactly graph_x and graph_y from worlds', () => {
  const pgm = fakePgm();
  mig.down(pgm);

  assert.equal(pgm.calls.dropColumns.length, 1);
  const { table, cols } = pgm.calls.dropColumns[0];
  assert.equal(table, 'worlds');
  assert.deepEqual([...cols].sort(), ['graph_x', 'graph_y']);

  assert.equal(pgm.calls.addColumns.length, 0);
});

// The branch's headline invariant -- a node drag must never invalidate
// terrain -- is otherwise only pinned at the route level (graph-position PUT
// touches only worlds.graph_x/graph_y). Pin it here too: this migration must
// never touch world_chunks, up or down.
test('touches only the worlds table -- never world_chunks -- in either direction', () => {
  const up = fakePgm();
  mig.up(up);
  const down = fakePgm();
  mig.down(down);

  for (const { table } of [...up.calls.addColumns, ...up.calls.dropColumns,
    ...down.calls.addColumns, ...down.calls.dropColumns]) {
    assert.equal(table, 'worlds');
  }
});
