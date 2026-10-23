const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const concepts = require('../src/services/spriteConcepts.js');
const queue = require('../src/services/spriteJobQueue.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

// One rolled-back transaction per test.
async function inTxn(fn) {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

async function creatureWithVariant(client) {
  const { rows: [r] } = await client.query(
    `SELECT ca.entity_type_id AS id, ca.variant FROM character_appearances ca
      ORDER BY ca.entity_type_id, ca.variant LIMIT 1`,
  );
  assert.ok(r, 'precondition: a seeded class with an appearance variant');
  return r;
}

const args = (id, variant, path) => ({
  entityTypeId: id, variant, conceptKey: `sprites/x/${id}/concept.png`,
  boxConceptPath: path, providerId: null, boxOrigin: 'http://box:1',
});

test('upsertKept inserts then replaces the subject\'s concept', { skip }, async () => {
  await inTxn(async (c) => {
    const { id } = await creatureWithVariant(c);
    const a = await concepts.upsertKept(c, args(id, null, '/p/one.png'));
    assert.equal(a.box_concept_path, '/p/one.png');
    const b = await concepts.upsertKept(c, args(id, null, '/p/two.png'));
    assert.equal(b.box_concept_path, '/p/two.png');
    const { rows } = await c.query('SELECT * FROM sprite_concepts WHERE entity_type_id = $1', [id]);
    assert.equal(rows.length, 1);
    assert.equal((await concepts.getKept(c, { entityTypeId: id, variant: null })).box_concept_path, '/p/two.png');
    assert.equal(await concepts.getKept(c, { entityTypeId: id, variant: 2 }), null);
  });
});

test('entity and its appearance variant keep separate concepts', { skip }, async () => {
  await inTxn(async (c) => {
    const { id, variant } = await creatureWithVariant(c);
    await concepts.upsertKept(c, args(id, null, '/p/entity.png'));
    await concepts.upsertKept(c, args(id, variant, '/p/variant.png'));
    const { rows } = await c.query('SELECT 1 FROM sprite_concepts WHERE entity_type_id = $1', [id]);
    assert.equal(rows.length, 2);
    assert.equal((await concepts.getKept(c, { entityTypeId: id, variant: null })).box_concept_path, '/p/entity.png');
    assert.equal((await concepts.getKept(c, { entityTypeId: id, variant })).box_concept_path, '/p/variant.png');
  });
});

test('removeKept forgets only the given subject\'s concept', { skip }, async () => {
  await inTxn(async (c) => {
    const { id, variant } = await creatureWithVariant(c);
    await concepts.upsertKept(c, args(id, null, '/p/entity.png'));
    await concepts.upsertKept(c, args(id, variant, '/p/variant.png'));
    await concepts.removeKept(c, { entityTypeId: id, variant });
    assert.equal(await concepts.getKept(c, { entityTypeId: id, variant }), null);
    assert.ok(await concepts.getKept(c, { entityTypeId: id, variant: null }));
    await concepts.removeKept(c, { entityTypeId: id, variant: null });
    assert.equal(await concepts.getKept(c, { entityTypeId: id, variant: null }), null);
  });
});

test('clearKept removes and skips a running subject', { skip }, async () => {
  await inTxn(async (c) => {
    const { id, variant } = await creatureWithVariant(c);
    await concepts.upsertKept(c, args(id, null, '/p/entity.png'));
    await concepts.upsertKept(c, args(id, variant, '/p/variant.png'));
    await c.query(
      `INSERT INTO sprite_sets (entity_type_id, appearance_variant, creature, backend, status)
       VALUES ($1, $2, 'run-test', 'gpu-box', 'running')`, [id, variant],
    );
    const out = await concepts.clearKept(c, [{ entityId: id, variant: null }, { entityId: id, variant }]);
    assert.equal(out.cleared, 1);
    assert.deepEqual(out.skipped_running, [`${id}:${variant}`]);
    assert.equal(await concepts.getKept(c, { entityTypeId: id, variant: null }), null);
    assert.ok(await concepts.getKept(c, { entityTypeId: id, variant }));
    const none = await concepts.clearKept(c, []);
    assert.deepEqual(none, { cleared: 0, skipped_running: [] });
  });
});

test('clearKept labels a running entity subject as its bare id', { skip }, async () => {
  await inTxn(async (c) => {
    const { id } = await creatureWithVariant(c);
    await concepts.upsertKept(c, args(id, null, '/p/entity.png'));
    await c.query(
      `INSERT INTO sprite_sets (entity_type_id, creature, backend, status)
       VALUES ($1, 'run-test', 'gpu-box', 'running')`, [id],
    );
    const out = await concepts.clearKept(c, [{ entityId: id, variant: null }]);
    assert.deepEqual(out, { cleared: 0, skipped_running: [String(id)] });
  });
});

async function row(c, id, variant, status, extra = {}) {
  const { rows: [r] } = await c.query(
    `INSERT INTO sprite_sets (entity_type_id, appearance_variant, creature, generation_kind, backend, status,
                              box_job_id, redraw_of)
     VALUES ($1, $2, 'del-test', $3, 'gpu-box', $4, $5, $6) RETURNING *`,
    [id, variant, extra.kind || 'creature', status, extra.boxJobId || null, extra.redrawOf || null],
  );
  return r;
}
const count = async (c, id) => Number((await c.query('SELECT count(*) FROM sprite_sets WHERE entity_type_id = $1', [id])).rows[0].count);

test('deleteGeneratedRows deletes every status and skips running', { skip }, async () => {
  await inTxn(async (c) => {
    const { id, variant } = await creatureWithVariant(c);
    await c.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [id]);
    // Subject A (entity): done, approved, failed, queued.  Subject B (variant): running + done.
    // A queued row coexists with no other live row of its subject.
    await row(c, id, null, 'done');
    await row(c, id, null, 'approved');
    await row(c, id, null, 'failed');
    await row(c, id, null, 'queued');
    await row(c, id, variant, 'done');
    await row(c, id, variant, 'running');
    const out = await queue.deleteGeneratedRows(c, [{ entityId: id, variant: null }, { entityId: id, variant }]);
    assert.equal(out.rows.length, 4);
    assert.equal(out.subjects, 1);
    assert.deepEqual(out.skipped_running, [`${id}:${variant}`]);
    assert.equal(await count(c, id), 2);
  });
});

test('deleteGeneratedRows removes a redraw chain of an approved sheet and nulls the creature sprite', { skip }, async () => {
  await inTxn(async (c) => {
    const { id } = await creatureWithVariant(c);
    await c.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [id]);
    await c.query(`UPDATE entity_types SET sprite = '{"x":1}'::jsonb, render_mode = 'animated' WHERE id = $1`, [id]);
    const sheet = await row(c, id, null, 'approved');
    const r1 = await row(c, id, null, 'done', { redrawOf: sheet.id });
    await row(c, id, null, 'done', { redrawOf: r1.id });
    const out = await queue.deleteGeneratedRows(c, [{ entityId: id, variant: null }]);
    assert.equal(out.rows.length, 3);
    assert.equal(await count(c, id), 0);
    const { rows: [e] } = await c.query('SELECT sprite, render_mode FROM entity_types WHERE id = $1', [id]);
    assert.equal(e.sprite, null);
    assert.equal(e.render_mode, 'static');
  });
});

