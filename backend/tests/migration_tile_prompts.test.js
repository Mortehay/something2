const test = require('node:test');
const assert = require('node:assert');

// Records the DDL calls node-pg-migrate would make, so we can assert the
// migration's shape without a live database (same pattern as
// migration_world_players.test.js).
function fakePgm() {
  const calls = { addColumns: [], sql: [], dropColumns: [] };
  return {
    calls,
    addColumns: (name, cols) => calls.addColumns.push({ name, cols }),
    dropColumns: (name, cols) => calls.dropColumns.push({ name, cols }),
    sql: (s) => calls.sql.push(s),
    func: (x) => ({ raw: x }),
  };
}

const mig = require('../migrations/1714440026000_tile_prompts_sprite.js');
const NAMES = ['grass', 'highgrass', 'leafs', 'sand', 'rocks', 'earth',
  'dirt', 'snow', 'ice', 'swamp', 'water'];

test('up adds prompt, sprite, render_mode with correct types and defaults', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  assert.equal(pgm.calls.addColumns.length, 1);
  const { name, cols } = pgm.calls.addColumns[0];
  assert.equal(name, 'tile_types');
  assert.equal(cols.prompt.type, 'text');
  assert.equal(cols.prompt.notNull, true);
  assert.equal(cols.prompt.default, '');
  assert.equal(cols.sprite.type, 'jsonb');
  assert.equal(cols.sprite.notNull, false);
  assert.equal(cols.render_mode.type, 'text');
  assert.equal(cols.render_mode.notNull, true);
  assert.equal(cols.render_mode.default, 'color');
});

test('seeds a non-empty base prompt for each of the 11 named tiles', () => {
  assert.equal(Object.keys(mig.TILE_PROMPTS).length, 11);
  for (const n of NAMES) {
    assert.ok(mig.TILE_PROMPTS[n] && mig.TILE_PROMPTS[n].length > 0,
      `missing prompt for ${n}`);
  }
  const pgm = fakePgm();
  mig.up(pgm);
  for (const n of NAMES) {
    const stmt = pgm.calls.sql.find(
      (s) => /SET prompt =/.test(s) && s.includes(`WHERE name = '${n}'`));
    assert.ok(stmt, `no seed UPDATE for ${n}`);
  }
});

test('down drops the three columns', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.deepEqual(pgm.calls.dropColumns[0],
    { name: 'tile_types', cols: ['prompt', 'sprite', 'render_mode'] });
});
