// SOMET-721: the sprite batch lives only in backend memory, so a restart ended
// it and left its row 'running' with nothing draining the queue.
const test = require('node:test');
const assert = require('node:assert/strict');

const { resumeInterruptedBatch } = require('../src/services/spriteDispatcher.js');

const ON = { SPRITE_RESUME_ON_BOOT: 'true' };

function fakes(stranded, start = async () => {}) {
  const calls = { requeue: [], start: 0 };
  return {
    calls,
    db: { marker: 'db' },
    queue: {
      requeueStale: async (db, staleMs) => { calls.requeue.push({ db, staleMs }); return stranded; },
    },
    dispatcher: { start: () => { calls.start += 1; return start(); } },
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

test('a boot with nothing interrupted starts no batch, even with rows queued', async () => {
  const f = fakes([]);
  const resumed = await resumeInterruptedBatch({ db: f.db, dispatcher: f.dispatcher, queue: f.queue, env: ON });
  assert.equal(resumed, 0);
  assert.equal(f.calls.start, 0);
});

for (const [name, env] of [['unset', {}], ['not exactly true', { SPRITE_RESUME_ON_BOOT: '1' }]]) {
  test(`with the flag ${name} a boot touches nothing, so a second instance cannot take rows`, async () => {
    const f = fakes([{ id: 'a' }]);
    const resumed = await resumeInterruptedBatch({ db: f.db, dispatcher: f.dispatcher, queue: f.queue, env });
    assert.equal(resumed, 0);
    assert.deepEqual(f.calls.requeue, []);
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
  f.queue.requeueStale = async () => { throw new Error('db down'); };
  await assert.rejects(
    resumeInterruptedBatch({ db: f.db, dispatcher: f.dispatcher, queue: f.queue, env: ON }),
    /db down/,
  );
  assert.equal(f.calls.start, 0);
});
