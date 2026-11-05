'use strict';
// Host-side git helper. Runs as the host user (their git + SSH setup), listens
// on a unix socket (default) or 127.0.0.1:GIT_HELPER_PORT, and exposes only the
// allow-listed operations from gitOps.js behind a shared-secret token.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHelperServer, serve } = require('../helper-core/helperServer');
const { createGitOps, GitRefusal } = require('./gitOps');

// Slightly over a push/pull's overall op deadline (120s), so a legitimately slow op can finish.
const DRAIN_CAP_MS = 125_000;

function createServer({ root, runDir, port, drainMs } = {}) {
  const repoRoot = root || process.env.GIT_HELPER_ROOT || path.resolve(__dirname, '../..');
  const dir = runDir || process.env.GIT_HELPER_RUN_DIR || path.join(repoRoot, 'backend', 'run');
  const tcpPort = port || (process.env.GIT_HELPER_PORT ? Number(process.env.GIT_HELPER_PORT) : null);
  const ops = createGitOps({ root: repoRoot });
  const core = createHelperServer({
    name: 'git helper',
    dir,
    sockName: 'git-helper.sock',
    tokenName: 'git-helper.token',
    tokenHeader: 'X-Git-Helper-Token',
    tcpPort,
    drainCap: drainMs || (process.env.GIT_HELPER_DRAIN_MS ? Number(process.env.GIT_HELPER_DRAIN_MS) : DRAIN_CAP_MS),
    stopTarget: 'make git-helper-stop',
    dirEnv: 'GIT_HELPER_RUN_DIR',
    sockHint: ', or use GIT_HELPER_PORT',
    routes: {
      'GET /status': () => ops.status(),
      'POST /fetch': () => ops.fetch(),
      'POST /pull': () => ops.pull(),
      'POST /commit': (body) => ops.commit({ message: body && body.message }),
      'POST /push': () => ops.push(),
    },
    resultStatus: (out) => (out && out.ok === false ? 502 : 200),
    classifyError: (e) => (e instanceof GitRefusal
      ? { status: e.code === 'bad_request' ? 400 : 409, error: e.code, message: e.message }
      : null),
    busy: () => ops.isBusy(),
    abort: () => ops.abort(),
  });

  async function start() {
    try {
      const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (inside !== 'true') throw new Error('no');
    } catch {
      throw new Error(`${repoRoot} is not a git work tree`);
    }
    return core.start();
  }

  return { start, server: core.server };
}

if (require.main === module) serve('git-helper', createServer());

module.exports = { createServer };
