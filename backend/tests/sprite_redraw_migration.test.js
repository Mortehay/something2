const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../migrations/1714440825000_sprite_sets_redraw.js');

function capture(fn) {
  const sql = [];
  fn({ sql: (text) => sql.push(text) });
  return sql.join('\n');
}

test('redraw migration adds the three columns, with the self reference', () => {
  const up = capture(migration.up);
  assert.match(up, /ADD COLUMN IF NOT EXISTS redraw_of uuid REFERENCES sprite_sets\(id\) ON DELETE SET NULL/);
  assert.match(up, /ADD COLUMN IF NOT EXISTS redraw_frames jsonb/);
  assert.match(up, /ADD COLUMN IF NOT EXISTS box_task_id text/);
});

test('redraw migration down drops all three columns', () => {
  const down = capture(migration.down);
  for (const col of ['redraw_of', 'redraw_frames', 'box_task_id']) {
    assert.match(down, new RegExp(`DROP COLUMN IF EXISTS ${col}\\b`));
  }
});
