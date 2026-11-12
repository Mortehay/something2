// Profile: change a verified email via a confirmation link mailed to the NEW address.
// The current email stays in force until the link is confirmed; the pending address lives only on the
// live `change_email` token row. Request/cancel need a session (and pass the email gate when it is active);
// peek/confirm are public because the link is opened from a mail client, possibly signed out.
const { rateLimit } = require('express-rate-limit');
const { clientIpKey } = require('../clientIp.js');
const { requireAuth } = require('./middleware.js');
const { verifyPassword, hashPassword } = require('./passwords.js');
const { signToken } = require('./tokens.js');
const { normalizeEmail, verifiedHolder } = require('./emailAddress.js');
const {
  issueEmailToken, consumeEmailToken, peekEmailTokenEmail, CHANGE_EMAIL_TTL_MS,
} = require('./emailTokens.js');
const { sendThrottleSec } = require('./accountEmailRoutes.js');
const { linkOrigin } = require('../email/linkOrigin.js');
const { changeEmailEmail, emailChangedNoticeEmail, maskEmail } = require('../email/templates.js');
const { sendEmail, mailEnabled } = require('../email/mailer.js');
const { mintCode } = require('./inviteCodeGen.js');

const INVITE_CAP = 3; // per user per rolling 24 h; revoked codes still count; admins are exempt

// Per-IP cap on change requests (each one runs a bcrypt compare and may mail). The per-user
// cooldown/hourly cap in sendThrottleSec bounds the mail one account can trigger.
const IP_CHANGE_CAP = 30;

