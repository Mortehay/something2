const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../migrations/1714440690000_sprite_batch_queue.js');

function fakePgm() {
  const calls = { addColumns: [], addConstraint: [], createIndex: [], dropColumns: [] };
  return {
    calls,
    addColumns: (table, columns) => calls.addColumns.push({ table, columns }),
    addConstraint: (table, name, check) => calls.addConstraint.push({ table, name, check }),
    createIndex: (table, columns, options) => calls.createIndex.push({ table, columns, options }),
    dropIndex: () => {},
    dropConstraint: () => {},
    dropColumns: (table, columns) => calls.dropColumns.push({ table, columns }),
    func: (value) => ({ raw: value }),
  };
}

test('sprite batch migration adds durable request, result and claim fields', () => {
  const pgm = fakePgm();
  migration.up(pgm);
  const columns = pgm.calls.addColumns[0].columns;
  for (const name of [
    'generation_kind', 'base_prompt', 'provider_id', 'image_key', 'attempts',
    'last_error', 'claimed_at', 'updated_at',
  ]) assert.ok(columns[name], `missing ${name}`);
  assert.equal(columns.provider_id.references, 'ai_providers');
});

test('sprite batch migration prevents two live jobs for one entity', () => {
  const pgm = fakePgm();
  migration.up(pgm);
  const index = pgm.calls.createIndex.find((call) => call.options?.name === 'sprite_sets_one_live_per_entity');
  assert.equal(index.options.unique, true);
  assert.match(index.options.where, /queued.*running/);
});

