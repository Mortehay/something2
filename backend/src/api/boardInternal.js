// SOMET-720. A small HTTP listener for the Orange Pi helper, separate from the public
// app on purpose: it binds to 127.0.0.1 inside the backend container, on a port neither
// Caddy nor compose publishes, and starts only with BOARD_INTERNAL_ENABLED=1 (set in
// compose/orangepi alone). The helper reaches it with `remote.sh backend node -e ...`,
// so no route exists for anyone holding the public link, and no token is involved.
const http = require('node:http');

const HOST = '127.0.0.1';
const MAX_BODY = 1024;

class BodyError extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new BodyError('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new BodyError('not json')); }
    });
    req.on('error', reject);
  });
}

function boardInternalHandler(live) {
  const send = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  return async (req, res) => {
    try {
      const route = `${req.method} ${req.url}`;
      if (route === 'GET /counters') return send(res, 200, live.counters());
      if (route === 'GET /players') return send(res, 200, await live.players());
      if (route === 'GET /bosses') return send(res, 200, await live.bosses());
      if (route === 'POST /bosses/summon') {
        let body;
        try { body = await readBody(req); } catch (err) {
          if (err instanceof BodyError) return send(res, 400, { ok: false, error: 'bad_request', message: 'The body must be small JSON.' });
          throw err;
        }
        const out = await live.summon(body);
        return send(res, out.status, out.body);
      }
      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      console.error('board internal listener:', err);
      return send(res, 500, { error: 'internal', message: 'The request failed.' });
    }
  };
}

// -> the listening server, or null when it is not enabled or its port is unusable. A
// listener that cannot start logs and goes away: it never affects the game.
function startBoardInternal(live, env = process.env) {
  if (env.BOARD_INTERNAL_ENABLED !== '1') return null;
  const port = Number(env.BOARD_INTERNAL_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`board internal listener: BOARD_INTERNAL_PORT "${env.BOARD_INTERNAL_PORT}" is not a port; not started`);
    return null;
  }
  const server = http.createServer(boardInternalHandler(live));
  server.on('error', (err) => console.error(`board internal listener failed: ${err.message}`));
  server.listen(port, HOST, () => console.log(`Board internal listener on ${HOST}:${port}`));
  return server;
}

module.exports = { startBoardInternal, boardInternalHandler, HOST };
