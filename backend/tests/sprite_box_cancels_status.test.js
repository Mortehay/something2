// SOMET-707: verify() against the box's cancel contract, with an in-memory db
// so it runs without a database. The SQL text is only inspected for which
// branch wrote; the row state is what the real queries would have produced.
const test = require('node:test');
const assert = require('node:assert/strict');
const boxCancels = require('../src/services/spriteBoxCancels.js');

const T0 = Date.parse('2026-11-02T12:00:00Z');
const OPTS = { settleMs: 180000, graceMs: 60000 };
const PROVIDER = { id: 'p1' };

function fakeDb(initial) {
  const row = { id: 1, box_job_id: 'j1', state: 'stopping', requested_at: new Date(T0), last_box_updated_at: null, last_change_at: null, checked_at: null, last_progress: null, ...initial };
  return {
    row,
    async query(sql, params) {
      if (/^\s*SELECT/.test(sql)) return { rows: row.state === 'stopped' ? [] : [{ ...row }] };
      const at = (ms) => new Date(ms);
      if (/state = 'stopped', stopped_at/.test(sql)) { row.state = 'stopped'; } else if (/SET state = \$2, last_box_updated_at = \$3, last_progress = \$4/.test(sql)) {
        [, row.state, row.last_box_updated_at, row.last_progress] = params; row.last_change_at = at(params[4]); row.checked_at = at(params[4]);
      } else if (/SET last_box_updated_at = \$2, last_progress/.test(sql)) {
        [, row.last_box_updated_at] = params; row.last_change_at = at(params[3]); row.checked_at = at(params[3]);
      } else if (/COALESCE\(\$3, last_box_updated_at\)/.test(sql)) {
        row.state = params[1]; row.checked_at = at(params[4]);
      } else throw new Error(`unexpected sql ${sql}`);
      return { rows: [] };
    },
  };
}
const stub = (jobs) => { let i = 0; return { getSheetJob: async () => jobs[Math.min(i++, jobs.length - 1)] }; };
const job = (status, message, updatedAt, finishedAt, stage) => ({
  ok: true, job: { status, progress: { message, stage }, updatedAt, ...(finishedAt ? { finishedAt } : {}) },
});
// A job the box had started: its record carries the stage it reached.
const startedCancelling = (message, updatedAt) => job('cancelling', message, updatedAt, undefined, 'turnaround-denoise');
const verifyAt = (db, box, at) => boxCancels.verify(db, PROVIDER, { box, now: () => at, ...OPTS });

test('cancelled with finished_at stops the row on the first look, with no settle wait', async () => {
  const db = fakeDb();
  const open = await verifyAt(db, stub([job('cancelled', 'x', 'u1', 'f1')]), T0 + 5000);
  assert.equal(db.row.state, 'stopped');
  assert.deepEqual(open, []);
});

test('cancelling is not stopped: baseline, then unchanged inside the settle window stays open', async () => {
  const db = fakeDb();
  const box = stub([job('cancelling', 'cell 3', 'u1')]);
  await verifyAt(db, box, T0 + 5000);
  const open = await verifyAt(db, box, T0 + 60000);
  assert.equal(open.length, 1);
  assert.equal(db.row.state, 'stopping');
});

test('cancelling with progress moving past grace flags still_drawing', async () => {
  const db = fakeDb();
  const box = stub([job('cancelling', 'cell 3', 'u1'), job('cancelling', 'cell 4', 'u2')]);
  await verifyAt(db, box, T0 + 70000);
  await verifyAt(db, box, T0 + 85000);
  assert.equal(db.row.state, 'still_drawing');
});

test('a box that never reports cancelled still settles after an unchanged window', async () => {
  const db = fakeDb();
  const box = stub([job('running', 'cell 3', 'u1')]);
  await verifyAt(db, box, T0 + 5000);
  await verifyAt(db, box, T0 + 5000 + 181000);
  assert.equal(db.row.state, 'stopped');
});

test('cancelled without finished_at is no proof the task exited: it takes the settle path', async () => {
  const db = fakeDb();
  const box = stub([job('cancelled', 'cell 3', 'u1')]);
  await verifyAt(db, box, T0 + 5000);
  assert.equal(db.row.state, 'stopping', 'first look is only a baseline');
  await verifyAt(db, box, T0 + 5000 + 179000);
  assert.equal(db.row.state, 'stopping', 'not yet 180 s');
  await verifyAt(db, box, T0 + 5000 + 181000);
  assert.equal(db.row.state, 'stopped');
});

test('cancelled without finished_at whose progress keeps moving is still_drawing', async () => {
  const db = fakeDb();
  const box = stub([job('cancelled', 'cell 3', 'u1'), job('cancelled', 'cell 4', 'u2')]);
  await verifyAt(db, box, T0 + 70000);
  await verifyAt(db, box, T0 + 85000);
  assert.equal(db.row.state, 'still_drawing');
});

