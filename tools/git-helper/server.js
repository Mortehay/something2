'use strict';
// Host-side git helper. Runs as the host user (their git + SSH setup), listens
// on a unix socket (default) or 127.0.0.1:GIT_HELPER_PORT, and exposes only the
// allow-listed operations from gitOps.js behind a shared-secret token.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { createGitOps, GitRefusal } = require('./gitOps');

const MAX_BODY = 64 * 1024;
const MAX_SOCK_PATH = 107;
// Slightly over the per-call git timeout (60s), so a legitimately slow op can finish.
const DRAIN_CAP_MS = 65_000;
const PROBE_TIMEOUT_MS = 2000;

// Is something accepting connections at this endpoint? Refused/missing/not-a-socket = stale.
function probeLive(target) {
  return new Promise((resolve) => {
    const c = net.connect(target);
    const done = (live) => { c.destroy(); resolve(live); };
    c.setTimeout(PROBE_TIMEOUT_MS, () => done(true)); // accepts but hangs: treat as live
    c.once('connect', () => done(true));
    c.once('error', (e) => done(!['ECONNREFUSED', 'ENOENT', 'ENOTSOCK'].includes(e.code)));
  });
}

function tokenOk(given, expected) {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new GitRefusal('bad_request', 'Request body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new GitRefusal('bad_request', 'Body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function createServer({ root, runDir, port, drainMs } = {}) {
  const repoRoot = root || process.env.GIT_HELPER_ROOT || path.resolve(__dirname, '../..');
  const dir = runDir || process.env.GIT_HELPER_RUN_DIR || path.join(repoRoot, 'backend', 'run');
  const tcpPort = port || (process.env.GIT_HELPER_PORT ? Number(process.env.GIT_HELPER_PORT) : null);
  const sockPath = path.join(dir, 'git-helper.sock');
  const tokenPath = path.join(dir, 'git-helper.token');
  const ops = createGitOps({ root: repoRoot });
  const drainCap = drainMs || (process.env.GIT_HELPER_DRAIN_MS ? Number(process.env.GIT_HELPER_DRAIN_MS) : DRAIN_CAP_MS);
  let token = null;
  let shuttingDown = false;
  let inflight = 0;
  let idleWaiter = null;

  const send = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };

  const routes = {
    'GET /status': () => ops.status(),
    'POST /fetch': () => ops.fetch(),
    'POST /pull': () => ops.pull(),
    'POST /commit': (body) => ops.commit({ message: body && body.message }),
    'POST /push': () => ops.push(),
  };

  async function handle(req, res) {
    if (!tokenOk(req.headers['x-git-helper-token'], token)) return send(res, 401, { error: 'unauthorized', message: 'Missing or wrong token.' });
    if (shuttingDown) return send(res, 503, { error: 'shutting_down', message: 'The git helper is shutting down.' });
    const route = routes[`${req.method} ${(req.url || '').split('?')[0]}`];
    if (!route) return send(res, 404, { error: 'not_found', message: 'No such endpoint.' });
    try {
      const body = req.method === 'POST' ? await readJson(req) : null;
      const out = await route(body);
      return send(res, out && out.ok === false ? 502 : 200, out);
    } catch (e) {
      if (e instanceof GitRefusal) return send(res, e.code === 'bad_request' ? 400 : 409, { error: e.code, message: e.message });
      return send(res, 500, { error: 'internal', message: e.message });
    }
  }

  const server = http.createServer((req, res) => {
    inflight += 1;
    // 'close' fires after the response has been flushed (or the client went away).
    res.once('close', () => {
      inflight -= 1;
      if (inflight === 0 && idleWaiter) idleWaiter();
    });
    handle(req, res);
  });

  // Stop listening, let in-flight requests (and their responses) finish, capped.
  // Resolves true when drained cleanly, false when the cap hit and git was killed.
  async function drain() {
    shuttingDown = true;
    server.close();
    server.closeIdleConnections();
    let clean = true;
    if (inflight > 0) {
      clean = await new Promise((resolve) => {
        const timer = setTimeout(() => { idleWaiter = null; resolve(false); }, drainCap);
        idleWaiter = () => { clearTimeout(timer); idleWaiter = null; resolve(true); };
      });
    }
    if (!clean) { ops.abort(); await new Promise((r) => setTimeout(r, 100)); }
    server.closeAllConnections();
    fs.rmSync(sockPath, { force: true });
    return clean;
  }

  async function start() {
    try {
      const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (inside !== 'true') throw new Error('no');
    } catch {
      throw new Error(`${repoRoot} is not a git work tree`);
    }
    // sun_path holds 107 bytes + NUL; listen() would silently truncate a longer path.
    if (!tcpPort && Buffer.byteLength(sockPath) > MAX_SOCK_PATH) {
      throw new Error(`socket path ${sockPath} is ${Buffer.byteLength(sockPath)} bytes, over the ${MAX_SOCK_PATH}-byte unix socket limit; `
        + 'set GIT_HELPER_RUN_DIR to a shorter directory, or use GIT_HELPER_PORT');
    }
    // Before anything on disk changes (the token especially): a live helper owns this endpoint.
    const endpoint = tcpPort ? { port: tcpPort, host: '127.0.0.1' } : sockPath;
    if (await probeLive(endpoint)) {
      throw new Error(`a git helper is already listening on ${tcpPort ? `127.0.0.1:${tcpPort}` : sockPath}; stop it first (make git-helper-stop)`);
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600);
    if (!tcpPort) fs.rmSync(sockPath, { force: true });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      if (tcpPort) server.listen(tcpPort, '127.0.0.1', resolve);
      else server.listen(sockPath, resolve);
    });
    if (!tcpPort) fs.chmodSync(sockPath, 0o600);
    const listening = tcpPort ? `127.0.0.1:${tcpPort}` : sockPath;
    return {
      listening,
      drain,
      close: () => new Promise((resolve) => {
        server.close(() => { fs.rmSync(sockPath, { force: true }); resolve(); });
        server.closeAllConnections();
      }),
    };
  }

  return { start, server };
}

if (require.main === module) {
  const h = createServer();
  h.start().then((handle) => {
    console.log(`git-helper listening on ${handle.listening}`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      handle.drain().then((clean) => process.exit(clean ? 0 : 1));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((e) => { console.error(`git-helper: ${e.message}`); process.exit(1); });
}

module.exports = { createServer };
