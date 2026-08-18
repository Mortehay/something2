const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// SOMET-421/422. The production images are the first thing in this repo that
// actually runs the app as a service -- every compose/develop/*.Dockerfile
// ends in `tail -f /dev/null` with the source bind-mounted. These tests read
// the Dockerfiles as text (no Dockerfile parser is a project dependency) and
// assert the properties that would silently produce a broken deployment:
// a dev-idling CMD, `npm install` ignoring the lockfile, or --omit=dev
// dropping node-pg-migrate, which migrations need at deploy time.

const ORANGEPI = path.join(__dirname, '..', '..', 'compose', 'orangepi');
const BACKEND_DOCKERFILE = path.join(ORANGEPI, 'backend.Dockerfile');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('backend image runs the server rather than idling', () => {
  const text = read(BACKEND_DOCKERFILE);
  assert.match(
    text,
    /^CMD \["node", "src\/index\.js"\]/m,
    'production backend must exec the server, not tail -f /dev/null'
  );
  // Scoped to CMD lines on purpose. The file's header comment names
  // `tail -f /dev/null` to contrast with the development image, and a
  // whole-file check would fail on that comment -- forbidding the code from
  // explaining itself.
  const cmdLines = text.split('\n').filter((l) => l.startsWith('CMD'));
  assert.ok(cmdLines.length > 0, 'a production image must declare a CMD');
  for (const line of cmdLines) {
    assert.doesNotMatch(line, /tail/, `dev-idling CMD in a production image: ${line}`);
  }
});

test('backend image installs from the lockfile without dev dependencies', () => {
  const text = read(BACKEND_DOCKERFILE);
  assert.match(text, /npm ci --omit=dev/, 'must be `npm ci --omit=dev`');
  assert.doesNotMatch(
    text,
    /npm install/,
    '`npm install` ignores the lockfile and can drift from what was tested'
  );
});

test('backend image does not run as root', () => {
  assert.match(read(BACKEND_DOCKERFILE), /^USER node$/m);
});

const FRONTEND_DOCKERFILE = path.join(ORANGEPI, 'frontend.Dockerfile');

test('frontend image builds the bundle rather than serving a dev server', () => {
  const text = read(FRONTEND_DOCKERFILE);
  assert.match(text, /RUN npm run build/, 'must run the vite build');
  assert.doesNotMatch(text, /npm run dev/, 'no dev server in a production image');
  assert.doesNotMatch(text, /tail/, 'no dev-idling CMD');
});

test('frontend build refuses to bake a localhost API url', () => {
  const text = read(FRONTEND_DOCKERFILE);
  assert.match(text, /ARG VITE_API_URL/, 'API url must be a build arg');
  // VITE_API_URL is read in 20+ modules with a http://localhost:13101
  // fallback. A bundle built without it points every player at their own
  // machine and fails silently, so the BUILD must fail loudly instead.
  //
  // Asserting on the GUARD, not on the bare word "localhost": this file's
  // comments mention localhost too, so a looser check would still pass with
  // the guard deleted -- a test that asserts nothing.
  //
  // Must be -qiE (case-insensitive), not -qE: an earlier version used -qE,
  // which let `VITE_API_URL=http://LocalHost:8080` sail through the build
  // untouched (SOMET-423 fix round 1) -- glibc/browsers resolve `LocalHost`
  // identically to `localhost`, so the case-sensitive grep was a real bypass,
  // not a hardened check.
  assert.match(
    text,
    /grep -qiE 'localhost\|127\\\.0\\\.0\\\.1'/,
    'the build must actively test VITE_API_URL against localhost, case-insensitively'
  );
  assert.match(text, /exit 1/, 'the guard must fail the build, not warn');
});

test('frontend build has a documented, opt-in-only escape hatch for the localhost guard', () => {
  const text = read(FRONTEND_DOCKERFILE);
  // The opt-out must exist as its own build arg (not, say, reusing
  // VITE_API_URL itself), and it must default to unset/empty so a real
  // deployment that never mentions it still gets the guard.
  assert.match(text, /ARG ALLOW_LOCALHOST_API_URL/, 'opt-out must be a build arg');
  // The guard must only skip the localhost check when the opt-out is
  // exactly "1" -- not merely set, not "true", not any truthy string --
  // and the empty-VITE_API_URL check must NOT be short-circuited by it.
  assert.match(
    text,
    /\[ "\$ALLOW_LOCALHOST_API_URL" != "1" \] && echo "\$VITE_API_URL" \| grep -qiE/,
    'the opt-out must gate only the localhost check, not the required-value check'
  );
  // The required-value check must run first and unconditionally -- the
  // opt-out must never be checked (or able to short-circuit) before it.
  const emptyCheckIdx = text.indexOf('if [ -z "$VITE_API_URL" ]');
  const optOutCheckIdx = text.indexOf('$ALLOW_LOCALHOST_API_URL" != "1"');
  assert.ok(emptyCheckIdx !== -1, 'the required-value check must still exist');
  assert.ok(optOutCheckIdx !== -1, 'the opt-out condition must exist');
  assert.ok(
    emptyCheckIdx < optOutCheckIdx,
    'the required-value check must precede the opt-out check, so the opt-out cannot bypass it'
  );
});

test('frontend image serves the bundle from caddy', () => {
  const text = read(FRONTEND_DOCKERFILE);
  assert.match(text, /^FROM caddy:2-alpine/m);
  assert.match(text, /COPY --from=build \/app\/dist \/srv/);
});
