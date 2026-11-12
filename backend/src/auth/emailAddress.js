// Email address helpers shared by the account-email routes (and registration).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Characters that make an address a header-list or display-name construct (",;<>\"()"), plus whitespace and
// control characters. An address carrying any of them is refused, not parsed: it is about to be handed to the mailer.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_RE = /[,;<>"()\s\u0000-\u001f\u007f]/;

// Trim + lowercase; null for anything that is not a plausible address.
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length === 0 || e.length > 254 || FORBIDDEN_RE.test(e) || !EMAIL_RE.test(e)) return null;
  return e;
}

// The user id that holds `email` VERIFIED, other than exceptUserId; else null.
async function verifiedHolder(db, email, exceptUserId = null) {
  const { rows } = await db.query(
    `SELECT id FROM users
      WHERE email = $1 AND email_verified_at IS NOT NULL AND ($2::int IS NULL OR id <> $2::int)
      LIMIT 1`,
    [email, exceptUserId],
  );
  return rows.length ? rows[0].id : null;
}

// A registration made with an email-bound invite code pins the account's email.
async function isEmailLocked(db, userId) {
  const { rows } = await db.query(
    'SELECT 1 FROM invite_codes WHERE used_by = $1 AND email IS NOT NULL LIMIT 1',
    [userId],
  );
  return rows.length > 0;
}

module.exports = { normalizeEmail, verifiedHolder, isEmailLocked };
