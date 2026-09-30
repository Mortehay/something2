// backend/tests/describe_audio_slots_db.test.js
//
// run() against the real slot list, prompt store and catalog, with the model
// writer faked (or, for the race, the real writer over a faked text model).
//
// NO GLOBAL-STATE EXPECTATIONS (final review M2). The scratch DB is also the
// canary's: any prompt a batch run wrote there changes "how many slots are
// todo". Every case here therefore runs over creatures it picked at test time
// as having NO audio_prompts row at all, narrowed with run()'s `keys` filter,
// and deletes only those creatures' prompt rows afterwards. A creature is 4
// slots: hurt/death have a cue (writable), nearby/attack are upload-only.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { run, BOX_ONLY_BUSY_WAIT_LIMIT } = require('../scripts/describe-audio-slots');
const audioPrompts = require('../src/services/audioPrompts');
const writer = require('../src/services/audioPromptWriter');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const noStyles = async () => ({ music: [], ambience: [] });

// Creatures with no prompt row of any kind (active or history), so deleting
// every row for them afterwards removes only what this file wrote. DESC so
// this file and audio_generation_prompts_db (which takes the first by name
// ASC) do not reach for the same creature.
async function freshCreatures(pool, n) {
  const names = (await pool.query(
    `SELECT e.name FROM entity_types e
      WHERE e.is_creature AND NOT EXISTS (
        SELECT 1 FROM audio_prompts p WHERE p.subject_kind = 'creature' AND p.subject_key = e.name)
      ORDER BY e.name DESC LIMIT $1`, [n])).rows.map((r) => r.name);
  assert.equal(names.length, n, `need ${n} creatures with no prompt rows on the scratch DB`);
  return names;
}

function setup(t, n = 3) {
  const pool = new Pool({ connectionString: url });
  const ctx = { pool, keys: [] };
  t.after(async () => {
    try {
      if (ctx.keys.length) {
        await pool.query("DELETE FROM audio_prompts WHERE subject_kind = 'creature' AND subject_key = ANY($1)", [ctx.keys]);
      }
    } finally { await pool.end(); }
  });
  return (async () => { ctx.keys = await freshCreatures(pool, n); return ctx; })();
}

const okWrite = (writes) => async (db, target, opts) => {
  writes.push({ target, opts });
  return { ok: true, row: { via: 'box', text: `t${writes.length}`, style: null } };
};

test('dry run: only the chosen subjects, upload-only slots reported not written', { skip }, async (t) => {
  const { pool, keys } = await setup(t);
  const writes = [];
  const logs = [];
  const dry = await run(pool, { kinds: ['creature'], keys, dryRun: true },
    { log: (l) => logs.push(l), write: okWrite(writes), loadStyles: noStyles });
  assert.equal(writes.length, 0, 'dry run writes nothing');
  assert.equal(dry.todo, 6, '3 creatures x (hurt, death); nearby/attack have no cue');
  assert.ok(logs.some((l) => /6 upload-only/.test(l)), `upload-only slots are reported: ${logs[0]}`);
});

test('busy under --box-only waits and retries the SAME slot; cue and expectation passed', { skip }, async (t) => {
  const { pool, keys } = await setup(t);
  const writes = [];
  const write = okWrite(writes);
  let busyOnce = true;
  const flaky = async (db, target, opts) => {
    if (busyOnce) { busyOnce = false; return { ok: false, busy: true, error: '409' }; }
    return write(db, target, opts);
  };
  const slept = [];
  const sum = await run(pool, { kinds: ['creature'], keys, slot: 'hurt', boxOnly: true },
    { log: () => {}, write: flaky, sleep: async (ms) => { slept.push(ms); }, loadStyles: noStyles });
  assert.equal(slept.length, 1);
  assert.equal(sum.creature.written, 3);
  assert.equal(writes.every((w) => w.opts.boxOnly === true), true);
  assert.equal(writes.every((w) => w.opts.cue === 'hit'), true, 'cue is passed for sfx slots');
  assert.equal(writes.every((w) => w.opts.expectActiveId === null), true, 'a missing slot expects NO active prompt');
});