test('deleteGeneratedRows on a variant nulls character_appearances.sprite and sets render_mode static', { skip }, async () => {
  await inTxn(async (c) => {
    const { id, variant } = await creatureWithVariant(c);
    await c.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [id]);
    await c.query(`UPDATE entity_types SET sprite = '{"keep":1}'::jsonb, render_mode = 'animated' WHERE id = $1`, [id]);
    await c.query(
      `UPDATE character_appearances SET sprite = '{"x":1}'::jsonb, render_mode = 'animated'
        WHERE entity_type_id = $1 AND variant = $2`, [id, variant],
    );
    await row(c, id, variant, 'approved');
    await queue.deleteGeneratedRows(c, [{ entityId: id, variant }]);
    const { rows: [a] } = await c.query(
      'SELECT sprite, render_mode FROM character_appearances WHERE entity_type_id = $1 AND variant = $2', [id, variant]);
    assert.equal(a.sprite, null);
    assert.equal(a.render_mode, 'static');
    const { rows: [e] } = await c.query('SELECT sprite, render_mode FROM entity_types WHERE id = $1', [id]);
    assert.deepEqual(e.sprite, { keep: 1 });
    assert.equal(e.render_mode, 'animated');
  });
});

test('deleteGeneratedRows leaves a prop entity row unchanged', { skip }, async () => {
  await inTxn(async (c) => {
    const { rows: [p] } = await c.query('SELECT id FROM entity_types WHERE is_creature = false ORDER BY id LIMIT 1');
    assert.ok(p, 'precondition: a non-creature entity');
    await c.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [p.id]);
    await c.query(`UPDATE entity_types SET sprite = '{"prop":1}'::jsonb, render_mode = 'animated' WHERE id = $1`, [p.id]);
    await row(c, p.id, null, 'approved', { kind: 'object' });
    const out = await queue.deleteGeneratedRows(c, [{ entityId: p.id, variant: null }]);
    assert.equal(out.rows.length, 1);
    const { rows: [e] } = await c.query('SELECT sprite, render_mode FROM entity_types WHERE id = $1', [p.id]);
    assert.deepEqual(e.sprite, { prop: 1 });
    assert.equal(e.render_mode, 'animated');
  });
});

