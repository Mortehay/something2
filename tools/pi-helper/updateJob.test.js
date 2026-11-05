'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createJobs } = require('./jobs');
const { updateJob, execTools, isSettled, unsettledReason } = require('./updateJob');

const OLD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const RUN_URL = 'https://github.com/o/r/actions/runs/77';
const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 5)); };
const res = (over = {}) => ({ code: 0, stdout: '', stderr: '', output: '', timedOut: false, ...over });

// A fake world: a clock that only sleep() moves, and a board whose state tests can rewrite.
// The default board is OLD and settled: its last finished deploy is OLD.
function world(over = {}) {
  const w = {
    t: 2_000_000_000_000,
    calls: [], gitCalls: [], ghCalls: [], scripts: [], reads: 0,
    board: { reached: true, head: OLD, deployed: OLD, health: '200', lock: 'no', hook: 'no' },
    originOrangepi: OLD, originMain: MAIN, ancestor: 0, pushCode: 0,
    runs: [{ databaseId: 77, status: 'completed', conclusion: 'success', url: RUN_URL }],
    jobsOf: () => [{ name: 'test', conclusion: 'success' }, { name: 'build', conclusion: 'success' }, { name: 'manifest', conclusion: 'success' }, { name: 'deploy', conclusion: 'failure' }],
    ...over,
  };
  w.clock = () => w.t;
  w.sleep = async (ms) => { w.t += ms; };
  w.now = () => Math.floor(w.t / 1000);
  // What a finished deploy leaves behind: HEAD moved and the marker written.
  w.finishDeploy = () => { w.board.head = MAIN; w.board.deployed = MAIN; w.board.lock = 'no'; w.board.hook = 'no'; };
  w.git = async (args) => {
    w.gitCalls.push(args);
    const k = args.join(' ');
    if (args[0] === 'fetch') return res();
    if (k === 'rev-parse origin/orangepi') return res({ stdout: `${w.originOrangepi}\n` });
    if (k === 'rev-parse origin/main') return res({ stdout: `${w.originMain}\n` });
    if (args[0] === 'merge-base') return res({ code: w.ancestor });
    if (args[0] === 'push') return res({ code: w.pushCode, stderr: 'push said no' });
    return res({ code: 99 });
  };
  w.gh = async (args) => {
    w.ghCalls.push(args);
    if (w.ghResult) return w.ghResult(args);
    if (args[0] === 'run' && args[1] === 'list') return res({ stdout: JSON.stringify(typeof w.runs === 'function' ? w.runs() : w.runs) });
    if (args[0] === 'run' && args[1] === 'view') return res({ stdout: JSON.stringify({ jobs: w.jobsOf() }) });
    return res({ code: 1 });
  };
  w.runner = {
    env: () => ({ ORANGEPI_APP_DIR: '/app' }),
    secrets: () => [],
    script: async (name, args, opts = {}) => {
      w.scripts.push({ name, args, opts });
      if (name === 'remote.sh') {
        w.reads += 1;
        if (w.onRead) w.onRead(w.reads);
        const b = w.board;
        if (!b.reached) return res({ code: 255, stderr: 'ssh: connect timed out' });
        const f = (v) => (v == null ? '' : v);
        return res({ stdout: `head=${f(b.head)}\ndeployed=${f(b.deployed)}\nhealth=${b.health}\nlock=${b.lock}\nhook_deploying=${b.hook}\n` });
      }
      if (w.script) { const r = await w.script(name, args, opts); if (r) return r; }
      if (name === 'deploy.sh' && !w.noMove) w.finishDeploy();
      return res();
    },
  };
  w.deploys = () => w.scripts.filter((s) => s.name === 'deploy.sh');
  w.steps = (timeouts = {}) => updateJob({ runner: w.runner, git: w.git, gh: w.gh, releases: w.releases, clock: w.clock, sleep: w.sleep, timeouts: { ciPoll: 1000, boardPoll: 1000, ...timeouts } });
  return w;
}
async function run(steps) {
  const jobs = createJobs();
  jobs.start('update', steps);
  await until(() => jobs.current().state !== 'running');
  return jobs.current();
}
const step = (j, name) => j.steps.find((s) => s.name === name);
const names = (j) => j.steps.map((s) => s.name);
// A settled board at MAIN: its last finished deploy is MAIN.
const SETTLED_MAIN = { reached: true, head: MAIN, deployed: MAIN, health: '200', lock: 'no', hook: 'no' };
// What a deploy that failed after its reset leaves: HEAD at MAIN, the old stack healthy, no marker.
const HALF = { reached: true, head: MAIN, deployed: null, health: '200', lock: 'no', hook: 'no' };

test('step names are exactly backup, push, ci, deploy, verify', async () => {
  const w = world();
  assert.deepEqual(w.steps().map((s) => s.name), ['backup', 'push', 'ci', 'deploy', 'verify']);
});

