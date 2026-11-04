// SOMET-718. Admin proxy to the host-side pi helper (tools/pi-helper). The
// board's own backend must NOT mount this (mountBoardRoutes): anyone with the
// public test link can reach that backend. Nothing from the request body or
// from query values other than the validated range is forwarded.
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const pi = require('../services/piHelperClient.js');

const RANGES = ['15m', '1h', '6h'];
const TUNNELS = ['cloudflare', 'ngrok'];
const ACTIONS = ['start', 'stop'];
const PASS = [200, 202, 400, 409, 503];

function boardRoutes(pool) {
  const router = express.Router();
  router.use(requireAdmin(pool));

  const unavailable = (res, err) => res.status(503).json({
    error: 'helper_unavailable', message: err.message, hint: pi.HINT, ...(err.midAction ? { midAction: true } : {}),
  });

  // -> { status, body } | null (response already sent)
  async function ask(res, method, route) {
    let out;
    try { out = await pi.call(method, route); } catch (err) {
      if (err instanceof pi.HelperUnavailable) { unavailable(res, err); return null; }
      throw err;
    }
    if (!PASS.includes(out.status)) {
      console.error('pi helper answered', out.status, JSON.stringify(out.body));
      res.status(502).json({ error: 'helper_error', message: 'The helper returned an error' });
      return null;
    }
    return out;
  }

  const proxy = (method, route) => async (req, res, next) => {
    try {
      const out = await ask(res, method, route(req));
      if (out) res.status(out.status).json(out.body);
    } catch (err) { next(err); }
  };

  router.get('/status', async (req, res, next) => {
    try {
      let out;
      try { out = await pi.call('GET', '/status'); } catch (err) {
        if (err instanceof pi.HelperUnavailable) return res.json({ available: false, reason: 'helper_unavailable', hint: pi.HINT });
        throw err;
      }
      if (out.status !== 200) {
        console.error('pi helper answered', out.status, JSON.stringify(out.body));
        return res.status(502).json({ error: 'helper_error', message: 'The helper returned an error' });
      }
      return res.json({ available: true, ...out.body });
    } catch (err) { return next(err); }
  });

  router.get('/metrics', (req, res, next) => {
    const range = req.query.range;
    if (typeof range !== 'string' || !RANGES.includes(range)) return res.status(400).json({ error: 'bad_range', message: `range must be one of ${RANGES.join(', ')}` });
    return proxy('GET', () => `/metrics?range=${range}`)(req, res, next);
  });
  router.get('/job', proxy('GET', () => '/job'));
  router.get('/seed/preview', proxy('GET', () => '/seed/preview'));

  router.post('/update', proxy('POST', () => '/update'));
  router.post('/seed/apply', proxy('POST', () => '/seed/apply'));
  router.post('/restart', proxy('POST', () => '/restart'));
  router.post('/tunnel/:name/:action', (req, res, next) => {
    const { name, action } = req.params;
    if (!TUNNELS.includes(name) || !ACTIONS.includes(action)) return res.status(400).json({ error: 'bad_request', message: 'Unknown tunnel or action' });
    return proxy('POST', () => `/tunnel/${name}/${action}`)(req, res, next);
  });

  return router;
}

// The board's own compose never sets BOARD_TAB_ENABLED, so there /api/board 404s.
function mountBoardRoutes(app, pool, env = process.env) {
  if (env.BOARD_TAB_ENABLED === '1') app.use('/api/board', boardRoutes(pool));
}

module.exports = boardRoutes;
module.exports.mountBoardRoutes = mountBoardRoutes;
