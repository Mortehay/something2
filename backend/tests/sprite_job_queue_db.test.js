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

// sprite_sets_one_live_per_entity_variant (migration 1714440750000) replaced
// the old one-job-per-entity unique index with one keyed on
// (entity_type_id, COALESCE(appearance_variant, 0)) specifically so a
// class's 5 appearance variants can all be queued at once -- this proves
// that, not just that enqueueing one variant works.
test('enqueue targets distinct appearance variants of the same class independently', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [cls] } = await client.query(
      `SELECT ca.entity_type_id FROM character_appearances ca
        GROUP BY ca.entity_type_id HAVING count(*) >= 2 LIMIT 1`,
    );
    assert.ok(cls, 'precondition: a class with at least two appearance variants');

    const { rows, unknown } = await queue.enqueue(client, [
      { entityId: cls.entity_type_id, variant: 1 },
      { entityId: cls.entity_type_id, variant: 2 },
    ]);

    assert.deepEqual(unknown, []);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.appearance_variant).sort(), [1, 2]);
    assert.ok(rows.every((r) => r.entity_type_id === cls.entity_type_id));
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});

async function withRolledBackClient(fn) {
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

const FREE_ENTITY = `NOT EXISTS (SELECT 1 FROM sprite_sets s
                      WHERE s.entity_type_id = e.id AND s.status IN ('queued','running'))`;
const EIGHT = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];

test('enqueue stores actions, frames and 8 facings for a creature', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    assert.ok(e, 'precondition: a creature with no live sprite job');

    const { rows: [row] } = await queue.enqueue(client, [{ entityId: e.id }],
      { actions: ['idle', 'walk'], framesPerAction: 6 });

    assert.deepEqual(row.actions, ['idle', 'walk']);
    assert.deepEqual(row.directions, EIGHT);
    assert.equal(row.frames_per_action, 6);
    assert.equal(row.frames, 6);
    assert.equal(row.backend, 'gpu-box');
    assert.equal(row.status, 'queued');
  });
});

test('enqueue gives props one facing', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [creature] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const { rows: [prop] } = await client.query(
      `SELECT e.id FROM entity_types e
        WHERE COALESCE(e.is_creature, false) = false AND COALESCE(e.is_playable, false) = false
          AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    assert.ok(creature && prop, 'precondition: a free creature and a free prop');

    const { rows } = await queue.enqueue(client,
      [{ entityId: creature.id }, { entityId: prop.id }],
      { actions: ['idle', 'sway'], framesPerAction: 4 });

    const byEntity = new Map(rows.map((r) => [r.entity_type_id, r]));
    assert.deepEqual(byEntity.get(creature.id).directions, EIGHT);
    assert.deepEqual(byEntity.get(prop.id).directions, ['s']);
    assert.deepEqual(byEntity.get(prop.id).actions, ['idle', 'sway']);
  });
});

test('attachBox records the box job and concept', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const { rows: [row] } = await queue.enqueue(client, [{ entityId: e.id }],
      { actions: ['idle'], framesPerAction: 4 });
    const { rows: [prov] } = await client.query('SELECT id FROM ai_providers ORDER BY id LIMIT 1');

    const updated = await queue.attachBox(client, row.id, {
      boxJobId: 'job-abc', conceptKey: 'images/core_ab12.png', providerId: prov ? prov.id : null,
    });

    assert.equal(updated.box_job_id, 'job-abc');
    assert.equal(updated.concept_key, 'images/core_ab12.png');
    assert.equal(updated.job_id, 'job-abc');
    assert.equal(updated.provider_id, prov ? prov.id : null);
    assert.equal(updated.backend, 'gpu-box');
  });
});

test('complete stores concept_key and sheet_seconds', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const { rows: [row] } = await queue.enqueue(client, [{ entityId: e.id }],
      { actions: ['idle'], framesPerAction: 4 });
    const done = await queue.complete(client, row.id, {
      image_key: 'k.png', concept_key: 'images/core_x.png', sheet_seconds: 90,
    });
    assert.equal(done.status, 'done');
    assert.equal(done.concept_key, 'images/core_x.png');
    assert.equal(done.sheet_seconds, 90);
  });
});

test('lastSecondsPerCell divides by cells', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    // Newer than anything real, so it is the "newest done row with timing".
    await client.query(
      `INSERT INTO sprite_sets (creature, backend, seed, frames, status, actions, directions,
                                frames_per_action, sheet_seconds, finished_at)
       VALUES ('spc-test', 'gpu-box', 1, 4, 'done', ARRAY['idle','walk'], ARRAY['s','e'], 4, 320,
               now() + interval '1 day')`,
    );
    // 2 actions x 2 directions x 4 frames = 16 cells; 320 / 16 = 20.
    assert.equal(await queue.lastSecondsPerCell(client), 20);
  });
});

test('lastSecondsPerCell is null when no done row has timing', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    await client.query(`UPDATE sprite_sets SET sheet_seconds = NULL`);
    assert.equal(await queue.lastSecondsPerCell(client), null);
  });
});

const spcRow = (client, name, secs, finishedAt, updatedAt = 'now()') => client.query(
  `INSERT INTO sprite_sets (creature, backend, seed, frames, status, actions, directions,
                            frames_per_action, sheet_seconds, finished_at, updated_at)
   VALUES ($1, 'gpu-box', 1, 4, 'done', ARRAY['idle'], ARRAY['s'], 4, $2, ${finishedAt}, ${updatedAt})`,
  [name, secs],
);

test('complete sets finished_at and keeps a stored sheet_seconds when given none', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const { rows: [row] } = await queue.enqueue(client, [{ entityId: e.id }],
      { actions: ['idle'], framesPerAction: 4 });
    const first = await queue.complete(client, row.id, { image_key: 'k.png', sheet_seconds: 90 });
    assert.ok(first.finished_at, 'finished_at set on complete');
    const again = await queue.complete(client, row.id, { image_key: 'k.png', sheet_seconds: null });
    assert.equal(again.sheet_seconds, 90, 'a resumed/NULL completion must not erase the measured time');
  });
});

test('lastSecondsPerCell orders by completion time, not by later updated_at bumps', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    // older completion, but touched later (approve bumps updated_at)
    await spcRow(client, 'spc-old', 40, "now() + interval '1 day'", "now() + interval '3 days'");
    // newer completion; 4 cells, 8 s -> 2 s/cell
    await spcRow(client, 'spc-new', 8, "now() + interval '2 days'", "now() + interval '2 days'");
    assert.equal(await queue.lastSecondsPerCell(client), 2);
  });
});

test('lastSecondsPerCell ignores NULL and zero sheet_seconds', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    await spcRow(client, 'spc-good', 12, "now() + interval '1 day'");
    await spcRow(client, 'spc-zero', 0, "now() + interval '2 days'");
    await spcRow(client, 'spc-null', null, "now() + interval '3 days'");
    assert.equal(await queue.lastSecondsPerCell(client), 3);
  });
});
