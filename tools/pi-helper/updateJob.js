'use strict';
// Update the board to the latest source branch (default main): backup, push it to the build
// branch (default orangepi), wait for CI,
// deploy, verify. git and gh are injected so tests use fakes and temp repos only.
const { execFile } = require('node:child_process');
const { redact } = require('./boardRunner');
const { resolveBranches } = require('./branches');

const MIN = 60_000;
const DEFAULT_TIMEOUTS = {
  backup: 10 * MIN, ci: 40 * MIN, hookWait: 3 * MIN, deploy: 25 * MIN, verify: 60_000,
  ciPoll: 20_000, boardPoll: 10_000, ciGrace: 2 * MIN, settleGrace: 60_000,
};
const WORKFLOW = 'orangepi-images.yml';
const MANIFEST_JOB = 'manifest';
const GH_FAILS_MAX = 5;
const EX_TEMPFAIL = 75;
const OP_MS = 60_000;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// deploy.sh prints `failed-steps=<name>; <name>` (and `stack=up` when the health wait passed) as its
// last lines when a step failed. Null when the output does not carry them.
function deployFailureMessage(output) {
  const lines = String(output || '').split('\n').map((l) => l.trim());
  const names = lines.filter((l) => l.startsWith('failed-steps=')).pop();
  if (!names || names.length <= 'failed-steps='.length) return null;
  const list = names.slice('failed-steps='.length);
  return lines.includes('stack=up')
    ? `The deploy finished with the game running, but these steps failed: ${list}. Update will redeploy next time.`
    : `The deploy failed at: ${list}.`;
}

const tail = (text, n = 3) => String(text || '').trim().split('\n').filter(Boolean).slice(-n).join(' | ');
const mins = (ms) => (ms >= MIN ? `${Math.round(ms / MIN)} minutes` : `${Math.round(ms / 1000)} seconds`);

// --- execFile wrappers ------------------------------------------------------
// Resolve { code, stdout, stderr }, never reject. A missing binary is code 127.
function execTools({ root, secrets, env }) {
  const base = env || process.env;
  const exec = (cmd, args, extraEnv) => new Promise((resolve) => {
    const secs = secrets ? secrets() : [];
    execFile(cmd, args, {
      cwd: root, timeout: OP_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
      env: { ...base, ...extraEnv },
    }, (err, stdout, stderr) => {
      let code = 0;
      let errText = stderr || '';
      if (err) {
        if (err.code === 'ENOENT') { code = 127; errText = `${cmd} was not found: ${err.message}`; }
        else if (err.killed) { code = 124; errText = `${errText}\n${cmd} timed out after ${OP_MS / 1000}s`; }
        else code = typeof err.code === 'number' ? err.code : 1;
      }
      resolve({ code, stdout: redact(stdout || '', secs), stderr: redact(errText, secs) });
    });
  });
  const gitEnv = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  if (!base.GIT_SSH_COMMAND) gitEnv.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return {
    git: (args) => exec('git', args, gitEnv),
    gh: (args) => exec('gh', args, { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }),
  };
}

