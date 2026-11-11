// The site address put in emailed links (verify / reset / invite).
//
// SECURITY: never build a link from a raw Origin/Host header. An attacker who
// forges them would get a victim's reset token mailed to a host they control.
// An Origin is trusted only if allowlisted (CORS_ORIGINS / APP_URL) or exactly
// equal to the Host the request arrived on (the tunnel case, where the public
// host changes per run). Otherwise fall back to configuration; null means
// "refuse to send".
const { parseOrigins } = require('../corsPolicy.js');

// Normalised "scheme://host[:port]" for http(s) only, else null.
function normalise(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin; // lowercased scheme+host, default port dropped, no slash
  } catch {
    return null;
  }
}

function linkOrigin(req, env = process.env) {
  const header = (n) => (typeof req.get === 'function' ? req.get(n) : req.headers && req.headers[n]);
  const allowed = parseOrigins(env.CORS_ORIGINS).map(normalise).filter(Boolean);
  const appUrl = normalise(env.APP_URL);

  const origin = normalise(header('origin'));
  if (origin) {
    if (allowed.includes(origin) || origin === appUrl) return origin;
    const host = String(header('host') || '').trim().toLowerCase();
    if (host && new URL(origin).host === host) return origin;
  }
  return appUrl || allowed[0] || null;
}

module.exports = { linkOrigin };
