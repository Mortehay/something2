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

// `snapshot: true` opens the transaction at REPEATABLE READ, so every read in it sees
// the database as of its first query plus this transaction's own writes. A test that
// compares a table-wide aggregate before and after its own insert needs this: at the
// default READ COMMITTED each read takes a fresh snapshot, so a queued row another test
// file commits or deletes between the two reads shifts the delta (SOMET-750).
async function withRolledBackClient(fn, { snapshot = false } = {}) {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query(snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

const FREE_ENTITY = `NOT EXISTS (SELECT 1 FROM sprite_sets s
                      WHERE s.entity_type_id = e.id AND s.status IN ('queued','running'))`;
// SOMET-669: directional sheets are drawn front, right side and back only.
const FACINGS = ['s', 'e', 'n'];

test('enqueue stores actions, frames and the facings for a creature', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    assert.ok(e, 'precondition: a creature with no live sprite job');

    const { rows: [row] } = await queue.enqueue(client, [{ entityId: e.id }],
      { actions: ['idle', 'walk'], framesPerAction: 6 });

    assert.deepEqual(row.actions, ['idle', 'walk']);
    assert.deepEqual(row.directions, FACINGS);
    assert.equal(row.frames_per_action, 6);
    assert.equal(row.frames, 6);
    assert.equal(row.backend, 'gpu-box');
    assert.equal(row.status, 'queued');
  });
});

test('enqueue re-takes options on a queued job and leaves a running one alone', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [a, b] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 2`,
    );
    assert.ok(a && b, 'precondition: two creatures with no live sprite job');

    const first = await queue.enqueue(client, [{ entityId: a.id }, { entityId: b.id }],
      { actions: ['idle'], framesPerAction: 4 });
    const running = first.rows.find((r) => r.entity_type_id === b.id);
    await client.query("UPDATE sprite_sets SET status = 'running' WHERE id = $1", [running.id]);

    const again = await queue.enqueue(client, [{ entityId: a.id }, { entityId: b.id }],
      { actions: ['idle', 'walk', 'attack'], framesPerAction: 6 });

    assert.equal(again.rows.length, 0, 'no second live row');
    assert.equal(again.updated.length, 1);
    const fixed = again.updated[0];
    assert.equal(fixed.id, first.rows.find((r) => r.entity_type_id === a.id).id, 'same row, same place in line');
    assert.deepEqual(fixed.actions, ['idle', 'walk', 'attack']);
    assert.equal(fixed.frames_per_action, 6);
    assert.equal(fixed.frames, 6);
    const { rows: [still] } = await client.query('SELECT actions, frames_per_action FROM sprite_sets WHERE id = $1', [running.id]);
    assert.deepEqual(still, { actions: ['idle'], frames_per_action: 4 });
  });
});

test('an update detaches a rescued row from its box job only when the sheet changes', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [a, b] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 2`,
    );
    assert.ok(a && b, 'precondition: two creatures with no live sprite job');
    await queue.enqueue(client, [{ entityId: a.id }, { entityId: b.id }], { actions: ['idle'], framesPerAction: 4 });
    await client.query(
      `UPDATE sprite_sets SET box_job_id = 'box-' || entity_type_id
        WHERE entity_type_id = ANY($1::int[]) AND status = 'queued'`,
      [[a.id, b.id]],
    );

    const same = await queue.enqueue(client, [{ entityId: a.id }], { actions: ['idle'], framesPerAction: 4 });
    assert.equal(same.updated[0].box_job_id, `box-${a.id}`, 'unchanged options keep the resumable job');
    assert.equal(same.updated[0].dropped_box_job_id, null);

    const changed = await queue.enqueue(client, [{ entityId: b.id }], { actions: ['idle'], framesPerAction: 6 });
    assert.equal(changed.updated[0].box_job_id, null);
    assert.equal(changed.updated[0].dropped_box_job_id, `box-${b.id}`);
  });
});

