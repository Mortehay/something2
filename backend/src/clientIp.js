// Who the rate limiters think you are (SOMET-437).
//
// Express reports `req.ip` as the address of whatever opened the TCP
// connection. Behind the production stack that is the Caddy container, for
// every request from every player, so both limiters -- the global 300/min in
// index.js and the 10-per-15-min auth limiter in auth/routes.js -- degraded
// into ONE shared bucket the moment the game was served through a proxy.
//
// The obvious fix is the dangerous one. `app.set('trust proxy', true)` makes
// Express believe the left-most X-Forwarded-For entry, and X-Forwarded-For is
// just a request header: a client that appends one gets a fresh bucket per
// request, which is strictly worse than the shared bucket it replaces. So
// nothing here trusts anything unless the operator has said what is in front:
//
//   TRUST_PROXY             number of proxy hops (or 'loopback' / a CIDR list).
//                           Unset => nothing is trusted, headers are ignored,
//                           behaviour is exactly what it was before this file.
//   TRUST_CF_CONNECTING_IP  honour Cloudflare's CF-Connecting-IP. Cloudflare
//                           SETS and OVERWRITES that header at its edge, so it
//                           is the one value in the chain a client cannot
//                           choose -- but only if the request really did come
//                           through Cloudflare, which is why it does nothing
//                           unless TRUST_PROXY is configured too.
const { ipKeyGenerator } = require('express-rate-limit');

const CF_HEADER = 'cf-connecting-ip';

// Values that would mean "trust whatever the request claims". Refused loudly
// at startup: a limiter that anyone can sidestep by rotating a header is worse
// than no limiter, because it still reads as protection on the dashboard.
const BLANKET = new Set(['true', 'yes', 'all', '*']);

function trustProxySetting(env = process.env) {
  const raw = String(env.TRUST_PROXY ?? '').trim();
  if (!raw || raw === '0' || raw === 'false') return false;
  if (BLANKET.has(raw.toLowerCase())) {
    throw new Error(
      `TRUST_PROXY=${raw} would trust a client-supplied X-Forwarded-For and let anyone bypass `
      + 'the rate limiters. Set the number of proxy hops in front of the backend instead '
      + '(e.g. TRUST_PROXY=2 for cloudflared -> caddy), or a subnet list.',
    );
  }
  // A hop count is the common case; anything else is passed through to Express,
  // which also accepts 'loopback', 'uniquelocal' and comma-separated CIDRs.
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

function applyTrustProxy(app, env = process.env) {
  app.set('trust proxy', trustProxySetting(env));
}

function trustsCfHeader(env = process.env) {
  const raw = String(env.TRUST_CF_CONNECTING_IP ?? '').trim().toLowerCase();
  // Paired with TRUST_PROXY on purpose -- see the header comment: with no
  // trusted hop in front, the request reaching us IS the client, and it can
  // send any CF-Connecting-IP it likes.
  return (raw === '1' || raw === 'true' || raw === 'yes') && trustProxySetting(env) !== false;
}

function clientIp(req, env = process.env) {
  if (trustsCfHeader(env)) {
    const header = req.headers ? req.headers[CF_HEADER] : undefined;
    const value = Array.isArray(header) ? header[0] : header;
    // Cloudflare sends a single address; the split is defence against a
    // middlebox that turned it into a list, not an expected shape.
    const first = String(value || '').split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || '';
}

// The key both limiters use. ipKeyGenerator is express-rate-limit's own
// normalizer (it collapses an IPv6 address to its /56, so one household cannot
// walk a limiter by picking a new address out of its prefix); the library
// requires it whenever a custom keyGenerator embeds an IP.
//
// Call sites wrap this in an arrow rather than passing it directly: the
// library invokes keyGenerator(req, res), and this function's second parameter
// is `env` -- handing it a response object would silently disable the CF path.
function clientIpKey(req, env = process.env) {
  return ipKeyGenerator(clientIp(req, env));
}

module.exports = { applyTrustProxy, clientIp, clientIpKey, trustProxySetting, CF_HEADER };
