const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const queue = require('../src/services/spriteJobQueue.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

// SOMET-702: base lookup + reuse_base_id persistence. One transaction, rolled back.
test('reuseBaseCandidates: only finished gpu-box creature sheets of the subject, newest first; attachBox records reuse_base_id', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [entity] } = await client.query(
      'SELECT entity_type_id AS id FROM character_appearances WHERE variant = 2 ORDER BY entity_type_id LIMIT 1',
    );
    assert.ok(entity, 'precondition: an entity type with appearance variant 2');
    // Isolate the subject from whatever the database already holds.
    await client.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [entity.id]);
    const ins = async (over) => {
      const r = {
        variant: null, status: 'done', backend: 'gpu-box', kind: 'creature', atlas: 'a', manifest: 'm', concept: 'c', at: '2026-01-01', ...over,
      };
      const { rows: [row] } = await client.query(
        `INSERT INTO sprite_sets (entity_type_id, appearance_variant, creature, generation_kind, base_prompt, backend, seed, frames,
                                  status, atlas_key, manifest_key, concept_key, updated_at)
         VALUES ($1, $2, 'reuse-base-test', $3, 'x', $4, 1, 2, $5, $6, $7, $8, $9) RETURNING id`,
        [entity.id, r.variant, r.kind, r.backend, r.status, r.atlas, r.manifest, r.concept, r.at],
      );
      return row.id;
    };
    const older = await ins({ at: '2026-01-01' });
    const newest = await ins({ at: '2026-03-01', status: 'approved' });
    await ins({ at: '2026-04-01', status: 'failed' });
    await ins({ at: '2026-04-02', backend: 'auto' });
    await ins({ at: '2026-04-03', kind: 'object' });
    await ins({ at: '2026-04-04', atlas: null });
    await ins({ at: '2026-04-05', manifest: null });
    await ins({ at: '2026-04-06', concept: null });
    await ins({ at: '2026-04-07', variant: 2 });

    const found = await queue.reuseBaseCandidates(client, { entityTypeId: entity.id, variant: null });
    assert.deepEqual(found.map((r) => r.id), [newest, older]);
    const excl = await queue.reuseBaseCandidates(client, { entityTypeId: entity.id, variant: null, excludeId: newest });
    assert.deepEqual(excl.map((r) => r.id), [older]);
    const v2 = await queue.reuseBaseCandidates(client, { entityTypeId: entity.id, variant: 2 });
    assert.equal(v2.length, 1);

    const { rows: [mine] } = await client.query(
      `INSERT INTO sprite_sets (entity_type_id, creature, generation_kind, base_prompt, backend, seed, frames, status)
       VALUES ($1, 'reuse-base-test', 'creature', 'x', 'gpu-box', 1, 2, 'running') RETURNING id`, [entity.id],
    );
    const a = await queue.attachBox(client, mine.id, { boxJobId: 'b1', conceptKey: 'k', providerId: null, reuseBaseId: older });
    assert.equal(a.reuse_base_id, older);
    // A later full-sheet attach clears it.
    const b = await queue.attachBox(client, mine.id, { boxJobId: 'b2', conceptKey: 'k', providerId: null });
    assert.equal(b.reuse_base_id, null);
    assert.equal((await queue.reuseBaseById(client, older)).id, older);
    assert.equal(await queue.reuseBaseById(client, '00000000-0000-0000-0000-000000000000'), null);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
