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

// SOMET-709: appearance variants come from their own query and mapping.
test('an appearance variant row carries the directions of its own newest sheet', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const username = `sprite-subjects-admin-${Math.random().toString(36).slice(2)}`;
  const { rows: [admin] } = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', 'admin'],
  );
  const { rows: [app1] } = await pool.query(
    `SELECT ca.entity_type_id, ca.variant FROM character_appearances ca
       JOIN entity_types e ON e.id = ca.entity_type_id AND e.is_playable = true
      ORDER BY ca.entity_type_id, ca.variant DESC LIMIT 1`,
  );
  assert.ok(app1, 'precondition: a seeded appearance variant');
  const { rows: [sheet] } = await pool.query(
    `INSERT INTO sprite_sets (entity_type_id, appearance_variant, creature, generation_kind, backend, status, actions, directions,
                              frames_per_action, box_job_id, atlas_key, manifest_key, created_at)
     VALUES ($1, $2, 'hero', 'creature', 'gpu-box', 'done', '{idle}', '{s,se,e}', 6, 'box-709', 'sprites/v.png', 'sprites/v.json', now() + interval '1 hour')
     RETURNING id`,
    [app1.entity_type_id, app1.variant],
  );
  t.after(async () => {
    await pool.query('DELETE FROM sprite_sets WHERE id = $1', [sheet.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await pool.end();
  });
  const AUTH = ['Authorization', `Bearer ${signToken({
    userId: admin.id, username, role: 'admin', tokenVersion: admin.token_version,
  })}`];
  const res = await request(app).get('/api/sprite-admin/subjects').set(...AUTH);
  assert.equal(res.status, 200);
  const row = res.body.subjects.find((s) => s.id === `${app1.entity_type_id}:${app1.variant}`);
  assert.equal(row.sheet_job_id, sheet.id);
  assert.deepEqual(row.sheet_directions, ['s', 'se', 'e']);
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
  assert.deepEqual(row.sheet_directions, ['s']);
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

test('subjects carry real_western from the newest job for an entity and for an appearance variant (SOMET-686)', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const username = `sprite-subjects-admin-${Math.random().toString(36).slice(2)}`;
  const { rows: [admin] } = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', 'admin'],
  );
  const { rows: [ent] } = await pool.query(
    "INSERT INTO entity_types (name, prompt, color) VALUES ($1, 'a test wolf', '#888888') RETURNING id",
    [`western-subj-${Math.random().toString(36).slice(2)}`],
  );
  const { rows: [cls] } = await pool.query(
    `SELECT e.id, ca.variant FROM entity_types e JOIN character_appearances ca ON ca.entity_type_id = e.id
      WHERE e.is_playable = true ORDER BY e.id, ca.variant LIMIT 1`,
  );
  assert.ok(cls, 'precondition: a playable class with an appearance variant');
  t.after(async () => {
    await pool.query('DELETE FROM sprite_sets WHERE entity_type_id = ANY($1)', [[ent.id, cls.id]]);
    await pool.query('DELETE FROM entity_types WHERE id = $1', [ent.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await pool.end();
  });
  const AUTH = ['Authorization', `Bearer ${signToken({
    userId: admin.id, username, role: 'admin', tokenVersion: admin.token_version,
  })}`];
  for (const [entityId, variant] of [[ent.id, null], [cls.id, cls.variant]]) {
    await pool.query(
      `INSERT INTO sprite_sets (entity_type_id, appearance_variant, creature, backend, status, actions, directions,
                                frames_per_action, real_western, created_at)
       VALUES ($1, $2, 'wolf', 'gpu-box', 'done', '{idle}', '{s,w}', 3, true, now() + interval '1 day')`,
      [entityId, variant],
    );
  }
  const res = await request(app).get('/api/sprite-admin/subjects').set(...AUTH);
  assert.equal(res.status, 200);
  const e = res.body.subjects.find((s) => s.id === ent.id);
  assert.equal(e.real_western, true);
  const v = res.body.subjects.find((s) => s.id === `${cls.id}:${cls.variant}`);
  assert.equal(v.real_western, true);
});

test('an approved prop row reports the effect the game uses; a pending row reports the one it will get (SOMET-677)', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const tag = `fx-${Math.random().toString(36).slice(2)}`;
  const username = `sprite-subjects-admin-${tag}`;
  const { rows: [admin] } = await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, token_version", [username],
  );
  const { rows: [ent] } = await pool.query(
    "INSERT INTO entity_types (name, prompt, color, is_creature, render_mode, idle_fx) VALUES ($1, 'a test prop', '#888888', false, 'static', 'none') RETURNING id", [`zzFx ${tag}`],
  );
  t.after(async () => {
    await pool.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [ent.id]);
    await pool.query('DELETE FROM entity_types WHERE id = $1', [ent.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await pool.end();
  });
  const insertJob = (status, fx) => pool.query(
    `INSERT INTO sprite_sets (creature, entity_type_id, backend, status, generation_kind, frames, prop_fx)
     VALUES ($1, $2, 'gpu-box', $3, 'object', 1, $4)`, [`zzFx ${tag}`, ent.id, status, fx],
  );
  const fxOf = async () => {
    const res = await request(app).get('/api/sprite-admin/subjects')
      .query({ search: tag, limit: 1000 }).set('Authorization', `Bearer ${signToken({ userId: admin.id, username, role: 'admin', tokenVersion: admin.token_version })}`);
    assert.equal(res.status, 200);
    const list = Array.isArray(res.body) ? res.body : res.body.subjects;
    const row = list.find((r) => r.id === ent.id || r.entity_id === ent.id || r.name === `zzFx ${tag}`);
    assert.ok(row, 'the prop lists');
    return row.prop_fx;
  };

  await insertJob('approved', 'drift');
  assert.equal(await fxOf(), 'none', 'approved says drift, the game draws none');
  await pool.query("UPDATE entity_types SET idle_fx = 'sway' WHERE id = $1", [ent.id]);
  assert.equal(await fxOf(), 'sway', 'an Entities edit after approve shows too');
  await pool.query("UPDATE sprite_sets SET status = 'done' WHERE entity_type_id = $1", [ent.id]);
  assert.equal(await fxOf(), 'drift', 'a row awaiting review shows the effect approve will apply');
});

// Sprite-tab prompt lane on /subjects and on Queue. Router built directly with a
// fake box catalog (no box traffic), on the private test DB.
function promptLaneApp(pool) {
  const express = require('express');
  const fs = require('node:fs');
  const path = require('node:path');
  const spriteBatchRoutes = require('../src/api/spriteBatchRoutes.js');
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gpuBox/action-catalog.json'), 'utf8'));
  const a = express();
  a.use(express.json());
  a.use('/api/sprite-admin', spriteBatchRoutes(pool, (_q, _s, next) => next(), { status: () => ({ running: false }) }, {
    box: { actionCatalog: async () => ({ ok: true, catalog }) },
    loadProvider: async () => ({ id: 'p' }),
  }));
  return a;
}

async function withPromptLane(fn) {
  const pool = new Pool({ connectionString: url });
  const tag = `sx-sbs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const names = [`${tag}-console`, `${tag}-sprite`, `${tag}-crate`];
  const { rows } = await pool.query(
    `INSERT INTO entity_types (name, prompt, color, is_creature) VALUES
       ($1, 'a console wolf', '#888888', true), ($2, 'a sprite wolf', '#888888', true), ($3, 'a crate', '#888888', false)
     RETURNING id, name`,
    names,
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  try {
    await fn(pool, { consoleE: byName.get(names[0]), spriteE: byName.get(names[1]), crate: byName.get(names[2]) });
  } finally {
    const ids = rows.map((r) => r.id);
    await pool.query('DELETE FROM sprite_sets WHERE entity_type_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM sprite_concepts WHERE entity_type_id = ANY($1::int[])', [ids]);
    await pool.query("DELETE FROM art_prompt_descriptions WHERE subject_kind = 'entity' AND subject_key = ANY($1::text[])", [names]);
    await pool.query('DELETE FROM entity_types WHERE id = ANY($1::int[])', [ids]);
    await pool.end();
  }
}

test('GET /subjects shows the sprite prompt and its source: template for an art-console description, sprite for a Sprite-tab one', { skip }, async () => {
  const desc = require('../src/services/artPromptDescriptions.js');
  await withPromptLane(async (pool, { consoleE, spriteE, crate }) => {
    await desc.replace(pool, 'entity', consoleE.name, { text: 'console words', model: 'm' });
    await desc.replace(pool, 'entity', spriteE.name, { text: 'a lean wolf mid-stride', model: 'm', origin: 'sprite' });
    await pool.query(
      `INSERT INTO sprite_concepts (entity_type_id, concept_key, box_concept_path, box_origin, regenerated, prompt)
       VALUES ($1, 'sprites/x/c.png', '/p/c.png', 'http://box:1', true, 'a lean wolf mid-stride')`, [spriteE.id]);
    await pool.query(
      `INSERT INTO sprite_sets (entity_type_id, creature, generation_kind, base_prompt, backend, seed, frames, status, needs_prompt, regenerate_concept)
       VALUES ($1, $2, 'creature', 'a sprite wolf', 'gpu-box', 1, 4, 'queued', true, true)`, [spriteE.id, spriteE.name]);
    const res = await request(promptLaneApp(pool)).get('/api/sprite-admin/subjects');
    assert.equal(res.status, 200);
    const c = res.body.subjects.find((s) => s.id === consoleE.id);
    assert.equal(c.prompt, 'a console wolf', 'the existing prompt field is unchanged');
    assert.equal(c.sprite_prompt, 'a console wolf');
    assert.equal(c.sprite_prompt_source, 'template');
    assert.equal(c.sprite_prompt_origin, null);
    assert.equal(c.prompt_kind, 'entity');
    assert.equal(c.prompt_key, consoleE.name);
    assert.equal(c.kept_concept_regenerated, null);
    const s = res.body.subjects.find((x) => x.id === spriteE.id);
    assert.equal(s.prompt, 'a sprite wolf');
    assert.equal(s.sprite_prompt, 'a lean wolf mid-stride');
    assert.equal(s.sprite_prompt_source, 'description');
    assert.equal(s.sprite_prompt_origin, 'sprite');
    assert.equal(s.needs_prompt, true);
    assert.equal(s.regenerate_concept, true);
    assert.equal(s.kept_concept_regenerated, true);
    const p = res.body.subjects.find((x) => x.id === crate.id);
    assert.equal(p.prompt_kind, null);
    assert.equal(p.prompt_key, null);
    assert.equal(p.sprite_prompt, null);
    // An appearance variant is keyed Class:variant under character_appearance.
    // Seeded playable classes carry appearance rows (the first test in this
    // file asserts the same precondition), so this cannot pass vacuously.
    const v = res.body.subjects.find((x) => x.variant != null);
    assert.ok(v, 'precondition: a seeded appearance variant row');
    const cls = res.body.subjects.find((x) => x.id === v.entity_id);
    assert.equal(v.prompt_kind, 'character_appearance');
    assert.equal(v.prompt_key, `${cls.name}:${v.variant}`);
    assert.equal(v.sprite_prompt, v.prompt, 'a never-opted-in variant is drawn from its template');
    assert.equal(v.sprite_prompt_source, 'template');
  });
});

test('POST /jobs with regenerate:true queues needs_prompt rows whose base_prompt is the current sprite prompt', { skip }, async () => {
  const desc = require('../src/services/artPromptDescriptions.js');
  await withPromptLane(async (pool, { consoleE, spriteE }) => {
    await desc.replace(pool, 'entity', consoleE.name, { text: 'console words', model: 'm' });
    await desc.replace(pool, 'entity', spriteE.name, { text: 'a lean wolf mid-stride', model: 'm', origin: 'sprite' });
    const res = await request(promptLaneApp(pool)).post('/api/sprite-admin/jobs')
      .send({ targets: [{ entity_id: consoleE.id }, { entity_id: spriteE.id }], actions: ['idle'], frames: 2, regenerate: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { rows } = await pool.query(
      'SELECT entity_type_id, base_prompt, needs_prompt, regenerate_concept FROM sprite_sets WHERE entity_type_id = ANY($1::int[])',
      [[consoleE.id, spriteE.id]]);
    const of = (id) => rows.find((r) => r.entity_type_id === id);
    assert.deepEqual(of(consoleE.id), { entity_type_id: consoleE.id, base_prompt: 'a console wolf', needs_prompt: true, regenerate_concept: true });
    assert.deepEqual(of(spriteE.id), { entity_type_id: spriteE.id, base_prompt: 'a lean wolf mid-stride', needs_prompt: true, regenerate_concept: true });
    // Without regenerate nothing asks for a prompt, and the never-opted-in creature keeps its template.
    await pool.query('DELETE FROM sprite_sets WHERE entity_type_id = ANY($1::int[])', [[consoleE.id, spriteE.id]]);
    await request(promptLaneApp(pool)).post('/api/sprite-admin/jobs')
      .send({ targets: [{ entity_id: consoleE.id }], actions: ['idle'], frames: 2 });
    const { rows: [plain] } = await pool.query('SELECT base_prompt, needs_prompt, regenerate_concept FROM sprite_sets WHERE entity_type_id = $1', [consoleE.id]);
    assert.deepEqual(plain, { base_prompt: 'a console wolf', needs_prompt: false, regenerate_concept: false });
  });
});