test('re-queuing a row queued under the old eight facings re-draws it in the current set (SOMET-669)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [a] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    assert.ok(a, 'precondition: a creature with no live sprite job');
    const { rows: [row] } = await queue.enqueue(client, [{ entityId: a.id }], { actions: ['idle'], framesPerAction: 4 });
    // As a row queued before SOMET-669 was stored, with a resumable box job.
    await client.query(
      `UPDATE sprite_sets SET directions = ARRAY['s','se','e','ne','n','nw','w','sw'], box_job_id = 'box-old'
        WHERE id = $1`,
      [row.id],
    );

    const again = await queue.enqueue(client, [{ entityId: a.id }], { actions: ['idle'], framesPerAction: 4 });

    assert.equal(again.updated[0].id, row.id, 'same row, same place in line');
    assert.deepEqual(again.updated[0].directions, FACINGS);
    assert.equal(again.updated[0].box_job_id, null, 'the old job draws eight facings, so it is detached');
    assert.equal(again.updated[0].dropped_box_job_id, 'box-old');
  });
});

test('a queued row whose cell changes is an options change that detaches its box job (SOMET-706)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [a] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    assert.ok(a, 'precondition: a creature with no live sprite job');
    const opts = { actions: ['idle'], framesPerAction: 4 };
    const [row] = (await queue.enqueue(client, [{ entityId: a.id }], opts)).rows;
    assert.equal(row.cell, null, 'omitted cell stores NULL');
    await client.query(`UPDATE sprite_sets SET box_job_id = 'box-c' WHERE id = $1`, [row.id]);

    const same = await queue.enqueue(client, [{ entityId: a.id }], { ...opts, cell: '48x64' });
    assert.equal(same.updated[0].cell, null, '48x64 stores NULL');
    assert.equal(same.updated[0].box_job_id, 'box-c', 'NULL -> 48x64 is no change');

    const big = await queue.enqueue(client, [{ entityId: a.id }], { ...opts, cell: '96x128' });
    assert.equal(big.updated[0].cell, '96x128');
    assert.equal(big.updated[0].box_job_id, null);
    assert.equal(big.updated[0].dropped_box_job_id, 'box-c');

    await client.query(`UPDATE sprite_sets SET box_job_id = 'box-d' WHERE id = $1`, [row.id]);
    const keep = await queue.enqueue(client, [{ entityId: a.id }], { ...opts, cell: '96x128' });
    assert.equal(keep.updated[0].box_job_id, 'box-d', 'same cell keeps the job');
    const back = await queue.enqueue(client, [{ entityId: a.id }], opts);
    assert.equal(back.updated[0].cell, null);
    assert.equal(back.updated[0].dropped_box_job_id, 'box-d');
  });
});

test('redraw_actions is stored, a change detaches the queued box job, props never get it (SOMET-711)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [a] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const opts = { actions: ['idle'], framesPerAction: 4 };
    const [row] = (await queue.enqueue(client, [{ entityId: a.id }], opts)).rows;
    assert.equal(row.redraw_actions, false, 'omitted is false');
    await client.query(`UPDATE sprite_sets SET box_job_id = 'box-r' WHERE id = $1`, [row.id]);
    const on = await queue.enqueue(client, [{ entityId: a.id }], { ...opts, redrawActions: true });
    assert.equal(on.updated[0].redraw_actions, true);
    assert.equal(on.updated[0].box_job_id, null);
    assert.equal(on.updated[0].dropped_box_job_id, 'box-r');

    const { rows: [p] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = false AND e.is_playable = false AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const [prop] = (await queue.enqueue(client, [{ entityId: p.id }], { actions: ['idle'], framesPerAction: 1, redrawActions: true })).rows;
    assert.equal(prop.redraw_actions, false);
  });
});

