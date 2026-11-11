const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Load the shared auth helper exactly as test files do: it must scrub mail env.
require('./helpers/auth.js');
const dotenv = require('dotenv');
const { smtpConfigured } = require('../src/email/mailer.js');
const { emailGateActive } = require('../src/auth/tokens.js');
const { childEnv, SCRUBBED_MAIL_ENV } = require('../scripts/testdb.js');

const MAIL_KEYS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'EMAIL_GATE_FORCE'];

// The container suite has the real Gmail settings in /app/.env and src/index.js
// runs dotenv.config(). dotenv fills ABSENT keys, so the helper's scrub only
// holds if it leaves the keys present (as ''), not deleted.
test('after helpers/auth.js, a .env carrying SMTP settings cannot switch the gate on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-scrub-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'SMTP_HOST=smtp.example.com\nSMTP_USER=someone\nSMTP_PASS=secret\nEMAIL_GATE_FORCE=1\n');
  try {
    dotenv.config({ path: file, quiet: true });
    assert.equal(smtpConfigured(), false);
    assert.equal(emailGateActive(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('testdb.js child env blanks every mail key, whatever the parent has', () => {
  assert.deepEqual([...SCRUBBED_MAIL_ENV].sort(), [...MAIL_KEYS].sort());
  const parent = { PATH: '/bin', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_PORT: '465', EMAIL_GATE_FORCE: '1' };
  const env = childEnv({ DATABASE_URL: 'postgres://x/y', SMTP_HOST: 'from-extra' }, parent);
  for (const k of MAIL_KEYS) assert.equal(env[k], '', `${k} must be blanked (present, empty)`);
  assert.equal(env.DATABASE_URL, 'postgres://x/y');
  assert.equal(env.PATH, '/bin');
  assert.equal(smtpConfigured(env), false);
  assert.equal(emailGateActive(env), false);
});

test('every spawn site in testdb.js builds its env through childEnv', () => {
  const src = fs.readFileSync(path.join(__dirname, '../scripts/testdb.js'), 'utf8');
  const spawns = (src.match(/spawnSync\(/g) || []).length;
  const viaChildEnv = (src.match(/env: childEnv\(/g) || []).length;
  assert.ok(spawns >= 3, `expected the seed/migrate/run spawn sites, found ${spawns}`);
  assert.equal(viaChildEnv, spawns, 'a spawn site passes an unscrubbed env');
  assert.ok(!/env:\s*\{\s*\.\.\.process\.env/.test(src), 'a spawn site spreads process.env directly');
});
