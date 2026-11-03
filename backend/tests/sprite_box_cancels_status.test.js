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
const job = (status, message, updatedAt) => ({ ok: true, job: { status, progress: { message }, updatedAt } });
const verifyAt = (db, box, at) => boxCancels.verify(db, PROVIDER, { box, now: () => at, ...OPTS });

test('cancelled stops the row on the first look, with no settle wait', async () => {
  const db = fakeDb();
  const open = await verifyAt(db, stub([job('cancelled', 'x', 'u1')]), T0 + 5000);
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