test('provider_id is stored per creature row, a change detaches the queued box job, props never get it (HQ lane)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [prov] } = await client.query(
      `INSERT INTO ai_providers (name, base_url, modality, request_template, enabled)
       VALUES ('hq-test', 'http://box-hq:8001', 'sprite', '{"engine":"comfyui-hq"}'::jsonb, true) RETURNING id`);
    const { rows: [a] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const opts = { actions: ['idle'], framesPerAction: 4 };
    const [row] = (await queue.enqueue(client, [{ entityId: a.id }], opts)).rows;
    assert.equal(row.chosen_provider_id, null, 'omitted is NULL');
    await client.query(`UPDATE sprite_sets SET box_job_id = 'box-p' WHERE id = $1`, [row.id]);
    const moved = await queue.enqueue(client, [{ entityId: a.id }], { ...opts, providerId: prov.id });
    assert.equal(moved.updated[0].chosen_provider_id, prov.id);
    assert.equal(moved.updated[0].box_job_id, null);
    assert.equal(moved.updated[0].dropped_box_job_id, 'box-p');

    const { rows: [p] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = false AND e.is_playable = false AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const [prop] = (await queue.enqueue(client, [{ entityId: p.id }], { actions: ['idle'], framesPerAction: 1, providerId: prov.id })).rows;
    assert.equal(prop.chosen_provider_id, null);
  });
});

test('the attach step\'s provider_id never pins a row: re-queuing with no connector choice keeps the box job (review I1)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [prov] } = await client.query(
      `INSERT INTO ai_providers (name, base_url, modality, request_template, enabled)
       VALUES ('attach-test', 'http://box-a:8001', 'sprite', '{}'::jsonb, true) RETURNING id`);
    const { rows: [a] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const opts = { actions: ['idle'], framesPerAction: 4 };
    const [row] = (await queue.enqueue(client, [{ entityId: a.id }], opts)).rows;
    await queue.attachBox(client, row.id, { boxJobId: 'box-r', conceptKey: 'c.png', providerId: prov.id });
    await client.query(`UPDATE sprite_sets SET status = 'queued' WHERE id = $1`, [row.id]);
    const again = await queue.enqueue(client, [{ entityId: a.id }], opts);
    assert.equal(again.updated[0].box_job_id, 'box-r', 'same options, no choice: the rescued job is kept');
    assert.equal(again.updated[0].chosen_provider_id, null);
  });
});

test('re-queuing a queued prop with cell 96x128 keeps its cell NULL and its box job (SOMET-706)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [p] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = false AND e.is_playable = false AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    assert.ok(p, 'precondition: a prop with no live sprite job');
    const opts = { actions: ['idle'], framesPerAction: 1, cell: '96x128' };
    const [row] = (await queue.enqueue(client, [{ entityId: p.id }], opts)).rows;
    await client.query(`UPDATE sprite_sets SET box_job_id = 'box-p' WHERE id = $1`, [row.id]);
    const again = await queue.enqueue(client, [{ entityId: p.id }], opts);
    assert.equal(again.updated[0].cell, null);
    assert.equal(again.updated[0].box_job_id, 'box-p');
  });
});

test('a prop row ignores the cell option (SOMET-706)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [p] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = false AND e.is_playable = false AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    assert.ok(p, 'precondition: a prop with no live sprite job');
    const [row] = (await queue.enqueue(client, [{ entityId: p.id }], { actions: ['idle'], framesPerAction: 1, cell: '96x128' })).rows;
    assert.equal(row.cell, null);
  });
});

test('requeueStale at age 0 takes a just-claimed row back and keeps its box job (SOMET-721)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const { rows: [row] } = await queue.enqueue(client, [{ entityId: e.id }], { actions: ['idle'], framesPerAction: 4 });
    // now() is frozen inside this transaction; a real boot runs in a later one.
    await client.query(
      `UPDATE sprite_sets SET status = 'running', claimed_at = now() - interval '1 second', box_job_id = 'bx' WHERE id = $1`,
      [row.id],
    );
    assert.deepEqual((await queue.requeueStale(client, 60_000)).filter((r) => r.id === row.id), [], 'the Rescue floor would leave it');
    const back = (await queue.requeueStale(client, 0)).find((r) => r.id === row.id);
    assert.equal(back.status, 'queued');
    assert.equal(back.box_job_id, 'bx');
    assert.equal(back.claimed_at, null);
  });
});

