const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { hashPassword, verifyPassword } = require('./passwords.js');
const { signToken } = require('./tokens.js');
const { requireAuth, requireAdmin } = require('./middleware.js');

const VALID_ROLES = ['player', 'admin'];

// Rate limiter for register/login. Keyed on IP + username so that flooding one
// username cannot lock a DIFFERENT username out from the same IP. The IP portion
// is normalized via ipKeyGenerator (IPv6-subnet aware) as express-rate-limit
// requires whenever a custom key embeds the client IP.
function authRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const ip = ipKeyGenerator(req.ip || '');
      const username = req.body && req.body.username ? String(req.body.username).toLowerCase() : '';
      return `${ip}:${username}`;
    },
  });
}

// A token minted for a freshly-fetched/created user row.
function tokenFor(row) {
  return signToken({
    userId: row.id,
    username: row.username,
    role: row.role,
    tokenVersion: row.token_version,
  });
}

// `pool` is a query-capable handle (proxied to the live pool by index.js so the
// test seam still works).
module.exports = function authRouter(pool) {
  const router = express.Router();
  const limiter = authRateLimiter();

  router.post('/register', limiter, async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'username and password are required' });
      }
      // citext makes this uniqueness check case-insensitive.
      const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'username is taken' });
      }
      const passwordHash = await hashPassword(password);
      // role is the 'player' LITERAL — NEVER sourced from the request body.
      const { rows } = await pool.query(
        `INSERT INTO users (username, password_hash, role)
         VALUES ($1, $2, 'player')
         RETURNING id, username, role, token_version`,
        [username, passwordHash],
      );
      const row = rows[0];
      return res.status(201).json({
        token: tokenFor(row),
        user: { id: row.id, username: row.username, role: row.role },
      });
    } catch (err) {
      // Never log req.body — it carries the plaintext password.
      console.error('register failed');
      return res.status(500).json({ error: 'registration failed' });
    }
  });

  router.post('/login', limiter, async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return res.status(401).json({ error: 'invalid credentials' });
      }
      const { rows } = await pool.query(
        'SELECT id, username, password_hash, role, token_version FROM users WHERE username = $1',
        [username],
      );
      const user = rows[0];
      // Generic 401 whether the user is missing OR the password is wrong — never
      // reveal which field was at fault. Verify against a hash even when the user
      // is absent would be ideal for timing; here we keep the message uniform.
      const ok = user ? await verifyPassword(password, user.password_hash) : false;
      if (!ok) {
        return res.status(401).json({ error: 'invalid credentials' });
      }
      return res.status(200).json({
        token: tokenFor(user),
        user: { id: user.id, username: user.username, role: user.role },
      });
    } catch (err) {
      console.error('login failed');
      return res.status(500).json({ error: 'login failed' });
    }
  });

  router.post('/logout-all', requireAuth(pool), async (req, res) => {
    try {
      await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [req.user.id]);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('logout-all failed');
      return res.status(500).json({ error: 'logout-all failed' });
    }
  });

  router.get('/me', requireAuth(pool), (req, res) => {
    // req.user is { id, username, role } — no hash is ever attached.
    return res.status(200).json(req.user);
  });

  router.post('/admin/users/:id/role', requireAdmin(pool), async (req, res) => {
    try {
      const { role } = req.body || {};
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: 'role must be player or admin' });
      }
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'invalid user id' });
      }
      const { rows } = await pool.query(
        'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, role',
        [role, id],
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'user not found' });
      }
      return res.status(200).json(rows[0]);
    } catch (err) {
      console.error('role update failed');
      return res.status(500).json({ error: 'role update failed' });
    }
  });

  return router;
};
