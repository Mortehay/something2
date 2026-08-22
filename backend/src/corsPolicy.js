// SOMET-381. Who may call this API from a browser.
//
// `cors()` with no origin option answers every preflight with
// Access-Control-Allow-Origin: <the caller's origin>. That is fine on a
// workstation and not fine once the game is reachable from the internet: any
// page anywhere could drive the API with a visitor's cookies-less-but-real
// requests, and every admin route is one stolen token away.
//
// THE PRODUCTION CASE NEEDS NO ENTRIES. compose/orangepi fronts the frontend
// and the backend through a single Caddy origin (see its Caddyfile:
// /api/* reverse_proxy backend:3101), so browser calls are same-origin and
// never preflight. An empty allowlist is therefore the correct production
// configuration, not a misconfiguration -- which is why "empty" must mean
// "deny cross-origin", never "allow everything".
//
// Dev is the case that needs entries: vite serves :15173 and the API answers
// on :13101, two origins, so the browser does preflight.

// Requests with no Origin header at all -- curl, the health check, a
// server-to-server call, a same-origin navigation. CORS is a browser
// mechanism for cross-origin JS; a missing Origin is not a cross-origin
// browser request and refusing it would break every non-browser client
// without protecting anything.
const ALLOW_NO_ORIGIN = true;

function parseOrigins(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Exposed so the app can log what it decided at boot. A silent allowlist is
// how a deployment ends up either wide open or mysteriously blocking its own
// frontend, and neither failure announces itself.
function describePolicy(raw) {
  const origins = parseOrigins(raw);
  if (origins.length === 0) {
    return 'CORS: no cross-origin allowed (CORS_ORIGINS unset or empty). '
      + 'Correct when the frontend and API share one origin, as they do behind Caddy in production.';
  }
  return `CORS: allowing ${origins.length} origin(s): ${origins.join(', ')}`;
}

// The `origin` option cors() accepts: (origin, callback) => callback(err, allow).
//
// Deliberately calls back with `false` rather than an Error for a disallowed
// origin. An Error propagates into the express error handler and answers 500,
// which reads as "the server is broken" in logs and monitoring; `false` simply
// omits the Access-Control-Allow-Origin header, which is what a browser needs
// to see to refuse the response, and leaves the status alone.
function originChecker(raw) {
  const allowed = new Set(parseOrigins(raw));
  return (origin, callback) => {
    if (!origin) return callback(null, ALLOW_NO_ORIGIN);
    return callback(null, allowed.has(origin));
  };
}

// The full options object handed to cors().
//
// exposedHeaders is preserved verbatim from what this replaces: per the Fetch
// spec a cross-origin response only exposes safelisted headers to JS unless
// the server lists more, and X-Live-World-Pending (F-017/SOMET-197) was
// invisible to the admin UI without it. Narrowing the ORIGIN must not
// accidentally re-break the HEADER.
function corsOptions(env = process.env) {
  return {
    origin: originChecker(env.CORS_ORIGINS),
    exposedHeaders: ['X-Live-World-Pending'],
  };
}

module.exports = { corsOptions, originChecker, parseOrigins, describePolicy };
