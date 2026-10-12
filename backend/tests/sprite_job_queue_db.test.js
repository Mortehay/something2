const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const queue = require('../src/services/spriteJobQueue.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

// The single-entity generators (/api/sprite-jobs, /api/entity-jobs) insert
// sprite_sets rows as 'queued' with no entity_type_id and only ever move them
// to 'approved'. Every unapproved generation therefore sits at 'queued'
// forever -- 21 of them on the dev database when this was written. Those rows
// were already drawn; the batch must not claim them, or the first "Start
// batch" regenerates every one of them (with an empty base_prompt) before it
// reaches anything the admin queued.
//
// One transaction, rolled back: claim() is not scoped to a tag, so the rows are
// dated before anything a real database holds, which puts them first in the
// claim order without depending on what else is queued.
test('claim skips orphaned single-entity rows and takes the batch row', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [entity] } = await client.query(
      `SELECT e.id FROM entity_types e
        WHERE NOT EXISTS (SELECT 1 FROM sprite_sets s
                           WHERE s.entity_type_id = e.id AND s.status IN ('queued','running'))
        ORDER BY e.id LIMIT 1`,
    );
    assert.ok(entity, 'precondition: an entity type with no live sprite job');

    await client.query(
      `INSERT INTO sprite_sets (creature, backend, seed, frames, job_id, status, created_at)
       VALUES ('orphan-claim-test', 'stub', 1, 4, 'orphan-job', 'queued', '1970-01-01')`,
    );
    const { rows: [mine] } = await client.query(
      `INSERT INTO sprite_sets (entity_type_id, creature, generation_kind, base_prompt,
                                backend, seed, frames, status, created_at)
       VALUES ($1, 'batch-claim-test', 'creature', 'a wolf', 'auto', 1, 4, 'queued', '1970-01-02')
       RETURNING id`,
      [entity.id],
    );

    const claimed = await queue.claim(client);

    assert.equal(claimed && claimed.id, mine.id);
    assert.equal(claimed.status, 'running');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
