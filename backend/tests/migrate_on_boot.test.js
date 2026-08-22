const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { shouldMigrateOnBoot, runMigrations, __setMigrationRunner } = require('../src/index.js');

// Three defects fixed together in backend/src/index.js's boot sequence:
//   1. migrations ran on every boot unconditionally
//   2. a failed migration was caught, logged, and swallowed -- the process
//      kept serving against a half-migrated schema
//   3. runMigrations() was fire-and-forget, so app.listen() could start
//      accepting connections before migrations finished
//
// This file covers (1) and (2) directly. (3) -- that app.listen() now sits
// behind an awaited migration step -- is structural (see the require.main
// block in src/index.js) and isn't itself invoked by requiring `app` in
// tests, so it's not separately exercised here.

test('shouldMigrateOnBoot defaults to false when unset', () => {
  assert.equal(shouldMigrateOnBoot({}), false);
});

test('shouldMigrateOnBoot rejects falsy-looking strings, not just falsy values', () => {
  // The whole point: JS truthiness would make every one of these strings
  // truthy. Each must still resolve to "do not migrate".
  for (const value of ['false', '0', '', 'FALSE', 'no', 'null', 'undefined']) {
    assert.equal(
      shouldMigrateOnBoot({ MIGRATE_ON_BOOT: value }),
      false,
      `MIGRATE_ON_BOOT=${JSON.stringify(value)} must not opt in`,
    );
  }
});

test('shouldMigrateOnBoot rejects "1" -- this repo chose the exact string "true" as the opt-in', () => {
  assert.equal(shouldMigrateOnBoot({ MIGRATE_ON_BOOT: '1' }), false);
});

test('shouldMigrateOnBoot accepts only the exact opt-in value', () => {
  assert.equal(shouldMigrateOnBoot({ MIGRATE_ON_BOOT: 'true' }), true);
  assert.equal(shouldMigrateOnBoot({ MIGRATE_ON_BOOT: 'True' }), false);
  assert.equal(shouldMigrateOnBoot({ MIGRATE_ON_BOOT: ' true' }), false);
  assert.equal(shouldMigrateOnBoot({ MIGRATE_ON_BOOT: 'true ' }), false);
});

// runMigrations() used to catch its own runner's rejection, console.error it,
// and return normally -- the caller (and app.listen()) never learned the
// migration failed. It must now propagate the failure.

test('runMigrations rejects (does not swallow) when the underlying runner fails', async () => {
  __setMigrationRunner(async () => {
    throw new Error('boom: simulated migration failure');
  });
  try {
    await assert.rejects(runMigrations(), /boom: simulated migration failure/);
  } finally {
    __setMigrationRunner(require('node-pg-migrate').default);
  }
});

test('runMigrations resolves when the underlying runner succeeds', async () => {
  let called = false;
  __setMigrationRunner(async (opts) => {
    called = true;
    // Sanity: the real options are still being passed through the DI seam,
    // not silently dropped by the extraction.
    assert.ok(opts.dir.endsWith('migrations'));
    assert.equal(opts.direction, 'up');
    return [];
  });
  try {
    await assert.doesNotReject(runMigrations());
    assert.ok(called, 'expected the injected runner to be invoked');
  } finally {
    __setMigrationRunner(require('node-pg-migrate').default);
  }
});

// Compose wiring: develop preserves today's "up == migrated and serving"
// experience; orangepi treats migrations as their own deploy step and must
// not silently inherit boot-time migrations by omission looking like an
// oversight.

function backendServiceBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^ {2}backend:\s*$/.test(l));
  assert.ok(start !== -1, "expected a top-level 'backend:' service");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

test('compose/develop sets MIGRATE_ON_BOOT=true on the backend service', () => {
  const composePath = path.join(__dirname, '..', '..', 'compose', 'develop', 'docker-compose.yml');
  const block = backendServiceBlock(fs.readFileSync(composePath, 'utf8'));
  assert.match(block, /- MIGRATE_ON_BOOT=true\b/);
});

test('compose/orangepi does not set MIGRATE_ON_BOOT on the backend service', () => {
  const composePath = path.join(__dirname, '..', '..', 'compose', 'orangepi', 'docker-compose.yml');
  const block = backendServiceBlock(fs.readFileSync(composePath, 'utf8'));
  // Only the env-var assignment line is forbidden; the file is expected to
  // still explain the omission in prose (which mentions the name).
  assert.doesNotMatch(block, /^\s*-\s*MIGRATE_ON_BOOT=/m);
});
