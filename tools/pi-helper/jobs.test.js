'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJobs, BusyError, LOG_CAP, ABORTED_MESSAGE } = require('./jobs');
const { explainTunnelError } = require('./tunnelErrors');

const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 5)); };
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

test('a second start throws BusyError while one runs, and works after it ends', async () => {
  const jobs = createJobs();
  const g = gate();
  const j = jobs.start('restart', [{ name: 'wait', run: () => g.p }]);
  assert.equal(j.state, 'running');
  assert.throws(() => jobs.start('seed', []), BusyError);
  g.open();
  await until(() => jobs.current().state !== 'running');
  assert.equal(jobs.current().state, 'ok');
  assert.doesNotThrow(() => jobs.start('seed', [{ name: 'x', run: async () => {} }]));
});

test('a step that throws fails the job, names the step, and skips later steps', async () => {
  const jobs = createJobs();
  let ran = false;
  jobs.start('seed', [
    { name: 'one', run: async () => {} },
    { name: 'two', run: async () => { throw new Error('boom'); } },
    { name: 'three', run: async () => { ran = true; } },
  ]);
  await until(() => jobs.current().state !== 'running');
  const j = jobs.current();
  assert.equal(j.state, 'failed');
  assert.equal(j.error, 'boom');
  assert.deepEqual(j.steps.map((s) => s.state), ['ok', 'failed', 'pending']);
  assert.equal(j.steps[1].detail, 'boom');
  assert.equal(ran, false);
  assert.ok(j.finishedAt);
});

test('step() sets the running step detail and the job keeps its shape', async () => {
  const jobs = createJobs();
  jobs.start('tunnel', [{ name: 'a', run: async ({ step }) => step('hello') }]);
  await until(() => jobs.current().state !== 'running');
  const j = jobs.current();
  assert.equal(j.steps[0].detail, 'hello');
  for (const k of ['id', 'kind', 'state', 'startedAt', 'finishedAt', 'steps', 'log', 'error', 'targetSha', 'ciUrl']) assert.ok(k in j, k);
});

test('the log is capped at 16 KB and keeps the end', async () => {
  const jobs = createJobs();
  jobs.start('seed', [{ name: 'noisy', run: async ({ log }) => { for (let i = 0; i < 3000; i += 1) log(`line ${i} ${'x'.repeat(20)}`); } }]);
  await until(() => jobs.current().state !== 'running');
  const { log } = jobs.current();
  assert.ok(log.length <= LOG_CAP);
  assert.match(log, /line 2999 /);
  assert.doesNotMatch(log, /line 0 /);
});

test('abort() during a job ends it failed with the stopped message, even if the step returns normally', async () => {
  const jobs = createJobs();
  const g = gate();
  jobs.start('restart', [{ name: 'a', run: () => g.p }, { name: 'b', run: async () => {} }]);
  jobs.abort();
  g.open();
  await until(() => jobs.current().state !== 'running');
  const j = jobs.current();
  assert.equal(j.state, 'failed');
  assert.equal(j.error, ABORTED_MESSAGE);
  assert.equal(j.steps[1].state, 'pending');
});

test('abort() turns a thrown step error into the stopped message too', async () => {
  const jobs = createJobs();
  const g = gate();
  jobs.start('restart', [{ name: 'a', run: async () => { await g.p; throw new Error('killed'); } }]);
  jobs.abort();
  g.open();
  await until(() => jobs.current().state !== 'running');
  assert.equal(jobs.current().error, ABORTED_MESSAGE);
});

test('onDone is called once when a job ends, ok or failed, and its failure is ignored', async () => {
  const seen = [];
  const jobs = createJobs({ onDone: (j) => { seen.push(j.state); throw new Error('ignored'); } });
  jobs.start('tunnel', [{ name: 'a', run: async () => {} }]);
  await until(() => !jobs.isRunning());
  jobs.start('tunnel', [{ name: 'a', run: async () => { throw new Error('x'); } }]);
  await until(() => seen.length === 2);
  assert.deepEqual(seen, ['ok', 'failed']);
});

test('current() is null before any job and the latest job is kept', async () => {
  const jobs = createJobs();
  assert.equal(jobs.current(), null);
  jobs.start('restart', []);
  await until(() => jobs.current().state !== 'running');
  assert.equal(jobs.current().kind, 'restart');
});

test('explainTunnelError: known codes and an unknown one', () => {
  const a = explainTunnelError('ERR_NGROK_334');
  assert.match(a, /make tunnel/);
  assert.match(a, /laptop/);
  assert.match(a, /one agent/);
  assert.match(explainTunnelError('no_token'), /NGROK_AUTHTOKEN is not set in \.env/);
  assert.match(explainTunnelError('not_answering'), /did not answer/);
  assert.match(explainTunnelError('no_url'), /did not report an address/);
  assert.match(explainTunnelError('ERR_NGROK_313'), /free plan/);
  assert.match(explainTunnelError('weird_code'), /failed to start \(weird_code\)/);
});

test('a step can set targetSha and ciUrl on the job', async () => {
  const jobs = createJobs();
  jobs.start('update', [{ name: 'a', run: async ({ setTarget, setCiUrl }) => { setTarget('abc123'); setCiUrl('https://x/y'); } }]);
  for (let i = 0; i < 200 && jobs.current().state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(jobs.current().targetSha, 'abc123');
  assert.equal(jobs.current().ciUrl, 'https://x/y');
});
