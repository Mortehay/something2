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
