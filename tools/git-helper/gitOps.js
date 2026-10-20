'use strict';
// Allow-listed git operations for the Seed/Export tab. There is deliberately
// no generic "run git" entry point: every argv below is fixed, and the only
// caller-supplied value (the commit message) is its own argv element.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SEEDS = 'backend/seeds';
const TIMEOUT_MS = 60_000;
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

function runGit(root, args, { timeout = TIMEOUT_MS } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  // Never wait on an ssh password/host-key prompt; respect a user override.
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, env, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const timedOut = Boolean(err && err.killed);
        resolve({
          ok: !err,
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: stdout || '',
          stderr: timedOut ? `${stderr || ''}\ngit timed out after ${timeout / 1000}s` : (stderr || (err && !stdout ? err.message : '') || ''),
        });
      });
  });
}

function credentialHint(text) {
  return /terminal prompts disabled|Permission denied|could not read (Username|Password)|Host key verification failed/i.test(text)
    ? `${text}\n(git credentials are not available to the helper; run the same git command once in a terminal as this user to set them up)`
    : text;
}

function createGitOps({ root }) {
  let busy = false;

  const git = (args, opts) => runGit(root, args, opts);

  async function exclusive(fn) {
    if (busy) throw new GitRefusal('busy', 'Another git operation is still running.');
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }

  async function dirtyPaths() {
    const r = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
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

  async function status() {
    const [branchR, upR, headR, fetchR, dirty] = await Promise.all([
      git(['symbolic-ref', '--short', '-q', 'HEAD']),
      git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
      git(['log', '-1', '--format=%s']),
      git(['rev-parse', '--git-path', 'FETCH_HEAD']),
      dirtyPaths(),
    ]);
    const branch = branchR.ok ? branchR.stdout.trim() : null;
    const upstream = upR.ok ? upR.stdout.trim() : null;
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const c = await git(['rev-list', '--left-right', '--count', '@{u}...HEAD']);
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

  async function result(op, r) {
    const text = cap(`${r.stdout.trim()}\n${r.stderr.trim()}`);
    return { ok: r.ok, op, output: r.ok ? text : credentialHint(text), status: await status() };
  }

  const fetch = () => exclusive(async () => result('fetch', await git(['fetch', '--prune'])));

  const pull = () => exclusive(async () => {
    const s = await status();
    if (s.seedsDirty.length || s.otherDirty.length) {
      throw new GitRefusal('dirty', 'The working tree has uncommitted changes; commit or discard them before pulling.');
    }
    if (!s.upstream) throw new GitRefusal('no_upstream', 'The current branch has no upstream to pull from.');
    return result('pull', await git(['pull', '--ff-only']));
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
    return result('commit', await git(['commit', '-m', msg, '--', SEEDS]));
  });

  const push = () => exclusive(async () => {
    const s = await status();
    if (!s.branch) throw new GitRefusal('no_upstream', 'HEAD is detached; there is no branch to push.');
    if (!s.upstream) throw new GitRefusal('no_upstream', 'The current branch has no upstream.');
    if (s.behind > 0 && s.ahead > 0) {
      throw new GitRefusal('diverged', 'Local and remote have diverged; resolve this in a terminal. The helper never force-pushes.');
    }
    if (s.behind > 0) throw new GitRefusal('behind', 'The remote has newer commits; pull first.');
    // Fully qualified, no leading '+': a branch literally named '+x' must not become a forced refspec.
    return result('push', await git(['push', 'origin', `refs/heads/${s.branch}:refs/heads/${s.branch}`]));
  });

  return { status, fetch, pull, commit, push };
}

module.exports = { createGitOps, GitRefusal, runGit, OUTPUT_CAP };