test('resumePlan: interrupted only by running rows, connectors of everything a resumed run would touch (SOMET-721)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: es } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 2`,
    );
    const { rows: [hq] } = await client.query(
      `INSERT INTO ai_providers (name, base_url, request_template, modality) VALUES ('plan hq', 'http://hq', '{}', 'sprite') RETURNING id`,
    );
    // resumePlan reads the whole table, and parallel test files commit rows to it.
    // An empty temp table shadows it on this connection, with no lock on the real one.
    await client.query(`CREATE TEMP TABLE sprite_sets (LIKE sprite_sets INCLUDING ALL) ON COMMIT DROP`);
    assert.deepEqual(await queue.resumePlan(client), { interrupted: false, providerIds: [] });
    const { rows: [one, two] } = await queue.enqueue(client, es.map((e) => ({ entityId: e.id })), { actions: ['idle'], framesPerAction: 4 });
    const queuedOnly = await queue.resumePlan(client);
    assert.equal(queuedOnly.interrupted, false, 'queued rows alone were not interrupted');
    assert.deepEqual(queuedOnly.providerIds, [null]);
    // The stranded row is on a chosen connector; the queued one uses the active
    // connector, and the run would claim it next, so both must be probed.
    await client.query(`UPDATE sprite_sets SET status = 'running', claimed_at = now(), chosen_provider_id = $2 WHERE id = $1`, [one.id, hq.id]);
    const plan = await queue.resumePlan(client);
    assert.equal(plan.interrupted, true);
    assert.deepEqual(plan.providerIds.map((id) => (id === null ? null : Number(id))).sort(), [Number(hq.id), null].sort());
    // A single-entity row with no entity_type_id is never claimed, so it is not probed.
    await client.query(`UPDATE sprite_sets SET entity_type_id = NULL, chosen_provider_id = NULL WHERE id = $1`, [two.id]);
    assert.deepEqual((await queue.resumePlan(client)).providerIds.map(Number), [Number(hq.id)]);
  });
});

test('requeueHalted puts a running row back detached, and leaves other states alone', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const { rows: [row] } = await queue.enqueue(client, [{ entityId: e.id }], { actions: ['idle'], framesPerAction: 4 });
    assert.equal(await queue.requeueHalted(client, row.id), null, 'a queued row is not "halted"');
    await client.query(
      `UPDATE sprite_sets SET status = 'running', claimed_at = now(), box_job_id = 'bx' WHERE id = $1`, [row.id],
    );
    const back = await queue.requeueHalted(client, row.id);
    assert.equal(back.status, 'queued');
    assert.equal(back.box_job_id, null);
    assert.equal(back.claimed_at, null);
    assert.match(back.last_error, /halted/);
  });
});

test('requeueUnreachable puts a running row back queued keeping its box job (SOMET-756)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const { rows: [row] } = await queue.enqueue(client, [{ entityId: e.id }], { actions: ['idle'], framesPerAction: 4 });
    assert.equal(await queue.requeueUnreachable(client, row.id, new Error('x')), null, 'a queued row is left alone');
    await client.query(
      `UPDATE sprite_sets SET status = 'running', claimed_at = now(), box_job_id = 'bx', box_task_id = 'tk' WHERE id = $1`, [row.id],
    );
    const back = await queue.requeueUnreachable(client, row.id, new Error('could not reach http://box: fetch failed'));
    assert.equal(back.status, 'queued');
    assert.equal(back.box_job_id, 'bx');
    assert.equal(back.box_task_id, 'tk');
    assert.equal(back.claimed_at, null);
    assert.match(back.last_error, /could not reach/);
  });
});

