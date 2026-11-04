'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createJobs } = require('./jobs');
const { updateJob, execTools } = require('./updateJob');

const OLD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const RUN_URL = 'https://github.com/o/r/actions/runs/77';
const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 5)); };
const res = (over = {}) => ({ code: 0, stdout: '', stderr: '', output: '', timedOut: false, ...over });

// A fake world: a clock that only sleep() moves, and a board whose answers tests can rewrite.
function world(over = {}) {
  const w = {
    t: 1_000_000, boardOffset: 5_000_000, // board clock = workstation clock + 5000 s
    calls: [], gitCalls: [], ghCalls: [], scripts: [],
    board: { reached: true, commit: OLD, health: '200', startedBoardSec: 1_000 }, // started long before the job
    originOrangepi: OLD, originMain: MAIN, ancestor: 0, pushCode: 0,
    runs: [{ databaseId: 77, status: 'completed', conclusion: 'success', url: RUN_URL }],
    jobsOf: () => [{ name: 'test', conclusion: 'success' }, { name: 'build', conclusion: 'success' }, { name: 'manifest', conclusion: 'success' }, { name: 'deploy', conclusion: 'failure' }],
    deploy: null,
    ...over,
  };
  w.clock = () => w.t;
  w.sleep = async (ms) => { w.t += ms; };
  w.boardNow = () => Math.floor((w.t + w.boardOffset * 1000) / 1000);
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
      if (w.script) { const r = await w.script(name, args, opts); if (r) return r; }
      if (name === 'deploy.sh' && !w.noMove) w.board.commit = w.sha();
      return res();
    },
    ssh: async (command) => {
      w.calls.push(command);
      if (w.sshHook) { const r = w.sshHook(command); if (r) return r; }
      if (!w.board.reached) return res({ code: 255, stderr: 'ssh: connect timed out' });
      const started = w.board.startedBoardSec == null ? '' : new Date(w.board.startedBoardSec * 1000).toISOString().replace('.000Z', '.123456789Z');
      return res({ stdout: `now=${w.boardNow()}\ncommit=${w.board.commit}\nstarted=${started}\nhealth=${w.board.health}\n` });
    },
  };
  w.sha = () => w.originMain;
  w.steps = (timeouts = {}) => updateJob({ runner: w.runner, git: w.git, gh: w.gh, clock: w.clock, sleep: w.sleep, timeouts: { ciPoll: 1000, boardPoll: 1000, ...timeouts } });
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

test('step names are exactly backup, push, ci, deploy, verify', async () => {
  const w = world();
  assert.deepEqual(w.steps().map((s) => s.name), ['backup', 'push', 'ci', 'deploy', 'verify']);
});

