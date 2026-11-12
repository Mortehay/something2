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
};

module.exports.pendingEmailOf = pendingEmailOf;