// The live pending change for a user (newest), or null. Also read by /me.
async function pendingEmailOf(db, userId) {
  const { rows } = await db.query(
    `SELECT email FROM email_tokens
      WHERE user_id = $1 AND purpose = 'change_email' AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return rows.length ? rows[0].email : null;
}

const cancelPending = (db, userId) => db.query(
  `UPDATE email_tokens SET used_at = now()
    WHERE user_id = $1 AND purpose = 'change_email' AND used_at IS NULL`,
  [userId],
);

module.exports = function mountProfileRoutes(router, pool) {
  // No allowUnverified: when the gate is active the profile needs a verified account.
  const guard = requireAuth(pool);
  const ipChangeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: IP_CHANGE_CAP,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => clientIpKey(req),
    handler: (req, res) => res.status(429).json({ error: 'too_many_requests' }),
  });

  // ONE per-user budget shared by every route that guesses the current password (email change and password
  // change), so a stolen session gets 10 attempts per 15 min in total, not per route. Counts every attempt,
  // not only wrong passwords. Keyed by user id, so it must run after `guard`.
  const passwordAttemptLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `u${req.user.id}`,
    handler: (req, res) => res.status(429).json({ error: 'too_many_requests' }),
  });

  router.post('/password/change', guard, passwordAttemptLimiter, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (typeof newPassword !== 'string' || newPassword.length === 0) {
        return res.status(400).json({ error: 'password is required' });
      }
      const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
      if (!rows.length) return res.status(401).json({ error: 'unauthorized' });
      if (typeof currentPassword !== 'string' || currentPassword.length === 0
        || !(await verifyPassword(currentPassword, rows[0].password_hash))) {
        return res.status(403).json({ error: 'wrong_password' });
      }
      if (newPassword === currentPassword) return res.status(400).json({ error: 'same_password' });
      // One statement: new hash and the version bump land together, so every other session dies with the old hash.
      const upd = await pool.query(
        `UPDATE users SET password_hash = $1, token_version = token_version + 1
          WHERE id = $2 RETURNING id, username, role, token_version`,
        [await hashPassword(newPassword), req.user.id],
      );
      const u = upd.rows[0];
      return res.status(200).json({
        token: signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.token_version }),
      });
    } catch (err) {
      console.error('change password failed');
      return res.status(500).json({ error: 'change password failed' });
    }
  });

  router.post('/email/change', guard, passwordAttemptLimiter, ipChangeLimiter, async (req, res) => {
    try {
      if (!mailEnabled()) return res.status(503).json({ error: 'mail_disabled' });
      const { email: rawEmail, password } = req.body || {};
      const email = normalizeEmail(rawEmail);
      if (!email) return res.status(400).json({ error: 'invalid_email' });
      const { rows } = await pool.query('SELECT email, password_hash FROM users WHERE id = $1', [req.user.id]);
      const cur = rows[0];
      if (!cur) return res.status(401).json({ error: 'unauthorized' });
      // Password first: same_email / email_taken answers are only given to the account's owner.
      if (typeof password !== 'string' || password.length === 0 || !(await verifyPassword(password, cur.password_hash))) {
        return res.status(403).json({ error: 'wrong_password' });
      }
      if (cur.email && cur.email.toLowerCase() === email) return res.status(400).json({ error: 'same_email' });
      if (await verifiedHolder(pool, email, req.user.id) != null) {
        return res.status(409).json({ error: 'email_taken' });
      }
      const throttled = await sendThrottleSec(pool, req.user.id);
      if (throttled > 0) {
        return res.status(429).json({ error: 'resend_cooldown', retryAfterSec: throttled });
      }
      // Checked before issuing, so a refused send leaves no live token behind.
      const origin = linkOrigin(req);
      if (!origin) return res.status(500).json({ error: 'no_link_origin' });
      // Revokes any older pending change: a new request replaces it.
      const raw = await issueEmailToken(pool, {
        userId: req.user.id, purpose: 'change_email', email, ttlMs: CHANGE_EMAIL_TTL_MS,
      });
      const { subject, text, html } = changeEmailEmail({ link: `${origin}/confirm-email/${raw}` });
      try {
        await sendEmail({ to: email, subject, text, html });
      } catch (err) {
        // Never mailed: do not leave a pending change the user cannot confirm.
        await cancelPending(pool, req.user.id).catch(() => {});
        console.error('change email: send failed');
        return res.status(502).json({ error: 'email_failed' });
      }
      return res.status(200).json({ pendingEmail: email });
    } catch (err) {
      console.error('change email failed');
      return res.status(500).json({ error: 'change email failed' });
    }
  });

  router.post('/email/change/cancel', guard, async (req, res) => {
    try {
      await cancelPending(pool, req.user.id);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('cancel email change failed');
      return res.status(500).json({ error: 'cancel failed' });
    }
  });

  // Public, never consumes: mail scanners prefetch links.
  router.get('/email/change/:token', async (req, res) => {
    try {
      const email = await peekEmailTokenEmail(pool, req.params.token, 'change_email');
      res.set('Cache-Control', 'no-store');
      return res.status(200).json({ live: email != null, email });
    } catch (err) {
      console.error('change email peek failed');
      return res.status(500).json({ error: 'peek failed' });
    }
  });

  router.post('/email/change/confirm', async (req, res) => {
    try {
      const token = (req.body || {}).token;
      let outcome = 'expired';
      let oldEmail = null;
      let oldVerified = false;
      let newEmail = null;
      const client = await pool.connect();
      // A failed ROLLBACK leaves the connection in an unknown state: release(err) discards it (as passwordResetRoutes).
      let broken = null;
      try {
        await client.query('BEGIN');
        const got = await consumeEmailToken(client, token, 'change_email');
        if (got) {
          const { rows } = await client.query(
            'SELECT email, email_verified_at FROM users WHERE id = $1 FOR UPDATE', [got.userId],
          );
          if (rows.length) {
            oldEmail = rows[0].email;
            oldVerified = rows[0].email_verified_at != null;
            newEmail = String(got.email).toLowerCase();
            if (await verifiedHolder(client, newEmail, got.userId) != null) {
              outcome = 'taken';
            } else {
              await client.query('SAVEPOINT change');
              try {
                await client.query(
                  'UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2', [newEmail, got.userId],
                );
                outcome = 'changed';
              } catch (err) {
                // The partial unique index on verified emails is the real arbiter; the pre-check above races.
                if (!err || err.code !== '23505') throw err;
                await client.query('ROLLBACK TO SAVEPOINT change');
                outcome = 'taken';
              }
              if (outcome === 'changed') {
                // Links mailed to the old address (verify, reset) and any other pending change die with it.
                await client.query(
                  `UPDATE email_tokens SET used_at = now()
                    WHERE user_id = $1 AND used_at IS NULL
                      AND purpose IN ('verify_email', 'reset_password', 'change_email')`,
                  [got.userId],
                );
              }
            }
          }
        }
        // 'taken' commits too: the token is spent and the user requests again.
        await client.query(outcome === 'expired' ? 'ROLLBACK' : 'COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { broken = e; }
        throw err;
      } finally {
        client.release(broken || undefined);
      }
      if (outcome === 'expired') return res.status(410).json({ error: 'link_expired' });
      if (outcome === 'taken') return res.status(409).json({ error: 'email_taken' });
      // Only a VERIFIED old address is known to be the user's: never mail a stranger's unproven claim.
      if (oldEmail && oldVerified && oldEmail.toLowerCase() !== newEmail) {
        try {
          const { subject, text, html } = emailChangedNoticeEmail({ maskedNew: maskEmail(newEmail) });
          await sendEmail({ to: oldEmail, subject, text, html });
        } catch (err) {
          console.error('email changed notice failed');
        }
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('confirm email change failed');
      return res.status(500).json({ error: 'confirm failed' });
    }
  });

  const toInvite = (r) => ({
    code: r.code, createdAt: r.created_at, usedAt: r.used_at, usedBy: r.used_by_name || null, revokedAt: r.revoked_at,
  });
  const INVITE_COLS = `c.code::text AS code, c.created_at, c.used_at, c.revoked_at, u.username AS used_by_name`;
  const usedInLastDay = async (db, userId) => (await db.query(
    `SELECT count(*)::int AS n FROM invite_codes WHERE created_by = $1 AND created_at > now() - interval '24 hours'`,
    [userId],
  )).rows[0].n;

  router.get('/invites', guard, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ${INVITE_COLS} FROM invite_codes c LEFT JOIN users u ON u.id = c.used_by
          WHERE c.created_by = $1 ORDER BY c.created_at DESC, c.code DESC`,
        [req.user.id],
      );
      const remainingToday = req.user.role === 'admin'
        ? null : Math.max(0, INVITE_CAP - await usedInLastDay(pool, req.user.id));
      res.set('Cache-Control', 'no-store');
      return res.status(200).json({ invites: rows.map(toInvite), remainingToday });
    } catch (err) {
      console.error('list invites failed');
      return res.status(500).json({ error: 'list invites failed' });
    }
  });

  router.post('/invites', guard, async (req, res) => {
    const isAdmin = req.user.role === 'admin';
    let client;
    let broken = null; // a failed ROLLBACK leaves the connection unknown: release(err) discards it
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      try {
        // Per-user lock for the transaction: two concurrent creates cannot both read "2 used".
        if (!isAdmin) {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`player_invites:${req.user.id}`]);
          if (await usedInLastDay(client, req.user.id) >= INVITE_CAP) {
            // The cap-th newest code in the window is the one whose expiry frees a slot.
            const { rows } = await client.query(
              `SELECT GREATEST(1, ceil(extract(epoch FROM (created_at + interval '24 hours' - now())))::int) AS sec
                 FROM invite_codes
                WHERE created_by = $1 AND created_at > now() - interval '24 hours'
                ORDER BY created_at DESC OFFSET $2 LIMIT 1`,
              [req.user.id, INVITE_CAP - 1],
            );
            await client.query('ROLLBACK');
            return res.status(429).json({ error: 'invite_limit', retryAfterSec: rows.length ? rows[0].sec : 1 });
          }
        }
        let code = null;
        for (let attempt = 0; attempt < 5 && !code; attempt += 1) {
          const ins = await client.query(
            `INSERT INTO invite_codes (code, note, created_by) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING RETURNING code::text AS code`,
            [mintCode(), `player ${req.user.username}`, req.user.id],
          );
          if (ins.rows.length) code = ins.rows[0].code;
        }
        if (!code) throw new Error('could not mint a unique code');
        const { rows } = await client.query(
          `SELECT ${INVITE_COLS} FROM invite_codes c LEFT JOIN users u ON u.id = c.used_by WHERE c.code = $1`, [code],
        );
        await client.query('COMMIT');
        return res.status(201).json({ invite: toInvite(rows[0]) });
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { broken = e; }
        throw err;
      }
    } catch (err) {
      console.error('create invite failed');
      return res.status(500).json({ error: 'create invite failed' });
    } finally {
      if (client) client.release(broken || undefined);
    }
  });

  router.post('/invites/:code/revoke', guard, async (req, res) => {
    try {
      // One conditional UPDATE: only the caller's own, unused code; an already-revoked code keeps its first time.
      const upd = await pool.query(
        `UPDATE invite_codes SET revoked_at = COALESCE(revoked_at, now())
          WHERE code = $1 AND created_by = $2 AND used_at IS NULL RETURNING code`,
        [req.params.code, req.user.id],
      );
      if (!upd.rows.length) {
        const { rows } = await pool.query(
          'SELECT used_at FROM invite_codes WHERE code = $1 AND created_by = $2', [req.params.code, req.user.id],
        );
        if (rows.length) return res.status(409).json({ error: 'already_used' });
        return res.status(404).json({ error: 'not_found' });
      }
      const { rows } = await pool.query(
        `SELECT ${INVITE_COLS} FROM invite_codes c LEFT JOIN users u ON u.id = c.used_by WHERE c.code = $1`,
        [upd.rows[0].code],
      );
      return res.status(200).json({ invite: toInvite(rows[0]) });
    } catch (err) {
      console.error('revoke invite failed');
      return res.status(500).json({ error: 'revoke invite failed' });
    }
  });
};

module.exports.pendingEmailOf = pendingEmailOf;