test('enqueue gives props one facing', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [creature] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const { rows: [prop] } = await client.query(
      `SELECT e.id, e.name FROM entity_types e
        WHERE COALESCE(e.is_creature, false) = false AND COALESCE(e.is_playable, false) = false
          AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    assert.ok(creature && prop, 'precondition: a free creature and a free prop');

    const { rows } = await queue.enqueue(client,
      [{ entityId: creature.id }, { entityId: prop.id }],
      { actions: ['idle', 'sway'], framesPerAction: 4 });

    const byEntity = new Map(rows.map((r) => [r.entity_type_id, r]));
    assert.deepEqual(byEntity.get(creature.id).directions, FACINGS);
    assert.deepEqual(byEntity.get(prop.id).directions, ['s']);
    assert.deepEqual(byEntity.get(prop.id).actions, ['idle', 'sway']);
    // Props v2: no propFx means the per-prop default (SOMET-677); creatures carry NULL.
    assert.equal(byEntity.get(prop.id).prop_fx, /tree/i.test(prop.name) ? 'drift' : 'none');
    assert.equal(byEntity.get(creature.id).prop_fx, null);
  });
});

test('enqueue stores the chosen prop effect on prop rows only', { skip }, async () => {
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
      { actions: ['idle'], framesPerAction: 1, propFx: 'shine' });
    const byEntity = new Map(rows.map((r) => [r.entity_type_id, r]));
    assert.equal(byEntity.get(prop.id).prop_fx, 'shine');
    assert.equal(byEntity.get(creature.id).prop_fx, null);
    await assert.rejects(
      queue.enqueue(client, [{ entityId: prop.id }], { actions: ['idle'], propFx: 'glow' }),
      /propFx must be one of none, sway, shine, drift/,
    );
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

test('complete stores the merged actions when given and keeps them otherwise (SOMET-709)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const { rows: [row] } = await queue.enqueue(client, [{ entityId: e.id }], { actions: ['walk'], framesPerAction: 4 });
    const kept = await queue.complete(client, row.id, { atlas_key: 'a.png' });
    assert.deepEqual(kept.actions, ['walk']);
    const merged = await queue.complete(client, row.id, { atlas_key: 'a.png', actions: ['idle', 'walk'] });
    assert.deepEqual(merged.actions, ['idle', 'walk']);
  });
});

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

// ---- redraw rows ----------------------------------------------------------
// A finished sheet row (source) for a free creature; returns { entity, source }.
async function doneSource(client, nth = 0) {
  const { rows } = await client.query(
    `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT ${nth + 1}`,
  );
  const entity = rows[nth];
  assert.ok(entity, 'precondition: a creature with no live sprite job');
  const { rows: [queued] } = await queue.enqueue(client, [{ entityId: entity.id }],
    { actions: ['idle', 'walk'], framesPerAction: 6 });
  await queue.attachBox(client, queued.id, { boxJobId: `box-${queued.id}`, conceptKey: 'images/core_src.png', providerId: null });
  const source = await queue.complete(client, queued.id, {
    image_key: 'k.png', atlas_key: 'a.json', manifest_key: 'm.json', sheet_seconds: 90,
  });
  return { entity, source };
}
const FRAMES = [{ action: 'walk', direction: 'e', frame: 2 }, { action: 'walk', direction: 'e', frame: 3 }];

test('createRedraw copies the source and stores frames', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { source } = await doneSource(client);
    const row = await queue.createRedraw(client, source, FRAMES);
    assert.ok(row);
    assert.notEqual(row.id, source.id);
    assert.equal(row.redraw_of, source.id);
    assert.deepEqual(row.redraw_frames, FRAMES);
    assert.equal(row.box_job_id, source.box_job_id);
    assert.equal(row.concept_key, 'images/core_src.png');
    assert.equal(row.entity_type_id, source.entity_type_id);
    assert.deepEqual(row.actions, source.actions);
    assert.deepEqual(row.directions, source.directions);
    assert.equal(row.frames_per_action, 6);
    assert.equal(row.status, 'queued');
    assert.equal(row.sheet_seconds, null);
    assert.equal(row.box_task_id, null);
  });
});

test('createRedraw copies the source cell (SOMET-706)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { source } = await doneSource(client);
    await client.query('UPDATE sprite_sets SET cell = $2 WHERE id = $1', [source.id, '96x128']);
    const { rows: [src] } = await client.query('SELECT * FROM sprite_sets WHERE id = $1', [source.id]);
    const row = await queue.createRedraw(client, src, FRAMES);
    assert.equal(row.cell, '96x128');
  });
});

test('the database only accepts NULL, 48x64 and 96x128 as a cell (SOMET-706)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { source } = await doneSource(client);
    await client.query('SAVEPOINT s');
    await assert.rejects(client.query('UPDATE sprite_sets SET cell = $2 WHERE id = $1', [source.id, '10x10']), /sprite_sets_cell_check/);
    await client.query('ROLLBACK TO SAVEPOINT s');
  });
});

test('createRedraw returns null when the subject already has a live job', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { source } = await doneSource(client);
    assert.ok(await queue.createRedraw(client, source, FRAMES));
    assert.equal(await queue.createRedraw(client, source, FRAMES), null);
    const { rows: [{ n }] } = await client.query(
      "SELECT count(*)::int AS n FROM sprite_sets WHERE entity_type_id = $1 AND status = 'queued'", [source.entity_type_id]);
    assert.equal(n, 1);
  });
});

test('queuedCells counts only marked frames for a redraw row', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { source } = await doneSource(client);
    // A source on 7 x 8 x 6 so the full-sheet figure would be 336.
    await client.query(
      `UPDATE sprite_sets SET actions = ARRAY['a','b','c','d','e','f','g'], frames_per_action = 6 WHERE id = $1`, [source.id]);
    const { rows: [fresh] } = await client.query('SELECT * FROM sprite_sets WHERE id = $1', [source.id]);
    const before = await queue.queuedCells(client);
    const three = [0, 1, 2].map((frame) => ({ action: 'a', direction: 's', frame }));
    await queue.createRedraw(client, fresh, three);
    assert.equal(await queue.queuedCells(client) - before, 3);
  }, { snapshot: true });
});

test('queuedCellsBySampling groups queued cells by preset and chosen connector', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { source } = await doneSource(client);
    const { rows: [fresh] } = await client.query(
      "UPDATE sprite_sets SET sampling = 'guided' WHERE id = $1 RETURNING *", [source.id]);
    const before = await queue.queuedCellsBySampling(client);
    const three = [0, 1, 2].map((frame) => ({ action: 'a', direction: 's', frame }));
    await queue.createRedraw(client, fresh, three);
    const after = await queue.queuedCellsBySampling(client);
    const guided = (rows) => rows.filter((g) => g.sampling === 'guided' && g.provider_id == null)
      .reduce((n, g) => n + g.cells, 0);
    assert.equal(guided(after) - guided(before), 3, 'the redraw keeps its source preset and counts marked frames');
    const sum = (rows) => rows.reduce((n, g) => n + g.cells, 0);
    assert.equal(sum(after), await queue.queuedCells(client), 'groups add up to queuedCells');
  }, { snapshot: true });
});

test('requeueHalted keeps box_job_id on a redraw row and clears box_task_id', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { source } = await doneSource(client);
    const redraw = await queue.createRedraw(client, source, FRAMES);
    await client.query("UPDATE sprite_sets SET status = 'running', claimed_at = now() WHERE id = $1", [redraw.id]);
    await queue.attachRedrawTask(client, redraw.id, 'task-1');
    const back = await queue.requeueHalted(client, redraw.id);
    assert.equal(back.status, 'queued');
    assert.equal(back.box_job_id, source.box_job_id);
    assert.equal(back.box_task_id, null);
  });
});

test('requeueHalted with keepTask keeps box_task_id (the cancel failed, the task may still run)', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { source } = await doneSource(client);
    const redraw = await queue.createRedraw(client, source, FRAMES);
    await client.query("UPDATE sprite_sets SET status = 'running', claimed_at = now() WHERE id = $1", [redraw.id]);
    await queue.attachRedrawTask(client, redraw.id, 'task-1');
    const back = await queue.requeueHalted(client, redraw.id, { keepTask: true });
    assert.equal(back.status, 'queued');
    assert.equal(back.box_job_id, source.box_job_id);
    assert.equal(back.box_task_id, 'task-1');
    const off = await queue.requeueHalted(client, redraw.id, { keepTask: false });
    assert.equal(off, null, 'already queued');
  });
});

test('attachRedrawTask sets box_task_id; recordRedrawSheet sets only the keys', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { source } = await doneSource(client);
    const redraw = await queue.createRedraw(client, source, FRAMES);
    const attached = await queue.attachRedrawTask(client, redraw.id, 'task-9');
    assert.equal(attached.box_task_id, 'task-9');
    const rec = await queue.recordRedrawSheet(client, redraw.id, { atlas_key: 'a2.json', manifest_key: 'm2.json' });
    assert.equal(rec.atlas_key, 'a2.json');
    assert.equal(rec.manifest_key, 'm2.json');
    assert.equal(rec.status, 'queued');
    assert.equal(rec.box_task_id, 'task-9');
  });
});

test('enqueue replaces a queued redraw with a fresh full sheet', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { entity, source } = await doneSource(client);
    const redraw = await queue.createRedraw(client, source, FRAMES);
    const out = await queue.enqueue(client, [{ entityId: entity.id }], { actions: ['idle'], framesPerAction: 4 });
    const { rows: gone } = await client.query('SELECT 1 FROM sprite_sets WHERE id = $1', [redraw.id]);
    assert.equal(gone.length, 0, 'the redraw row is deleted');
    assert.equal(out.updated.length, 0, 'never updated in place');
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].redraw_of, null);
    assert.equal(out.rows[0].redraw_frames, null);
    assert.deepEqual(out.rows[0].actions, ['idle']);
    assert.equal(out.rows[0].frames_per_action, 4);
  });
});

test('discardRedraw deletes queued and half-finished failed redraws only', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { source } = await doneSource(client);
    const mk = async (status, extra = '') => {
      // One live row per subject: park the previous one before making the next.
      await client.query("UPDATE sprite_sets SET status = 'done' WHERE redraw_of = $1 AND status IN ('queued','running')", [source.id]);
      const r = await queue.createRedraw(client, source, FRAMES);
      await client.query(`UPDATE sprite_sets SET status = $2 ${extra} WHERE id = $1`, [r.id, status]);
      return r;
    };
    const queued = await mk('queued');
    assert.equal(await queue.discardRedraw(client, queued.id), 'deleted');

    const failedWithSheet = await mk('failed', ", box_task_id = 't', atlas_key = 'a.json'");
    assert.equal(await queue.discardRedraw(client, failedWithSheet.id), 'not_discardable');

    const failedNoSheet = await mk('failed', ", box_task_id = 't'");
    assert.equal(await queue.discardRedraw(client, failedNoSheet.id), 'deleted');

    const done = await mk('done', ", box_task_id = 't', atlas_key = 'a.json'");
    assert.equal(await queue.discardRedraw(client, done.id), 'not_discardable');

    assert.equal(await queue.discardRedraw(client, source.id), 'not_found', 'a plain sheet row is not a redraw');
    assert.equal(await queue.discardRedraw(client, '00000000-0000-0000-0000-000000000000'), 'not_found');
  });
});

// ---- chosen directions (SOMET-686) ----------------------------------------
const ALL8 = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const FREE_PROP = `COALESCE(e.is_creature, false) = false AND COALESCE(e.is_playable, false) = false`;

test('enqueue stores chosen directions and flags real_western only when a western one is chosen', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [a, b, c] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 3`,
    );
    assert.ok(a && b && c, 'precondition: three free creatures');
    const opts = { actions: ['idle'], framesPerAction: 4 };
    const [all] = (await queue.enqueue(client, [{ entityId: a.id }], { ...opts, directions: ALL8 })).rows;
    assert.deepEqual(all.directions, ALL8);
    assert.equal(all.real_western, true);
    const [some] = (await queue.enqueue(client, [{ entityId: b.id }], { ...opts, directions: ['s', 'e'] })).rows;
    assert.deepEqual(some.directions, ['s', 'e']);
    assert.equal(some.real_western, false);
    const [dflt] = (await queue.enqueue(client, [{ entityId: c.id }], opts)).rows;
    assert.deepEqual(dflt.directions, ['s', 'e', 'n']);
    assert.equal(dflt.real_western, false);
  });
});