test('a full update passes and pushes main to orangepi without force', async () => {
  const w = world({ board: { reached: true, commit: OLD, health: '200', startedBoardSec: 6_000_100 } });
  // The backend restarts when deploy.sh runs: after the job started (board time).
  w.script = (name) => { if (name === 'deploy.sh') { w.board.startedBoardSec = w.boardNow(); w.board.commit = MAIN; } };
  const j = await run(w.steps({ hookWait: 3000 }));
  assert.equal(j.state, 'ok', j.error);
  assert.deepEqual(names(j).map((n) => step(j, n).state), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(j.targetSha, MAIN);
  assert.equal(j.ciUrl, RUN_URL);
  assert.deepEqual(w.gitCalls.find((a) => a[0] === 'push'), ['push', 'origin', `${MAIN}:refs/heads/orangepi`]);
});

test('a failed backup pushes nothing', async () => {
  const w = world();
  w.script = (name) => (name === 'backup.sh' ? res({ code: 1, output: 'disk full\n' }) : null);
  const j = await run(w.steps());
  assert.equal(j.state, 'failed');
  assert.equal(step(j, 'backup').state, 'failed');
  assert.match(j.error, /backup/i);
  assert.equal(w.gitCalls.length, 0);
  assert.equal(w.scripts.some((s) => s.name === 'deploy.sh'), false);
});

test('backup runs backup.sh with a 10 minute timeout by default', async () => {
  const w = world();
  await run(w.steps());
  const b = w.scripts.find((s) => s.name === 'backup.sh');
  assert.equal(b.opts.timeoutMs, 600_000);
});

test('diverged orangepi stops before pushing', async () => {
  const w = world({ ancestor: 1 });
  const j = await run(w.steps());
  assert.equal(j.state, 'failed');
  assert.equal(step(j, 'push').state, 'failed');
  assert.match(j.error, /diverged/i);
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
  const j = await run(w.steps());
  assert.equal(step(j, 'ci').state, 'ok');
  const w2 = world({ runs: [] });
  const j2 = await run(w2.steps({ ci: 5000 }));
  assert.equal(step(j2, 'ci').state, 'failed');
  assert.match(j2.error, /no .*run/i);
});

test('with the push skipped and no CI run for that commit, ci stops at once with a sentence', async () => {
  const w = world({ originOrangepi: MAIN, runs: [] });
  const j = await run(w.steps());
  assert.equal(step(j, 'ci').state, 'failed');
  assert.match(j.error, /no CI run exists for that commit/i);
  assert.equal(w.ghCalls.length, 1);
});

test('with the push skipped, a completed successful run passes immediately', async () => {
  const w = world({ originOrangepi: MAIN });
  const j = await run(w.steps());
  assert.equal(step(j, 'ci').state, 'ok');
  assert.equal(w.ghCalls.length, 2);
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

test('deploy waits when the hook takes it: no deploy.sh call', async () => {
  const w = world();
  let polls = 0;
  w.sshHook = () => { polls += 1; if (polls === 3) { w.board.commit = MAIN; w.board.startedBoardSec = w.boardNow(); } return null; };
  const j = await run(w.steps({ hookWait: 180_000 }));
  assert.equal(j.state, 'ok', j.error);
  assert.equal(step(j, 'deploy').state, 'ok');
  assert.equal(w.scripts.some((s) => s.name === 'deploy.sh'), false);
});

test('deploy falls back to ssh when the hook never lands, with the right env', async () => {
  const w = world();
  w.script = (name) => { if (name === 'deploy.sh') { w.board.commit = MAIN; w.board.startedBoardSec = w.boardNow(); } };
  const j = await run(w.steps({ hookWait: 5000 }));
  assert.equal(j.state, 'ok', j.error);
  const d = w.scripts.filter((s) => s.name === 'deploy.sh');
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].opts.env, { ORANGEPI_BRANCH: 'orangepi', PI_SKIP_IF_CURRENT: '1' });
  assert.ok(d[0].opts.timeoutMs <= 25 * 60_000 && d[0].opts.timeoutMs > 20 * 60_000);
});

test('deploy retries on exit 75 rather than failing', async () => {
  const w = world();
  let n = 0;
  w.script = (name) => {
    if (name !== 'deploy.sh') return null;
    n += 1;
    if (n < 3) return res({ code: 75, output: 'another deploy is running\n' });
    w.board.commit = MAIN; w.board.startedBoardSec = w.boardNow();
    return null;
  };
  const j = await run(w.steps({ hookWait: 1000 }));
  assert.equal(j.state, 'ok', j.error);
  assert.equal(n, 3);
});

test('exit 75 for the whole budget fails with a sentence about another deploy', async () => {
  const w = world();
  w.script = (name) => (name === 'deploy.sh' ? res({ code: 75 }) : null);
  const j = await run(w.steps({ hookWait: 1000, deploy: 20_000 }));
  assert.equal(step(j, 'deploy').state, 'failed');
  assert.match(j.error, /another deploy/i);
});

test('exit 74 fails the deploy step with the script lines', async () => {
  const w = world();
  w.script = (name) => (name === 'deploy.sh' ? res({ code: 74, output: 'cannot create the deploy lock\nnot writable\n' }) : null);
  const j = await run(w.steps({ hookWait: 1000 }));
  assert.equal(step(j, 'deploy').state, 'failed');
  assert.match(j.error, /not writable/);
  assert.equal(w.scripts.filter((s) => s.name === 'deploy.sh').length, 1);
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
  let polls = 0;
  w.sshHook = () => {
    polls += 1;
    if (polls >= 2 && polls < 5) return res({ code: 255 });
    if (polls === 5) { w.board.commit = MAIN; w.board.startedBoardSec = w.boardNow(); }
    return null;
  };
  const j = await run(w.steps({ hookWait: 60_000 }));
  assert.equal(j.state, 'ok', j.error);
});

test('an already-current board passes quickly, deploy restarts nothing, verify skips only the started-after rule', async () => {
  const w = world({ originOrangepi: MAIN, board: { reached: true, commit: MAIN, health: '200', startedBoardSec: 1_000 } });
  const j = await run(w.steps());
  assert.equal(j.state, 'ok', j.error);
  assert.equal(w.scripts.some((s) => s.name === 'deploy.sh'), false);
  assert.match(step(j, 'deploy').detail, /already/i);
  assert.match(step(j, 'verify').detail, /not checked|skipped/i);
});

test('an already-current board still fails verify on bad health', async () => {
  const w = world({ originOrangepi: MAIN, board: { reached: true, commit: MAIN, health: '200', startedBoardSec: 1_000 } });
  w.sshHook = (() => { let n = 0; return () => { n += 1; if (n > 2) w.board.health = '502'; return null; }; })();
  const j = await run(w.steps({ hookWait: 1000, deploy: 5000, verify: 5000 }));
  assert.equal(j.state, 'failed');
});

test('verify rejects a backend started before the job', async () => {
  const w = world();
  w.script = (name) => { if (name === 'deploy.sh') w.board.commit = MAIN; }; // commit moved, healthy, but backend never restarted
  const j = await run(w.steps({ hookWait: 1000, verify: 5000 }));
  assert.equal(step(j, 'deploy').state, 'ok');
  assert.equal(step(j, 'verify').state, 'failed');
  assert.match(j.error, /started before/i);
});

test('verify rejects a board at the wrong commit, and an unhealthy one', async () => {
  const w = world({ noMove: true });
  w.script = (name) => { if (name === 'deploy.sh') w.board.startedBoardSec = w.boardNow(); };
  const j = await run(w.steps({ hookWait: 1000, verify: 5000 }));
  assert.equal(step(j, 'deploy').state, 'ok');
  assert.equal(step(j, 'verify').state, 'failed');
  const w2 = world();
  w2.script = (name) => { if (name === 'deploy.sh') { w2.board.startedBoardSec = w2.boardNow(); w2.board.commit = MAIN; w2.board.health = '503'; } };
  const j2 = await run(w2.steps({ hookWait: 1000, verify: 5000 }));
  assert.equal(step(j2, 'verify').state, 'failed');
  assert.match(j2.error, /503|health/i);
});

test('verify passes once health recovers within its window', async () => {
  const w = world();
  w.script = (name) => { if (name === 'deploy.sh') { w.board.startedBoardSec = w.boardNow(); w.board.commit = MAIN; w.board.health = '000'; } };
  let polls = 0;
  const base = w.runner.ssh;
  w.runner.ssh = async (c, o) => { const r = await base(c, o); if (w.board.health === '000' && ++polls > 3) w.board.health = '200'; return r; };
  const j = await run(w.steps({ hookWait: 1000, verify: 60_000 }));
  assert.equal(j.state, 'ok', j.error);
});

test('board queries use the fixed commands', async () => {
  const w = world({ originOrangepi: MAIN, board: { reached: true, commit: MAIN, health: '200', startedBoardSec: 1_000 } });
  await run(w.steps());
  const q = w.calls.find((c) => c.includes('rev-parse'));
  assert.match(q, /git -C '\/app' rev-parse HEAD/);
  assert.match(q, /docker inspect -f '\{\{\.State\.StartedAt\}\}' something2-orangepi-backend-1/);
  assert.match(q, /http:\/\/127\.0\.0\.1:8080\/api\/health/);
  assert.match(q, /date \+%s/);
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
