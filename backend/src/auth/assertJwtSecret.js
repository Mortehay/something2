// Boot-time guard against starting with a missing, placeholder, or too-short
// JWT_SECRET.
//
// Both the HTTP auth middleware (auth/middleware.js -> authenticate()) and
// the WS authority's upgrade handler (authority/server.js) trust ANY HS256
// token signed with this value; they only check the payload's user_id/tv
// against a DB row, with no rate limit on that path. A guessable secret is
// therefore a full auth bypass (including the seeded admin account), not
// just weak crypto hygiene. See docs/audits/2026-07-24/findings.json F-038.
//
// Call assertJwtSecretOrExit() once, guarded by `require.main === module`,
// before the server starts accepting connections (index.js). It must never
// run at plain `require()` time — tests import index.js's `app` with a
// short, deterministic secret (tests/helpers/auth.js) and must not trip
// this check.

const MIN_LENGTH = 32;

// The instructional placeholder text F-038 found still live in this
// project's .env — there is no .env.example file in this repo (checked at
// the time this guard was written; see docs/audits/2026-07-24/browser-run.md),
// so this set, not a template file, is the authoritative record of the
// placeholder(s) to reject. Add to it (do NOT remove entries) if a new
// placeholder value is ever used in setup instructions or a future template.
const KNOWN_PLACEHOLDERS = new Set([
  'replace-me-with-a-long-random-string-min-32-chars',
]);

// Pure check, no I/O: does the given value pass? Returns null when
// acceptable, otherwise a short human-readable reason. Never include the
// value itself in the reason.
function invalidJwtSecretReason(value) {
  if (!value) return 'missing';
  if (KNOWN_PLACEHOLDERS.has(value)) return 'a known placeholder value, not a real secret';
  if (value.length < MIN_LENGTH) return `too short (must be at least ${MIN_LENGTH} characters)`;
  return null;
}

// Boot-time gate. Exits the process (rather than throwing/returning) so a
// caller can't accidentally swallow the failure. Never logs the offending
// value.
function assertJwtSecretOrExit(value = process.env.JWT_SECRET) {
  const reason = invalidJwtSecretReason(value);
  if (!reason) return;
  console.error(
    [
      `FATAL: JWT_SECRET is ${reason} — refusing to start.`,
      'Every session token (including admin-capable ones) is signed with this value, and',
      'nothing else authenticates a request beyond it plus a small sequential user id, so a',
      'weak or default secret lets anyone who can reach this service forge a valid session.',
      'Generate a real secret and put it in .env as JWT_SECRET:',
      '  openssl rand -hex 32',
    ].join('\n'),
  );
  process.exit(1);
}

module.exports = { assertJwtSecretOrExit, invalidJwtSecretReason, MIN_LENGTH, KNOWN_PLACEHOLDERS };