test('chosen directions never change a prop row', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [creature] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const { rows: [prop] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE ${FREE_PROP} AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const { rows } = await queue.enqueue(client, [{ entityId: creature.id }, { entityId: prop.id }],
      { actions: ['idle'], framesPerAction: 4, directions: ALL8 });
    const byEntity = new Map(rows.map((r) => [r.entity_type_id, r]));
    assert.deepEqual(byEntity.get(prop.id).directions, ['s']);
    assert.equal(byEntity.get(prop.id).real_western, false);
    assert.deepEqual(byEntity.get(creature.id).directions, ALL8);
    assert.equal(byEntity.get(creature.id).real_western, true);
  });
});

test('re-queuing with new directions updates the queued row in place and detaches its box job', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const opts = { actions: ['idle'], framesPerAction: 4 };
    const [first] = (await queue.enqueue(client, [{ entityId: e.id }], opts)).rows;
    await client.query(`UPDATE sprite_sets SET box_job_id = 'bj-1' WHERE id = $1`, [first.id]);
    const { updated } = await queue.enqueue(client, [{ entityId: e.id }], { ...opts, directions: ['s', 'w'] });
    assert.equal(updated[0].id, first.id);
    assert.deepEqual(updated[0].directions, ['s', 'w']);
    assert.equal(updated[0].real_western, true);
    assert.equal(updated[0].box_job_id, null);
    assert.equal(updated[0].dropped_box_job_id, 'bj-1');
  });
});

