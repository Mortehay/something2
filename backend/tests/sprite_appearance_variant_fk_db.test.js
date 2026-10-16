// sprite_sets.appearance_variant must name a real character_appearances row:
// a composite FK on (entity_type_id, appearance_variant). A NULL variant is a
// plain entity job and is not checked (MATCH SIMPLE).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

test('sprite_sets (entity_type_id, appearance_variant) references character_appearances', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const { rows: [fk] } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'sprite_sets'::regclass AND contype = 'f'
        AND confrelid = 'character_appearances'::regclass`,
  );
  assert.ok(fk, 'expected an FK from sprite_sets to character_appearances');
  assert.match(fk.def, /FOREIGN KEY \(entity_type_id, appearance_variant\) REFERENCES character_appearances\(entity_type_id, variant\)/);

  // Behaviour, not just catalog text: an entity with no appearance rows cannot
  // carry a variant job, inside a rolled-back transaction.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [orphan] } = await client.query(
      `SELECT e.id FROM entity_types e
        WHERE NOT EXISTS (SELECT 1 FROM character_appearances ca WHERE ca.entity_type_id = e.id)
        LIMIT 1`,
    );
    assert.ok(orphan, 'precondition: an entity type without appearance rows');
    await assert.rejects(
      client.query(
        `INSERT INTO sprite_sets (entity_type_id, appearance_variant, creature, generation_kind, base_prompt, backend, seed, frames, status)
         VALUES ($1, 1, 'fk-test', 'creature', 'x', 'auto', 1, 4, 'failed')`,
        [orphan.id],
      ),
      (err) => err.code === '23503',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
