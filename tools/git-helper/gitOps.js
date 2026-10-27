'use strict';
// Allow-listed git operations for the Seed/Export tab. There is deliberately
// no generic "run git" entry point: every argv below is fixed, and the only
// caller-supplied value (the commit message) is its own argv element.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SEEDS = 'backend/seeds';
const TIMEOUT_MS = 60_000;
// push/pull make several git calls; one overall budget keeps them bounded.
const OP_DEADLINE_MS = 120_000;
const OUTPUT_CAP = 4096;
const MAX_MESSAGE = 10_000;

class GitRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cap(s) {
  const t = String(s || '').trim();
  return t.length > OUTPUT_CAP ? `${t.slice(0, OUTPUT_CAP)}\n...[truncated]` : t;
}

function runGit(root, args, { timeout = TIMEOUT_MS, children, isAborted } = {}) {
  if (isAborted && isAborted()) {
    return Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'aborted' });
  }
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  // Never wait on an ssh password/host-key prompt; respect a user override.
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd: root, env, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const timedOut = Boolean(err && err.killed);
        resolve({
          ok: !err,
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: stdout || '',
          stderr: timedOut ? `${stderr || ''}\ngit timed out after ${timeout / 1000}s` : (stderr || (err && !stdout ? err.message : '') || ''),
        });
      });
    if (children) {
      children.add(child);
      child.once('close', () => children.delete(child));
    }
  });
}

function credentialHint(text) {
  return /terminal prompts disabled|Permission denied|could not read (Username|Password)|Host key verification failed/i.test(text)
    ? `${text}\n(git credentials are not available to the helper; run the same git command once in a terminal as this user to set them up)`
    : text;
}

