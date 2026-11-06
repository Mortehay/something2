// SOMET-721: the sprite batch lives only in backend memory, so a restart ended
// it and left its row 'running' with nothing draining the queue.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDispatcher, resumeInterruptedBatch } = require('../src/services/spriteDispatcher.js');

const ON = { SPRITE_RESUME_ON_BOOT: 'true' };

function fakes(stranded, start = async () => {}, problem = null, { providerIds = [null], live = null } = {}) {
  const calls = { requeue: [], start: 0, checked: [] };
  return {
    calls,
    db: { marker: 'db' },
    queue: {
      resumePlan: async () => ({ interrupted: stranded.length > 0, providerIds: stranded.length ? providerIds : [null] }),
      requeueStale: async (db, staleMs) => { calls.requeue.push({ db, staleMs }); return stranded; },
    },
    dispatcher: {
      start: () => { calls.start += 1; return start(); },
      boxProblem: async (ids) => { calls.checked.push(ids); return problem; },
      status: () => live,
    },
  };
}

test('a boot that finds running rows requeues them all, whatever their age, and restarts the batch', async () => {
  const f = fakes([{ id: 'a' }, { id: 'b' }]);
  const resumed = await resumeInterruptedBatch({ db: f.db, dispatcher: f.dispatcher, queue: f.queue, env: ON });
  assert.equal(resumed, 2);
  // Age 0: no run can own a row at boot, and a row claimed just before the
  // restart must not stay stranded behind the Rescue button's 60 s floor.
  assert.deepEqual(f.calls.requeue, [{ db: f.db, staleMs: 0 }]);
  assert.equal(f.calls.start, 1);
});

test('a boot with nothing interrupted starts no batch and asks the box nothing, even with rows queued', async () => {
  const f = fakes([]);
  const resumed = await resumeInterruptedBatch({ db: f.db, dispatcher: f.dispatcher, queue: f.queue, env: ON });
  assert.equal(resumed, 0);
  assert.equal(f.calls.start, 0);
  assert.deepEqual(f.calls.checked, []);
});

// Validation 2026-11-05: starting with the box down failed the row whose box
// job was still alive and then every queued row, within seconds, unattended.
test('a boot that cannot reach the box leaves the rows interrupted and starts nothing', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => { logged.push(args.join(' ')); });
  const f = fakes([{ id: 'a' }], async () => {}, 'could not reach the box');
  const resumed = await resumeInterruptedBatch({ db: f.db, dispatcher: f.dispatcher, queue: f.queue, env: ON });
  assert.equal(resumed, 0);
  assert.deepEqual(f.calls.requeue, [], 'a row put back to queued would no longer read as interrupted');
  assert.equal(f.calls.start, 0);
  assert.match(logged.join(), /could not reach the box/);
});

for (const [name, env] of [['unset', {}], ['not exactly true', { SPRITE_RESUME_ON_BOOT: '1' }]]) {
  test(`with the flag ${name} a boot touches nothing, so a second instance cannot take rows`, async () => {
    const f = fakes([{ id: 'a' }]);
    const resumed = await resumeInterruptedBatch({ db: f.db, dispatcher: f.dispatcher, queue: f.queue, env });
    assert.equal(resumed, 0);
    assert.deepEqual(f.calls.requeue, []);
    assert.deepEqual(f.calls.checked, []);
    assert.equal(f.calls.start, 0);
  });
}

test('a batch that later fails is logged, not an unhandled rejection', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => { logged.push(args); });
  const f = fakes([{ id: 'a' }], async () => { throw new Error('box gone'); });
  const resumed = await resumeInterruptedBatch({ db: f.db, dispatcher: f.dispatcher, queue: f.queue, env: ON });
  assert.equal(resumed, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][1].message), /box gone/);
});

test('a database failure reaches the caller, which logs it and keeps booting', async () => {
  const f = fakes([]);
  f.queue.resumePlan = async () => { throw new Error('db down'); };
  await assert.rejects(
    resumeInterruptedBatch({ db: f.db, dispatcher: f.dispatcher, queue: f.queue, env: ON }),
    /db down/,
  );
  assert.equal(f.calls.start, 0);
});

test('the probe covers every connector the plan names, not only the stranded row', async () => {
  const f = fakes([{ id: 'a' }], async () => {}, null, { providerIds: [7, null] });
  await resumeInterruptedBatch({ db: f.db, dispatcher: f.dispatcher, queue: f.queue, env: ON });
  assert.deepEqual(f.calls.checked, [[7, null]]);
});

// The server listens before the probe ends, and the probe can take a minute:
// requeuing now would pull the row out from under a run the admin just started.
test('a run started during the probe is left alone', async () => {
  const f = fakes([{ id: 'a' }], async () => {}, null, { live: { running: true } });
  const resumed = await resumeInterruptedBatch({ db: f.db, dispatcher: f.dispatcher, queue: f.queue, env: ON });
  assert.equal(resumed, 0);
  assert.deepEqual(f.calls.requeue, []);
  assert.equal(f.calls.start, 0);
});

// boxProblem through a real dispatcher: each stranded row's connector is what must answer.
function probeDispatcher({ active = { name: 'active' }, byId = {}, answers = {} } = {}) {
  const probed = [];
  const dispatcher = createDispatcher({
    db: {},
    store: {},
    box: { checkAuth: async (p) => { probed.push(p.name); return answers[p.name] || { ok: true, status: 200 }; } },
    loadProvider: async () => active,
    loadProviderById: async (id) => byId[id] || null,
  });
  return { dispatcher, probed };
}

test('boxProblem is null when every stranded row can reach its connector', async () => {
  const { dispatcher, probed } = probeDispatcher({ byId: { 7: { name: 'hq' } } });
  assert.equal(await dispatcher.boxProblem([null, 7]), null);
  assert.deepEqual(probed, ['active', 'hq']);
});

test('a row whose chosen connector is gone is its own problem: it fails alone, as in a normal run', async () => {
  const { dispatcher, probed } = probeDispatcher();
  assert.equal(await dispatcher.boxProblem([7, null]), null);
  assert.deepEqual(probed, ['active']);
});

test('boxProblem names the reason: unreachable, rejected key, no provider', async () => {
  const down = probeDispatcher({ answers: { active: { ok: false, error: 'could not reach the box', retryable: true } } });
  assert.match(await down.dispatcher.boxProblem([null]), /could not reach the box/);
  const key = probeDispatcher({ answers: { active: { ok: false, status: 401, error: 'box rejected the key (401)' } } });
  assert.match(await key.dispatcher.boxProblem([null]), /rejected the key/);
  assert.match(await probeDispatcher({ active: null }).dispatcher.boxProblem([null]), /no sprite provider/);
});
