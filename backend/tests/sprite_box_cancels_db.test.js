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
  const box = stubBox({ jobs: [job('running', 'cell 3', 'u1'), job('running', 'cell 4', 'u2'), job('running', 'cell 5', 'u3')] });
  await verifyAt(pool, box, T0 + 70000); // baseline, already past grace
  let open = await verifyAt(pool, box, T0 + 85000); // change: the previous check was past grace
  let row = open.find((r) => r.box_job_id === 'bc-test-2');
  assert.equal(row.state, 'still_drawing');
  assert.equal(row.last_progress, 'cell 4');
  open = await verifyAt(pool, box, T0 + 100000);
  assert.equal(open.find((r) => r.box_job_id === 'bc-test-2').last_progress, 'cell 5');
}));

test('one change after grace, whose previous check was inside grace, is a finishing cell: stays stopping', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-2c', T0);
  const box = stubBox({ jobs: [job('running', 'cell 3', 'u1'), job('running', 'cell 4', 'u2'), job('cancelling', 'cell 4', 'u2')] });
  await verifyAt(pool, box, T0 + 50000);
  let open = await verifyAt(pool, box, T0 + 65000);
  assert.equal(open.find((r) => r.box_job_id === 'bc-test-2c').state, 'stopping');
  open = await verifyAt(pool, box, T0 + 70000);
  assert.equal(open.find((r) => r.box_job_id === 'bc-test-2c').state, 'stopping');
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
  const box = stubBox({ jobs: [job('cancelling', 'cell 3', 'u1')] });
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
  await verifyAt(pool, box, T0 + 205000);
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

test('a failing DELETE still records the row, with the error in send_error', { skip }, () => withPool(async (pool) => {
  const box = stubBox({ cancel: { ok: false, error: 'GPU box answered 500 for DELETE' } });
  const r = await req(pool, box, 'bc-test-7', T0);
  assert.equal(r.ok, false);
  assert.match(r.error, /500/);
  const rows = await mine(pool);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].send_error, 'GPU box answered 500 for DELETE');
  assert.equal(boxCancels.view(rows[0]).send_error, 'GPU box answered 500 for DELETE');
}));

test('the row exists before the DELETE is answered, stamped with the request time', { skip }, () => withPool(async (pool) => {
  let seen = null;
  const box = {
    cancelSheetJob: async () => { seen = (await mine(pool))[0]; return { ok: true }; },
  };
  let t = T0;
  await boxCancels.request(pool, PROVIDER, { boxJobId: 'bc-test-20', subject: 'Wolf', source: 'clear' }, {
    box, now: () => { const at = t; t += 3000; return at; },
  });
  assert.ok(seen, 'row was not written before the DELETE');
  assert.equal(seen.state, 'stopping');
  assert.equal(new Date(seen.requested_at).getTime(), T0);
}));

const FAILED = { ok: false, error: 'GPU box answered 500 for DELETE' };

test('a failed cancel on a job that never moves is never reported stopped', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox({ cancel: FAILED }), 'bc-test-21', T0);
  const idle = stubBox({ jobs: [job('queued', 'waiting', 'u1')] });
  await verifyAt(pool, idle, T0 + 1000);
  await verifyAt(pool, idle, T0 + 200000);
  const open = await verifyAt(pool, idle, T0 + 1000000);
  assert.equal(open.length >= 1, true);
  const row = (await mine(pool))[0];
  assert.equal(row.state, 'stopping');
  assert.equal(row.send_error, FAILED.error);
  assert.equal(row.last_progress, 'waiting');
}));

for (const status of ['done', 'failed', 'cancelled', 'missing']) {
  test(`a failed cancel closes once the box says the job is ${status}`, { skip }, () => withPool(async (pool) => {
    await req(pool, stubBox({ cancel: FAILED }), 'bc-test-22', T0);
    await verifyAt(pool, stubBox({ jobs: [job(status, 'x', 'u1')] }), T0 + 1000);
    assert.deepEqual(await mine(pool), []);
  }));
}

test('a refused cancel on a job the box is already cancelling drops the error and settles normally', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox({ cancel: FAILED }), 'bc-test-23', T0);
  const box = stubBox({ jobs: [job('cancelling', 'cell 3', 'u1')] });
  await verifyAt(pool, box, T0 + 1000);
  assert.equal((await mine(pool))[0].send_error, null);
  await verifyAt(pool, box, T0 + 1000 + OPTS.settleMs);
  assert.deepEqual(await mine(pool), []);
}));

test('a failed cancel is still closed by the age cap', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox({ cancel: FAILED }), 'bc-test-24', T0);
  await verifyAt(pool, stubBox({ jobs: [job('queued', 'waiting', 'u1')] }), T0 + 7 * 3600000);
  assert.deepEqual(await mine(pool), []);
}));

test('a retry that lands clears the send error; one that fails replaces it', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox({ cancel: FAILED }), 'bc-test-25', T0);
  await req(pool, stubBox({ cancel: { ok: false, error: 'second' } }), 'bc-test-25', T0 + 1000, 'retry');
  assert.equal((await mine(pool))[0].send_error, 'second');
  await req(pool, stubBox(), 'bc-test-25', T0 + 2000, 'retry');
  assert.equal((await mine(pool))[0].send_error, null);
}));

test('a slow failed DELETE does not stamp the error onto a newer request', { skip }, () => withPool(async (pool) => {
  const slow = {
    cancelSheetJob: async () => {
      await req(pool, stubBox(), 'bc-test-26', T0 + 5000, 'retry');
      return FAILED;
    },
  };
  await boxCancels.request(pool, PROVIDER, { boxJobId: 'bc-test-26', subject: 'Wolf', source: 'halt' }, { box: slow, now: () => T0 });
  assert.equal((await mine(pool))[0].send_error, null);
}));

