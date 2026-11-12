'use strict';
// Host-side tunnel helper. Runs as the host user (it needs the docker socket), listens on a
// unix socket (default) or 127.0.0.1:TUNNEL_HELPER_PORT, and exposes only the operations from
// tunnels.js behind a shared-secret token. It never starts a tunnel on its own.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHelperServer, serve } = require('../helper-core/helperServer');
const { createTunnels: realCreateTunnels } = require('./tunnels');

// Slightly over a start's own wait (40 s) plus the compose calls around it.
const DRAIN_CAP_MS = 90_000;

// Dotenv-free read of the values this helper needs. Never logged or returned.
function readEnv(root) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

function composeRunner(root) {
  return (args) => new Promise((resolve) => {
    execFile('docker', ['compose', '--project-directory', root, '--env-file', '.env', '-f', 'compose/develop/docker-compose.yml', ...args],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr: stderr || (err && typeof err.code !== 'number' ? err.message : '') }));
  });
}

function createServer({ root, runDir, port, drainMs, createTunnels = realCreateTunnels, compose, env } = {}) {
  const repoRoot = root || process.env.TUNNEL_HELPER_ROOT || path.resolve(__dirname, '../..');
  const dir = runDir || process.env.TUNNEL_HELPER_RUN_DIR || path.join(repoRoot, 'backend', 'run');
  const tcpPort = port || (process.env.TUNNEL_HELPER_PORT ? Number(process.env.TUNNEL_HELPER_PORT) : null);
  const values = env || readEnv(repoRoot);
  const tunnels = createTunnels({
    compose: compose || composeRunner(repoRoot),
    ngrokDomain: values.NGROK_DOMAIN || undefined,
    // The authtoken is only ever a redaction pattern here.
    secrets: [values.NGROK_AUTHTOKEN].filter(Boolean),
  });

  // One start/stop at a time: a start can block for up to 40 s.
  let busyOp = false;
  const exclusive = async (fn) => {
    if (busyOp) {
      const e = new Error('Another tunnel start or stop is still running.');
      e.code = 'busy_op';
      throw e;
    }
    busyOp = true;
    try { return await fn(); } finally { busyOp = false; }
  };

  const core = createHelperServer({
    name: 'tunnel helper',
    dir,
    sockName: 'tunnel-helper.sock',
    tokenName: 'tunnel-helper.token',
    tokenHeader: 'X-Tunnel-Helper-Token',
    tcpPort,
    drainCap: drainMs || (process.env.TUNNEL_HELPER_DRAIN_MS ? Number(process.env.TUNNEL_HELPER_DRAIN_MS) : DRAIN_CAP_MS),
    stopTarget: 'make tunnel-helper-stop',
    dirEnv: 'TUNNEL_HELPER_RUN_DIR',
    sockHint: ', or use TUNNEL_HELPER_PORT',
    routes: {
      'GET /status': async () => {
        try { return await tunnels.status(); } catch (e) {
          const err = new Error(String(e.message));
          err.code = 'docker_unavailable';
          throw err;
        }
      },
      'POST /start': (body) => exclusive(() => tunnels.start(body && body.provider, body && body.mode)),
      'POST /stop': (body) => exclusive(() => tunnels.stop(body && body.provider)),
      'GET /events': (_body, { url }) => {
        const since = new URL(url, 'http://x').searchParams.get('since');
        return tunnels.events(since == null ? 0 : since);
      },
    },
    classifyError: (e) => {
      if (e && e.code === 'busy_op') return { status: 409, error: 'busy_op', message: e.message };
      if (e && e.code === 'docker_unavailable') return { status: 503, error: 'docker_unavailable', message: e.message };
      return null;
    },
    busy: () => busyOp,
  });

  return { start: core.start, server: core.server };
}

if (require.main === module) serve('tunnel-helper', createServer());

module.exports = { createServer, readEnv };
