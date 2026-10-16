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
