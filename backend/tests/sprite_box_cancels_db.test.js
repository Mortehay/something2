const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const boxCancels = require('../src/services/spriteBoxCancels.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const PROVIDER = { id: 'p1' };
const T0 = Date.parse('2026-11-02T12:00:00Z');
const OPTS = { settleMs: 180000, graceMs: 60000 };

// A stub box: getSheetJob answers from a scripted list; cancelSheetJob from `cancel`.
function stubBox({ jobs = [], cancel = { ok: true } } = {}) {
  let i = 0;
  return {
    cancelled: [],
    cancelSheetJob: async function cancelSheetJob(_p, id) { this.cancelled.push(id); return cancel; },
    getSheetJob: async () => jobs[Math.min(i++, jobs.length - 1)],
  };
}
const job = (status, message, updatedAt) => ({ ok: true, job: { status, progress: { message }, updatedAt: updatedAt || null } });

async function withPool(fn) {
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query("DELETE FROM sprite_box_cancels WHERE box_job_id LIKE 'bc-test-%'");
    await fn(pool);
  } finally {
    await pool.query("DELETE FROM sprite_box_cancels WHERE box_job_id LIKE 'bc-test-%'").catch(() => {});
    await pool.end();
  }
}
const mine = async (pool) => (await boxCancels.open(pool)).filter((r) => r.box_job_id.startsWith('bc-test-'));
const req = (pool, box, id, at, source = 'halt') => boxCancels.request(
  pool, PROVIDER, { boxJobId: id, subject: 'Wolf', source }, { box, now: () => at },
);
const verifyAt = (pool, box, at) => boxCancels.verify(pool, PROVIDER, { box, now: () => at, ...OPTS });

test('request records a stopping row; asking again keeps one open row with a newer requested_at', { skip }, () => withPool(async (pool) => {
  const box = stubBox();
  assert.deepEqual(await req(pool, box, 'bc-test-1', T0), { ok: true });
  let rows = await mine(pool);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'stopping');
  assert.equal(new Date(rows[0].requested_at).getTime(), T0);
  await req(pool, box, 'bc-test-1', T0 + 30000, 'clear');
  rows = await mine(pool);
  assert.equal(rows.length, 1);
  assert.equal(new Date(rows[0].requested_at).getTime(), T0 + 30000);
  assert.equal(rows[0].source, 'clear');
  assert.deepEqual(box.cancelled, ['bc-test-1', 'bc-test-1']);
}));

test('progress still changing after the grace window is still_drawing', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-2', T0);
  const box = stubBox({ jobs: [job('running', 'cell 3', 'u1'), job('running', 'cell 4', 'u2')] });
  await verifyAt(pool, box, T0 + 10000); // baseline
  const open = await verifyAt(pool, box, T0 + 61000);
  const row = open.find((r) => r.box_job_id === 'bc-test-2');
  assert.equal(row.state, 'still_drawing');
  assert.equal(row.last_progress, 'cell 4');
}));

test('progress changing inside the grace window stays stopping', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-2b', T0);
  const box = stubBox({ jobs: [job('running', 'cell 3', 'u1'), job('running', 'cell 4', 'u2')] });
  await verifyAt(pool, box, T0 + 5000);
  const open = await verifyAt(pool, box, T0 + 20000);
  assert.equal(open.find((r) => r.box_job_id === 'bc-test-2b').state, 'stopping');
}));

test('progress unchanged for the settle window is stopped and no longer open', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-3', T0);
  const box = stubBox({ jobs: [job('cancelled', 'cell 3', 'u1')] });
  await verifyAt(pool, box, T0 + 10000);
  assert.equal((await mine(pool)).length, 1);
  await verifyAt(pool, box, T0 + 179000);
  assert.equal((await mine(pool)).length, 1, 'not yet 180 s');
  await verifyAt(pool, box, T0 + 190000);
  assert.deepEqual(await mine(pool), []);
  const { rows } = await pool.query("SELECT state, stopped_at FROM sprite_box_cancels WHERE box_job_id = 'bc-test-3'");
  assert.equal(rows[0].state, 'stopped');
  assert.ok(rows[0].stopped_at);
}));

test('a job the box never started (queued, same message) becomes stopped, never still_drawing', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-4', T0);
  const box = stubBox({ jobs: [job('queued', 'waiting for a worker')] });
  for (const dt of [20000, 70000, 130000]) {
    const open = await verifyAt(pool, box, T0 + dt);
    assert.equal(open.find((r) => r.box_job_id === 'bc-test-4').state, 'stopping');
  }
  await verifyAt(pool, box, T0 + 185000);
  assert.deepEqual(await mine(pool), []);
}));

test('a box that no longer has the job is stopped at once', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-5', T0);
  await verifyAt(pool, stubBox({ jobs: [{ ok: true, job: { status: 'missing' } }] }), T0 + 1000);
  assert.deepEqual(await mine(pool), []);
}));

test('a failing GET leaves the row untouched, even past the settle window', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-6', T0);
  const before = (await mine(pool))[0];
  const box = stubBox({ jobs: [{ ok: false, error: 'box down' }] });
  const open = await verifyAt(pool, box, T0 + 900000);
  const after = open.find((r) => r.box_job_id === 'bc-test-6');
  assert.equal(after.state, 'stopping');
  assert.equal(after.checked_at, before.checked_at);
  const thrower = { getSheetJob: async () => { throw new Error('socket hang up'); } };
  assert.equal((await verifyAt(pool, thrower, T0 + 900000)).filter((r) => r.box_job_id === 'bc-test-6').length, 1);
}));

test('a failing DELETE still records the row, with the error in last_progress', { skip }, () => withPool(async (pool) => {
  const box = stubBox({ cancel: { ok: false, error: 'GPU box answered 500 for DELETE' } });
  const r = await req(pool, box, 'bc-test-7', T0);
  assert.equal(r.ok, false);
  assert.match(r.error, /500/);
  const rows = await mine(pool);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last_progress, 'GPU box answered 500 for DELETE');
}));
