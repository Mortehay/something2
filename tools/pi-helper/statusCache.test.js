'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRunner } = require('./boardRunner');
const { readStatus } = require('./status');
const { createStatusCache } = require('./statusCache');
const { createJobs } = require('./jobs');
const { scratch } = require('./testkit');

function boardRig(s) {
  s.stub('ssh', 'echo commit=abc12345; echo health=200');
  s.stub('git', 'case "$1" in rev-list) echo 0;; esac');
  s.script('tunnel.sh', 'echo "$2" >> "$REPO_ROOT/tunnel-calls"; printf \'state=on\\nurl=https://x.example\\nverified=yes\\nage=1\\n\'');
  return createRunner({ root: s.root, env: s.env });
}
const tunnelCalls = (s) => (fs.existsSync(`${s.root}/tunnel-calls`) ? fs.readFileSync(`${s.root}/tunnel-calls`, 'utf8').split('\n').filter(Boolean) : []);

test('status polled four times a minute runs tunnel.sh once', async (t) => {
  const s = scratch(t);
  const runner = boardRig(s);
  let clock = 1_000_000;
  const cache = createStatusCache({ read: () => readStatus(runner), now: () => clock });
  for (let i = 0; i < 4; i += 1) { await cache.get(); clock += 15_000 - 1; }
  // one refresh = one status call per tunnel
  assert.deepEqual(tunnelCalls(s).sort(), ['cloudflare', 'ngrok']);
  clock += 20_000; // past 60 s
  await cache.get();
  assert.equal(tunnelCalls(s).length, 4);
});

test('a tunnel job invalidates the cached status', async (t) => {
  const s = scratch(t);
  const runner = boardRig(s);
  const cache = createStatusCache({ read: () => readStatus(runner), now: () => 1_000_000 });
  await cache.get();
  assert.equal(tunnelCalls(s).length, 2);
  const jobs = createJobs({ onDone: () => cache.onJobDone() });
  jobs.start('tunnel', [{ name: 'x', run: async () => {} }]);
  for (let i = 0; i < 400 && jobs.current().state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(tunnelCalls(s).length, 4, 'the job end re-read the tunnels');
  await cache.get();
  assert.equal(tunnelCalls(s).length, 4, 'and the clock did not need to advance');
  // invalidate alone makes the next GET read again
  cache.invalidate();
  await cache.get();
  assert.equal(tunnelCalls(s).length, 6);
});

test('a board going offline shows within one sample', async () => {
  let clock = 1_000_000;
  let sample = { t: clock, online: true };
  let reads = 0;
  const cache = createStatusCache({
    read: async () => { reads += 1; return { online: true, commit: 'abc' }; },
    latestSample: () => sample,
    now: () => clock,
  });
  assert.equal((await cache.get()).online, true);
  clock += 15_000;
  sample = { t: clock, online: false };
  const st = await cache.get();
  assert.equal(st.online, false);
  assert.equal(reads, 1, 'answered from the cache, no new read');
  // and back: a cached offline is not kept once the sampler sees the board again
  const c2 = createStatusCache({
    read: async () => { reads += 1; return { online: reads > 2 }; },
    latestSample: () => sample,
    now: () => clock,
  });
  sample = { t: clock, online: false };
  assert.equal((await c2.get()).online, false);
  clock += 15_000;
  sample = { t: clock, online: true };
  assert.equal((await c2.get()).online, true);
});

test('a stale sample is ignored and a concurrent read is shared', async () => {
  let clock = 1_000_000;
  let reads = 0;
  const cache = createStatusCache({
    read: async () => { reads += 1; await new Promise((r) => setTimeout(r, 20)); return { online: true }; },
    latestSample: () => ({ t: clock - 600_000, online: false }),
    now: () => clock,
  });
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(reads, 1);
  assert.equal(a.online, true);
  assert.equal(b.online, true);
});
