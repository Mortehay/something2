'use strict';
// SOMET-738. What the tab shows beside each link, kept across helper restarts.
//
// ngrok: no API found reports an account's usage, so outgoing bytes and requests are added up here from the
// agent's own counters. They restart with the container, and traffic this board did not carry (`make tunnel`
// on the laptop, same account) is invisible, so this is an estimate. It is counted by calendar month, while
// ngrok resets at the start of the account's billing cycle, whose date nothing here can read. ngrok's refusal
// (ERR_NGROK_725 / 727) is the one certain fact, so it wins over the estimate and only ngrok serving a request
// clears it, never the calendar.
//
// Cloudflare: quick tunnels have no published lifetime, so the time left cannot be known. How long earlier
// links really lasted can be.
const fs = require('fs');

// ngrok's free plan: https://ngrok.com/docs/pricing-limits/free-plan-limits
const OUT_LIMIT_BYTES = 1_000_000_000;
const REQUEST_LIMIT = 20_000;
const LIMIT_CODES = ['ERR_NGROK_725', 'ERR_NGROK_727'];
const PAST_LINKS_KEPT = 10;
// A link that had not answered for this long before its container was removed had already died; a healthy
// link stopped on purpose says nothing about how long links last.
const DEAD_BEFORE_STOP_MS = 3 * 60 * 1000;

const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
const percent = (v, limit) => Math.min(100, Math.round((v / limit) * 100));
const count = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

function createTunnelTracker({ file = null, now = Date.now } = {}) {
  const fresh = (t) => ({
    ngrok: { month: monthOf(t), since: t, outBytes: 0, requests: 0, lastOut: null, lastRequests: null, limitReached: false },
    cloudflare: { current: null, past: [] },
  });
  let state = fresh(now());
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = { ngrok: { ...state.ngrok, ...saved.ngrok }, cloudflare: { ...state.cloudflare, ...saved.cloudflare } };
    } catch { /* no file yet, or unreadable: start counting again */ }
  }

  function save() {
    if (!file) return;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* the display must not take the status down */ }
  }

  function rollMonth(t) {
    const n = state.ngrok;
    if (n.month === monthOf(t)) return;
    state.ngrok = { ...n, month: monthOf(t), since: t, outBytes: 0, requests: 0 };
  }

  // A counter lower than last time means a new container: everything it shows is new.
  const delta = (value, last) => (last === null || value < last ? value : value - last);

  function trackNgrok(tunnel) {
    const n = state.ngrok;
    if (tunnel.state === 'off') { n.lastOut = null; n.lastRequests = null; return; }
    if (tunnel.state !== 'on' || !tunnel.counters) return;
    const out = count(tunnel.counters.outBytes);
    const req = count(tunnel.counters.requests);
    if (out !== null) { n.outBytes += delta(out, n.lastOut); n.lastOut = out; }
    if (req !== null) { n.requests += delta(req, n.lastRequests); n.lastRequests = req; }
  }

  function trackCloudflare(tunnel, t) {
    const c = state.cloudflare;
    const close = () => {
      c.past.unshift({ seconds: Math.max(0, Math.round((c.current.lastOk - c.current.since) / 1000)), endedAt: c.current.lastOk });
      c.past = c.past.slice(0, PAST_LINKS_KEPT);
      c.current = null;
    };
    if (tunnel.state === 'off') {
      if (c.current && t - c.current.lastOk > DEAD_BEFORE_STOP_MS) close();
      c.current = null;
      return;
    }
    if (tunnel.state !== 'on' || !tunnel.verified || !tunnel.url) return;
    if (c.current && c.current.url !== tunnel.url) close();
    if (!c.current) {
      const age = Number.isFinite(tunnel.ageSeconds) ? tunnel.ageSeconds * 1000 : 0;
      c.current = { url: tunnel.url, since: t - age, lastOk: t };
    }
    c.current.lastOk = t;
  }

  function usage() {
    const n = state.ngrok;
    return {
      month: n.month,
      since: n.since,
      outBytes: n.outBytes,
      outLimitBytes: OUT_LIMIT_BYTES,
      outPercent: percent(n.outBytes, OUT_LIMIT_BYTES),
      requests: n.requests,
      requestLimit: REQUEST_LIMIT,
      requestPercent: percent(n.requests, REQUEST_LIMIT),
    };
  }

  // Adds what the tab shows to a BoardStatus. A board that is offline teaches nothing about its tunnels:
  // its tunnels read as off there, and that must not close a link or forget a counter.
  function apply(status) {
    const t = now();
    rollMonth(t);
    const tunnels = status.tunnels || {};
    if (status.online) {
      if (tunnels.ngrok) trackNgrok(tunnels.ngrok);
      if (tunnels.cloudflare) trackCloudflare(tunnels.cloudflare, t);
      save();
    }
    const { counters, ...ngrok } = tunnels.ngrok || { state: 'unknown' };
    return {
      ...status,
      tunnels: {
        ...tunnels,
        ngrok: { ...ngrok, usage: usage(), limitReached: state.ngrok.limitReached },
        cloudflare: { ...(tunnels.cloudflare || { state: 'unknown' }), pastLinkSeconds: state.cloudflare.past.map((p) => p.seconds) },
      },
    };
  }

  // What ngrok's edge answered: an error code, or null for a request it served. Another code (a bad token,
  // an agent running elsewhere) says nothing about the allowance either way.
  function noteNgrokAnswer(code) {
    const reached = code === null ? false : LIMIT_CODES.includes(code) ? true : state.ngrok.limitReached;
    if (state.ngrok.limitReached === reached) return;
    state.ngrok.limitReached = reached;
    save();
  }

  return { apply, noteNgrokAnswer };
}

module.exports = { createTunnelTracker, OUT_LIMIT_BYTES, REQUEST_LIMIT, LIMIT_CODES };
