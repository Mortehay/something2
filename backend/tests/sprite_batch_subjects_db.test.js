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
  assert.equal(row.redraw_source_atlas_key, null);
});

test('a subject whose latest row is a queued redraw carries redraw_of and the sheet from the source row', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const username = `sprite-subjects-admin-${Math.random().toString(36).slice(2)}`;
  const { rows: [admin] } = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', 'admin'],
  );
  const { rows: [ent] } = await pool.query(
    "INSERT INTO entity_types (name, prompt, color) VALUES ($1, 'a test wolf', '#888888') RETURNING id",
    [`redraw-subj-${Math.random().toString(36).slice(2)}`],
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
  const { rows: [src] } = await pool.query(
    `INSERT INTO sprite_sets (entity_type_id, creature, generation_kind, backend, status, actions, directions,
                              frames_per_action, box_job_id, atlas_key, manifest_key)
     VALUES ($1, 'wolf', 'creature', 'gpu-box', 'done', '{idle}', '{s}', 6, 'box-7', 'sprites/a.png', 'sprites/sheet.json')
     RETURNING id`,
    [ent.id],
  );
  await pool.query(
    `INSERT INTO sprite_sets (entity_type_id, creature, generation_kind, backend, status, actions, directions,
                              frames_per_action, box_job_id, redraw_of, redraw_frames, created_at)
     VALUES ($1, 'wolf', 'creature', 'gpu-box', 'queued', '{idle}', '{s}', 6, 'box-7', $2, $3::jsonb, now() + interval '1 second')`,
    [ent.id, src.id, JSON.stringify([{ action: 'idle', direction: 's', frame: 2 }])],
  );
  const res = await request(app).get('/api/sprite-admin/subjects').set(...AUTH);
  const row = res.body.subjects.find((s) => s.id === ent.id);
  assert.equal(row.job_state, 'queued');
  assert.equal(row.redraw_of, src.id);
  assert.deepEqual(row.redraw_frames, [{ action: 'idle', direction: 's', frame: 2 }]);
  assert.equal(row.box_task_id, null);
  assert.equal(row.redraw_source_atlas_key, 'sprites/a.png');
  assert.equal(row.sheet_job_id, src.id);
  assert.equal(row.sheet_atlas_key, 'sprites/a.png');
  assert.equal(row.sheet_manifest_key, 'sprites/sheet.json');
  assert.ok(row.sheet_updated_at);
});

// A (done) -> B (failed, captured a sheet) -> C (done): B changed the box's
// sheet too, so C compares against A and treats B's frames as marked.
test('a redraw after a failed redraw compares against the last good sheet, with both rows\' frames', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const username = `sprite-subjects-admin-${Math.random().toString(36).slice(2)}`;
  const { rows: [admin] } = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', 'admin'],
  );
  const { rows: [ent] } = await pool.query(
    "INSERT INTO entity_types (name, prompt, color) VALUES ($1, 'a test wolf', '#888888') RETURNING id",
    [`redraw-chain-${Math.random().toString(36).slice(2)}`],
  );
  const { rows: [cls] } = await pool.query(
    `SELECT ca.entity_type_id AS id, ca.variant FROM character_appearances ca
       JOIN entity_types e ON e.id = ca.entity_type_id AND e.is_playable = true
      ORDER BY ca.entity_type_id, ca.variant LIMIT 1`,
  );
  assert.ok(cls, 'precondition: a playable class with an appearance variant');
  const made = [];
  t.after(async () => {
    await pool.query('DELETE FROM sprite_sets WHERE id = ANY($1::uuid[])', [made]);
    await pool.query('DELETE FROM entity_types WHERE id = $1', [ent.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await pool.end();
  });
  const AUTH = ['Authorization', `Bearer ${signToken({
    userId: admin.id, username, role: 'admin', tokenVersion: admin.token_version,
  })}`];
  const F1 = { action: 'idle', direction: 's', frame: 1 };
  const F2 = { action: 'idle', direction: 's', frame: 2 };
  // Far-future created_at keeps the appearance chain newest for its variant.
  async function chain(entityId, variant, tag) {
    const ins = async (status, atlas, redrawOf, frames, secs) => {
      const { rows: [r] } = await pool.query(
        `INSERT INTO sprite_sets (entity_type_id, appearance_variant, creature, generation_kind, backend, status,
                                  actions, directions, frames_per_action, box_job_id, atlas_key, manifest_key,
                                  redraw_of, redraw_frames, created_at)
         VALUES ($1, $2, 'wolf', 'creature', 'gpu-box', $3, '{idle}', '{s}', 6, 'box-7', $4, 'sprites/m.json',
                 $5, $6::jsonb, now() + interval '1 day' + make_interval(secs => $7))
         RETURNING id`,
        [entityId, variant, status, atlas, redrawOf, frames && JSON.stringify(frames), secs],
      );
      made.push(r.id);
      return r.id;
    };
    const a = await ins('approved', `${tag}/a.png`, null, null, 0);
    const b = await ins('failed', `${tag}/b.png`, a, [F1], 1);
    await ins('done', `${tag}/c.png`, b, [F2], 2);
  }
  await chain(ent.id, null, 'ent');
  await chain(cls.id, cls.variant, 'app');
  const res = await request(app).get('/api/sprite-admin/subjects').set(...AUTH);
  assert.equal(res.status, 200);
  const key = (f) => `${f.action}/${f.direction}/${f.frame}`;
  for (const [id, tag] of [[ent.id, 'ent'], [`${cls.id}:${cls.variant}`, 'app']]) {
    const row = res.body.subjects.find((s) => s.id === id);
    assert.equal(row.atlas_key, `${tag}/c.png`, id);
    assert.equal(row.redraw_source_atlas_key, `${tag}/a.png`, `${id}: skips the failed ancestor`);
    assert.deepEqual(row.redraw_compare_frames.map(key).sort(), [key(F1), key(F2)], id);
  }
});

