// Sprite prompt regeneration schema (1714440881000).
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;

test('new flags default to false on sprite_sets, effect_sprite_jobs and sprite_concepts; sprite_concepts.prompt is null', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [e] } = await client.query(
      `INSERT INTO entity_types (name, color, walkable, spawn_tiles, chance)
       VALUES ($1, '#000000', true, '[]'::jsonb, 0) RETURNING id`, [`zz_mig_${process.pid}_${Date.now()}`]);
    const { rows: [s] } = await client.query(
      "INSERT INTO sprite_sets (creature, backend, entity_type_id) VALUES ('zz', 'stub', $1) RETURNING regenerate_concept, needs_prompt", [e.id]);
    assert.deepStrictEqual(s, { regenerate_concept: false, needs_prompt: false });
    const { rows: [j] } = await client.query(
      `INSERT INTO effect_sprite_jobs (subject_kind, subject_name, prompt, kind, frames, size, loop, blend, seed, status)
       VALUES ('vfx', 'zzmigregen', 'a flame', 'burst', 8, 64, false, 'additive', 1, 'done') RETURNING needs_prompt`);
    assert.deepStrictEqual(j, { needs_prompt: false });
    const { rows: [c] } = await client.query(
      `INSERT INTO sprite_concepts (entity_type_id, concept_key, box_concept_path, box_origin)
       VALUES ($1, 'k', '/p.png', 'http://box:1') RETURNING regenerated, prompt`, [e.id]);
    assert.deepStrictEqual(c, { regenerated: false, prompt: null });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});

test("art_prompt_descriptions.origin accepts NULL and 'sprite' and rejects 'art'", { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  const ins = (origin) => client.query(
    `INSERT INTO art_prompt_descriptions (subject_kind, subject_key, text, active, origin)
     VALUES ('item', $1, 't', false, $2) RETURNING origin`, [`ds_mig_${Math.random()}`, origin]);
  try {
    await client.query('BEGIN');
    assert.equal((await ins(null)).rows[0].origin, null);
    assert.equal((await ins('sprite')).rows[0].origin, 'sprite');
    await client.query('SAVEPOINT s');
    await assert.rejects(ins('art'), (err) => err.code === '23514');
    await client.query('ROLLBACK TO s');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
