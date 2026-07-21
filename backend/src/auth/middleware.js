const { verifyToken } = require('./tokens.js');

function extractBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

// Shared core: verify the token, then check the account's CURRENT token_version
// against the token's version — this is what makes revocation real. A token
// whose version is behind the row is rejected even though its signature is valid
// (e.g. password change / logout-everywhere bumps token_version).
// Returns the { id, username, role } to attach as req.user, or null if the
// caller already sent a response.
async function authenticate(pool, req, res) {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'missing token' });
    return null;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'invalid token' });
    return null;
  }

  // Fail CLOSED on a DB error, and never let the rejection escape: Express
  // 4.x does not catch async middleware rejections, so an unguarded pool
  // failure here (pool exhaustion, statement timeout, a DB restart) would
  // surface as an unhandledRejection and Node exits by default — taking the
  // co-hosted WS authority and every connected player down with it. The
  // sibling WS auth path is hardened against exactly this (authority/server.js);
  // this path must be too. A transient failure is a 500, not a crash.
  let userRow;
  try {
    const { rows } = await pool.query('SELECT token_version, role FROM users WHERE id = $1', [payload.user_id]);
    userRow = rows[0];
  } catch (err) {
    console.error('auth token_version lookup failed:', err);
    res.status(500).json({ error: 'auth check failed' });
    return null;
  }
  if (!userRow || userRow.token_version !== payload.tv) {
    res.status(401).json({ error: 'token revoked' });
    return null;
  }

  return { id: payload.user_id, username: payload.username, role: userRow.role };
}

// Named function (not an anonymous arrow) + an `isAuthGuard` marker property so a
// route-protection test can find this guard in Express's route stack
// (`layer.route.stack[n].handle.isAuthGuard`) by name/marker rather than by
// counting handlers.
function requireAuth(pool) {
  async function authGuard(req, res, next) {
    const user = await authenticate(pool, req, res);
    if (!user) return; // authenticate() already sent the 401
    req.user = user;
    next();
  }
  authGuard.isAuthGuard = true;
  return authGuard;
}

// Additionally marked `isAdminGuard` so it is distinguishable from a plain
// requireAuth guard in the route stack.
function requireAdmin(pool) {
  async function adminGuard(req, res, next) {
    const user = await authenticate(pool, req, res);
    if (!user) return; // authenticate() already sent the 401
    if (user.role !== 'admin') {
      res.status(403).json({ error: 'admin role required' });
      return;
    }
    req.user = user;
    next();
  }
  adminGuard.isAuthGuard = true;
  adminGuard.isAdminGuard = true;
  return adminGuard;
}

module.exports = { requireAuth, requireAdmin };