test('--box-only gives up after a bounded number of consecutive busy waits', { skip }, async (t) => {
  const { pool, keys } = await setup(t, 1);
  let calls = 0;
  const slept = [];
  const logs = [];
  await run(pool, { kinds: ['creature'], keys, boxOnly: true }, {
    log: (l) => logs.push(l),
    write: async () => { calls += 1; return { ok: false, busy: true, error: 'text service answered 503' }; },
    sleep: async (ms) => { slept.push(ms); },
    loadStyles: noStyles,
  });
  assert.equal(slept.length, BOX_ONLY_BUSY_WAIT_LIMIT, 'waits exactly the limit, never forever');
  assert.equal(calls, BOX_ONLY_BUSY_WAIT_LIMIT + 1);
  assert.ok(logs.some((l) => new RegExp(`busy, waiting \\(wait 3/${BOX_ONLY_BUSY_WAIT_LIMIT}, \\d+s elapsed\\)`).test(l)), 'running count + elapsed are logged');
  assert.ok(logs.some((l) => /stopping: the text box stayed busy or unreachable/.test(l)), 'the stop is logged');
});

test('5 consecutive non-busy failures stop the run', { skip }, async (t) => {
  const { pool, keys } = await setup(t);
  const calls = [];
  const write = async (db, target) => { calls.push(target); return { ok: false, busy: false, error: 'x' }; };
  const logs = [];
  await run(pool, { kinds: ['creature'], keys }, { log: (l) => logs.push(l), write, loadStyles: noStyles });
  assert.equal(calls.length, 5, 'stops after the 5th consecutive failure, out of 6 writable slots');
  assert.ok(logs.some((l) => /stopping: 5 failures in a row/.test(l)), 'the stop is logged');
});

test('a success in between resets the consecutive-failure counter', { skip }, async (t) => {
  const { pool, keys } = await setup(t);
  const outcomes = ['fail', 'fail', 'ok', 'fail', 'fail', 'fail'];
  const calls = [];
  const write = async (db, target) => {
    const outcome = outcomes[calls.length];
    calls.push(target);
    return outcome === 'ok'
      ? { ok: true, row: { via: 'box', text: `r${calls.length}`, style: null } }
      : { ok: false, busy: false, error: 'x' };
  };
  await run(pool, { kinds: ['creature'], keys }, { log: () => {}, write, loadStyles: noStyles });
  assert.equal(calls.length, 6, 'the mid-run success resets the streak, so no run of 5 is ever reached');
});

// Final review I1: the batch picks its todo list from ONE snapshot at the
// start, and a full run lasts a day. A hand edit made after the snapshot
// must survive the batch reaching that slot. Real writer and real store;
// only the text model is faked. Every slot is hand-edited just before the
// batch saves, so all 6 conflict -- which must NOT trip the 5-in-a-row stop.
test('a slot hand-edited after the snapshot keeps the hand edit', { skip }, async (t) => {
  const { pool, keys } = await setup(t);
  const tp = { complete: async () => ({ ok: true, json: { entity: 'a model-written beast' }, model: 'q', via: 'box' }) };
  const handIds = new Map();
  const write = async (db, target, opts) => {
    const hand = await audioPrompts.save(db, target.kind, target.key, target.slot, { text: 'typed by an admin' }, { expectActiveId: null });
    handIds.set(`${target.key}/${target.slot}`, String(hand.id));
    return writer.writeSlotPrompt(db, target, { ...opts, tp });
  };
  const logs = [];
  const sum = await run(pool, { kinds: ['creature'], keys }, { log: (l) => logs.push(l), write, loadStyles: noStyles });
  assert.equal(handIds.size, 6);
  assert.deepEqual(
    { written: sum.creature.written, failed: sum.creature.failed, changedDuringRun: sum.creature.changedDuringRun },
    { written: 0, failed: 0, changedDuringRun: 6 },
  );
  assert.equal(logs.some((l) => /stopping/.test(l)), false, 'conflicts are skips, not failures');
  for (const [k, id] of handIds) {
    const [key, slot] = k.split('/');
    // eslint-disable-next-line no-await-in-loop
    const active = await audioPrompts.getActive(pool, 'creature', key, slot);
    assert.equal(String(active.id), id, `${k}: the hand edit is still active`);
    assert.equal(active.text, 'typed by an admin');
  }
});

// Final review M7: a --stale rewrite keeps the admin's steering hint, and
// expects the stale row it read (so a hand fix since the snapshot survives).
test('--stale rewrite passes the stored hint and the stale row id', { skip }, async (t) => {
  const { pool, keys } = await setup(t, 1);
  const row = await audioPrompts.save(pool, 'creature', keys[0], 'hurt', {
    text: 'old words', sourceInput: 'a context that no longer matches', hint: 'more squeaky', model: 'q', via: 'box',
  });
  const writes = [];
  const sum = await run(pool, { kinds: ['creature'], keys, stale: true }, { log: () => {}, write: okWrite(writes), loadStyles: noStyles });
  assert.equal(sum.creature.written, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].target.slot, writes[0].target.hint], ['hurt', 'more squeaky']);
  assert.equal(String(writes[0].opts.expectActiveId), String(row.id));
});
