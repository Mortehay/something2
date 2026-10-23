const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../migrations/1714440826000_sprite_concepts.js');

function capture(fn) {
  const sql = [];
  fn({ sql: (text) => sql.push(text) });
  return sql.join('\n');
}

test('concepts migration creates the table, the per-subject unique index and the note column', () => {
  const up = capture(migration.up);
  assert.match(up, /CREATE TABLE IF NOT EXISTS sprite_concepts/);
  assert.match(up, /entity_type_id int NOT NULL REFERENCES entity_types\(id\) ON DELETE CASCADE/);
  assert.match(up, /appearance_variant smallint/);
  assert.match(up, /concept_key text NOT NULL/);
  assert.match(up, /box_concept_path text NOT NULL/);
  assert.match(up, /box_origin text NOT NULL/);
  assert.match(up, /CREATE UNIQUE INDEX IF NOT EXISTS sprite_concepts_one_per_subject\s+ON sprite_concepts \(entity_type_id, COALESCE\(appearance_variant, 0\)\)/);
  assert.match(up, /ADD COLUMN IF NOT EXISTS note text/);
});

test('concepts migration down drops the note column, the index and the table', () => {
  const down = capture(migration.down);
  assert.match(down, /DROP COLUMN IF EXISTS note\b/);
  assert.match(down, /DROP INDEX IF EXISTS sprite_concepts_one_per_subject/);
  assert.match(down, /DROP TABLE IF EXISTS sprite_concepts/);
});