function createGitOps({ root, opDeadlineMs = OP_DEADLINE_MS }) {
  let busy = false;
  const children = new Set();

  let aborted = false;
  const git = (args, opts) => runGit(root, args, { ...opts, children, isAborted: () => aborted });
  // A git runner whose every call is limited by min(60s, time left of the op deadline).
  const deadlineGit = () => {
    const end = Date.now() + opDeadlineMs;
    const run = (args) => {
      const left = end - Date.now();
      if (left <= 0) {
        return Promise.resolve({ ok: false, code: 1, stdout: '', stderr: `git operation timed out after ${opDeadlineMs / 1000}s overall` });
      }
      return git(args, { timeout: Math.min(TIMEOUT_MS, left) });
    };
    run.left = () => end - Date.now();
    return run;
  };
  // Shutdown cap reached: stop whatever git is still running and spawn nothing new.
  const abort = () => { aborted = true; for (const c of children) c.kill('SIGKILL'); };
  const isBusy = () => busy;

  async function exclusive(fn) {
    if (busy) throw new GitRefusal('busy', 'Another git operation is still running.');
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }

  async function dirtyPaths(run = git) {
    const r = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!r.ok) throw new Error(`git status failed: ${cap(r.stderr)}`);
    const parts = r.stdout.split('\0');
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      out.push(e.slice(3));
      if (e[0] === 'R' || e[0] === 'C' || e[1] === 'R' || e[1] === 'C') i++; // skip the origin path
    }
    return out;
  }

  // Pull/push always use origin/<current branch>; the configured @{u} is ignored.
  async function status(run = git) {
    const [branchR, headR, fetchR, dirty] = await Promise.all([
      run(['symbolic-ref', '--short', '-q', 'HEAD']),
      run(['log', '-1', '--format=%s']),
      run(['rev-parse', '--git-path', 'FETCH_HEAD']),
      dirtyPaths(run),
    ]);
    const branch = branchR.ok ? branchR.stdout.trim() : null;
    const remoteRef = branch ? `refs/remotes/origin/${branch}` : null;
    const upstream = remoteRef && (await run(['rev-parse', '--verify', '-q', remoteRef])).ok ? `origin/${branch}` : null;
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const c = await run(['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`]);
      if (c.ok) [behind, ahead] = c.stdout.trim().split(/\s+/).map(Number);
    }
    let lastFetchAt = null;
    if (fetchR.ok) {
      try { lastFetchAt = fs.statSync(path.resolve(root, fetchR.stdout.trim())).mtime.toISOString(); } catch { /* never fetched */ }
    }
    const inSeeds = (p) => p.startsWith(`${SEEDS}/`);
    return {
      branch,
      upstream,
      ahead,
      behind,
      seedsDirty: dirty.filter(inSeeds),
      otherDirty: dirty.filter((p) => !inSeeds(p)),
      headSubject: headR.ok ? headR.stdout.trim() : '',
      lastFetchAt,
    };
  }

  // The op already happened; a failing trailing status must never turn it into a failure.
  async function result(op, r, run) {
    const text = cap(`${r.stdout.trim()}\n${r.stderr.trim()}`);
    const out = { ok: r.ok, op, output: r.ok ? text : credentialHint(text), status: null };
    if (run && run.left() <= 0) {
      out.note = 'Status was not refreshed: the operation deadline was used up.';
      return out;
    }
    try {
      out.status = await status(run || git);
    } catch (e) {
      out.note = `Status could not be refreshed: ${cap(e.message)}`;
    }
    return out;
  }

  const fetch = () => exclusive(async () => result('fetch', await git(['fetch', '--prune'])));

  const pull = () => exclusive(async () => {
    const g = deadlineGit();
    const s = await status(g);
    if (!s.branch) throw new GitRefusal('no_upstream', 'HEAD is detached; there is no branch to pull.');
    if (s.seedsDirty.length || s.otherDirty.length) {
      throw new GitRefusal('dirty', 'The working tree has uncommitted changes; commit or discard them before pulling.');
    }
    // Fetch first so ahead/behind below are fresh, not whatever the last fetch left.
    const f = await g(['fetch', 'origin']);
    if (!f.ok) return result('pull', f, g);
    const fresh = await status(g);
    if (!fresh.upstream) throw new GitRefusal('no_upstream', `origin has no branch '${fresh.branch}'; there is nothing to pull.`);
    if (fresh.ahead > 0 && fresh.behind > 0) {
      throw new GitRefusal('diverged', 'Local and remote have diverged; resolve this in a terminal.');
    }
    return result('pull', await g(['merge', '--ff-only', `refs/remotes/origin/${fresh.branch}`]), g);
  });

  const commit = ({ message } = {}) => exclusive(async () => {
    const msg = typeof message === 'string' ? message : '';
    if (!msg.trim()) throw new GitRefusal('bad_request', 'A commit message is required.');
    if (msg.length > MAX_MESSAGE || msg.includes('\0')) throw new GitRefusal('bad_request', 'The commit message is invalid or too long.');
    const add = await git(['add', '--', SEEDS]);
    if (!add.ok) return result('commit', add);
    const staged = await git(['diff', '--cached', '--name-only', '-z', '--', SEEDS]);
    if (!staged.ok) return result('commit', staged);
    if (!staged.stdout.replace(/\0/g, '')) {
      throw new GitRefusal('nothing_to_commit', `Nothing under ${SEEDS}/ to commit.`);
    }
    // "-m <msg>" is one argv pair; the trailing pathspec restricts the commit
    // to seeds even if the user had other things staged.
    return result('commit', await git(['commit', '--cleanup=verbatim', '-m', msg, '--', SEEDS]));
  });

  const push = () => exclusive(async () => {
    const g = deadlineGit();
    const branchR = await g(['symbolic-ref', '--short', '-q', 'HEAD']);
    const branch = branchR.ok ? branchR.stdout.trim() : null;
    if (!branch) throw new GitRefusal('no_upstream', 'HEAD is detached; there is no branch to push.');
    // Fetch first: the push decision must rest on what origin has now, and is
    // measured against origin/<branch> (the push target), not @{u}.
    const f = await g(['fetch', 'origin']);
    if (!f.ok) return result('push', f, g);
    const remoteRef = `refs/remotes/origin/${branch}`;
    const exists = await g(['rev-parse', '--verify', '-q', remoteRef]);
    if (!exists.ok) throw new GitRefusal('no_upstream', `origin has no branch '${branch}'; push it once from a terminal first.`);
    const c = await g(['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`]);
    if (!c.ok) return result('push', c, g);
    const [behind, ahead] = c.stdout.trim().split(/\s+/).map(Number);
    if (behind > 0 && ahead > 0) {
      throw new GitRefusal('diverged', 'Local and remote have diverged; resolve this in a terminal. The helper never force-pushes.');
    }
    if (behind > 0) throw new GitRefusal('behind', 'The remote has newer commits; pull first.');
    // Fully qualified, no leading '+': a branch literally named '+x' must not become a forced refspec.
    return result('push', await g(['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]), g);
  });

  return { status, fetch, pull, commit, push, abort, isBusy };
}

module.exports = { createGitOps, GitRefusal, runGit, OUTPUT_CAP };
