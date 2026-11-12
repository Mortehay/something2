// Tunnels admin tab (dev PC only). Admin-only proxy to the host-side tunnel helper plus the
// recorded history. 404 unless TUNNEL_TAB_ENABLED === 'true' (read per request). Responses are
// built from whitelisted fields only, so no .env value (NGROK_AUTHTOKEN) can leak through.
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const defaultClient = require('../services/tunnelHelperClient.js');
const defaultTraffic = require('../services/tunnelTraffic.js');
const { registrationMode } = require('../productionSafety.js');

const PROVIDERS = ['cloudflare', 'ngrok'];
const MODES = ['built', 'live'];
const RETENTION_DAYS = 30;

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

// Pass through only the helper's own error code and message.
function passError(res, status, body) {
  const out = { error: (body && typeof body.error === 'string') ? body.error : 'helper_error' };
  if (body && typeof body.message === 'string') out.message = body.message;
  return res.status(status).json(out);
}

const STATE_FIELDS = ['provider', 'state', 'mode', 'url', 'startedAt', 'error'];
function pickState(st) {
  const out = {};
  for (const k of STATE_FIELDS) out[k] = st && st[k] !== undefined ? st[k] : null;
  return out;
}

// 400/409/503 pass the helper's error+message; anything else is a 502.
function sendHelperFailure(res, r) {
  if ([400, 409, 503].includes(r.status)) return passError(res, r.status, r.body);
  return res.status(502).json({ error: 'helper_error' });
}

module.exports = function tunnelRoutes(pool, { client = defaultClient, traffic = defaultTraffic } = {}) {
  const router = express.Router();
  const { call, HelperUnavailable, HINT } = client;

  router.use((req, res, next) => {
    if (process.env.TUNNEL_TAB_ENABLED !== 'true') return res.status(404).json({ error: 'not found' });
    return next();
  });
  router.use(requireAdmin(pool));

  const handler = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (HelperUnavailable && err instanceof HelperUnavailable) {
        return res.status(503).json({ error: 'helper_unavailable', hint: HINT });
      }
      console.error('tunnel route failed', err && err.message);
      return res.status(500).json({ error: 'tunnel request failed' });
    }
    return undefined;
  };

  const playersFor = (state) => {
    const host = state && state.url ? hostOf(state.url) : null;
    return host ? traffic.countFor(host) : 0;
  };

  router.get('/', async (req, res) => {
    let r;
    try {
      r = await call('GET', '/status');
    } catch (err) {
      if (HelperUnavailable && err instanceof HelperUnavailable) return res.json({ available: false, hint: HINT });
      console.error('tunnel status failed', err && err.message);
      return res.status(500).json({ error: 'tunnel request failed' });
    }
    if (r.status !== 200) return sendHelperFailure(res, r);
    const tunnels = {};
    for (const p of PROVIDERS) {
      const st = (r.body && r.body[p]) || { provider: p, state: 'off' };
      tunnels[p] = { ...pickState(st), players: playersFor(st) };
    }
    return res.json({ available: true, registrationMode: registrationMode(), tunnels });
  });

  router.get('/history', handler(async (req, res) => {
    const d = Number.parseInt(req.query.days, 10);
    const days = Number.isFinite(d) && d > 0 ? Math.min(d, RETENTION_DAYS) : RETENTION_DAYS;
    const { rows: sessions } = await pool.query(
      `SELECT id, provider, mode, url, started_at, ended_at, end_reason, peak_players, error
         FROM tunnel_sessions
        WHERE started_at >= now() - ($1::int * interval '1 day')
        ORDER BY started_at DESC, id DESC`, [days]);
    const ids = sessions.map((s) => s.id);
    const players = new Map();
    const events = new Map();
    if (ids.length) {
      const pr = await pool.query(
        `SELECT p.session_id, u.username
           FROM tunnel_session_players p JOIN users u ON u.id = p.user_id
          WHERE p.session_id = ANY($1::int[]) ORDER BY p.first_seen, u.username`, [ids]);
      for (const r of pr.rows) {
        if (!players.has(r.session_id)) players.set(r.session_id, []);
        players.get(r.session_id).push(r.username);
      }
      const er = await pool.query(
        `SELECT session_id, at, kind, detail FROM tunnel_session_events
          WHERE session_id = ANY($1::int[]) ORDER BY at, id`, [ids]);
      for (const r of er.rows) {
        if (!events.has(r.session_id)) events.set(r.session_id, []);
        events.get(r.session_id).push({ at: r.at, kind: r.kind, detail: r.detail });
      }
    }
    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        provider: s.provider,
        mode: s.mode,
        url: s.url,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        endReason: s.end_reason,
        durationSec: Math.max(0, Math.round(((s.ended_at ? new Date(s.ended_at) : new Date()) - new Date(s.started_at)) / 1000)),
        peakPlayers: s.peak_players,
        players: players.get(s.id) || [],
        error: s.error,
        events: events.get(s.id) || [],
      })),
    });
  }));

  const proxy = (action) => handler(async (req, res) => {
    const { provider } = req.params;
    if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'bad_request', message: 'provider must be cloudflare or ngrok' });
    const payload = { provider };
    if (action === 'start') {
      const mode = (req.body && req.body.mode) === undefined ? 'built' : req.body.mode;
      if (!MODES.includes(mode)) return res.status(400).json({ error: 'bad_request', message: 'mode must be built or live' });
      payload.mode = mode;
    }
    const r = await call('POST', `/${action}`, payload);
    if (r.status === 200) return res.json({ ...pickState(r.body), players: playersFor(r.body) });
    return sendHelperFailure(res, r);
  });

  router.post('/:provider/start', proxy('start'));
  router.post('/:provider/stop', proxy('stop'));

  return router;
};
