const test = require('node:test');
const assert = require('node:assert');

// Records the DDL calls node-pg-migrate would make, so we can assert the
// migration shape without a live database.
function fakePgm() {
  const calls = { createTable: [], addConstraint: [] };
  return {
    calls,
    createTable: (name, cols, opts) => calls.createTable.push({ name, cols, opts }),
    addConstraint: (name, cn, opts) => calls.addConstraint.push({ name, cn, opts }),
    dropTable: () => {},
    sql: () => {},
    func: (x) => ({ raw: x }),
  };
}

test('world_players migration creates the table with the expected columns', () => {
  const mig = require('../migrations/1714440015000_create_world_players.js');
  assert.equal(typeof mig.up, 'function');
  assert.equal(typeof mig.down, 'function');

  const pgm = fakePgm();
  mig.up(pgm);

  assert.equal(pgm.calls.createTable.length, 1);
  const t = pgm.calls.createTable[0];
  assert.equal(t.name, 'world_players');
  for (const col of ['world_id', 'user_id', 'x', 'y', 'updated_at']) {
    assert.ok(t.cols[col], `missing column ${col}`);
  }
  // Composite PK on (world_id, user_id).
  assert.deepEqual(t.opts.constraints.primaryKey, ['world_id', 'user_id']);
});