// The real run: box job c112b01c read `cancelling` from before 12:48:26 until the
// box failed it at 15:03:56; the row said stopped at 12:48:26.
test('a started job reading cancelling never settles, however long it stays unchanged', async () => {
  const db = fakeDb();
  const box = stub([startedCancelling('cancelling by request', 'u1')]);
  await verifyAt(db, box, T0 + 5000);
  for (const dt of [181000, 3600000, 2 * 3600000 + 15 * 60000]) {
    // eslint-disable-next-line no-await-in-loop
    const open = await verifyAt(db, box, T0 + 5000 + dt);
    assert.equal(open.length, 1, `open after ${dt} ms`);
    assert.equal(db.row.state, 'stopping');
  }
});

test('a long cancelling ends the moment the box says cancelled with finished_at', async () => {
  const db = fakeDb();
  const box = stub([startedCancelling('cell 3', 'u1'), startedCancelling('cell 3', 'u1'), job('cancelled', 'done', 'u2', 'f2')]);
  await verifyAt(db, box, T0 + 5000);
  await verifyAt(db, box, T0 + 5000 + 218000);
  assert.equal(db.row.state, 'stopping');
  await verifyAt(db, box, T0 + 5000 + 219000);
  assert.equal(db.row.state, 'stopped');
});

// The rest of the c112b01c run: polled for hours, then the box closed the job as
// failed. The new updated_at must not read as "still drawing, it ignored the cancel".
for (const [status, label] of [['failed', 'fails'], ['done', 'finishes']]) {
  test(`a long cancelling the box then ${label} closes at once, never still_drawing`, async () => {
    const db = fakeDb();
    const box = stub([
      startedCancelling('cancelling by request', 'u1'),
      startedCancelling('cancelling by request', 'u1'),
      job(status, 'stranded', 'u2', 'f2', 'turnaround-denoise'),
    ]);
    await verifyAt(db, box, T0 + 5000);
    await verifyAt(db, box, T0 + 3600000);
    const open = await verifyAt(db, box, T0 + 3600000 + 1500);
    assert.deepEqual(open, []);
    assert.equal(db.row.state, 'stopped');
  });
}

test('a started job reading cancelling is still given up on at the max age', async () => {
  const db = fakeDb();
  const box = stub([startedCancelling('cancelling by request', 'u1')]);
  await verifyAt(db, box, T0 + 5000);
  await boxCancels.verify(db, PROVIDER, { box, now: () => T0 + 6 * 3600000 + 1000, ...OPTS, maxAgeMs: 6 * 3600000 });
  assert.equal(db.row.state, 'stopped');
});

// The real run: box job 9530ff16 was cancelled 180 ms after it was created, so
// stage stayed null, and it still read cancelling an hour later while newer jobs
// ran on the card. It holds nothing, so "the box is busy with it" would be false.
test('a job that never started reading cancelling settles after the unchanged window', async () => {
  const db = fakeDb();
  const box = stub([job('cancelling', 'cancelling by request', 'u1', undefined, null)]);
  await verifyAt(db, box, T0 + 5000);
  await verifyAt(db, box, T0 + 5000 + 179000);
  assert.equal(db.row.state, 'stopping', 'not yet 180 s');
  await verifyAt(db, box, T0 + 5000 + 181000);
  assert.equal(db.row.state, 'stopped');
});

test('a started job the box reads as anything but cancelling still takes the settle path', async () => {
  const db = fakeDb();
  const box = stub([job('running', 'cell 3', 'u1', undefined, 'actions-denoise')]);
  await verifyAt(db, box, T0 + 5000);
  await verifyAt(db, box, T0 + 5000 + 181000);
  assert.equal(db.row.state, 'stopped');
});

// Through the real box client and its JSON, not a shaped stub: the stop proof and
// the started/never-started split both hang on field names the client maps.
const realBox = (t, body) => t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
const REAL_PROVIDER = { id: 'p1', base_url: 'http://box.test:8001', request_template: {} };
const realVerify = (db, at) => boxCancels.verify(db, REAL_PROVIDER, { now: () => at, ...OPTS });

test('real client: cancelled with finished_at stops at once; a started cancelling stays open', async (t) => {
  const started = { status: 'cancelling', stage: 'turnaround-denoise', progress_msg: 'cancelling by request', updated_at: 'u1', finished_at: null };
  realBox(t, started);
  const open = fakeDb();
  await realVerify(open, T0 + 5000);
  await realVerify(open, T0 + 5000 + 181000);
  assert.equal(open.row.state, 'stopping');

  t.mock.restoreAll();
  realBox(t, { status: 'cancelled', stage: 'turnaround-denoise', progress_msg: 'cancelled during turnaround-denoise', updated_at: 'u2', finished_at: '2026-11-04T23:11:49Z' });
  const closed = fakeDb();
  await realVerify(closed, T0 + 5000);
  assert.equal(closed.row.state, 'stopped');
});

test('real client: a never-started cancelling (stage null) settles', async (t) => {
  realBox(t, { status: 'cancelling', stage: null, progress_msg: 'cancelling by request', updated_at: 'u1', finished_at: null });
  const db = fakeDb();
  await realVerify(db, T0 + 5000);
  await realVerify(db, T0 + 5000 + 181000);
  assert.equal(db.row.state, 'stopped');
});