test('deleteGeneratedRows drops a prop sprite that points into a deleted row and keeps its image', { skip }, async () => {
  await inTxn(async (c) => {
    const { rows: [p] } = await c.query('SELECT id FROM entity_types WHERE is_creature = false ORDER BY id LIMIT 1');
    assert.ok(p, 'precondition: a non-creature entity');
    await c.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [p.id]);
    const sheet = await row(c, p.id, null, 'approved', { kind: 'object' });
    const sprite = { atlas_key: `sprites/Lamp/${sheet.id}/atlas.png`, manifest_key: `sprites/Lamp/${sheet.id}/m.json`, frames: 4 };
    await c.query(
      `UPDATE entity_types SET sprite = $2::jsonb, render_mode = 'animated', image = 'images/lamp-own.png' WHERE id = $1`,
      [p.id, JSON.stringify(sprite)],
    );
    await queue.deleteGeneratedRows(c, [{ entityId: p.id, variant: null }]);
    const { rows: [e] } = await c.query('SELECT sprite, render_mode, image FROM entity_types WHERE id = $1', [p.id]);
    assert.equal(e.sprite, null);
    assert.equal(e.render_mode, 'static');
    assert.equal(e.image, 'images/lamp-own.png');
  });
});

test('deleteGeneratedRows drops a variant prop sprite that points into a deleted row', { skip }, async () => {
  await inTxn(async (c) => {
    const { id, variant } = await creatureWithVariant(c);
    await c.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [id]);
    const sheet = await row(c, id, variant, 'approved', { kind: 'object' });
    await c.query(
      `UPDATE character_appearances SET sprite = $3::jsonb, render_mode = 'animated'
        WHERE entity_type_id = $1 AND variant = $2`,
      [id, variant, JSON.stringify({ manifest_key: `sprites/V/${sheet.id}/m.json`, frames: 2 })],
    );
    await queue.deleteGeneratedRows(c, [{ entityId: id, variant }]);
    const { rows: [a] } = await c.query(
      'SELECT sprite, render_mode FROM character_appearances WHERE entity_type_id = $1 AND variant = $2', [id, variant]);
    assert.equal(a.sprite, null);
    assert.equal(a.render_mode, 'static');
  });
});

test('deleteGeneratedRows keeps a prop sprite that points into another row\'s folder', { skip }, async () => {
  await inTxn(async (c) => {
    const { rows: [p] } = await c.query('SELECT id FROM entity_types WHERE is_creature = false ORDER BY id LIMIT 1');
    await c.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [p.id]);
    await row(c, p.id, null, 'approved', { kind: 'object' });
    const sprite = { atlas_key: 'sprites/Lamp/00000000-0000-4000-8000-000000000000/atlas.png', frames: 4 };
    await c.query(`UPDATE entity_types SET sprite = $2::jsonb, render_mode = 'animated' WHERE id = $1`, [p.id, JSON.stringify(sprite)]);
    await queue.deleteGeneratedRows(c, [{ entityId: p.id, variant: null }]);
    const { rows: [e] } = await c.query('SELECT sprite, render_mode FROM entity_types WHERE id = $1', [p.id]);
    assert.deepEqual(e.sprite, sprite);
    assert.equal(e.render_mode, 'animated');
  });
});

test('deleteGeneratedRows returns the box job ids of queued rows to cancel', { skip }, async () => {
  await inTxn(async (c) => {
    const { id, variant } = await creatureWithVariant(c);
    await c.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [id]);
    await row(c, id, null, 'queued', { boxJobId: 'box-q1' });
    await row(c, id, null, 'done', { boxJobId: 'box-done' });
    await row(c, id, variant, 'failed', { boxJobId: 'box-failed' });
    const out = await queue.deleteGeneratedRows(c, [{ entityId: id, variant: null }, { entityId: id, variant }]);
    assert.deepEqual(out.cancel_box_job_ids, ['box-q1']);
  });
});

test('setNote sets and clears the note, null for a missing row', { skip }, async () => {
  await inTxn(async (c) => {
    const { id } = await creatureWithVariant(c);
    await c.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [id]);
    const r = await row(c, id, null, 'done');
    assert.equal((await queue.setNote(c, r.id, 'hello')).note, 'hello');
    assert.equal((await queue.setNote(c, r.id, null)).note, null);
    assert.equal(await queue.setNote(c, '00000000-0000-0000-0000-000000000000', 'x'), null);
  });
});
