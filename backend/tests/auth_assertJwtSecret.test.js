const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertJwtSecretOrExit,
  invalidJwtSecretReason,
  MIN_LENGTH,
  KNOWN_PLACEHOLDERS,
} = require('../src/auth/assertJwtSecret.js');

// invalidJwtSecretReason is pure (no env/process access), so these cover the
// decision logic directly.

test('invalidJwtSecretReason rejects a missing secret', () => {
  assert.equal(invalidJwtSecretReason(undefined), 'missing');
  assert.equal(invalidJwtSecretReason(''), 'missing');
});

test('invalidJwtSecretReason rejects every known placeholder', () => {
  // This only proves the check is self-consistent with its own set -- it
  // cannot catch a real template value that was never added to
  // KNOWN_PLACEHOLDERS. The test below reads the actual template file for
  // that.
  for (const placeholder of KNOWN_PLACEHOLDERS) {
    assert.ok(invalidJwtSecretReason(placeholder), `expected ${placeholder} to be rejected`);
  }
});

test('invalidJwtSecretReason rejects whatever .env.example actually ships as JWT_SECRET', () => {
  // Reads the real template rather than KNOWN_PLACEHOLDERS, so this fails if
  // someone ever ships a bootable secret in .env.example -- including one
  // that is 32+ characters and was never added to the rejection set. That is
  // exactly the mistake this test exists to catch (SOMET-423 C1): the
  // template's placeholder was lengthened past MIN_LENGTH to clear this
  // guard, without being added to KNOWN_PLACEHOLDERS, which left `cp
  // .env.example .env` producing a bootable stack signed with a secret
  // committed to a public repository.
  const envExamplePath = path.join(__dirname, '..', '..', '.env.example');
  const text = fs.readFileSync(envExamplePath, 'utf8');
  const match = text.match(/^JWT_SECRET=(.*)$/m);
  assert.ok(match, '.env.example must have a JWT_SECRET= line');
  const shippedValue = match[1];
  assert.ok(
    invalidJwtSecretReason(shippedValue),
    `.env.example ships a JWT_SECRET value ("${shippedValue}") that assertJwtSecretOrExit ` +
      'would ACCEPT -- add it to KNOWN_PLACEHOLDERS in src/auth/assertJwtSecret.js'
  );
});

test('invalidJwtSecretReason rejects a secret shorter than the minimum length', () => {
  const short = 'a'.repeat(MIN_LENGTH - 1);
  assert.equal(invalidJwtSecretReason(short), `too short (must be at least ${MIN_LENGTH} characters)`);
});

test('invalidJwtSecretReason accepts a proper random secret', () => {
  const good = 'f'.repeat(MIN_LENGTH); // length-only check; real values come from `openssl rand -hex 32`
  assert.equal(invalidJwtSecretReason(good), null);
  assert.equal(invalidJwtSecretReason('a'.repeat(MIN_LENGTH + 20)), null);
});

// assertJwtSecretOrExit wraps invalidJwtSecretReason with the boot-time
// side effects (console.error + process.exit). Stub both so the test process
// itself doesn't exit, and assert the offending value is never logged.

function withStubbedExit(fn) {
  const originalExit = process.exit;
  const originalError = console.error;
  const calls = { exitCodes: [], errorLines: [] };
  process.exit = (code) => { calls.exitCodes.push(code); };
  console.error = (...args) => { calls.errorLines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
  return calls;
}

test('assertJwtSecretOrExit exits loudly on a missing secret, without echoing it', () => {
  const calls = withStubbedExit(() => assertJwtSecretOrExit(undefined));
  assert.deepEqual(calls.exitCodes, [1]);
  assert.ok(calls.errorLines.some((line) => /FATAL/.test(line)));
  assert.ok(calls.errorLines.some((line) => /openssl rand -hex 32/.test(line)));
});

test('assertJwtSecretOrExit exits loudly on a known placeholder, without echoing it', () => {
  const [placeholder] = [...KNOWN_PLACEHOLDERS];
  const calls = withStubbedExit(() => assertJwtSecretOrExit(placeholder));
  assert.deepEqual(calls.exitCodes, [1]);
  assert.ok(calls.errorLines.some((line) => /FATAL/.test(line)));
  // The offending value must never appear in what gets logged.
  assert.ok(calls.errorLines.every((line) => !line.includes(placeholder)));
});

test('assertJwtSecretOrExit exits loudly on a too-short secret', () => {
  const calls = withStubbedExit(() => assertJwtSecretOrExit('short-secret'));
  assert.deepEqual(calls.exitCodes, [1]);
  assert.ok(calls.errorLines.some((line) => /FATAL/.test(line)));
});

test('assertJwtSecretOrExit does nothing for a proper random secret', () => {
  const good = require('crypto').randomBytes(32).toString('hex');
  const calls = withStubbedExit(() => assertJwtSecretOrExit(good));
  assert.deepEqual(calls.exitCodes, []);
  assert.deepEqual(calls.errorLines, []);
});
