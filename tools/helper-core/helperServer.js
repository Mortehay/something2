'use strict';
// Shared plumbing for the host-side helpers (git-helper, pi-helper): a unix socket
// (or loopback TCP) behind a shared-secret token, a 503 + drain on shutdown, and a
// pid-less start/stop that refuses to run twice. Each helper supplies only its
// routes and how its errors map to HTTP.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const MAX_BODY = 64 * 1024;
const MAX_SOCK_PATH = 107;
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

class BadRequest extends Error {
  constructor(message) { super(message); this.code = 'bad_request'; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new BadRequest('Request body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new BadRequest('Body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

// name: "git helper" (for messages). dir/sockName/tokenName/tokenHeader: where and how.
// routes: { 'GET /x': async (body, ctx) => json }.
// busy(): work still running after requests finish; abort(): kill it.
// classifyError(e) -> { status, error, message } | null (null = generic 500).
// resultStatus(out) -> HTTP status for a successful route result (default 200).
// redact(text) -> text, applied to a 500's message.
// stopTarget/dirEnv/sockHint: hints in the "already running" and "path too long" messages.
function createHelperServer({
  name, dir, sockName, tokenName, tokenHeader, tcpPort, routes = {}, busy = () => false, abort = () => {},
  drainCap = 30_000, classifyError = () => null, resultStatus = () => 200, redact = (s) => s, stopTarget, dirEnv, sockHint = '',
}) {
  const sockPath = path.join(dir, sockName);
  const tokenPath = path.join(dir, tokenName);
  const headerKey = tokenHeader.toLowerCase();
  let token = null;
  let shuttingDown = false;
  let inflight = 0;

  const send = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };

  async function handle(req, res) {
    if (!tokenOk(req.headers[headerKey], token)) return send(res, 401, { error: 'unauthorized', message: 'Missing or wrong token.' });
    if (shuttingDown) return send(res, 503, { error: 'shutting_down', message: `The ${name} is shutting down.` });
    const route = routes[`${req.method} ${(req.url || '').split('?')[0]}`];
    if (!route) return send(res, 404, { error: 'not_found', message: 'No such endpoint.' });
    try {
      const body = req.method === 'POST' ? await readJson(req) : null;
      const out = await route(body, { url: req.url });
      return send(res, resultStatus(out), out);
    } catch (e) {
      if (e instanceof BadRequest) return send(res, 400, { error: 'bad_request', message: e.message });
      const mapped = classifyError(e);
      if (mapped) return send(res, mapped.status, { error: mapped.error, message: mapped.message });
      return send(res, 500, { error: 'internal', message: redact(String(e.message)) });
    }
  }

  const server = http.createServer((req, res) => {
    inflight += 1;
    // 'close' fires after the response has been flushed (or the client went away).
    res.once('close', () => { inflight -= 1; });
    handle(req, res);
  });

  // Stop listening, let in-flight requests and running work finish (capped), then abort().
  // Resolves true when drained cleanly, false when the cap hit and work was aborted.
  async function drain() {
    shuttingDown = true;
    server.close();
    server.closeIdleConnections();
    const settled = () => inflight === 0 && !busy();
    const deadline = Date.now() + drainCap;
    while (!settled() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const clean = settled();
    if (!clean || busy()) {
      // An abort that returns a promise (pi-helper: TERM, grace, KILL) is awaited; a synchronous one keeps its 100 ms.
      const pending = abort();
      if (pending && typeof pending.then === 'function') await pending.catch(() => {});
      else await new Promise((r) => setTimeout(r, 100));
    }
    server.closeAllConnections();
    fs.rmSync(sockPath, { force: true });
    return clean;
  }

  async function start() {
    // sun_path holds 107 bytes + NUL; listen() would silently truncate a longer path.
    if (!tcpPort && Buffer.byteLength(sockPath) > MAX_SOCK_PATH) {
      throw new Error(`socket path ${sockPath} is ${Buffer.byteLength(sockPath)} bytes, over the ${MAX_SOCK_PATH}-byte unix socket limit; `
        + `set ${dirEnv} to a shorter directory${sockHint}`);
    }
    // Before anything on disk changes (the token especially): a live helper owns this endpoint.
    const endpoint = tcpPort ? { port: tcpPort, host: '127.0.0.1' } : sockPath;
    if (await probeLive(endpoint)) {
      throw new Error(`a ${name} is already listening on ${tcpPort ? `127.0.0.1:${tcpPort}` : sockPath}; stop it first (${stopTarget})`);
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
    return {
      listening: tcpPort ? `127.0.0.1:${tcpPort}` : sockPath,
      drain,
      close: () => new Promise((resolve) => {
        server.close(() => { fs.rmSync(sockPath, { force: true }); resolve(); });
        server.closeAllConnections();
      }),
    };
  }

  return { start, server };
}

// The `require.main` half: start, log, drain on SIGTERM/SIGINT, exit 0 clean / 1 after an abort.
function serve(label, helper) {
  helper.start().then((handle) => {
    console.log(`${label} listening on ${handle.listening}`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      handle.drain().then((clean) => process.exit(clean ? 0 : 1));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((e) => { console.error(`${label}: ${e.message}`); process.exit(1); });
}

module.exports = { createHelperServer, serve, probeLive, tokenOk, BadRequest };
