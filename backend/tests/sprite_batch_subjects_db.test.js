// Real-HTTP, real-DB coverage for GET /api/sprite-admin/subjects: a playable
// class must list as its own base row PLUS one row per character_appearances
// variant (SOMET: appearance-variant directional sprites), not just the base
// row the console showed before.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

test('GET /api/sprite-admin/subjects lists each playable class plus one row per appearance variant', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);

  const username = `sprite-subjects-admin-${Math.random().toString(36).slice(2)}`;
  const { rows: [admin] } = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', 'admin'],
  );
  t.after(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await pool.end();
  });
  const AUTH = ['Authorization', `Bearer ${signToken({
    userId: admin.id, username, role: 'admin', tokenVersion: admin.token_version,
  })}`];

  const { rows: [cls] } = await pool.query(
    `SELECT e.id, e.name, count(ca.variant)::int AS n
       FROM entity_types e JOIN character_appearances ca ON ca.entity_type_id = e.id
      WHERE e.is_playable = true GROUP BY e.id, e.name ORDER BY e.id LIMIT 1`,
  );
  assert.ok(cls, 'precondition: a playable class with seeded appearance variants');

  const res = await request(app).get('/api/sprite-admin/subjects').set(...AUTH);
  assert.equal(res.status, 200);

  const base = res.body.subjects.find((s) => s.id === cls.id);
  assert.ok(base, 'the class itself must still list as its own base row');
  assert.equal(base.variant, null);

  const variants = res.body.subjects.filter((s) => s.variant != null && s.entity_id === cls.id);
  assert.equal(variants.length, cls.n, 'one row per character_appearances variant');
  assert.deepEqual(variants.map((v) => v.variant).sort((a, b) => a - b),
    Array.from({ length: cls.n }, (_, i) => i + 1));
  for (const v of variants) {
    assert.equal(v.id, `${cls.id}:${v.variant}`);
    assert.equal(v.is_playable, true);
    assert.ok(v.name.includes(cls.name));
  }

  // Grouped under their class: the console renders /subjects in order, so the
  // variants must sit directly after the class's own row, in variant order.
  const at = res.body.subjects.findIndex((s) => s.id === cls.id);
  assert.deepEqual(
    res.body.subjects.slice(at + 1, at + 1 + cls.n).map((s) => s.id),
    Array.from({ length: cls.n }, (_, i) => `${cls.id}:${i + 1}`),
  );

  // The Prompt column shows what will actually be generated for the variant,
  // not the class's own prompt.
  const { appearancePrompt } = require('../src/services/catalogSubjects.js');
  const { rows: [classRow] } = await pool.query('SELECT name, prompt FROM entity_types WHERE id = $1', [cls.id]);
  for (const v of variants) {
    assert.equal(v.prompt, appearancePrompt({ class_name: classRow.name, class_prompt: classRow.prompt, variant: v.variant }));
  }
});

test('subjects carry concept_key and actions from the newest job', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const username = `sprite-subjects-admin-${Math.random().toString(36).slice(2)}`;
  const { rows: [admin] } = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', 'admin'],
  );
  const { rows: [ent] } = await pool.query(
    "INSERT INTO entity_types (name, prompt, color) VALUES ($1, 'a test prop', '#888888') RETURNING id",
    [`subj-test-${Math.random().toString(36).slice(2)}`],
  );
  t.after(async () => {
    await pool.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [ent.id]);
    await pool.query('DELETE FROM entity_types WHERE id = $1', [ent.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await pool.end();
  });
  const AUTH = ['Authorization', `Bearer ${signToken({
    userId: admin.id, username, role: 'admin', tokenVersion: admin.token_version,
  })}`];
  await pool.query(
    `INSERT INTO sprite_sets (entity_type_id, creature, backend, status, actions, directions,
                              frames_per_action, concept_key, box_job_id, manifest_key, prop_fx)
     VALUES ($1, 'subj', 'gpu-box', 'done', '{idle,sway}', '{s}', 3, 'sprites/c.png', 'box-9', 'sprites/m.json', 'shine')`,
    [ent.id],
  );
  const res = await request(app).get('/api/sprite-admin/subjects').set(...AUTH);
  const row = res.body.subjects.find((s) => s.id === ent.id);
  assert.equal(row.concept_key, 'sprites/c.png');
  assert.deepEqual(row.actions, ['idle', 'sway']);
  assert.deepEqual(row.directions, ['s']);
  assert.equal(row.frames_per_action, 3);
  assert.equal(row.manifest_key, 'sprites/m.json');
  assert.equal(row.box_job_id, 'box-9');
  // Props v2: the preview popup labels "Effect on approve" from this.
  assert.equal(row.prop_fx, 'shine');
});
