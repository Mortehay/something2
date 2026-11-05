// SOMET-718. Admin proxy to the host-side pi helper (tools/pi-helper). The
// board's own backend must NOT mount this (mountBoardRoutes): anyone with the
// public test link can reach that backend. Nothing from the request body or
// from query values other than the validated range is forwarded, except the
// typed invite fields (count, note, code) on /invites/* (SOMET-734); the
// helper validates those again.
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const pi = require('../services/piHelperClient.js');

const RANGES = ['15m', '1h', '6h', '24h', '7d', '30d'];
const TUNNELS = ['cloudflare', 'ngrok'];
const ACTIONS = ['start', 'stop'];
const PASS = [200, 202, 400, 409, 503];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SUMMON_NAME_MAX = 120;

function boardRoutes(pool) {
  const router = express.Router();
  router.use(requireAdmin(pool));

  const unavailable = (res, err) => res.status(503).json({
    error: 'helper_unavailable', message: err.message, hint: pi.HINT, ...(err.midAction ? { midAction: true } : {}),
  });

  // -> { status, body } | null (response already sent)
  async function ask(res, method, route, { previewFailed = false, notFound = false, invitesFailed = false, payload } = {}) {
    let out;
    try { out = await pi.call(method, route, payload); } catch (err) {
      if (err instanceof pi.HelperUnavailable) { unavailable(res, err); return null; }
      throw err;
    }
    // Only the seed preview and the invite codes may pass a 502: the reason is a sentence the helper already redacted.
    const classified = out.status === 502 && out.body
      && ((previewFailed && out.body.error === 'preview_failed') || (invitesFailed && out.body.error === 'invites_failed'));
    // Only a history entry that does not exist may answer 404.
    const missing = notFound && out.status === 404;
    if (!PASS.includes(out.status) && !classified && !missing) {
      console.error('pi helper answered', out.status, JSON.stringify(out.body));
      res.status(502).json({ error: 'helper_error', message: 'The helper returned an error' });
      return null;
    }
    return out;
  }

  const proxy = (method, route, opts) => async (req, res, next) => {
    try {
      const out = await ask(res, method, route(req), opts);
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
      // 503 shutting_down while draining is a normal state, same as down.
      if (out.status === 503 && out.body && out.body.error === 'shutting_down') return res.json({ available: false, reason: 'helper_unavailable', hint: pi.HINT });
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
  router.get('/history', proxy('GET', () => '/history'));
  // The id is validated here and again in the helper, where it is only compared, never used as a path.
  router.get('/history/:id', (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad_request', message: 'That is not an action id.' });
    return proxy('GET', () => `/history/${req.params.id}`, { notFound: true })(req, res, next);
  });
  router.get('/releases', proxy('GET', () => '/releases'));
  router.get('/job', proxy('GET', () => '/job'));
  router.get('/seed/preview', proxy('GET', () => '/seed/preview', { previewFailed: true }));

  // Invite codes (SOMET-734). Registration stays invite-only and the script stays a CLI: the helper runs it on the
  // board with fixed arguments. Only the typed fields below are forwarded, and the helper validates them again.
  router.get('/invites', proxy('GET', () => '/invites', { invitesFailed: true }));
  const invitePost = (route, pick, types) => (req, res, next) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    // A cheap shape check for a faster 400; the helper checks the values.
    const bad = Object.entries(types).find(([k, t]) => body[k] !== undefined && body[k] !== null && typeof body[k] !== t);
    if (bad) return res.status(400).json({ error: 'bad_request', message: `${bad[0]} must be a ${bad[1]}.` });
    return proxy('POST', () => route, { invitesFailed: true, payload: pick(body) })(req, res, next);
  };
  router.post('/invites/mint', invitePost('/invites/mint', (b) => ({ count: b.count, note: b.note }), { count: 'number', note: 'string' }));
  router.post('/invites/revoke', invitePost('/invites/revoke', (b) => ({ code: b.code }), { code: 'string' }));

  router.get('/players', proxy('GET', () => '/players'));
  router.get('/bosses', proxy('GET', () => '/bosses'));
  // SOMET-720. Exactly these four fields travel; nothing else from the body does.
  router.post('/bosses/summon', express.json({ limit: '2kb' }), async (req, res, next) => {
    const b = req.body;
    const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= SUMMON_NAME_MAX;
    const shape = b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).sort().join() === 'name,owner,replaces,world';
    if (!shape || (b.owner !== 'world' && b.owner !== 'dungeon') || !text(b.name) || !text(b.world) || !(b.replaces === null || text(b.replaces))) {
      return res.status(400).json({ error: 'bad_request', message: 'A summon needs an owner, a boss name, a world and what it replaces.' });
    }
    try {
      const out = await pi.call('POST', '/bosses/summon', { owner: b.owner, name: b.name, world: b.world, replaces: b.replaces });
      if (!PASS.includes(out.status)) {
        console.error('pi helper answered', out.status, JSON.stringify(out.body));
        return res.status(502).json({ error: 'helper_error', message: 'The helper returned an error' });
      }
      return res.status(out.status).json(out.body);
    } catch (err) {
      if (err instanceof pi.HelperUnavailable) return unavailable(res, err);
      return next(err);
    }
  });

  router.post('/update', proxy('POST', () => '/update'));
  router.post('/seed/apply', proxy('POST', () => '/seed/apply'));
  // No arguments on purpose: the specs and their order are a fixed list in the helper (SOMET-722).
  router.post('/maps/apply', proxy('POST', () => '/maps/apply'));
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
