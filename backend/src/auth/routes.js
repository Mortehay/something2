const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { clientIpKey } = require('../clientIp.js');
const { hashPassword, verifyPassword } = require('./passwords.js');
const { signToken } = require('./tokens.js');
const { requireAuth, requireAdmin } = require('./middleware.js');
const { registrationMode } = require('../productionSafety.js');
const { claimInviteCode, attachInviteToUser } = require('./inviteCodes.js');

const VALID_ROLES = ['player', 'admin'];

// Rate limiter for register/login. Keyed on IP + username so that flooding one
// username cannot lock a DIFFERENT username out from the same IP. The IP portion
// comes from clientIp.js (SOMET-437), which normalizes via ipKeyGenerator as
// express-rate-limit requires and, behind a configured proxy, resolves the real
// client instead of the reverse proxy every player shares.
function authRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const ip = clientIpKey(req);
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

  // SOMET-381. Registration is gated by REGISTRATION_MODE:
  //   open   - anyone may sign up (historical behaviour, still the dev default)
  //   invite - a valid, unspent invite code is required
  //   closed - the endpoint is refused outright; accounts are made out-of-band
  //
  // The mode is read PER REQUEST rather than captured when the router is
  // built, so a test (and an operator restarting with a new value) gets the
  // mode actually configured rather than whatever was set at import time.
  router.post('/register', limiter, async (req, res) => {
    let client;
    try {
      const mode = registrationMode();
      if (mode === 'closed') {
        return res.status(403).json({ error: 'registration is closed' });
      }

      const { username, password, inviteCode } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'username and password are required' });
      }
      if (mode === 'invite' && !inviteCode) {
        return res.status(400).json({ error: 'an invite code is required' });
      }
      // citext makes this uniqueness check case-insensitive.
      const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'username is taken' });
      }
      const passwordHash = await hashPassword(password);

      // OPEN/CLOSED NEED NO TRANSACTION, and must not require one. The router
      // is handed a query-capable seam (index.js's guardPool); several existing
      // tests supply a stub with `query` and nothing else, and taking a client
      // unconditionally would break every one of them for no benefit -- there
      // is nothing to make atomic when no code is being spent.
      let row;
      if (mode !== 'invite') {
        // role is the 'player' LITERAL — NEVER sourced from the request body.
        const { rows } = await pool.query(
          `INSERT INTO users (username, password_hash, role)
           VALUES ($1, $2, 'player')
           RETURNING id, username, role, token_version`,
          [username, passwordHash],
        );
        row = rows[0];
      } else {
        // ONE TRANSACTION. The code is claimed with a conditional UPDATE (see
        // inviteCodes.js) BEFORE the insert, so the row is locked for any
        // racing request; and because the claim is inside this transaction, a
        // failed insert rolls it back rather than burning a code on a request
        // that created no account.
        client = await pool.connect();
        await client.query('BEGIN');

        if (!(await claimInviteCode(client, inviteCode))) {
          await client.query('ROLLBACK');
          // One message for "no such code" and "already used" alike: telling
          // them apart lets someone enumerate which codes exist.
          return res.status(403).json({ error: 'invalid or already-used invite code' });
        }

        // role is the 'player' LITERAL — NEVER sourced from the request body.
        const { rows } = await client.query(
          `INSERT INTO users (username, password_hash, role)
           VALUES ($1, $2, 'player')
           RETURNING id, username, role, token_version`,
          [username, passwordHash],
        );
        row = rows[0];
        await attachInviteToUser(client, inviteCode, row.id);
        await client.query('COMMIT');
      }

      return res.status(201).json({
        token: tokenFor(row),
        user: { id: row.id, username: row.username, role: row.role },
      });
    } catch (err) {
      if (client) { try { await client.query('ROLLBACK'); } catch { /* already gone */ } }
      // Never log req.body — it carries the plaintext password AND, now, an
      // invite code.
      console.error('register failed');
      return res.status(500).json({ error: 'registration failed' });
    } finally {
      // release() does NOT roll back (a lesson this project has already paid
      // for), so the ROLLBACK above is what actually undoes a failed attempt.
      if (client) client.release();
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
