const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// F-041 (SOMET-221): unlike JWT_SECRET and SPRITE_GEN_SHARED_SECRET, which
// docker-compose.yml requires via `${VAR:?message}` sourced from the
// gitignored .env, the Postgres and MinIO credentials were literal values
// hardcoded directly in this tracked file (POSTGRES_PASSWORD in the db
// service; MINIO_ROOT_PASSWORD in the minio service; the same value
// duplicated again as MINIO_SECRET_KEY in both backend and sprite-gen's
// environments; and again inline inside the DATABASE_URL connection strings
// in backend and game-engine). A developer rotating any of these could only
// do so by editing this tracked file, committing the new credential in
// cleartext.
//
// This test does not check for any *value* (no secret literals appear here
// or in the compose file after the fix) -- only that every place a
// password-class credential is consumed uses the required-with-no-silent-
// default `${VAR:?...}` pattern, matching the JWT_SECRET/SPRITE_GEN_SHARED_SECRET
// convention. Usernames (POSTGRES_USER, MINIO_ROOT_USER/MINIO_ACCESS_KEY) and
// non-secret config (POSTGRES_DB, ports) are deliberately out of scope --
// they aren't the credential half of the pair.

const COMPOSE_PATH = path.join(__dirname, '..', '..', 'compose', 'docker-compose.yml');

function requiredPattern(varName) {
  // `${VAR:?...}` -- anything after the `:?` up to the closing brace counts
  // as a message; we only assert the required-with-message shape exists.
  return new RegExp(`\\$\\{${varName}:\\?[^}]+\\}`);
}

test('POSTGRES_PASSWORD has no literal default and is required via .env', () => {
  const text = fs.readFileSync(COMPOSE_PATH, 'utf8');
  // Not hardcoded anywhere as a bare literal `POSTGRES_PASSWORD=password`.
  assert.ok(
    !/POSTGRES_PASSWORD=password\b/.test(text),
    'POSTGRES_PASSWORD must not be a hardcoded literal in the tracked compose file'
  );
  const matches = text.match(new RegExp(requiredPattern('POSTGRES_PASSWORD').source, 'g')) || [];
  // db's own env var, plus DATABASE_URL in backend and game-engine.
  assert.strictEqual(
    matches.length, 3,
    `expected 3 required ${'${POSTGRES_PASSWORD:?...}'} references (db, backend DATABASE_URL, ` +
    `game-engine DATABASE_URL), found ${matches.length}`
  );
});

test('MinIO root/secret password has no literal default and is required via .env', () => {
  const text = fs.readFileSync(COMPOSE_PATH, 'utf8');
  assert.ok(
    !/MINIO_ROOT_PASSWORD=minioadmin\b/.test(text),
    'MINIO_ROOT_PASSWORD must not be a hardcoded literal in the tracked compose file'
  );
  assert.ok(
    !/MINIO_SECRET_KEY=minioadmin\b/.test(text),
    'MINIO_SECRET_KEY must not be a hardcoded literal in the tracked compose file'
  );
  const matches = text.match(new RegExp(requiredPattern('MINIO_ROOT_PASSWORD').source, 'g')) || [];
  // minio's own MINIO_ROOT_PASSWORD, plus MINIO_SECRET_KEY in backend and sprite-gen.
  assert.strictEqual(
    matches.length, 3,
    `expected 3 required ${'${MINIO_ROOT_PASSWORD:?...}'} references (minio, backend ` +
    `MINIO_SECRET_KEY, sprite-gen MINIO_SECRET_KEY), found ${matches.length}`
  );
});
