// backend/tests/describe_audio_slots_db.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { run } = require('../scripts/describe-audio-slots');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('describe-audio-slots run()', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());
  const writes = [];
  const write = async (db, target, opts) => { writes.push({ target, opts }); return { ok: true, row: { via: 'box', text: `t${writes.length}`, style: null } }; };
  const logs = [];
  const dry = await run(pool, { kinds: ['attack_type'], dryRun: true }, { log: (l) => logs.push(l), write, loadStyles: async () => ({ music: [], ambience: [] }) });
  assert.equal(writes.length, 0, 'dry run writes nothing');
  assert.equal(dry.todo, 6, '3 attack types x 2 slots on a clean scratch DB');

  let busyOnce = true;
  const flaky = async (db, target, opts) => {
    if (busyOnce) { busyOnce = false; return { ok: false, busy: true, error: '409' }; }
    return write(db, target, opts);
  };
  const slept = [];
  const sum = await run(pool, { kinds: ['attack_type'], slot: 'use', boxOnly: true },
    { log: () => {}, write: flaky, sleep: async (ms) => { slept.push(ms); }, loadStyles: async () => ({ music: [], ambience: [] }) });
  assert.equal(slept.length, 1, 'busy under --box-only waits once and retries the SAME slot');
  assert.equal(sum.attack_type.written, 3);
  assert.equal(writes.every((w) => w.opts.boxOnly === true), true);
  assert.ok(writes.some((w) => w.opts.cue === 'slash'), 'cue is passed for sfx slots');
});

test('5 consecutive non-busy failures stop the run', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());
  const calls = [];
  const write = async (db, target) => { calls.push(target); return { ok: false, busy: false, error: 'x' }; };
  const logs = [];
  await run(pool, { kinds: ['attack_type'] },
    { log: (l) => logs.push(l), write, loadStyles: async () => ({ music: [], ambience: [] }) });
  assert.equal(calls.length, 5, 'stops after the 5th consecutive failure, out of 6 attack_type slots');
  assert.ok(logs.some((l) => /stopping: 5 failures in a row/.test(l)), 'the stop is logged');
});

test('a success in between resets the consecutive-failure counter', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());
  const outcomes = ['fail', 'fail', 'ok', 'fail', 'fail', 'fail'];
  const calls = [];
  const write = async (db, target) => {
    const outcome = outcomes[calls.length];
    calls.push(target);
    return outcome === 'ok'
      ? { ok: true, row: { via: 'box', text: `r${calls.length}`, style: null } }
      : { ok: false, busy: false, error: 'x' };
  };
  await run(pool, { kinds: ['attack_type'] },
    { log: () => {}, write, loadStyles: async () => ({ music: [], ambience: [] }) });
  assert.equal(calls.length, 6, 'the mid-run success resets the streak, so no run of 5 is ever reached');
});
