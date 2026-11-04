'use strict';
// Host-side Orange Pi helper: the Pi tab's powers live here, not in the backend
// container. Same socket/token/drain/pid shape as tools/git-helper/server.js.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { probeLive, tokenOk } = require('../git-helper/server');
const { createRunner } = require('./boardRunner');
const { readStatus } = require('./status');

const MAX_BODY = 64 * 1024;
const MAX_SOCK_PATH = 107;
// A running deploy gets 30 s on stop, then its child is killed and the job marked failed.
const DRAIN_CAP_MS = 30_000;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request body too large.'), { code: 'bad_request' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Body is not JSON.'), { code: 'bad_request' })); }
    });
    req.on('error', reject);
  });
}

// routes: { 'GET /status': async (body, ctx) => json }. busy()/abort() let later
// job code hold the drain open and kill its children when the cap hits.
function createServer({ root, runDir, routes = {}, drainMs, busy = () => false, abort = () => {} } = {}) {
  const repoRoot = root || process.env.PI_HELPER_ROOT || path.resolve(__dirname, '../..');
  const dir = runDir || process.env.PI_HELPER_RUN_DIR || path.join(repoRoot, 'backend', 'run');
  const sockPath = path.join(dir, 'pi-helper.sock');
  const tokenPath = path.join(dir, 'pi-helper.token');
  const drainCap = drainMs || (process.env.PI_HELPER_DRAIN_MS ? Number(process.env.PI_HELPER_DRAIN_MS) : DRAIN_CAP_MS);
  let token = null;
  let shuttingDown = false;
  let inflight = 0;

  const send = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };

  async function handle(req, res) {
    if (!tokenOk(req.headers['x-pi-helper-token'], token)) return send(res, 401, { error: 'unauthorized', message: 'Missing or wrong token.' });
    if (shuttingDown) return send(res, 503, { error: 'shutting_down', message: 'The Pi helper is shutting down.' });
    const route = routes[`${req.method} ${(req.url || '').split('?')[0]}`];
    if (!route) return send(res, 404, { error: 'not_found', message: 'No such endpoint.' });
    try {
      const body = req.method === 'POST' ? await readJson(req) : null;
      return send(res, 200, await route(body, { url: req.url }));
    } catch (e) {
      if (e.code === 'bad_request') return send(res, 400, { error: 'bad_request', message: e.message });
      return send(res, 500, { error: 'internal', message: e.message });
    }
  }

  const server = http.createServer((req, res) => {
    inflight += 1;
    res.once('close', () => { inflight -= 1; });
    handle(req, res);
  });

  async function drain() {
    shuttingDown = true;
    server.close();
    server.closeIdleConnections();
    const settled = () => inflight === 0 && !busy();
    const deadline = Date.now() + drainCap;
    while (!settled() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const clean = settled();
    if (!clean) { abort(); await new Promise((r) => setTimeout(r, 100)); }
    server.closeAllConnections();
    fs.rmSync(sockPath, { force: true });
    return clean;
  }

  async function start() {
    if (Buffer.byteLength(sockPath) > MAX_SOCK_PATH) {
      throw new Error(`socket path ${sockPath} is ${Buffer.byteLength(sockPath)} bytes, over the ${MAX_SOCK_PATH}-byte unix socket limit; set PI_HELPER_RUN_DIR to a shorter directory`);
    }
    if (await probeLive(sockPath)) {
      throw new Error(`a Pi helper is already listening on ${sockPath}; stop it first (make pi-helper-stop)`);
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600);
    fs.rmSync(sockPath, { force: true });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sockPath, resolve);
    });
    fs.chmodSync(sockPath, 0o600);
    return {
      listening: sockPath,
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
  const root = process.env.PI_HELPER_ROOT || path.resolve(__dirname, '../..');
  const runner = createRunner({ root });
  const h = createServer({ root, routes: { 'GET /status': () => readStatus(runner) } });
  h.start().then((handle) => {
    console.log(`pi-helper listening on ${handle.listening}`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      handle.drain().then((clean) => process.exit(clean ? 0 : 1));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((e) => { console.error(`pi-helper: ${e.message}`); process.exit(1); });
}

module.exports = { createServer };
