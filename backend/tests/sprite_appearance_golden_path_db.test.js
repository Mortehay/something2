// End-to-end golden path for the appearance-variant directional sprite
// pipeline, through the real HTTP routes against a real database: list it as
// a subject -> queue it -> (simulate what the sprite-gen worker would do on
// success) -> approve it -> the variant's OWN sprite is now set, the class's
// base entity_types.sprite is untouched, and the variant disappears from
// "missing visual" in a fresh /subjects read.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const queue = require('../src/services/spriteJobQueue.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

test('an appearance variant: queue -> complete -> approve writes its own directional sprite', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);

  const username = `sprite-golden-admin-${Math.random().toString(36).slice(2)}`;
  const { rows: [admin] } = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', 'admin'],
  );
  const AUTH = ['Authorization', `Bearer ${signToken({
    userId: admin.id, username, role: 'admin', tokenVersion: admin.token_version,
  })}`];

  const { rows: [target] } = await pool.query(
    `SELECT entity_type_id, variant FROM character_appearances
      WHERE sprite IS NULL ORDER BY entity_type_id, variant LIMIT 1`,
  );
  assert.ok(target, 'precondition: at least one appearance variant with no sprite of its own yet');

  t.after(async () => {
    await pool.query(
      `UPDATE character_appearances SET sprite = NULL, render_mode = NULL, updated_at = now()
        WHERE entity_type_id = $1 AND variant = $2`,
      [target.entity_type_id, target.variant],
    );
    await pool.query(
      `DELETE FROM sprite_sets WHERE entity_type_id = $1 AND appearance_variant = $2`,
      [target.entity_type_id, target.variant],
    );
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await pool.end();
  });

  // 1. It lists as a missing-visual subject before anything happens.
  const before = await request(app).get('/api/sprite-admin/subjects').set(...AUTH);
  const beforeRow = before.body.subjects.find(
    (s) => s.entity_id === target.entity_type_id && s.variant === target.variant,
  );
  assert.ok(beforeRow, 'the variant must already be listed');
  assert.equal(beforeRow.sprite, null);

  // 2. Queue it through the real route.
  const queued = await request(app).post('/api/sprite-admin/jobs').set(...AUTH)
    .send({ targets: [{ entity_id: target.entity_type_id, variant: target.variant }] });
  assert.equal(queued.status, 201);
  assert.equal(queued.body.queued, 1);

  // 3. Simulate the sprite-gen worker finishing the job (queue.complete is
  // the same function the real dispatcher calls on success).
  const { rows: [job] } = await pool.query(
    `SELECT id FROM sprite_sets WHERE entity_type_id = $1 AND appearance_variant = $2
      ORDER BY created_at DESC LIMIT 1`,
    [target.entity_type_id, target.variant],
  );
  await queue.complete(pool, job.id, {
    atlas_key: 'sprites/golden-path-test/atlas.png',
    manifest_key: 'sprites/golden-path-test/manifest.json',
  });

  // 4. Approve it through the real route.
  const approved = await request(app).post('/api/sprite-admin/jobs/approve').set(...AUTH)
    .send({ job_ids: [job.id] });
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.body.approved, [job.id]);

  // 5. The variant's OWN sprite is set; the class's base entity_types.sprite
  // was never touched by any of this.
  const { rows: [variantRow] } = await pool.query(
    'SELECT sprite, render_mode FROM character_appearances WHERE entity_type_id = $1 AND variant = $2',
    [target.entity_type_id, target.variant],
  );
  assert.equal(variantRow.sprite.atlas_key, 'sprites/golden-path-test/atlas.png');
  assert.equal(variantRow.sprite.static_frame, 'S/0');
  assert.equal(variantRow.render_mode, 'static');

  // 6. A fresh /subjects read no longer counts it as missing.
  const after = await request(app).get('/api/sprite-admin/subjects').set(...AUTH);
  const afterRow = after.body.subjects.find(
    (s) => s.entity_id === target.entity_type_id && s.variant === target.variant,
  );
  assert.ok(afterRow.sprite, 'the variant must now carry its own sprite');
  assert.equal(afterRow.job_state, 'approved');
});
