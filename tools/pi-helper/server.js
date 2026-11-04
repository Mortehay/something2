'use strict';
// Host-side Orange Pi helper: the Pi tab's powers live here, not in the backend
// container. Socket/token/drain plumbing is tools/helper-core/helperServer.js.
const path = require('node:path');
const { createHelperServer, serve, BadRequest } = require('../helper-core/helperServer');
const { createRunner, redact } = require('./boardRunner');
const { readStatus } = require('./status');
const { createSampler } = require('./sampler');

// A running deploy gets 30 s on stop, then its child is killed.
const DRAIN_CAP_MS = 30_000;

// routes: { 'GET /status': async (body, ctx) => json }. busy()/abort() let job code hold
// the drain open and kill its children when the cap hits. secrets() redacts a 500's message.
function createServer({ root, runDir, routes = {}, drainMs, busy, abort, secrets, onListening, onDrain, afterDrain } = {}) {
  const repoRoot = root || process.env.PI_HELPER_ROOT || path.resolve(__dirname, '../..');
  const helper = createHelperServer({
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
  if (!onListening && !onDrain && !afterDrain) return helper;
  // Lifecycle hooks, all best effort: onListening once bound, onDrain before the drain
  // begins (stop timers), afterDrain once work has ended (close the shared ssh master).
  const hook = async (fn) => { if (fn) { try { await fn(); } catch { /* best effort */ } } };
  return {
    ...helper,
    start: async () => {
      const live = await helper.start();
      await hook(onListening);
      return {
        ...live,
        drain: async () => {
          await hook(onDrain);
          const clean = await live.drain();
          await hook(afterDrain);
          return clean;
        },
      };
    },
  };
}

// GET /metrics?range=15m|1h|6h -> { samples }. Any other range is a 400.
function metricsRoute(sampler) {
  return (_body, ctx) => {
    const range = new URL(ctx.url, 'http://helper').searchParams.get('range');
    const samples = sampler.samples(range);
    if (!samples) throw new BadRequest('range must be 15m, 1h or 6h.');
    return { samples };
  };
}

if (require.main === module) {
  const root = process.env.PI_HELPER_ROOT || path.resolve(__dirname, '../..');
  const runDir = process.env.PI_HELPER_RUN_DIR || path.join(root, 'backend', 'run');
  const runner = createRunner({ root });
  // The sampler reads tunnel URLs from the latest status; the helper refreshes it every 60 s.
  let latestStatus = null;
  const refreshStatus = () => readStatus(runner).then((st) => { latestStatus = st; return st; });
  const sampler = createSampler({ runner, getTunnels: () => (latestStatus && latestStatus.tunnels) || {} });
  const statusTimer = setInterval(() => { refreshStatus().catch(() => {}); }, 60_000);
  statusTimer.unref();
  serve('pi-helper', createServer({
    root,
    runDir,
    routes: { 'GET /status': refreshStatus, 'GET /metrics': metricsRoute(sampler) },
    onListening: () => sampler.start(),
    onDrain: () => { sampler.stop(); clearInterval(statusTimer); },
    afterDrain: () => runner.closeMaster(),
    busy: () => runner.busyCount() > 0,
    abort: () => runner.abort(),
    secrets: () => runner.secrets(),
  }));
}

module.exports = { createServer, metricsRoute };
