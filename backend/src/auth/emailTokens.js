// Single-use, hashed, expiring tokens for email verification and password
// reset. The raw UUID only ever lives in the emailed link; the DB stores its
// sha256. `db` is a pg Pool or a checked-out client (works in the caller's
// transaction).
const crypto = require('node:crypto');

const VERIFY_TTL_MS = 24 * 3600e3;
const RESET_TTL_MS = 24 * 3600e3;
const CHANGE_EMAIL_TTL_MS = 24 * 3600e3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hashToken = (raw) => crypto.createHash('sha256').update(String(raw).toLowerCase()).digest('hex');
const isUuid = (raw) => typeof raw === 'string' && UUID_RE.test(raw);

// Invalidate the user's older unused tokens of this purpose, then insert a new one.
async function issueEmailToken(db, { userId, purpose, email, ttlMs }) {
  await db.query(
    `UPDATE email_tokens SET used_at = now()
      WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose],
  );
  const raw = crypto.randomUUID();
  await db.query(
    `INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5::bigint * interval '1 millisecond'))`,
    [hashToken(raw), userId, purpose, email, Math.trunc(ttlMs)],
  );
  return raw;
}

// ONE conditional UPDATE (same mechanism as claimInviteCode): a concurrent
// second consumer blocks on the row lock, then re-evaluates used_at IS NULL.
async function consumeEmailToken(db, raw, purpose) {
  if (!isUuid(raw)) return null;
  const { rows } = await db.query(
    `UPDATE email_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, email`,
    [hashToken(raw), purpose],
  );
  return rows.length ? { userId: rows[0].user_id, email: rows[0].email } : null;
}

// Non-consuming validity check.
async function peekEmailToken(db, raw, purpose) {
  if (!isUuid(raw)) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM email_tokens
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(raw), purpose],
  );
  return rows.length > 0;
}

// When the user last had a token of this purpose issued (resend cooldown).
async function lastIssuedAt(db, userId, purpose) {
  const { rows } = await db.query(
    'SELECT max(created_at) AS at FROM email_tokens WHERE user_id = $1 AND purpose = $2',
    [userId, purpose],
  );
  return rows[0] && rows[0].at ? rows[0].at : null;
}

module.exports = {
  VERIFY_TTL_MS, RESET_TTL_MS, CHANGE_EMAIL_TTL_MS, issueEmailToken, consumeEmailToken, peekEmailToken, lastIssuedAt,
};