test('a full update passes: the hook never lands, deploy.sh restarts the backend, verify confirms', async () => {
  const w = world();
  const j = await run(w.steps({ hookWait: 3000 }));
  assert.equal(j.state, 'ok', j.error);
  assert.deepEqual(names(j).map((n) => step(j, n).state), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(j.targetSha, MAIN);
  assert.equal(j.ciUrl, RUN_URL);
  assert.deepEqual(w.gitCalls.find((a) => a[0] === 'push'), ['push', 'origin', `${MAIN}:refs/heads/orangepi`]);
  assert.equal(w.deploys().length, 1);
  assert.match(step(j, 'verify').detail, /confirmed/);
});

test('a failed backup pushes nothing', async () => {
  const w = world();
  w.script = (name) => (name === 'backup.sh' ? res({ code: 1, output: 'disk full\n' }) : null);
  const j = await run(w.steps());
  assert.equal(j.state, 'failed');
  assert.equal(step(j, 'backup').state, 'failed');
  assert.match(j.error, /backup/i);
  assert.equal(step(j, 'backup').detail, j.error);
  assert.equal(w.gitCalls.length, 0);
  assert.equal(w.deploys().length, 0);
});

test('backup runs backup.sh with a 10 minute timeout by default', async () => {
  const w = world();
  await run(w.steps());
  assert.equal(w.scripts.find((s) => s.name === 'backup.sh').opts.timeoutMs, 600_000);
});

test('diverged orangepi stops before pushing, and merge-base gets the resolved shas', async () => {
  const w = world({ ancestor: 1 });
  const j = await run(w.steps());
  assert.equal(j.state, 'failed');
  assert.equal(step(j, 'push').state, 'failed');
  assert.match(j.error, /diverged/i);
  assert.equal(step(j, 'push').detail, j.error);
  assert.deepEqual(w.gitCalls.find((a) => a[0] === 'merge-base'), ['merge-base', '--is-ancestor', OLD, MAIN]);
  assert.equal(w.gitCalls.some((a) => a[0] === 'push'), false);
  assert.equal(step(j, 'ci').state, 'pending');
});

test('a merge-base error other than exit 1 is an error, not diverged', async () => {
  const w = world({ ancestor: 128 });
  const j = await run(w.steps());
  assert.equal(step(j, 'push').state, 'failed');
  assert.doesNotMatch(j.error, /diverged/i);
  assert.equal(w.gitCalls.some((a) => a[0] === 'push'), false);
});

test('push never forces: no --force flag and no + in the refspec', async () => {
  const w = world();
  await run(w.steps());
  const pushes = w.gitCalls.filter((a) => a[0] === 'push');
  assert.equal(pushes.length, 1);
  for (const p of pushes) {
    assert.ok(!p.some((x) => /force|^-f$|--force-with-lease/.test(x)));
    assert.ok(!p.some((x) => x.includes('+')));
  }
});

test('the push step only fetches with explicit refspecs, reads refs and pushes', async () => {
  const w = world();
  await run(w.steps());
  const verbs = w.gitCalls.map((a) => a[0]);
  assert.ok(verbs.every((v) => ['fetch', 'rev-parse', 'merge-base', 'push'].includes(v)), verbs.join(','));
  assert.deepEqual(w.gitCalls[0], ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main', '+refs/heads/orangepi:refs/remotes/origin/orangepi']);
});

test('push is skipped when already at main', async () => {
  const w = world({ originOrangepi: MAIN });
  const j = await run(w.steps());
  assert.equal(w.gitCalls.some((a) => a[0] === 'push'), false);
  assert.equal(step(j, 'push').state, 'ok');
  assert.match(step(j, 'push').detail, /already/i);
  assert.equal(j.targetSha, MAIN);
});

test('a rejected push fails the push step with the git message', async () => {
  const w = world({ pushCode: 1 });
  const j = await run(w.steps());
  assert.equal(step(j, 'push').state, 'failed');
  assert.match(j.error, /push said no/);
});

test('ci passes on manifest success even if the deploy job failed', async () => {
  const w = world();
  const j = await run(w.steps());
  assert.equal(step(j, 'ci').state, 'ok');
  assert.equal(j.ciUrl, RUN_URL);
  assert.deepEqual(w.ghCalls[0], ['run', 'list', '--workflow', 'orangepi-images.yml', '--commit', MAIN, '--json', 'databaseId,status,conclusion,url']);
  assert.deepEqual(w.ghCalls[1], ['run', 'view', '77', '--json', 'jobs']);
});

test('ci waits while manifest is still running, then passes', async () => {
  const w = world();
  let polls = 0;
  w.jobsOf = () => { polls += 1; return [{ name: 'manifest', status: polls < 3 ? 'in_progress' : 'completed', conclusion: polls < 3 ? null : 'success' }]; };
  w.runs = () => [{ databaseId: 77, status: 'in_progress', conclusion: '', url: RUN_URL }];
  const j = await run(w.steps());
  assert.equal(step(j, 'ci').state, 'ok');
  assert.equal(polls, 3);
});

test('ci failure shows the run url (skipped manifest after a failed build)', async () => {
  const w = world();
  w.jobsOf = () => [{ name: 'test', conclusion: 'success' }, { name: 'build', conclusion: 'failure' }, { name: 'manifest', conclusion: 'skipped' }];
  const j = await run(w.steps());
  assert.equal(step(j, 'ci').state, 'failed');
  assert.ok(j.error.includes(RUN_URL));
  assert.equal(j.ciUrl, RUN_URL);
  assert.equal(step(j, 'deploy').state, 'pending');
});

test('ci times out with a failing ci step', async () => {
  const w = world();
  w.runs = [{ databaseId: 77, status: 'in_progress', conclusion: '', url: RUN_URL }];
  w.jobsOf = () => [{ name: 'manifest', status: 'in_progress', conclusion: null }];
  const j = await run(w.steps({ ci: 5000 }));
  assert.equal(step(j, 'ci').state, 'failed');
  assert.match(j.error, /did not finish|time/i);
  assert.ok(j.error.includes(RUN_URL));
});

test('a run that has not appeared yet is not a failure until the timeout', async () => {
  const w = world();
  let n = 0;
  w.runs = () => { n += 1; return n < 4 ? [] : [{ databaseId: 77, status: 'completed', conclusion: 'success', url: RUN_URL }]; };
  assert.equal(step(await run(w.steps()), 'ci').state, 'ok');
  const w2 = world({ runs: [] });
  const j2 = await run(w2.steps({ ci: 5000 }));
  assert.equal(step(j2, 'ci').state, 'failed');
  assert.match(j2.error, /did not finish/);
});

test('with the push skipped and no CI run, ci waits a grace period and then stops with a sentence', async () => {
  const w = world({ originOrangepi: MAIN, runs: [] });
  const j = await run(w.steps({ ciGrace: 5000 }));
  assert.equal(step(j, 'ci').state, 'failed');
  assert.match(j.error, /No CI run exists for that commit/);
  assert.ok(w.ghCalls.length > 1, 'it polled during the grace');
  // A run that shows up within the grace passes.
  const w2 = world({ originOrangepi: MAIN });
  let n = 0;
  w2.runs = () => { n += 1; return n < 3 ? [] : [{ databaseId: 77, status: 'completed', conclusion: 'success', url: RUN_URL }]; };
  assert.equal(step(await run(w2.steps({ ciGrace: 5000 })), 'ci').state, 'ok');
});

test('with the push skipped, a completed successful run passes immediately', async () => {
  const w = world({ originOrangepi: MAIN });
  const j = await run(w.steps());
  assert.equal(step(j, 'ci').state, 'ok');
  assert.equal(w.ghCalls.length, 2);
});

test('unreadable gh JSON has its own sentence and does not claim no run exists', async () => {
  const w = world();
  w.ghResult = async () => res({ stdout: 'not json at all' });
  const j = await run(w.steps());
  assert.equal(step(j, 'ci').state, 'failed');
  assert.match(j.error, /could not be read/);
  assert.doesNotMatch(j.error, /no CI run exists/i);
  assert.equal(w.ghCalls.length, 5);
});

test('a non-auth gh error stops after 5 failures in a row, not after 40 minutes', async () => {
  const w = world();
  w.ghResult = async () => res({ code: 1, stderr: 'HTTP 502: bad gateway' });
  const j = await run(w.steps());
  assert.equal(step(j, 'ci').state, 'failed');
  assert.match(j.error, /5 times in a row/);
  assert.equal(w.ghCalls.length, 5);
});

test('gh missing stops at ci with a sentence', async () => {
  const w = world();
  w.ghResult = async () => res({ code: 127, stderr: 'spawn gh ENOENT' });
  const j = await run(w.steps());
  assert.equal(step(j, 'ci').state, 'failed');
  assert.match(j.error, /GitHub CLI/);
  assert.match(j.error, /gh auth login|install/);
  assert.equal(step(j, 'push').state, 'ok');
});

test('gh not signed in stops at ci with a sentence', async () => {
  const w = world();
  w.ghResult = async () => res({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' });
  const j = await run(w.steps());
  assert.equal(step(j, 'ci').state, 'failed');
  assert.match(j.error, /not signed in|gh auth login/);
});

// ---- settled -----------------------------------------------------------------

test('isSettled table: dropping any one condition fails', () => {
  const base = { reached: true, head: MAIN, deployed: MAIN, health: '200', lock: 'no', hookDeploying: 'no' };
  const cases = [
    ['all conditions hold', {}, true],
    ['hook_deploying unknown is allowed', { hookDeploying: 'unknown' }, true],
    ['hook_deploying yes is not settled', { hookDeploying: 'yes' }, false],
    ['lock yes', { lock: 'yes' }, false],
    ['lock unreadable', { lock: 'unknown' }, false],
    ['wrong head', { head: OLD, deployed: OLD }, false],
    ['no head', { head: null }, false],
    ['no marker', { deployed: null }, false],
    ['marker names another commit', { deployed: OLD }, false],
    ['health 502', { health: '502' }, false],
    ['health 000', { health: '000' }, false],
    ['board not reached', { reached: false }, false],
  ];
  for (const [label, over, want] of cases) assert.equal(isSettled({ ...base, ...over }, MAIN), want, label);
  assert.match(unsettledReason({ ...base, deployed: null }, MAIN), /no finished deploy is recorded/);
  assert.equal(isSettled(null, MAIN), false);
  // Settled needs head to be THE TARGET, not merely equal to the marker.
  assert.equal(isSettled({ ...base, head: OLD, deployed: OLD }, MAIN), false);
});

test('an already current board restarts nothing', async () => {
  const w = world({ originOrangepi: MAIN, board: { ...SETTLED_MAIN } });
  const j = await run(w.steps());
  assert.equal(j.state, 'ok', j.error);
  assert.equal(w.deploys().length, 0);
  assert.match(step(j, 'deploy').detail, /settled/);
  assert.equal(w.reads, 2); // one in deploy, one in verify; no hookWait delay
});

test('a hook mid-deploy never reports success', async () => {
  // C1: the hook reset HEAD early; the old containers keep serving and no marker is written yet.
  const w = world({ board: { ...HALF } });
  w.onRead = (n) => {
    if (n === 1) { w.board.hook = 'yes'; } // the hook says it is deploying
    if (n === 4) { w.board.hook = 'no'; w.board.lock = 'yes'; } // then only the lock is visible
    if (n === 7) { w.board.lock = 'no'; w.board.deployed = MAIN; } // the deploy finishes and writes its marker
  };
  const j = await run(w.steps({ hookWait: 1000 }));
  assert.equal(j.state, 'ok', j.error);
  assert.equal(w.deploys().length, 0, 'it waited rather than deploying over a running deploy');
  assert.ok(w.reads >= 7, `it kept reading until the restart (${w.reads})`);
});

test('a hook mid-deploy with no marker is not settled even with HEAD and health right', async () => {
  const w = world({ board: { ...HALF } });
  w.noMove = true;
  const j = await run(w.steps({ hookWait: 1000, deploy: 5000 }));
  assert.equal(j.state, 'failed');
  assert.equal(step(j, 'verify').state, 'pending');
});

test('a retry after a failed deploy redeploys', async () => {
  // C2: a failed deploy left HEAD at the sha and the old stack healthy, with no marker.
  const w = world({ originOrangepi: MAIN, board: { ...HALF } });
  const j = await run(w.steps({ hookWait: 3000 }));
  assert.equal(j.state, 'ok', j.error);
  assert.equal(w.deploys().length, 1);
  assert.equal(step(j, 'deploy').state, 'ok');
});

test('a restart of the old version does not fake settled: the marker still names the old commit', async () => {
  const w = world({ originOrangepi: MAIN, board: { reached: true, head: MAIN, deployed: OLD, health: '200', lock: 'no', hook: 'no' } });
  const j = await run(w.steps({ hookWait: 3000 }));
  assert.equal(j.state, 'ok', j.error);
  assert.equal(w.deploys().length, 1);
});

test('the first update on a board with no marker: the old hook finished, then deploy.sh runs once after hookWait and settles', async () => {
  const w = world({ board: { ...HALF } });
  const start = w.t;
  const j = await run(w.steps({ hookWait: 30_000 }));
  assert.equal(j.state, 'ok', j.error);
  assert.equal(w.deploys().length, 1);
  assert.ok(w.t - start >= 30_000, 'it waited the hook window first');
});

test('deploy waits when the hook takes it: no deploy.sh call', async () => {
  const w = world();
  w.onRead = (n) => { if (n === 3) w.finishDeploy(); };
  const j = await run(w.steps({ hookWait: 180_000 }));
  assert.equal(j.state, 'ok', j.error);
  assert.equal(w.deploys().length, 0);
});

test('deploy falls back to deploy.sh when the hook never lands, with the right env', async () => {
  const w = world();
  const j = await run(w.steps({ hookWait: 5000 }));
  assert.equal(j.state, 'ok', j.error);
  const d = w.deploys();
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].opts.env, { ORANGEPI_BRANCH: 'orangepi', PI_SKIP_IF_CURRENT: '1' });
  assert.ok(d[0].opts.timeoutMs <= 25 * 60_000 && d[0].opts.timeoutMs > 20 * 60_000);
});

test('exit 75 keeps waiting within the budget', async () => {
  const w = world();
  let n = 0;
  w.script = (name) => {
    if (name !== 'deploy.sh') return null;
    n += 1;
    if (n < 3) return res({ code: 75, output: 'another deploy is running\n' });
    return null;
  };
  const j = await run(w.steps({ hookWait: 1000 }));
  assert.equal(j.state, 'ok', j.error);
  assert.equal(n, 3);
  // A deploy that never frees up fails inside the budget.
  const w2 = world();
  w2.script = (name) => (name === 'deploy.sh' ? res({ code: 75 }) : null);
  const j2 = await run(w2.steps({ hookWait: 1000, deploy: 20_000 }));
  assert.equal(step(j2, 'deploy').state, 'failed');
  assert.match(j2.error, /did not settle within/);
});

test('deploy returning 0 without settling fails and names the condition', async () => {
  const w = world({ noMove: true });
  const j = await run(w.steps({ hookWait: 1000, settleGrace: 5000 }));
  assert.equal(step(j, 'deploy').state, 'failed');
  assert.match(j.error, /finished but the board is not settled/);
  assert.match(j.error, /not 8?b|the board is at aaaaaaaa/);
  assert.equal(w.deploys().length, 1);
  // Names the backend condition when only that is wrong.
  const w2 = world({ noMove: true });
  w2.script = (name) => { if (name === 'deploy.sh') { w2.board.head = MAIN; w2.board.deployed = OLD; } return null; };
  const j2 = await run(w2.steps({ hookWait: 1000, settleGrace: 5000 }));
  assert.match(j2.error, /last finished deploy was aaaaaaaa/);
});

test('exit 74 fails the deploy step with the script lines', async () => {
  const w = world();
  w.script = (name) => (name === 'deploy.sh' ? res({ code: 74, output: 'cannot create the deploy lock\nnot writable\n' }) : null);
  const j = await run(w.steps({ hookWait: 1000 }));
  assert.equal(step(j, 'deploy').state, 'failed');
  assert.match(j.error, /not writable/);
  assert.equal(w.deploys().length, 1);
});

test('a deploy that finished with the game up but a failed step names the steps', async () => {
  const w = world();
  const out = 'noise\n3 step(s) failed.\nfailed-steps=reseed the passive tree (--force); restore any missing catalog rows\nstack=up\n';
  w.script = (name) => (name === 'deploy.sh' ? res({ code: 1, output: out }) : null);
  const j = await run(w.steps({ hookWait: 1000 }));
  assert.equal(step(j, 'deploy').state, 'failed');
  assert.equal(j.error, 'The deploy finished with the game running, but these steps failed: reseed the passive tree (--force); restore any missing catalog rows. Update will redeploy next time.');
});

test('a deploy that failed without the stack up says where it failed; no trailer keeps the tail message', async () => {
  const w = world();
  w.script = (name) => (name === 'deploy.sh' ? res({ code: 1, output: 'x\nfailed-steps=run migrations\n' }) : null);
  const j = await run(w.steps({ hookWait: 1000 }));
  assert.equal(j.error, 'The deploy failed at: run migrations.');
  const w2 = world();
  w2.script = (name) => (name === 'deploy.sh' ? res({ code: 1, output: 'boom happened\n' }) : null);
  assert.match((await run(w2.steps({ hookWait: 1000 }))).error, /The deploy failed \(exit 1\): boom happened/);
});

test('the board going offline mid-deploy fails at the deploy step with a sentence', async () => {
  const w = world();
  w.board.reached = false;
  w.script = (name) => (name === 'deploy.sh' ? res({ code: 255, output: 'ssh: connect to host timed out\n' }) : null);
  const j = await run(w.steps({ hookWait: 3000, deploy: 30_000 }));
  assert.equal(step(j, 'deploy').state, 'failed');
  assert.match(j.error, /board .*(offline|reached)/i);
  assert.equal(step(j, 'verify').state, 'pending');
});

test('polling tolerates ssh failures while the board restarts', async () => {
  const w = world();
  w.onRead = (n) => {
    if (n >= 2 && n < 5) w.board.reached = false;
    if (n === 5) { w.board.reached = true; w.finishDeploy(); }
  };
  const j = await run(w.steps({ hookWait: 60_000 }));
  assert.equal(j.state, 'ok', j.error);
});

test('verify is a bounded check of isSettled: two reads, no clock logic', async () => {
  const w = world();
  w.script = (name) => { if (name === 'deploy.sh') { w.finishDeploy(); } return null; };
  // After the deploy step settles, verify finds the health gone, and the second read too.
  let verifying = false;
  w.onRead = () => { if (verifying) w.board.health = '503'; };
  const base = w.steps({ hookWait: 1000, verify: 60_000 });
  const j = await run(base.map((s) => (s.name === 'verify' ? { ...s, run: (c) => { verifying = true; return s.run(c); } } : s)));
  assert.equal(step(j, 'verify').state, 'failed');
  assert.match(j.error, /503/);
});

test('verify does not claim the hook is idle when its state is unknown', async () => {
  const w = world({ originOrangepi: MAIN, board: { ...SETTLED_MAIN, hook: 'unknown' } });
  const j = await run(w.steps());
  assert.equal(j.state, 'ok', j.error);
  assert.match(step(j, 'verify').detail, /hook state is unknown/);
  assert.doesNotMatch(step(j, 'verify').detail, /no deploy running|hook is idle/);
  const w2 = world({ originOrangepi: MAIN, board: { ...SETTLED_MAIN } });
  assert.match(step(await run(w2.steps()), 'verify').detail, /hook is idle/);
});

test('verify passes when the second read settles', async () => {
  const w = world();
  let verifying = false;
  let vr = 0;
  w.onRead = () => { if (verifying) { vr += 1; w.board.health = vr === 1 ? '000' : '200'; } };
  const base = w.steps({ hookWait: 1000, verify: 60_000 });
  const j = await run(base.map((s) => (s.name === 'verify' ? { ...s, run: (c) => { verifying = true; return s.run(c); } } : s)));
  assert.equal(j.state, 'ok', j.error);
  assert.equal(vr, 2);
});

test('board state comes from remote.sh deploy-state', async () => {
  const w = world({ originOrangepi: MAIN, board: { ...SETTLED_MAIN } });
  await run(w.steps());
  assert.deepEqual(w.scripts.find((s) => s.name === 'remote.sh').args, ['deploy-state']);
});

// ---- real git: a temp bare origin and clones -------------------------------

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
function repos(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-update-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  g(dir, 'init', '--bare', '-b', 'main', origin);
  const work = path.join(dir, 'work');
  g(dir, 'clone', origin, work);
  const commit = (cwd, file, branch) => { fs.writeFileSync(path.join(cwd, file), file); g(cwd, 'add', file); g(cwd, 'commit', '-m', file); g(cwd, 'push', 'origin', `HEAD:refs/heads/${branch}`); return g(cwd, 'rev-parse', 'HEAD'); };
  g(work, 'checkout', '-b', 'main');
  commit(work, 'base', 'main');
  g(work, 'push', 'origin', 'main:orangepi');
  // A second clone moves origin while `work` has not fetched.
  const other = path.join(dir, 'other');
  g(dir, 'clone', origin, other);
  return { dir, origin, work, other, commit };
}
const realPush = async (work) => {
  const { git } = execTools({ root: work, secrets: () => [], env: GIT_ENV });
  const w = world();
  const steps = updateJob({ runner: w.runner, git, gh: w.gh, clock: w.clock, sleep: w.sleep, timeouts: {} });
  let target = null;
  await steps.find((s) => s.name === 'push').run({ step() {}, log() {}, setTarget: (s) => { target = s; }, setCiUrl() {} });
  return target;
};
const snapshot = (work) => ({ branches: g(work, 'for-each-ref', 'refs/heads', '--format=%(refname) %(objectname)'), head: g(work, 'rev-parse', 'HEAD'), status: g(work, 'status', '--porcelain'), index: g(work, 'ls-files', '-s') });

test('real git: a fast-forward push moves origin/orangepi to main, local branches untouched', async (t) => {
  const r = repos(t);
  const newMain = r.commit(r.other, 'f1', 'main');
  const before = snapshot(r.work);
  const target = await realPush(r.work);
  assert.equal(target, newMain);
  assert.equal(g(r.origin, 'rev-parse', 'refs/heads/orangepi'), newMain);
  assert.equal(g(r.work, 'rev-parse', 'refs/remotes/origin/main'), newMain); // remote-tracking refs really moved
  assert.deepEqual(snapshot(r.work), before);
});

test('real git: a diverged orangepi stops and the remote is untouched', async (t) => {
  const r = repos(t);
  r.commit(r.other, 'f1', 'main');
  const div = r.commit(r.other, 'side', 'orangepi'); // orangepi gets a commit main does not have
  const before = snapshot(r.work);
  await assert.rejects(() => realPush(r.work), /diverged/i);
  assert.equal(g(r.origin, 'rev-parse', 'refs/heads/orangepi'), div);
  assert.deepEqual(snapshot(r.work), before);
});

test('real git: already equal skips the push', async (t) => {
  const r = repos(t);
  const head = g(r.origin, 'rev-parse', 'refs/heads/main');
  const target = await realPush(r.work);
  assert.equal(target, head);
  assert.equal(g(r.origin, 'rev-parse', 'refs/heads/orangepi'), head);
});

test('real git: a missing remote orangepi branch is an error, not a push', async (t) => {
  const r = repos(t);
  g(r.origin, 'branch', '-D', 'orangepi');
  await assert.rejects(() => realPush(r.work), /orangepi/);
  assert.throws(() => g(r.origin, 'rev-parse', '--verify', 'refs/heads/orangepi'));
});

test('execTools redacts secrets from git output and reports a missing gh as code 127', async (t) => {
  const r = repos(t);
  const { git, gh } = execTools({ root: r.work, secrets: () => ['hunter2x'], env: { ...GIT_ENV, PATH: '/nonexistent' } });
  const out = await git(['config', '--get', 'nothing.here']);
  assert.notEqual(out.code, 0);
  const ghRes = await gh(['--version']);
  assert.equal(ghRes.code, 127);
  const { git: git2 } = execTools({ root: r.work, secrets: () => ['base'], env: GIT_ENV });
  const show = await git2(['log', '-1', '--format=%s']);
  assert.equal(show.stdout.trim(), '***');
});

// ---- branch settings from .env (SOMET-719) ----------------------------------

const pushWith = async (work, branchEnv) => {
  const { git } = execTools({ root: work, secrets: () => [], env: GIT_ENV });
  const w = world();
  w.runner.env = () => ({ ORANGEPI_APP_DIR: '/app', ...branchEnv });
  const steps = updateJob({ runner: w.runner, git, gh: w.gh, clock: w.clock, sleep: w.sleep, timeouts: {} });
  let target = null;
  await steps.find((s) => s.name === 'push').run({ step() {}, log() {}, setTarget: (s) => { target = s; }, setCiUrl() {} });
  return target;
};

test('real git: ORANGEPI_SOURCE_BRANCH=dev is pushed into ORANGEPI_BRANCH=build, local branches untouched', async (t) => {
  const r = repos(t);
  g(r.work, 'push', 'origin', 'main:dev');
  g(r.work, 'push', 'origin', 'main:build');
  const dev = r.commit(r.other, 'd1', 'dev');
  const mainBefore = g(r.origin, 'rev-parse', 'refs/heads/main');
  const opBefore = g(r.origin, 'rev-parse', 'refs/heads/orangepi');
  const before = snapshot(r.work);
  const target = await pushWith(r.work, { ORANGEPI_SOURCE_BRANCH: 'dev', ORANGEPI_BRANCH: 'build' });
  assert.equal(target, dev);
  assert.equal(g(r.origin, 'rev-parse', 'refs/heads/build'), dev);
  assert.equal(g(r.origin, 'rev-parse', 'refs/heads/main'), mainBefore, 'main is never touched');
  assert.equal(g(r.origin, 'rev-parse', 'refs/heads/orangepi'), opBefore, 'the default build branch is not used');
  assert.deepEqual(snapshot(r.work), before);
});

test('real git: a diverged build branch names both branches', async (t) => {
  const r = repos(t);
  g(r.work, 'push', 'origin', 'main:dev');
  g(r.work, 'push', 'origin', 'main:build');
  r.commit(r.other, 'd1', 'dev');
  const div = r.commit(r.other, 'side', 'build');
  await assert.rejects(() => pushWith(r.work, { ORANGEPI_SOURCE_BRANCH: 'dev', ORANGEPI_BRANCH: 'build' }), /build has diverged from dev/);
  assert.equal(g(r.origin, 'rev-parse', 'refs/heads/build'), div);
});

test('invalid branch names are refused before the backup, with a sentence', async () => {
  for (const bad of ['-x', 'a b', 'a;rm -rf /', '$(id)', 'a..b', '']) {
    for (const key of ['ORANGEPI_BRANCH', 'ORANGEPI_SOURCE_BRANCH']) {
      if (bad === '') continue; // blank means the default
      const w = world();
      w.runner.env = () => ({ [key]: bad });
      const j = await run(w.steps());
      assert.equal(j.state, 'failed', `${key}=${bad}`);
      assert.match(step(j, 'backup').detail || j.error || JSON.stringify(j), new RegExp(`${key} ".*" is not a valid branch name`));
      assert.equal(w.scripts.length, 0, 'nothing ran');
      assert.equal(w.gitCalls.length, 0);
    }
  }
});

test('equal branches are refused', async () => {
  const w = world();
  w.runner.env = () => ({ ORANGEPI_BRANCH: 'dev', ORANGEPI_SOURCE_BRANCH: 'dev' });
  const j = await run(w.steps());
  assert.equal(j.state, 'failed');
  assert.match(j.error, /both "dev"/);
  assert.equal(w.scripts.length, 0);
});

test('defaults are unchanged: main into orangepi, and deploy.sh gets orangepi', async () => {
  const w = world();
  const j = await run(w.steps());
  assert.equal(j.state, 'ok', j.error);
  assert.deepEqual(w.gitCalls.find((a) => a[0] === 'push'), ['push', 'origin', `${MAIN}:refs/heads/orangepi`]);
  assert.equal(w.deploys()[0].opts.env.ORANGEPI_BRANCH, 'orangepi');
});

test('a custom build branch is what deploy.sh is told to deploy', async () => {
  const w = world();
  w.runner.env = () => ({ ORANGEPI_BRANCH: 'build', ORANGEPI_SOURCE_BRANCH: 'dev' });
  const inner = w.git;
  w.git = (args) => inner(args.map((a) => a.replace('origin/dev', 'origin/main').replace('origin/build', 'origin/orangepi')));
  const j = await run(w.steps({ hookWait: 3000 }));
  assert.equal(w.deploys()[0].opts.env.ORANGEPI_BRANCH, 'build', JSON.stringify(j));
  assert.deepEqual(w.gitCalls.find((a) => a[0] === 'push'), ['push', 'origin', `${MAIN}:refs/heads/build`]);
});

test('ci logs a progress line only when its text changes', async () => {
  const w = world({ originOrangepi: MAIN, runs: [{ databaseId: 77, status: 'in_progress', conclusion: null, url: RUN_URL }] });
  let polls = 0;
  w.jobsOf = () => {
    polls += 1;
    if (polls <= 3) return [{ name: 'test', conclusion: 'success' }];
    if (polls <= 6) return [{ name: 'manifest', status: 'in_progress', conclusion: null }];
    return [{ name: 'manifest', status: 'completed', conclusion: 'success' }];
  };
  const j = await run(w.steps());
  assert.equal(step(j, 'ci').state, 'ok');
  assert.equal(j.log.split('manifest is waiting').length - 1, 1);
  assert.equal(j.log.split('manifest is in_progress').length - 1, 1);
});

// ---- releases ----------------------------------------------------------------
const fakeReleases = () => {
  const r = { calls: [] };
  r.afterUpdate = async (a) => { r.calls.push(a); return { version: a.version }; };
  return r;
};

test('a successful update records one release with the board version from before the deploy', async () => {
  const w = world();
  w.releases = fakeReleases();
  const j = await run(w.steps({ hookWait: 3000 }));
  assert.equal(j.state, 'ok', j.error);
  assert.equal(w.releases.calls.length, 1);
  const c = w.releases.calls[0];
  assert.equal(c.version, MAIN);
  assert.equal(c.previous, OLD);
  assert.equal(c.sourceBranch, 'main');
  assert.equal(c.buildBranch, 'orangepi');
  assert.equal(c.ciUrl, RUN_URL);
  assert.equal(typeof c.log, 'function');
});

test('a failed update records no release', async () => {
  for (const make of [
    (w) => { w.gh = async () => res({ code: 1, stderr: 'boom' }); }, // ci fails
    (w) => { w.script = async (name) => (name === 'deploy.sh' ? res({ code: 1, output: 'nope' }) : null); }, // deploy fails
    (w) => { w.noMove = true; }, // deploy returns 0 but the board never settles: verify/deploy fail
  ]) {
    const w = world();
    w.releases = fakeReleases();
    make(w);
    const j = await run(w.steps({ hookWait: 1000, settleGrace: 2000, deploy: 5000 }));
    assert.equal(j.state, 'failed');
    assert.equal(w.releases.calls.length, 0);
  }
});

test('a board already settled at that commit records nothing new', async () => {
  const w = world();
  w.board = { ...SETTLED_MAIN };
  w.originOrangepi = MAIN;
  w.releases = fakeReleases();
  const j = await run(w.steps({ hookWait: 3000 }));
  assert.equal(j.state, 'ok', j.error);
  assert.equal(w.releases.calls.length, 0);
});

test('a release that cannot be recorded does not fail the update', async () => {
  const w = world();
  w.releases = { afterUpdate: async () => { throw new Error('disk full'); } };
  const j = await run(w.steps({ hookWait: 3000 }));
  assert.equal(j.state, 'ok', j.error);
});

test('a failed board write does not fail the update and is retried', async () => {
  const { createReleases } = require('./releases');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rel-job-'));
  const store = [];
  let boardUp = false;
  const releaseRunner = {
    env: () => ({ ORANGEPI_DATA_DIR: '/data' }),
    ssh: async (cmd, opts) => {
      if (!boardUp) return res({ code: 255, stderr: 'ssh: connect timed out' });
      if (opts.input) { store.push(JSON.parse(opts.input)); return res(); }
      return res({ stdout: `deployed=${MAIN}\n=== releases\n${store.map((e) => JSON.stringify(e)).join('\n')}${store.length ? '\n' : ''}` });
    },
  };
  const rel = createReleases({ runner: releaseRunner, git: async () => res({ code: 128 }), file: path.join(dir, 'pi-releases.jsonl'), log: () => {} });
  try {
    const w = world();
    w.releases = rel;
    const j = await run(w.steps({ hookWait: 3000 }));
    assert.equal(j.state, 'ok', j.error);
    assert.match(j.log, /could not be written to the board/);
    assert.equal(store.length, 0);
    boardUp = true;
    await rel.sync();
    assert.deepEqual(store.map((e) => e.version), [MAIN]);
    assert.equal(store[0].previousVersion, OLD);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
