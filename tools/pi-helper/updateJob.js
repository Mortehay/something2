'use strict';
// Update the board to the latest main: backup, push main to `orangepi`, wait for CI,
// deploy, verify. git and gh are injected so tests use fakes and temp repos only.
const { execFile } = require('node:child_process');
const { redact } = require('./boardRunner');
const { HEALTH_URL } = require('./status');

const MIN = 60_000;
const DEFAULT_TIMEOUTS = {
  backup: 10 * MIN, ci: 40 * MIN, hookWait: 3 * MIN, deploy: 25 * MIN, verify: 5 * MIN,
  ciPoll: 20_000, boardPoll: 10_000,
};
const BRANCH = 'orangepi';
const WORKFLOW = 'orangepi-images.yml';
const MANIFEST_JOB = 'manifest';
const BACKEND_CONTAINER = 'something2-orangepi-backend-1';
const EX_TEMPFAIL = 75;
const OP_MS = 60_000;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
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

// --- board queries ----------------------------------------------------------
const BOARD_NOW_CMD = `printf 'now=%s\\n' "$(date +%s)"`;

function probeCommand(appDir) {
  return `${BOARD_NOW_CMD}; `
    + `printf 'commit=%s\\n' "$(git -C ${shq(appDir)} rev-parse HEAD 2>/dev/null)"; `
    + `printf 'started=%s\\n' "$(docker inspect -f '{{.State.StartedAt}}' ${BACKEND_CONTAINER} 2>/dev/null)"; `
    + `printf 'health=%s\\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${shq(HEALTH_URL)} 2>/dev/null || echo 000)"`;
}

function parseKv(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const toSeconds = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
};