test('a first verify long after the request only records a baseline', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-8', T0);
  const same = stubBox({ jobs: [job('running', 'cell 3', 'u1')] });
  let open = await verifyAt(pool, same, T0 + 200000);
  assert.equal(open.find((r) => r.box_job_id === 'bc-test-8').state, 'stopping', 'not settled on first sight');
  await verifyAt(pool, same, T0 + 200000 + 181000);
  assert.deepEqual(await mine(pool), []);

  await req(pool, stubBox(), 'bc-test-9', T0);
  const moving = stubBox({ jobs: [job('running', 'cell 3', 'u1'), job('running', 'cell 5', 'u3')] });
  await verifyAt(pool, moving, T0 + 200000);
  open = await verifyAt(pool, moving, T0 + 230000);
  assert.equal(open.find((r) => r.box_job_id === 'bc-test-9').state, 'still_drawing');
}));

test('settle boundary: unchanged at baseline+179 s stays open, at +181 s stopped', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-10', T0);
  const box = stubBox({ jobs: [job('cancelling', 'cell 3', 'u1')] });
  await verifyAt(pool, box, T0 + 10000);
  await verifyAt(pool, box, T0 + 10000 + 179000);
  assert.equal((await mine(pool)).length, 1);
  await verifyAt(pool, box, T0 + 10000 + 181000);
  assert.deepEqual(await mine(pool), []);
}));

test('a verify that raced a newer request does not overwrite the reset row', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-11', T0);
  await verifyAt(pool, stubBox({ jobs: [job('running', 'cell 3', 'u1')] }), T0 + 5000);
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { getSheetJob: async () => { await gate; return job('running', 'cell 9', 'u9'); } };
  const inFlight = verifyAt(pool, slow, T0 + 90000);
  await new Promise((r) => setTimeout(r, 100));
  await req(pool, stubBox(), 'bc-test-11', T0 + 91000, 'retry');
  release();
  await inFlight;
  const [row] = await mine(pool);
  assert.equal(row.state, 'stopping');
  assert.equal(new Date(row.requested_at).getTime(), T0 + 91000);
  assert.equal(row.checked_at, null);
  assert.equal(row.last_box_updated_at, null);
}));

test('an unknown box status counts as a progress observation (raw status), not an untouched row', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-12', T0);
  const unknown = { ok: false, error: 'unknown job status "winding-down"', rawStatus: 'winding-down', progress: {}, updatedAt: null };
  const box = stubBox({ jobs: [unknown] });
  await verifyAt(pool, box, T0 + 10000);
  const [row] = await mine(pool);
  assert.equal(row.last_progress, 'winding-down');
  assert.ok(row.checked_at);
  await verifyAt(pool, box, T0 + 10000 + 181000);
  assert.deepEqual(await mine(pool), []);
}));

test('an open row older than the max age is given up on', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-13', T0);
  const box = stubBox({ jobs: [{ ok: false, error: 'box down' }] });
  const HOUR = 3600000;
  await verifyAt(pool, box, T0 + 5 * HOUR);
  assert.equal((await mine(pool)).length, 1);
  await verifyAt(pool, box, T0 + 6 * HOUR + 1000);
  assert.deepEqual(await mine(pool), []);
  const { rows } = await pool.query("SELECT state, last_progress, stopped_at FROM sprite_box_cancels WHERE box_job_id = 'bc-test-13'");
  assert.equal(rows[0].state, 'stopped');
  assert.equal(rows[0].last_progress, 'gave up verifying after 6 h');
  assert.ok(rows[0].stopped_at);
}));

test('the give-up message names the configured max age in hours (SOMET-700)', { skip }, () => withPool(async (pool) => {
  const HOUR = 3600000;
  const prev = process.env.SPRITE_CANCEL_MAX_AGE_MS;
  process.env.SPRITE_CANCEL_MAX_AGE_MS = String(1.5 * HOUR);
  try {
    await req(pool, stubBox(), 'bc-test-14', T0);
    await verifyAt(pool, stubBox({ jobs: [{ ok: false, error: 'box down' }] }), T0 + 2 * HOUR);
  } finally {
    if (prev === undefined) delete process.env.SPRITE_CANCEL_MAX_AGE_MS; else process.env.SPRITE_CANCEL_MAX_AGE_MS = prev;
  }
  const { rows } = await pool.query("SELECT last_progress FROM sprite_box_cancels WHERE box_job_id = 'bc-test-14'");
  assert.equal(rows[0].last_progress, 'gave up verifying after 1.5 h');
}));

test('box status cancelled stops the row at once, no settle wait (SOMET-707)', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-c1', T0);
  const box = stubBox({ jobs: [job('cancelled', 'stopped', 'u1')] });
  const open = await verifyAt(pool, box, T0 + 5000);
  assert.equal(open.find((r) => r.box_job_id === 'bc-test-c1'), undefined);
}));

test('box status cancelling keeps watching and flags still_drawing when progress moves past grace (SOMET-707)', { skip }, () => withPool(async (pool) => {
  await req(pool, stubBox(), 'bc-test-c2', T0);
  const box = stubBox({ jobs: [job('cancelling', 'cell 3', 'u1'), job('cancelling', 'cell 4', 'u2')] });
  await verifyAt(pool, box, T0 + 70000);
  const open = await verifyAt(pool, box, T0 + 85000);
  assert.equal(open.find((r) => r.box_job_id === 'bc-test-c2').state, 'still_drawing');
}));
