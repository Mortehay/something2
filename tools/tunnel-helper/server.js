'use strict';
// Host-side tunnel helper. Runs as the host user (it needs the docker socket), listens on a
// unix socket (default) or 127.0.0.1:TUNNEL_HELPER_PORT, and exposes only the operations from
// tunnels.js behind a shared-secret token. It never starts a tunnel on its own.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHelperServer, serve, BadRequest } = require('../helper-core/helperServer');
const { createTunnels: realCreateTunnels } = require('./tunnels');

// Slightly over a start's own wait (40 s) plus the compose calls around it. A cold build can
// outlast it; the build then finishes on its own and the next status read adopts the result.
const DRAIN_CAP_MS = 90_000;
// Every compose call but the build of `web` (which passes its own, longer limit).
const COMPOSE_TIMEOUT_MS = 120_000;

// Dotenv-free read of the values this helper needs. Never logged or returned.
function readEnv(root) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(m[2]);
    // Quoted values keep any #; an unquoted value ends at ' #'.
    out[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '').trim();
  }
  return out;
}

// compose(args, { timeoutMs }) -> { code, stdout, stderr }. exec is injectable for tests.
function composeRunner(root, exec = execFile) {
  return (args, { timeoutMs = COMPOSE_TIMEOUT_MS } = {}) => new Promise((resolve) => {
    exec('docker', ['compose', '--project-directory', root, '--env-file', '.env', '-f', 'compose/develop/docker-compose.yml', ...args],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs },
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

  // One start/stop at a time. A start holds the lock until it has finished (a cold build of
  // `web` can take minutes) even though POST /start answers as soon as the card is `starting`.
  let busyOp = false;
  const toHttpError = (e) => {
    // A bad request stays a 400; anything else here is a compose/docker failure the backend should show.
    if (e instanceof BadRequest) return e;
    const err = new Error(String(e && e.message));
    err.code = 'docker_unavailable';
    return err;
  };
  const takeLock = () => {
    if (busyOp) {
      const e = new Error('Another tunnel start or stop is still running.');
      e.code = 'busy_op';
      throw e;
    }
    busyOp = true;
  };
  const exclusive = async (fn) => {
    takeLock();
    try { return await fn(); } catch (e) { throw toHttpError(e); } finally { busyOp = false; }
  };

  // Answers with the `starting` card at once; the build, `up` and address wait carry on in the
  // background under the lock, and how they end lands in the card and the event log. A start
  // that ends before `starting` (already on, bad request, docker down) answers with its result.
  const startInBackground = async (provider, mode) => {
    takeLock();
    let early;
    const startingSeen = new Promise((resolve) => { early = resolve; });
    const work = Promise.resolve()
      .then(() => tunnels.start(provider, mode, { onStarting: (card) => early({ card }) }))
      .then((card) => ({ card }), (error) => ({ error }))
      .finally(() => { busyOp = false; });
    const first = await Promise.race([startingSeen, work]);
    if (first.error) throw toHttpError(first.error);
    return first.card;
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
      'POST /start': (body) => startInBackground(body && body.provider, body && body.mode),
      'POST /stop': (body) => exclusive(() => tunnels.stop(body && body.provider)),
      'GET /events': (_body, { url }) => {
        const raw = new URL(url, 'http://x').searchParams.get('since');
        if (raw !== null && !/^\d+$/.test(raw)) throw new BadRequest('since must be a non-negative integer.');
        const since = raw === null ? 0 : Number(raw);
        const out = tunnels.events(since);
        // next below the reader's cursor means the helper's clock stepped back (ids start at the clock): resend all.
        return out.next < since ? tunnels.events(0) : out;
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

module.exports = { createServer, readEnv, composeRunner, COMPOSE_TIMEOUT_MS };