test('subjects carry kept_concept_key and the latest row\'s note for an entity and for a variant', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const username = `sprite-subjects-admin-${Math.random().toString(36).slice(2)}`;
  const { rows: [admin] } = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', 'admin'],
  );
  const { rows: [ent] } = await pool.query(
    "INSERT INTO entity_types (name, prompt, color) VALUES ($1, 'a test wolf', '#888888') RETURNING id",
    [`concept-subj-${Math.random().toString(36).slice(2)}`],
  );
  const { rows: [cls] } = await pool.query(
    `SELECT e.id, ca.variant FROM entity_types e JOIN character_appearances ca ON ca.entity_type_id = e.id
      WHERE e.is_playable = true ORDER BY e.id, ca.variant LIMIT 1`,
  );
  assert.ok(cls, 'precondition: a playable class with an appearance variant');
  t.after(async () => {
    await pool.query('DELETE FROM sprite_concepts WHERE entity_type_id = ANY($1)', [[ent.id, cls.id]]);
    await pool.query('DELETE FROM sprite_sets WHERE entity_type_id = ANY($1)', [[ent.id, cls.id]]);
    await pool.query('DELETE FROM entity_types WHERE id = $1', [ent.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await pool.end();
  });
  const AUTH = ['Authorization', `Bearer ${signToken({
    userId: admin.id, username, role: 'admin', tokenVersion: admin.token_version,
  })}`];
  for (const [entityId, variant, tag] of [[ent.id, null, 'ent'], [cls.id, cls.variant, 'app']]) {
    await pool.query(
      `INSERT INTO sprite_sets (entity_type_id, appearance_variant, creature, backend, status, actions, directions,
                                frames_per_action, note, created_at)
       VALUES ($1, $2, 'wolf', 'gpu-box', 'done', '{idle}', '{s}', 3, $3, now() + interval '1 day')`,
      [entityId, variant, `note-${tag}`],
    );
    await pool.query(
      `INSERT INTO sprite_concepts (entity_type_id, appearance_variant, concept_key, box_concept_path, box_origin)
       VALUES ($1, $2, $3, 'box/path.png', 'http://box')`,
      [entityId, variant, `sprites/kept-${tag}.png`],
    );
  }
  const res = await request(app).get('/api/sprite-admin/subjects').set(...AUTH);
  assert.equal(res.status, 200);
  const e = res.body.subjects.find((s) => s.id === ent.id);
  assert.equal(e.kept_concept_key, 'sprites/kept-ent.png');
  assert.equal(e.note, 'note-ent');
  const v = res.body.subjects.find((s) => s.id === `${cls.id}:${cls.variant}`);
  assert.equal(v.kept_concept_key, 'sprites/kept-app.png');
  assert.equal(v.note, 'note-app');
  const base = res.body.subjects.find((s) => s.id === cls.id);
  assert.equal(base.kept_concept_key ?? null, null, 'the class base row is a different subject than its variant');
});
