// SOMET-381. The settings that gate going public.
//
// Each assertion here corresponds to one of that item's acceptance criteria,
// and each is written to FAIL if the protection is removed -- not merely to
// describe the current code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { originChecker, parseOrigins, corsOptions } = require('../src/corsPolicy.js');
const {
  productionProblems, assertProductionSafety, registrationMode, REGISTRATION_MODES,
} = require('../src/productionSafety.js');

// --- CORS -------------------------------------------------------------------

test('an empty allowlist denies every cross-origin caller', () => {
  const check = originChecker('');
  for (const origin of ['https://evil.example', 'http://localhost:15173', 'null']) {
    check(origin, (err, allow) => {
      assert.equal(err, null);
      assert.equal(allow, false, `${origin} must not be allowed by an empty allowlist`);
    });
  }
});

test('an unset allowlist is not a wildcard', () => {
  // The bug this whole item exists for: cors() with no origin option reflects
  // whatever Origin it is given. Undefined config must be the SAFE end of the
  // range, not the permissive one.
  const check = originChecker(undefined);
  check('https://evil.example', (err, allow) => assert.equal(allow, false));
});

test('listed origins are allowed and unlisted ones are not', () => {
  const check = originChecker('http://localhost:15173, https://game.example');
  const verdicts = {};
  for (const o of ['http://localhost:15173', 'https://game.example', 'https://evil.example']) {
    check(o, (_e, allow) => { verdicts[o] = allow; });
  }
  assert.deepEqual(verdicts, {
    'http://localhost:15173': true,
    'https://game.example': true,
    'https://evil.example': false,
  });
});

test('a request with no Origin is allowed', () => {
  // curl, the health check, server-to-server. CORS governs cross-origin
  // BROWSER requests; refusing these protects nothing and breaks monitoring.
  originChecker('')(undefined, (_e, allow) => assert.equal(allow, true));
});

test('an origin is not matched by prefix, suffix or substring', () => {
  // "https://game.example.evil.com" must not pass because it contains the
  // allowed origin, and "https://game.example" must not admit a different port.
  const check = originChecker('https://game.example');
  for (const bad of [
    'https://game.example.evil.com',
    'https://evil.com/https://game.example',
    'https://game.example:8443',
    'http://game.example',
  ]) {
    check(bad, (_e, allow) => assert.equal(allow, false, `${bad} must not be allowed`));
  }
});

test('narrowing the origin did not drop the exposed header', () => {
  // X-Live-World-Pending (F-017/SOMET-197) is invisible to the admin UI
  // without this, and the failure is silent -- the header is sent and the
  // browser simply does not hand it to JS.
  assert.deepEqual(corsOptions({}).exposedHeaders, ['X-Live-World-Pending']);
});

test('parseOrigins tolerates the shapes an env var actually arrives in', () => {
  assert.deepEqual(parseOrigins('  a , b ,, c '), ['a', 'b', 'c']);
  assert.deepEqual(parseOrigins(''), []);
  assert.deepEqual(parseOrigins(undefined), []);
});

// --- Production configuration ----------------------------------------------

test('non-production configuration is left alone', () => {
  // The guard exists to stop a workstation config REACHING production, not to
  // make local work harder.
  assert.deepEqual(productionProblems({ NODE_ENV: 'development', SEED_TEST_USER: '1' }), []);
});

test('production refuses SEED_TEST_USER=1', () => {
  const problems = productionProblems({
    NODE_ENV: 'production', REGISTRATION_MODE: 'invite', SEED_TEST_USER: '1',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /SEED_TEST_USER/);
});

test('production refuses an unstated registration mode', () => {
  const problems = productionProblems({ NODE_ENV: 'production' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /REGISTRATION_MODE/);
});

test('a safe production configuration passes', () => {
  assert.deepEqual(productionProblems({
    NODE_ENV: 'production', REGISTRATION_MODE: 'invite', SEED_TEST_USER: '0',
  }), []);
  assert.doesNotThrow(() => assertProductionSafety({
    NODE_ENV: 'production', REGISTRATION_MODE: 'closed', SEED_TEST_USER: '0',
  }));
});

test('assertProductionSafety reports every problem at once', () => {
  // One fault per redeploy is a wasted release cycle each time.
  let msg = '';
  try {
    assertProductionSafety({ NODE_ENV: 'production', SEED_TEST_USER: '1' });
    assert.fail('should have thrown');
  } catch (e) { msg = e.message; }
  assert.match(msg, /SEED_TEST_USER/);
  assert.match(msg, /REGISTRATION_MODE/);
});

test('JWT_SECRET is deliberately NOT re-checked here', () => {
  // auth/assertJwtSecret.js owns it, in every environment. If this ever starts
  // failing, someone has added a second copy of that rule and the two will drift.
  assert.deepEqual(productionProblems({
    NODE_ENV: 'production', REGISTRATION_MODE: 'open', JWT_SECRET: 'dev-jwt-secret-change-me-32-chars-min',
  }), []);
  const { invalidJwtSecretReason } = require('../src/auth/assertJwtSecret.js');
  assert.ok(invalidJwtSecretReason('dev-jwt-secret-change-me-32-chars-min'),
    'the placeholder must still be rejected by the guard that does own it');
});

test('registrationMode normalises and rejects nonsense', () => {
  assert.equal(registrationMode({}), 'open');
  assert.equal(registrationMode({ REGISTRATION_MODE: ' INVITE ' }), 'invite');
  assert.throws(() => registrationMode({ REGISTRATION_MODE: 'sometimes' }), /REGISTRATION_MODE/);
  assert.deepEqual(REGISTRATION_MODES, ['open', 'invite', 'closed']);
});

// --- The shipped configuration ---------------------------------------------

test('the production compose does not ship an open door', () => {
  const compose = fs.readFileSync(
    path.join(__dirname, '..', '..', 'compose', 'orangepi', 'docker-compose.yml'), 'utf8');
  // Defaulting to `open` in the production file would defeat the boot guard,
  // since the variable would then be SET and the guard only catches unset.
  assert.match(compose, /REGISTRATION_MODE=\$\{REGISTRATION_MODE:-invite\}/,
    'production compose must default registration to invite, not open');
  assert.ok(!/CORS_ORIGINS=\*/.test(compose), 'production must not wildcard CORS');
});

test('the dev compose still names the dev origins', () => {
  // Denying by default is only safe if the dev stack, which really is
  // cross-origin, is configured. Without this `make dev` breaks and the fix
  // would be to widen the policy again.
  const compose = fs.readFileSync(
    path.join(__dirname, '..', '..', 'compose', 'develop', 'docker-compose.yml'), 'utf8');
  assert.match(compose, /CORS_ORIGINS=.*localhost:15173/);
});