// --- the board's state -------------------------------------------------------
// `remote.sh deploy-state` prints key=value lines; lib.sh (pi_deploy_state) defines them.
function parseKv(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function parseState(stdout) {
  const kv = parseKv(stdout);
  return {
    reached: true,
    head: /^[0-9a-f]{40}$/.test(kv.head || '') ? kv.head : null,
    deployed: /^[0-9a-f]{40}$/.test(kv.deployed || '') ? kv.deployed : null,
    health: kv.health || '000',
    lock: kv.lock || 'unknown',
    hookDeploying: kv.hook_deploying || 'unknown',
  };
}

// Why the board is not settled, or null when it is. Settled means: HEAD is the target, the
// marker of the last COMPLETED deploy names HEAD, health is 200, no deploy lock, and the hook
// is not deploying (unknown is allowed). A missing or unreadable field is never settled.
function unsettledReason(state, sha) {
  if (!state || !state.reached) return 'the board is not answering';
  if (state.head !== sha) return `the board is at ${state.head ? state.head.slice(0, 8) : 'an unknown commit'}, not ${sha.slice(0, 8)}`;
  if (state.deployed == null) return 'no finished deploy is recorded for this commit, so it may be half deployed';
  if (state.deployed !== state.head) return `the last finished deploy was ${state.deployed.slice(0, 8)}, not ${sha.slice(0, 8)}`;
  if (state.health !== '200') return `the health check answered ${state.health}, not 200`;
  if (state.lock !== 'no') return state.lock === 'yes' ? 'a deploy is holding the lock' : 'the deploy lock could not be read';
  if (state.hookDeploying === 'yes') return 'the deploy hook is still deploying';
  return null;
}
const isSettled = (state, sha) => unsettledReason(state, sha) === null;

function updateJob({ runner, git, gh, releases, clock = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeouts = {} } = {}) {
  const to = { ...DEFAULT_TIMEOUTS, ...timeouts };
  // State shared between steps.
  // previous: the board's deployed-sha before this update (undefined = not read yet, null = no marker).
  const st = { sha: null, ciUrl: null, pushed: false, source: null, build: null, previous: undefined };
  // Read per job, not per process: .env is edited while the helper runs. Throws a sentence.
  const readBranches = () => {
    const b = resolveBranches(runner.env());
    if (b.error) throw new Error(b.error);
    st.source = b.source;
    st.build = b.build;
  };

  // A failed step shows its failure sentence as its detail, not the last progress note.
  const guard = (name, fn) => ({
    name,
    run: async (ctx) => {
      try { await fn(ctx); } catch (e) { ctx.step(e.message); throw e; }
    },
  });

  // One read of the board; { reached: false } when the call failed (the board may be restarting).
  async function readState() {
    const r = await runner.script('remote.sh', ['deploy-state'], { timeoutMs: 45_000 });
    if (r.code !== 0 || r.timedOut) return { reached: false };
    return parseState(r.stdout);
  }

  const backup = guard('backup', async ({ step, log }) => {
    readBranches();
    const r = await runner.script('backup.sh', [], { timeoutMs: to.backup, onLine: log });
    if (r.timedOut) throw new Error(`The backup did not finish within ${mins(to.backup)}. Nothing was pushed.`);
    if (r.code !== 0) throw new Error(`The backup failed (exit ${r.code}), so nothing was pushed: ${tail(r.output)}`);
    step('backup finished');
    // The version being replaced must be read BEFORE the push: the CI hook deploys as soon as the build
    // branch moves and removes the marker first, so a read in the deploy step sees null or the new sha.
    const before = await readState();
    if (before.reached) st.previous = before.deployed;
  });

  const push = guard('push', async ({ step, setTarget }) => {
    const must = async (args, what) => {
      const r = await git(args);
      if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`);
      return r;
    };
    if (!st.build) readBranches();
    const { source, build } = st;
    // Explicit refspecs so origin/* really move; the + is on remote-tracking refs only.
    await must(['fetch', 'origin', `+refs/heads/${source}:refs/remotes/origin/${source}`, `+refs/heads/${build}:refs/remotes/origin/${build}`],
      `Fetching origin ${source} and ${build}`);
    const op = (await must(['rev-parse', `origin/${build}`], `Reading origin/${build}`)).stdout.trim();
    const main = (await must(['rev-parse', `origin/${source}`], `Reading origin/${source}`)).stdout.trim();
    st.sha = main;
    setTarget(main);
    if (op === main) {
      step(`${build} is already at ${source} (${main.slice(0, 8)}); nothing to push`);
      return;
    }
    const anc = await git(['merge-base', '--is-ancestor', op, main]);
    if (anc.code === 1) {
      throw new Error(`${build} has diverged from ${source} (it has commits ${source} does not). Nothing was pushed; fix the branch by hand.`);
    }
    if (anc.code !== 0) throw new Error(`Comparing ${build} with ${source} failed (exit ${anc.code}): ${tail(anc.stderr || anc.stdout)}`);
    // Never forced: a plain refspec, so the remote refuses anything but a fast-forward.
    await must(['push', 'origin', `${main}:refs/heads/${build}`], `Pushing ${source} to ${build}`);
    st.pushed = true;
    step(`pushed ${main.slice(0, 8)} to ${build}`);
  });

  const ci = guard('ci', async ({ step, log, setCiUrl }) => {
    const sha = st.sha;
    const t0 = clock();
    const deadline = t0 + to.ci;
    let url = null;
    let note = '';
    let fails = 0;
    let failKind = '';
    let logged = ''; // the last progress line logged: repeats are not
    const fail = (kind, msg) => { fails += 1; failKind = kind; note = msg; };
    for (;;) {
      const list = await gh(['run', 'list', '--workflow', WORKFLOW, '--commit', sha, '--json', 'databaseId,status,conclusion,url']);
      let run = null;
      let readable = false;
      if (list.code === 127) throw new Error('The GitHub CLI (gh) is not installed here, so CI cannot be checked. Install gh and run gh auth login, then try again.');
      if (list.code !== 0) {
        const msg = tail(list.stderr || list.stdout);
        if (/auth login|not logged|authenticat|GH_TOKEN|HTTP 401|bad credentials/i.test(msg)) {
          throw new Error('The GitHub CLI (gh) is not signed in, so CI cannot be checked. Run gh auth login, then try again.');
        }
        fail('gh', `gh failed: ${msg}`);
      } else {
        let runs = null;
        try { runs = JSON.parse(list.stdout || '[]'); } catch { runs = null; }
        if (!Array.isArray(runs)) fail('parse', `gh returned output that could not be read: ${tail(list.stdout) || '(empty)'}`);
        else { readable = true; run = runs[0] || null; }
      }
      if (readable && !run) {
        fails = 0;
        // A pushed commit starts a run within about 30 s. One that was not pushed now has a run already or never will.
        if (!st.pushed && clock() - t0 >= to.ciGrace) {
          throw new Error(`No CI run exists for that commit (${sha.slice(0, 8)}), so its images were never built. Push a new commit to ${st.build} or run the workflow by hand.`);
        }
        note = 'no CI run has appeared yet';
      } else if (run) {
        url = run.url || url;
        if (url) { setCiUrl(url); st.ciUrl = url; }
        const view = await gh(['run', 'view', String(run.databaseId), '--json', 'jobs']);
        let jobs = null;
        if (view.code === 0) { try { jobs = JSON.parse(view.stdout).jobs; } catch { jobs = null; } }
        if (!Array.isArray(jobs)) fail('gh', `gh could not read the jobs: ${tail(view.stderr || view.stdout) || '(empty)'}`);
        else {
          fails = 0;
          const m = jobs.find((j) => j.name === MANIFEST_JOB);
          if (m && m.conclusion === 'success') { step(`the images are published (${url || 'no url'})`); return; }
          if (m && m.conclusion) throw new Error(`CI did not publish the images: the ${MANIFEST_JOB} job ${m.conclusion}. ${url || ''}`.trim());
          if (!m && run.status === 'completed') throw new Error(`CI finished without a ${MANIFEST_JOB} job. ${url || ''}`.trim());
          note = `${MANIFEST_JOB} is ${(m && m.status) || 'waiting'}`;
        }
      }
      if (fails >= GH_FAILS_MAX) {
        throw new Error(failKind === 'parse'
          ? `The GitHub CLI returned output that could not be read ${fails} times in a row; CI was not checked. ${note}`
          : `The GitHub CLI failed ${fails} times in a row, so CI was not checked. ${note}`);
      }
      if (clock() >= deadline) throw new Error(`CI did not finish within ${mins(to.ci)} (${note}). ${url || ''}`.trim());
      step(note);
      if (note !== logged) { logged = note; log(note); }
      await sleep(to.ciPoll);
    }
  });

  const deploy = guard('deploy', async ({ step, log }) => {
    const t0 = clock();
    const deadline = t0 + to.deploy;
    const hookEnd = t0 + Math.min(to.hookWait, to.deploy);
    let deployedAt = null; // when deploy.sh last returned 0
    let everReached = false;
    let last = null;
    for (;;) {
      last = await readState();
      if (last.reached) everReached = true;
      if (last.reached && st.previous === undefined) st.previous = last.deployed; // fallback when the pre-push read failed
      const why = unsettledReason(last, st.sha);
      if (why === null) { step(`the board is at ${st.sha.slice(0, 8)} and settled`); return; }
      if (clock() >= deadline) {
        if (!everReached) throw new Error(`The board went offline during the deploy and was never reachable within ${mins(to.deploy)}.`);
        if (!last.reached) throw new Error(`The board went offline during the deploy and did not come back within ${mins(to.deploy)}.`);
        throw new Error(`The board did not settle within ${mins(to.deploy)}: ${why}.`);
      }
      if (!last.reached) {
        step('waiting; the board is not answering');
      } else if (last.lock === 'yes' || last.hookDeploying === 'yes') {
        step(last.lock === 'yes' ? 'another deploy holds the lock; waiting for it' : 'the CI hook is deploying; waiting for it');
      } else if (deployedAt !== null) {
        if (clock() - deployedAt >= to.settleGrace) {
          throw new Error(`The deploy finished but the board is not settled: ${why}.`);
        }
        step(`the deploy finished; waiting for the board to settle (${why})`);
      } else if (clock() < hookEnd) {
        step(`waiting for the CI hook to deploy (${why})`);
      } else {
        step(`deploying over ssh (${why})`);
        const r = await runner.script('deploy.sh', [], {
          timeoutMs: Math.max(1000, deadline - clock()), onLine: log,
          env: { ORANGEPI_BRANCH: st.build, PI_SKIP_IF_CURRENT: '1' },
        });
        if (r.timedOut) throw new Error(`The deploy did not finish within ${mins(to.deploy)}.`);
        if (r.code === 0) deployedAt = clock();
        else if (r.code === EX_TEMPFAIL) step('another deploy holds the lock; will retry');
        else {
          const after = await readState();
          if (!after.reached) throw new Error(`The board went offline during the deploy (exit ${r.code}): ${tail(r.output)}`);
          throw new Error(deployFailureMessage(r.output) || `The deploy failed (exit ${r.code}): ${tail(r.output)}`);
        }
      }
      await sleep(to.boardPoll);
    }
  });

  // A release is written only after verify passed. Nothing here may fail the update.
  async function recordRelease(log) {
    if (!releases || st.previous === st.sha) return;
    try {
      await releases.afterUpdate({ version: st.sha, previous: st.previous, sourceBranch: st.source, buildBranch: st.build, ciUrl: st.ciUrl, log });
    } catch (e) { try { log(`The release could not be recorded: ${e && e.message}`); } catch { /* best effort */ } }
  }

  const verify = guard('verify', async ({ step, log }) => {
    let why = '';
    for (let read = 0; read < 2; read += 1) {
      const state = await readState();
      why = unsettledReason(state, st.sha);
      if (why === null) {
        const hook = state.hookDeploying === 'no' ? 'the deploy hook is idle' : 'the deploy hook state is unknown';
        step(`confirmed: the board is at ${st.sha.slice(0, 8)}, a finished deploy of it is recorded, health 200, no deploy lock, ${hook}`);
        await recordRelease(log);
        return;
      }
      if (read === 0) await sleep(to.verify);
    }
    throw new Error(`The update is not confirmed: ${why}.`);
  });

  return [backup, push, ci, deploy, verify];
}

module.exports = { updateJob, execTools, isSettled, unsettledReason, parseState, DEFAULT_TIMEOUTS };
