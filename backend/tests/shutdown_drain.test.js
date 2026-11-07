// SOMET-676: the shutdown drain's wiring, with fakes -- no database, no signals.
// The real persistence is covered by shutdown_drain_db.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { installShutdownDrain } = require('../src/shutdownDrain.js');

function rig(overrides = {}) {
  const proc = new EventEmitter();
  const calls = [];
  const exits = [];
  const server = {
    close(cb) { calls.push('server.close'); setImmediate(cb); },
    closeIdleConnections() { calls.push('closeIdle'); },
    closeAllConnections() { calls.push('closeAll'); },
  };
  const log = { log() {}, error() {} };
  const handle = installShutdownDrain({
    server,
    drain: overrides.drain || (async () => { calls.push('drain'); return { players: 2, worlds: 1, failed: 0 }; }),
    endPool: async () => { calls.push('endPool'); },
    exit: (c) => { exits.push(c); },
    proc, log, timeoutMs: overrides.timeoutMs ?? 5000,
    repeatGraceMs: overrides.repeatGraceMs ?? 0, now: overrides.now || Date.now,
  });
  return { proc, calls, exits, handle };
}
// Polls instead of sleeping a guessed time: the first test in the file pays the JIT warm-up.
async function settle(exits) {
  for (let i = 0; i < 100 && !(exits && exits.length); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGUSR2']) {
  test(`${sig}: refuses new HTTP, drains, ends the pool, THEN exits 0`, async () => {
    const { proc, calls, exits } = rig();
    proc.emit(sig);
    await settle(exits);
    assert.deepEqual(calls, ['server.close', 'closeIdle', 'drain', 'closeAll', 'endPool']);
    assert.deepEqual(exits, [0]);
  });
}

test('a drain that reports failed writes exits non-zero', async () => {
  const { proc, exits } = rig({ drain: async () => ({ players: 1, worlds: 1, failed: 1 }) });
  proc.emit('SIGTERM');
  await settle(exits);
  assert.deepEqual(exits, [1]);
});

test('a drain that throws exits non-zero rather than hanging', async () => {
  const { proc, exits } = rig({ drain: async () => { throw new Error('boom'); } });
  proc.emit('SIGTERM');
  await settle(exits);
  assert.deepEqual(exits, [1]);
});

test('a hung drain is cut off by the hard timeout with a non-zero exit', async () => {
  const { proc, exits } = rig({ drain: () => new Promise(() => {}), timeoutMs: 40 });
  proc.emit('SIGTERM');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(exits, [1]);
});

test('a second signal during the drain exits immediately, without waiting for it', async () => {
  let release;
  const { proc, exits } = rig({ drain: () => new Promise((r) => { release = () => r({ players: 0, worlds: 0, failed: 0 }); }) });
  proc.emit('SIGTERM');
  await settle();
  assert.deepEqual(exits, [], 'still draining');
  proc.emit('SIGINT');
  assert.deepEqual(exits, [1], 'second signal exits at once');
  release();
});

test('a repeat inside the grace (nodemon\'s follow-up SIGINT) is ignored, one after it exits at once', async () => {
  let clock = 1000;
  let release;
  const { proc, exits } = rig({
    repeatGraceMs: 1500, now: () => clock,
    drain: () => new Promise((r) => { release = () => r({ players: 1, worlds: 1, failed: 0 }); }),
  });
  proc.emit('SIGTERM');
  await settle();
  clock += 200; proc.emit('SIGINT');
  assert.deepEqual(exits, [], 'the drain keeps going');
  clock += 2000; proc.emit('SIGINT');
  assert.deepEqual(exits, [1], 'a genuine second signal still exits immediately');
  release();
});
