const test = require('node:test');
const assert = require('node:assert');

function fakePgm() {
  const calls = { createTable: [], dropTable: [], addConstraint: [], createIndex: [] };
  return {
    calls,
    createTable: (name, cols, opts) => calls.createTable.push({ name, cols, opts }),
    dropTable: (name) => calls.dropTable.push(name),
    addConstraint: (name, cname, expr) => calls.addConstraint.push({ name, cname, expr }),
    createIndex: (name, cols) => calls.createIndex.push({ name, cols }),
    func: (x) => ({ raw: x }),
  };
}

const mig = require('../migrations/1714440150000_world_chests.js');

test('up creates world_chests with the full lifecycle column set', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const t = pgm.calls.createTable.find((c) => c.name === 'world_chests');
  assert.ok(t, 'world_chests not created');
  const c = t.cols;
  assert.equal(c.world_id.references, 'worlds');
  assert.equal(c.world_id.onDelete, 'CASCADE');
  assert.equal(c.guard_entity_type_id.references, 'entity_types');
  assert.equal(c.state.default, 'locked');
  assert.equal(c.guard_creature_ids.type, 'jsonb');
  assert.equal(c.guard_creature_ids.default, '[]');
  assert.equal(c.opened_at.notNull, undefined, 'opened_at must be nullable — unopened chests have none');
  assert.equal(c.respawn_at.notNull, undefined, 'respawn_at must be nullable — vault chests never respawn');
});

test('kind and state are CHECK-constrained to exactly the spec vocabulary', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const kind = pgm.calls.addConstraint.find((c) => /kind/.test(c.cname));
  assert.match(kind.expr, /'vault'/);
  assert.match(kind.expr, /'field'/);
  const state = pgm.calls.addConstraint.find((c) => /state/.test(c.cname));
  for (const s of ['locked', 'unlocked', 'opened']) {
    assert.match(state.expr, new RegExp(`'${s}'`), `state CHECK omits ${s}`);
  }
});

test('indexes (world_id, state) for the respawn sweep and marker queries', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const idx = pgm.calls.createIndex.find((c) => c.name === 'world_chests');
  assert.deepEqual(idx.cols, ['world_id', 'state']);
});

test('down drops the table', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.deepEqual(pgm.calls.dropTable, ['world_chests']);
});
