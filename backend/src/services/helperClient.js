// Shared client for host-side helpers (tools/git-helper, tools/pi-helper). The
// backend container never holds the keys those helpers use; it asks over a unix
// socket (default) or TCP (urlEnv, for Docker Desktop) with a shared-secret
// token the helper regenerates at every start, so the token is read per call.
const fs = require('node:fs');
const http = require('node:http');

function createHelperClient({ socketEnv, urlEnv, tokenEnv, defaultSocket, defaultTokenFile, tokenHeader, label, timeoutMs, acceptNull = false }) {
  class HelperUnavailable extends Error {
    // midAction: the request had been sent when the helper went away, so the
    // action may or may not have happened.
    constructor(message, { midAction = false } = {}) {
      super(message);
      this.midAction = midAction;
      this.name = 'HelperUnavailable';
      this.code = 'helper_unavailable';
    }
  }

  function readToken() {
    const file = process.env[tokenEnv] || defaultTokenFile;
    let raw;
    try { raw = fs.readFileSync(file, 'utf8').trim(); } catch { throw new HelperUnavailable(`${label} token missing`); }
    if (!raw) throw new HelperUnavailable(`${label} token empty`);
    return raw;
  }

  // -> { status, body } for any HTTP answer; throws HelperUnavailable when the
  // helper cannot be reached or rejects the token.
  function call(method, route, payload) {
    const token = readToken();
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const headers = { [tokenHeader]: token };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const target = process.env[urlEnv]
      ? (() => { const u = new URL(process.env[urlEnv]); return { hostname: u.hostname, port: u.port || 80 }; })()
      : { socketPath: process.env[socketEnv] || defaultSocket };
    return new Promise((resolve, reject) => {
      const req = http.request({ ...target, method, path: route, headers, timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body;
          let parsed = false;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); parsed = true; } catch { /* non-JSON answer */ }
          // A wrong token means the helper restarted since the file was read.
          if (res.statusCode === 401) return reject(new HelperUnavailable(`${label} rejected the token`));
          // JSON null is a real answer only where the caller opts in (GET /job
          // with no job); otherwise it is as unreadable as a non-JSON body.
          if (!parsed || body === undefined || (body === null && !acceptNull)) return reject(new HelperUnavailable(`${label} sent an unreadable answer`, { midAction: true }));
          return resolve({ status: res.statusCode, body });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      // ECONNREFUSED / ENOENT mean nothing was sent; anything else (reset, hang
      // up, timeout) happened with the request in flight.
      req.on('error', (e) => reject(new HelperUnavailable(`${label} unreachable: ${e.code || e.message}`,
        { midAction: !['ECONNREFUSED', 'ENOENT', 'EACCES'].includes(e.code) })));
      if (data) req.write(data);
      req.end();
    });
  }

  return { call, HelperUnavailable };
}

module.exports = { createHelperClient };
