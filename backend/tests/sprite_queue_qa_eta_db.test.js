const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const queue = require('../src/services/spriteJobQueue.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

// One transaction per test, rolled back, so nothing persists.
async function withTx(fn) {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [creature] } = await client.query(
      `SELECT id FROM entity_types WHERE is_creature = true AND is_playable IS NOT TRUE AND body_plan IS NULL ORDER BY id LIMIT 1`,
    );
    const { rows: [prop] } = await client.query(
      `SELECT id FROM entity_types WHERE is_creature IS NOT TRUE AND is_playable IS NOT TRUE ORDER BY id LIMIT 1`,
    );
    assert.ok(creature && prop, 'precondition: a creature and a prop entity');
    await client.query('DELETE FROM sprite_sets WHERE entity_type_id = ANY($1::int[])', [[creature.id, prop.id]]);
    await fn(client, creature.id, prop.id);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

test('enqueue with qualityChecks false stores false on creature rows, NULL on props', { skip }, () => withTx(async (db, c, p) => {
  const { rows } = await queue.enqueue(db, [{ entityId: c }, { entityId: p }], { qualityChecks: false });
  const byId = new Map(rows.map((r) => [r.entity_type_id, r]));
  assert.equal(byId.get(c).quality_checks, false);
  assert.equal(byId.get(p).quality_checks, null);
}));

test('qualityChecks defaults to false; true is stored; HQ provider rows store NULL', { skip }, () => withTx(async (db, c) => {
  const a = await queue.enqueue(db, [{ entityId: c }]);
  assert.equal(a.rows[0].quality_checks, false);
  await db.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [c]);
  const b = await queue.enqueue(db, [{ entityId: c }], { qualityChecks: true });
  assert.equal(b.rows[0].quality_checks, true);
  await db.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [c]);
  const { rows: [prov] } = await db.query('SELECT id FROM sprite_providers ORDER BY id LIMIT 1').catch(() => ({ rows: [] }));
  if (prov) {
    const h = await queue.enqueue(db, [{ entityId: c }], { qualityChecks: true, providerId: prov.id, hqProviderIds: new Set([prov.id]) });
    assert.equal(h.rows[0].quality_checks, null);
  }
}));

test('re-queue of a queued row changing only qualityChecks detaches its box_job_id and returns it as dropped_box_job_id', { skip }, () => withTx(async (db, c) => {
  const { rows: [r] } = await queue.enqueue(db, [{ entityId: c }], { qualityChecks: false });
  await db.query(`UPDATE sprite_sets SET box_job_id = 'box-1', job_id = 'box-1' WHERE id = $1`, [r.id]);
  const { updated } = await queue.enqueue(db, [{ entityId: c }], { qualityChecks: true });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].box_job_id, null);
  assert.equal(updated[0].dropped_box_job_id, 'box-1');
  assert.equal(updated[0].quality_checks, true);
}));

test('re-queue with the same qualityChecks keeps box_job_id', { skip }, () => withTx(async (db, c) => {
  const { rows: [r] } = await queue.enqueue(db, [{ entityId: c }], { qualityChecks: false });
  await db.query(`UPDATE sprite_sets SET box_job_id = 'box-1', job_id = 'box-1' WHERE id = $1`, [r.id]);
  const { updated } = await queue.enqueue(db, [{ entityId: c }], { qualityChecks: false });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].box_job_id, 'box-1');
  assert.equal(updated[0].dropped_box_job_id, null);
}));

test('calibratedSecondsPerCell ignores QA-on, NULL-QA, redraw and sheet_seconds-NULL rows and returns null under 3 samples', { skip }, () => withTx(async (db, c) => {
  const { calibrateSecondsPerCell, cellsOf } = require('../src/services/spriteEta.js');
  const sampling = 'calib-test';
  // 6 actions x 5 rendered facings x 4 frames, 8 requested facings.
  const dirs = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
  const acts = ['idle', 'walk', 'attack', 'cast', 'damage', 'death'];
  const ins = async ({ qa, seconds, redrawOf = null, status = 'done' }) => {
    const { rows: [row] } = await db.query(
      `INSERT INTO sprite_sets (entity_type_id, creature, generation_kind, base_prompt, backend, seed, frames, status,
                                actions, directions, frames_per_action, sampling, quality_checks, sheet_seconds, redraw_of, finished_at)
       VALUES ($1, 'calib-test', 'creature', 'x', 'gpu-box', 1, 4, $2, $3, $4, 4, $5, $6, $7, $8, now()) RETURNING id`,
      [c, status, acts, dirs, sampling, qa, seconds, redrawOf],
    );
    return row.id;
  };
  const cells = cellsOf({ actions: acts, directions: dirs, frames: 4 });
  const sec = (spc) => 85 + spc * 8 + 0.6 * cells + spc * cells;
  const base = await ins({ qa: false, seconds: sec(30) });
  await ins({ qa: false, seconds: sec(40) });
  // Excluded kinds.
  await ins({ qa: true, seconds: sec(100) });
  await ins({ qa: null, seconds: sec(100) });
  await ins({ qa: false, seconds: null });
  await ins({ qa: false, seconds: sec(100), redrawOf: base });
  await ins({ qa: false, seconds: sec(100), status: 'failed' });
  assert.equal(await queue.calibratedSecondsPerCell(db, { sampling }), null);
  await ins({ qa: false, seconds: sec(50) });
  const m = await queue.calibratedSecondsPerCell(db, { sampling });
  assert.ok(Math.abs(m - 40) < 1e-6, `median ${m}`);
  assert.ok(Math.abs(calibrateSecondsPerCell({ sheetSeconds: sec(40), cells, requestedFacings: 8 }) - 40) < 1e-6);
  assert.equal(await queue.calibratedSecondsPerCell(db, { sampling: 'other-sampling' }), null);
}));

test('setPredicted writes predicted_seconds by id', { skip }, () => withTx(async (db, c, p) => {
  const { rows } = await queue.enqueue(db, [{ entityId: c }, { entityId: p }]);
  await queue.setPredicted(db, rows.map((r, i) => ({ id: r.id, seconds: 100 + i })));
  const { rows: got } = await db.query('SELECT id, predicted_seconds FROM sprite_sets WHERE id = ANY($1::uuid[]) ORDER BY id', [rows.map((r) => r.id)]);
  const want = new Map(rows.map((r, i) => [r.id, 100 + i]));
  for (const g of got) assert.equal(g.predicted_seconds, want.get(g.id));
  await queue.setPredicted(db, []);
}));

test('default creature actions are the seven', { skip }, () => withTx(async (db, c) => {
  const { rows: [r] } = await queue.enqueue(db, [{ entityId: c }]);
  assert.deepEqual(r.actions, ['idle', 'walk', 'attack', 'cast', 'damage', 'death', 'use']);
}));
