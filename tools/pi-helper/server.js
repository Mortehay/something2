'use strict';
// Host-side Orange Pi helper: the Pi tab's powers live here, not in the backend
// container. Socket/token/drain plumbing is tools/helper-core/helperServer.js.
const path = require('node:path');
const { createHelperServer, serve } = require('../helper-core/helperServer');
const { createRunner, redact } = require('./boardRunner');
const { readStatus } = require('./status');

// A running deploy gets 30 s on stop, then its child is killed.
const DRAIN_CAP_MS = 30_000;

// routes: { 'GET /status': async (body, ctx) => json }. busy()/abort() let job code hold
// the drain open and kill its children when the cap hits. secrets() redacts a 500's message.
function createServer({ root, runDir, routes = {}, drainMs, busy, abort, secrets } = {}) {
  const repoRoot = root || process.env.PI_HELPER_ROOT || path.resolve(__dirname, '../..');
  return createHelperServer({
    name: 'Pi helper',
    dir: runDir || process.env.PI_HELPER_RUN_DIR || path.join(repoRoot, 'backend', 'run'),
    sockName: 'pi-helper.sock',
    tokenName: 'pi-helper.token',
    tokenHeader: 'X-Pi-Helper-Token',
    routes,
    busy,
    abort,
    drainCap: drainMs || (process.env.PI_HELPER_DRAIN_MS ? Number(process.env.PI_HELPER_DRAIN_MS) : DRAIN_CAP_MS),
    redact: (text) => redact(text, secrets ? secrets() : []),
    stopTarget: 'make pi-helper-stop',
    dirEnv: 'PI_HELPER_RUN_DIR',
  });
}

if (require.main === module) {
  const root = process.env.PI_HELPER_ROOT || path.resolve(__dirname, '../..');
  const runner = createRunner({ root });
  serve('pi-helper', createServer({
    root,
    routes: { 'GET /status': () => readStatus(runner) },
    busy: () => runner.busyCount() > 0,
    abort: () => runner.abort(),
    secrets: () => runner.secrets(),
  }));
}

module.exports = { createServer };
