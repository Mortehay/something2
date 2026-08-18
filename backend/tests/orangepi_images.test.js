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
  assert.match(
    text,
    /grep -qE 'localhost\|127\\\.0\\\.0\\\.1'/,
    'the build must actively test VITE_API_URL against localhost'
  );
  assert.match(text, /exit 1/, 'the guard must fail the build, not warn');
});

test('frontend image serves the bundle from caddy', () => {
  const text = read(FRONTEND_DOCKERFILE);
  assert.match(text, /^FROM caddy:2-alpine/m);
  assert.match(text, /COPY --from=build \/app\/dist \/srv/);
});