test('createRedraw copies real_western from the source', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { source } = await doneSource(client);
    await client.query('UPDATE sprite_sets SET real_western = true WHERE id = $1', [source.id]);
    const { rows: [fresh] } = await client.query('SELECT * FROM sprite_sets WHERE id = $1', [source.id]);
    const row = await queue.createRedraw(client, fresh, FRAMES);
    assert.equal(row.real_western, true);
  });
});

test('sampling is stored per creature row, a change detaches the queued box job, props never get it', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { rows: [a] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = true AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const opts = { actions: ['idle'], framesPerAction: 4 };
    const [row] = (await queue.enqueue(client, [{ entityId: a.id }], opts)).rows;
    assert.equal(row.sampling, null, 'omitted is NULL (box default)');
    await client.query(`UPDATE sprite_sets SET box_job_id = 'box-s' WHERE id = $1`, [row.id]);
    const moved = await queue.enqueue(client, [{ entityId: a.id }], { ...opts, sampling: 'guided' });
    assert.equal(moved.updated[0].sampling, 'guided');
    assert.equal(moved.updated[0].box_job_id, null);
    assert.equal(moved.updated[0].dropped_box_job_id, 'box-s');

    const { rows: [p] } = await client.query(
      `SELECT e.id FROM entity_types e WHERE e.is_creature = false AND e.is_playable = false AND ${FREE_ENTITY} ORDER BY e.id LIMIT 1`,
    );
    const [prop] = (await queue.enqueue(client, [{ entityId: p.id }], { actions: ['idle'], framesPerAction: 1, sampling: 'guided' })).rows;
    assert.equal(prop.sampling, null);
  });
});

test('createRedraw copies the source sampling preset', { skip }, async () => {
  await withRolledBackClient(async (client) => {
    const { source } = await doneSource(client);
    await client.query('UPDATE sprite_sets SET sampling = $2 WHERE id = $1', [source.id, 'sharp']);
    const { rows: [src] } = await client.query('SELECT * FROM sprite_sets WHERE id = $1', [source.id]);
    const row = await queue.createRedraw(client, src, FRAMES);
    assert.equal(row.sampling, 'sharp');
  });
});