function updateJob({ runner, git, gh, clock = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeouts = {} } = {}) {
  const to = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const appDir = (runner.env && runner.env().ORANGEPI_APP_DIR) || '/app';
  // State shared between steps.
  const st = { sha: null, pushed: false, boardStart: null, alreadyCurrent: false };

  // One ssh call; { reached: false } when ssh failed (the board may be restarting).
  async function probe() {
    const r = await runner.ssh(probeCommand(appDir), { timeoutMs: 20_000 });
    if (r.code !== 0 || r.timedOut) return { reached: false };
    const kv = parseKv(r.stdout);
    const now = Number(kv.now);
    return {
      reached: true,
      now: Number.isFinite(now) && now > 0 ? now : null,
      commit: /^[0-9a-f]{40}$/.test(kv.commit || '') ? kv.commit : null,
      started: kv.started ? toSeconds(kv.started) : null,
      health: kv.health || '000',
    };
  }

  const backup = {
    name: 'backup',
    run: async ({ step, log }) => {
      // The board's own clock at job start; started-after is judged in board time.
      const t = await runner.ssh(BOARD_NOW_CMD, { timeoutMs: 20_000 });
      const n = Number(parseKv(t.stdout).now);
      st.boardStart = t.code === 0 && Number.isFinite(n) && n > 0 ? n : null;
      const r = await runner.script('backup.sh', [], { timeoutMs: to.backup, onLine: log });
      if (r.timedOut) throw new Error(`The backup did not finish within ${mins(to.backup)}. Nothing was pushed.`);
      if (r.code !== 0) throw new Error(`The backup failed (exit ${r.code}), so nothing was pushed: ${tail(r.output)}`);
      step('backup finished');
    },
  };

  const push = {
    name: 'push',
    run: async ({ step, setTarget }) => {
      const must = async (args, what) => {
        const r = await git(args);
        if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`);
        return r;
      };
      // Explicit refspecs so origin/* really move; the + is on remote-tracking refs only.
      await must(['fetch', 'origin', `+refs/heads/main:refs/remotes/origin/main`, `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`],
        `Fetching origin main and ${BRANCH}`);
      const op = (await must(['rev-parse', `origin/${BRANCH}`], `Reading origin/${BRANCH}`)).stdout.trim();
      const main = (await must(['rev-parse', 'origin/main'], 'Reading origin/main')).stdout.trim();
      st.sha = main;
      setTarget(main);
      if (op === main) {
        step(`${BRANCH} is already at main (${main.slice(0, 8)}); nothing to push`);
        return;
      }
      const anc = await git(['merge-base', '--is-ancestor', `origin/${BRANCH}`, 'origin/main']);
      if (anc.code === 1) {
        throw new Error(`${BRANCH} has diverged from main (it has commits main does not). Nothing was pushed; fix the branch by hand.`);
      }
      if (anc.code !== 0) throw new Error(`Comparing ${BRANCH} with main failed (exit ${anc.code}): ${tail(anc.stderr || anc.stdout)}`);
      // Never forced: a plain refspec, so the remote refuses anything but a fast-forward.
      await must(['push', 'origin', `${main}:refs/heads/${BRANCH}`], `Pushing main to ${BRANCH}`);
      st.pushed = true;
      step(`pushed ${main.slice(0, 8)} to ${BRANCH}`);
    },
  };

  const ci = {
    name: 'ci',
    run: async ({ step, log, setCiUrl }) => {
      const sha = st.sha;
      const deadline = clock() + to.ci;
      let url = null;
      let lastNote = '';
      for (;;) {
        const list = await gh(['run', 'list', '--workflow', WORKFLOW, '--commit', sha, '--json', 'databaseId,status,conclusion,url']);
        if (list.code === 127) throw new Error('The GitHub CLI (gh) is not installed here, so CI cannot be checked. Install gh and run gh auth login, then try again.');
        if (list.code !== 0) {
          const msg = tail(list.stderr || list.stdout);
          if (/auth login|not logged|authenticat|GH_TOKEN|HTTP 401|bad credentials/i.test(msg)) {
            throw new Error('The GitHub CLI (gh) is not signed in, so CI cannot be checked. Run gh auth login, then try again.');
          }
          lastNote = `gh failed: ${msg}`;
        } else {
          let runs = [];
          try { runs = JSON.parse(list.stdout || '[]'); } catch { lastNote = 'gh returned unreadable output'; }
          const run = Array.isArray(runs) ? runs[0] : null;
          if (!run) {
            if (!st.pushed) throw new Error(`No CI run exists for that commit (${sha.slice(0, 8)}), so its images were never built. Push a new commit to ${BRANCH} or run the workflow by hand.`);
            lastNote = 'no CI run has appeared yet';
          } else {
            url = run.url || url;
            if (url) setCiUrl(url);
            const view = await gh(['run', 'view', String(run.databaseId), '--json', 'jobs']);
            let jobs = null;
            if (view.code === 0) { try { jobs = JSON.parse(view.stdout).jobs; } catch { jobs = null; } }
            if (!Array.isArray(jobs)) lastNote = `gh could not read the jobs: ${tail(view.stderr || view.stdout)}`;
            else {
              const m = jobs.find((j) => j.name === MANIFEST_JOB);
              if (m && m.conclusion === 'success') { step(`the images are published (${url || 'no url'})`); return; }
              if (m && m.conclusion) throw new Error(`CI did not publish the images: the ${MANIFEST_JOB} job ${m.conclusion}. ${url || ''}`.trim());
              if (!m && run.status === 'completed') throw new Error(`CI finished without a ${MANIFEST_JOB} job. ${url || ''}`.trim());
              lastNote = `${MANIFEST_JOB} is ${(m && m.status) || 'waiting'}`;
            }
          }
        }
        if (clock() >= deadline) {
          throw new Error(`CI did not finish within ${mins(to.ci)} (${lastNote}). ${url || ''}`.trim());
        }
        step(lastNote);
        log(lastNote);
        await sleep(to.ciPoll);
      }
    },
  };

  const atTarget = (p) => p.reached && p.commit === st.sha && p.health === '200';

  const deploy = {
    name: 'deploy',
    run: async ({ step, log }) => {
      const t0 = clock();
      const deadline = t0 + to.deploy;
      const hookEnd = t0 + Math.min(to.hookWait, to.deploy);
      let first = true;
      let last = { reached: true };
      // The CI hook may take the board by itself; give it time before pushing from here.
      for (;;) {
        last = await probe();
        if (atTarget(last)) {
          if (first) { st.alreadyCurrent = true; step('the board is already at this commit and healthy; nothing to deploy'); }
          else step('the board took the commit from the CI hook');
          return;
        }
        first = false;
        if (clock() >= hookEnd) break;
        step(last.reached ? 'waiting for the CI hook to deploy' : 'waiting; the board is not answering');
        await sleep(to.boardPoll);
      }
      step('the hook did not deploy it; deploying over ssh');
      let lockBusy = false;
      for (;;) {
        const remaining = deadline - clock();
        if (remaining <= 0) {
          if (!last.reached) throw new Error(`The board went offline during the deploy and did not come back within ${mins(to.deploy)}.`);
          if (lockBusy) throw new Error(`Another deploy was still running after ${mins(to.deploy)}, and the board is not at this commit yet.`);
          throw new Error(`The deploy did not finish within ${mins(to.deploy)}.`);
        }
        const r = await runner.script('deploy.sh', [], {
          timeoutMs: remaining, onLine: log,
          env: { ORANGEPI_BRANCH: BRANCH, PI_SKIP_IF_CURRENT: '1' },
        });
        if (r.timedOut) throw new Error(`The deploy did not finish within ${mins(to.deploy)}.`);
        if (r.code === 0) { step('deploy finished'); return; }
        if (r.code !== EX_TEMPFAIL) {
          last = await probe();
          if (!last.reached) throw new Error(`The board went offline during the deploy (exit ${r.code}): ${tail(r.output)}`);
          throw new Error(`The deploy failed (exit ${r.code}): ${tail(r.output)}`);
        }
        lockBusy = true;
        step('another deploy holds the lock; waiting for it');
        last = await probe();
        if (atTarget(last)) { step('the other deploy brought the board to this commit'); return; }
        await sleep(to.boardPoll);
      }
    },
  };

  const verify = {
    name: 'verify',
    run: async ({ step }) => {
      const deadline = clock() + to.verify;
      const skipStarted = st.alreadyCurrent;
      // Without a board time at job start, fall back to the workstation clock with 60 s of slack.
      const since = st.boardStart != null ? st.boardStart : Math.floor(clock() / 1000) - 60;
      let why = '';
      for (;;) {
        const p = await probe();
        if (!p.reached) why = 'the board is not answering';
        else if (p.commit !== st.sha) why = `the board is at ${p.commit ? p.commit.slice(0, 8) : 'an unknown commit'}, not ${st.sha.slice(0, 8)}`;
        else if (p.health !== '200') why = `the health check answered ${p.health}`;
        else if (!skipStarted && !(p.started != null && p.started >= since)) {
          why = p.started == null ? 'the backend container start time could not be read' : 'the backend started before this update began (the old backend is still running)';
        } else {
          step(skipStarted
            ? `board at ${st.sha.slice(0, 8)} and healthy; backend start time not checked because nothing needed restarting`
            : `board at ${st.sha.slice(0, 8)}, healthy, backend restarted`);
          return;
        }
        if (clock() >= deadline) throw new Error(`The update is not confirmed after ${mins(to.verify)}: ${why}.`);
        step(why);
        await sleep(to.boardPoll);
      }
    },
  };

  return [backup, push, ci, deploy, verify];
}

module.exports = { updateJob, execTools, DEFAULT_TIMEOUTS };
