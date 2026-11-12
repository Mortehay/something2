// Forgot / reset password via emailed single-use links.
const { rateLimit } = require('express-rate-limit');
const { clientIpKey } = require('../clientIp.js');
const { hashPassword } = require('./passwords.js');
const { normalizeEmail, verifiedHolder } = require('./emailAddress.js');
const { issueEmailToken, consumeEmailToken, peekEmailToken, RESET_TTL_MS } = require('./emailTokens.js');
const { linkOrigin } = require('../email/linkOrigin.js');
const { resetPasswordEmail } = require('../email/templates.js');
const { sendEmail } = require('../email/mailer.js');

const PER_EMAIL_HOURLY_CAP = 3;

// The account a reset for `email` goes to: the verified holder, else the single
// account holding it unverified, else nobody (ambiguous or unknown).
async function resetTarget(db, email) {
  const verified = await verifiedHolder(db, email);
  if (verified != null) return verified;
  const { rows } = await db.query('SELECT id FROM users WHERE email = $1 LIMIT 2', [email]);
  return rows.length === 1 ? rows[0].id : null;
}

// Mail a reset link if allowed. Never throws and reports nothing to the caller:
// the HTTP response must not depend on whether anything was sent.
async function maybeSendReset(pool, req, email) {
  try {
    const userId = await resetTarget(pool, email);
    if (userId == null) return;
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM email_tokens
        WHERE purpose = 'reset_password' AND email = $1 AND created_at > now() - interval '1 hour'`,
      [email],
    );
    if (rows[0].n >= PER_EMAIL_HOURLY_CAP) return;
    const origin = linkOrigin(req);
    if (!origin) { console.error('password reset: no trusted link origin'); return; }
    const raw = await issueEmailToken(pool, { userId, purpose: 'reset_password', email, ttlMs: RESET_TTL_MS });
    const { subject, text, html } = resetPasswordEmail({ link: `${origin}/reset-password/${raw}` });
    await sendEmail({ to: email, subject, text, html });
  } catch (err) {
    console.error('password reset email failed');
  }
}

module.exports = function mountPasswordResetRoutes(router, pool) {
  const ipLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => clientIpKey(req),
  });

  router.post('/password/forgot', ipLimiter, async (req, res) => {
    const email = normalizeEmail((req.body || {}).email);
    // Answer BEFORE any lookup so timing cannot reveal whether the email exists.
    res.status(200).json({ ok: true });
    if (email) {
      maybeSendReset(pool, req, email).catch(() => console.error('forgot: reset send failed'));
    }
  });

  router.get('/password/reset/:token', async (req, res) => {
    try {
      return res.status(200).json({ live: await peekEmailToken(pool, req.params.token, 'reset_password') });
    } catch (err) {
      console.error('reset peek failed');
      return res.status(500).json({ error: 'reset failed' });
    }
  });

  router.post('/password/reset', async (req, res) => {
    try {
      const { token, password } = req.body || {};
      if (typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ error: 'password is required' });
      }
      if (!(await peekEmailToken(pool, token, 'reset_password'))) {
        return res.status(410).json({ error: 'link_expired' });
      }
      const hash = await hashPassword(password);
      // One transaction: a failure anywhere rolls the consume back so the link survives.
      const client = await pool.connect();
      let expired = false;
      try {
        await client.query('BEGIN');
        const got = await consumeEmailToken(client, token, 'reset_password');
        if (!got) {
          expired = true;
        } else {
          const { rows } = await client.query(
            'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING email',
            [hash, got.userId],
          );
          if (!rows.length) {
            expired = true;
          } else {
            const cur = rows[0].email ? rows[0].email.toLowerCase() : null;
            // Reaching the mailbox proves ownership of the address on the account.
            if (cur && cur === String(got.email).toLowerCase() && await verifiedHolder(client, cur, got.userId) == null) {
              await client.query('SAVEPOINT verify');
              try {
                await client.query('UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL', [got.userId]);
              } catch (err) {
                if (!err || err.code !== '23505') throw err; // lost the race: leave unverified
                await client.query('ROLLBACK TO SAVEPOINT verify');
              }
            }
          }
        }
        await client.query(expired ? 'ROLLBACK' : 'COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* connection already gone */ }
        throw err;
      } finally {
        client.release();
      }
      if (expired) return res.status(410).json({ error: 'link_expired' });
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('password reset failed');
      return res.status(500).json({ error: 'reset failed' });
    }
  });
};
