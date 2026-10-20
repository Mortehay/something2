// SOMET-642. Client for the host-side git helper (tools/git-helper). The
// backend container has no git and never holds the push key; it asks the
// helper over a unix socket (default) or TCP (GIT_HELPER_URL, for Docker
// Desktop) with a shared-secret token the helper regenerates at every start,
// so the token is read on every call.
const fs = require('node:fs');
const http = require('node:http');
const { pcLabel } = require('./seedSync/runs.js');

const DEFAULT_SOCKET = '/app/run/git-helper.sock';
const DEFAULT_TOKEN_FILE = '/app/run/git-helper.token';
const TIMEOUT_MS = 90000; // the helper's own git timeout is 60 s

const HINT = 'Run make git-helper on this PC';

class HelperUnavailable extends Error {
  // midAction: the request had been sent when the helper went away, so the
  // git action may or may not have happened.
  constructor(message, { midAction = false } = {}) {
    super(message);
    this.midAction = midAction;
    this.name = 'HelperUnavailable';
    this.code = 'helper_unavailable';
  }
}

function readToken() {
  const file = process.env.GIT_HELPER_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').trim(); } catch { throw new HelperUnavailable('git helper token missing'); }
  if (!raw) throw new HelperUnavailable('git helper token empty');
  return raw;
}

// -> { status, body } for any HTTP answer; throws HelperUnavailable when the
// helper cannot be reached or rejects the token.
function call(method, route, payload) {
  const token = readToken();
  const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
  const headers = { 'X-Git-Helper-Token': token };
  if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
  const target = process.env.GIT_HELPER_URL
    ? (() => { const u = new URL(process.env.GIT_HELPER_URL); return { hostname: u.hostname, port: u.port || 80 }; })()
    : { socketPath: process.env.GIT_HELPER_SOCKET || DEFAULT_SOCKET };
  return new Promise((resolve, reject) => {
    const req = http.request({ ...target, method, path: route, headers, timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-JSON answer */ }
        // A wrong token means the helper restarted since the file was read.
        if (res.statusCode === 401) return reject(new HelperUnavailable('git helper rejected the token'));
        if (!body) return reject(new HelperUnavailable('git helper sent an unreadable answer', { midAction: true }));
        return resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    // ECONNREFUSED / ENOENT mean nothing was sent; anything else (reset, hang
    // up, timeout) happened with the request in flight.
    req.on('error', (e) => reject(new HelperUnavailable(`git helper unreachable: ${e.code || e.message}`,
      { midAction: !['ECONNREFUSED', 'ENOENT', 'EACCES'].includes(e.code) })));
    if (data) req.write(data);
    req.end();
  });
}

// "seed export: <groups> from <pc>", groups from the changed
// backend/seeds/sync/<group>.json paths.
function suggestCommitMessage(seedsDirty) {
  const groups = [];
  for (const p of Array.isArray(seedsDirty) ? seedsDirty : []) {
    const m = /^backend\/seeds\/sync\/([^/]+)\.json$/.exec(String(p));
    if (m && !groups.includes(m[1])) groups.push(m[1]);
  }
  return `seed export: ${groups.length ? groups.join(', ') : 'seeds'} from ${pcLabel()}`;
}

module.exports = { call, HelperUnavailable, suggestCommitMessage, HINT };
