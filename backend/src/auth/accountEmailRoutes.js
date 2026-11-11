// Account email: set, resend the verification link, verify.
const { requireAuth } = require('./middleware.js');
const { normalizeEmail, verifiedHolder, isEmailLocked } = require('./emailAddress.js');
const { issueEmailToken, consumeEmailToken, lastIssuedAt, VERIFY_TTL_MS } = require('./emailTokens.js');
const { linkOrigin } = require('../email/linkOrigin.js');
const { verifyEmailEmail } = require('../email/templates.js');
const { sendEmail } = require('../email/mailer.js');

const RESEND_COOLDOWN_MS = 60e3;

// Mails a verification link for `email`. Throws Error('no_link_origin') when no
// trusted origin exists (never mails a link to an unvetted host); sendEmail
// failures propagate. Also used by registration.
async function sendVerification(db, req, user, email) {
  const origin = linkOrigin(req);
  if (!origin) throw new Error('no_link_origin');
  const raw = await issueEmailToken(db, {
    userId: user.id, purpose: 'verify_email', email, ttlMs: VERIFY_TTL_MS,
  });
  const { subject, text, html } = verifyEmailEmail({ link: `${origin}/verify-email/${raw}` });
  await sendEmail({ to: email, subject, text, html });
}

function sendFailure(res, err) {
  if (err && err.message === 'no_link_origin') return res.status(500).json({ error: 'no_link_origin' });
  console.error('verification email failed');
  return res.status(502).json({ error: 'email_failed' });
}

module.exports = function mountAccountEmailRoutes(router, pool) {
  const guard = requireAuth(pool, { allowUnverified: true });

  router.post('/email', guard, async (req, res) => {
    try {
      const email = normalizeEmail((req.body || {}).email);
      if (!email) return res.status(400).json({ error: 'invalid_email' });
      const { rows } = await pool.query(
        'SELECT email, email_verified_at FROM users WHERE id = $1', [req.user.id],
      );
      const cur = rows[0];
      if (!cur) return res.status(401).json({ error: 'unauthorized' });
      if (cur.email_verified_at != null) return res.status(409).json({ error: 'email_locked' });
      if (await isEmailLocked(pool, req.user.id)) {
        if (!cur.email || cur.email.toLowerCase() !== email) {
          return res.status(409).json({ error: 'email_locked' });
        }
      }
      if (await verifiedHolder(pool, email, req.user.id) != null) {
        return res.status(409).json({ error: 'email_taken' });
      }
      await pool.query(
        'UPDATE users SET email = $1, email_verified_at = NULL WHERE id = $2', [email, req.user.id],
      );
      try {
        await sendVerification(pool, req, req.user, email);
      } catch (err) {
        return sendFailure(res, err);
      }
      return res.status(200).json({ email });
    } catch (err) {
      console.error('set email failed');
      return res.status(500).json({ error: 'set email failed' });
    }
  });

  router.post('/email/resend', guard, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT email, email_verified_at FROM users WHERE id = $1', [req.user.id],
      );
      const cur = rows[0];
      if (!cur || !cur.email) return res.status(400).json({ error: 'invalid_email' });
      if (cur.email_verified_at != null) return res.status(409).json({ error: 'email_locked' });
      const last = await lastIssuedAt(pool, req.user.id, 'verify_email');
      if (last) {
        const wait = RESEND_COOLDOWN_MS - (Date.now() - new Date(last).getTime());
        if (wait > 0) {
          return res.status(429).json({ error: 'resend_cooldown', retryAfterSec: Math.ceil(wait / 1000) });
        }
      }
      try {
        await sendVerification(pool, req, req.user, cur.email.toLowerCase());
      } catch (err) {
        return sendFailure(res, err);
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('resend email failed');
      return res.status(500).json({ error: 'resend failed' });
    }
  });

  // Public: the link is opened from a mail client, possibly signed out.
  router.post('/verify-email', async (req, res) => {
    try {
      const token = (req.body || {}).token;
      const got = await consumeEmailToken(pool, token, 'verify_email');
      if (!got) return res.status(410).json({ error: 'link_expired' });
      const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [got.userId]);
      const cur = rows[0];
      if (!cur || !cur.email || cur.email.toLowerCase() !== String(got.email).toLowerCase()) {
        return res.status(410).json({ error: 'link_expired' });
      }
      const email = cur.email.toLowerCase();
      if (await verifiedHolder(pool, email, got.userId) != null) {
        return res.status(409).json({ error: 'email_taken' });
      }
      try {
        await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [got.userId]);
      } catch (err) {
        // The partial unique index is the real arbiter; the pre-check above races.
        if (err && err.code === '23505') return res.status(409).json({ error: 'email_taken' });
        throw err;
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('verify email failed');
      return res.status(500).json({ error: 'verify failed' });
    }
  });
};

module.exports.sendVerification = sendVerification;
