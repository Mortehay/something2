const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// No-DB structural test. The property that matters is that the migration is
// INERT without the flag: a password committed to this repository must not be
// able to become a live login on an environment that never opted in. Asserting
// that by running the migration against a database would only prove it for the
// database at hand; asserting it structurally proves it for all of them.
function fakePgm() {
  const order = [];
  return {
    order,
    sql: (s) => order.push({ op: 'sql', s }),
    func: (s) => ({ __func: s }),
  };
}

const MIGRATION = '1714440161000_seed_test_player.js';
const mig = require(`../migrations/${MIGRATION}`);

const emitted = (fn) => {
  const pgm = fakePgm();
  fn(pgm);
  return { pgm, sql: pgm.order.map((c) => c.s).join('\n') };
};

function withFlag(value, fn) {
  const prev = process.env.SEED_TEST_USER;
  if (value === undefined) delete process.env.SEED_TEST_USER;
  else process.env.SEED_TEST_USER = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.SEED_TEST_USER;
    else process.env.SEED_TEST_USER = prev;
  }
}

test('without SEED_TEST_USER the migration does nothing at all', () => {
  withFlag(undefined, () => {
    const { pgm } = emitted(mig.up);
    assert.deepEqual(pgm.order, [], 'the migration must be a complete no-op without the flag');
  });
});

// The flag is checked for the exact string '1', so anything else is off. Tested
// because "SEED_TEST_USER=0" and "SEED_TEST_USER=false" are the two ways an
// operator tries to turn something OFF, and a truthiness check would turn both
// of them ON.
test('only the exact value 1 enables it', () => {
  for (const value of ['0', 'false', 'no', '', 'true', 'yes']) {
    withFlag(value, () => {
      const { pgm } = emitted(mig.up);
      assert.deepEqual(pgm.order, [],
        `SEED_TEST_USER=${JSON.stringify(value)} must not seed anything`);
    });
  }
  withFlag('1', () => {
    const { pgm } = emitted(mig.up);
    assert.ok(pgm.order.length > 0, "SEED_TEST_USER=1 must seed");
  });
});

test('with SEED_TEST_USER it creates the account and one Warrior', () => {
  withFlag('1', () => {
    const { sql } = emitted(mig.up);
    assert.match(sql, /INSERT INTO users/i);
    assert.match(sql, /'testplayer'/);
    assert.match(sql, /'player'/, 'the seeded account must be a player, never an admin');
    assert.doesNotMatch(sql, /'admin'/, 'this migration must never create an admin');
    assert.match(sql, /INSERT INTO characters/i);
    assert.match(sql, /'Warrior'/);
    assert.match(sql, /ON CONFLICT/i, 're-running the migration must be idempotent');
    assert.doesNotMatch(sql, /SEED_TEST_USER/, 'the flag must gate the emit, not be emitted into SQL');
  });
});

test('the password is a bcrypt hash, not a literal', () => {
  withFlag('1', () => {
    const { sql } = emitted(mig.up);
    assert.match(sql, /\$2[aby]\$12\$/, 'must store a 12-round bcrypt hash, matching 1714440025000');
    // The literal password must not appear in the emitted SQL at all -- not in
    // a comment, not in a column, nowhere. A hash that sits beside its own
    // plaintext is not a hash.
    const readme = fs.readFileSync(
      path.join(__dirname, '../migrations/test-user-readme.md'), 'utf8');
    const documented = /\|\s*password\s*\|\s*`([^`]+)`/.exec(readme);
    assert.ok(documented, 'test-user-readme.md must document the password in its table');
    assert.ok(!sql.includes(documented[1]),
      'the plaintext password must never reach the SQL');
  });
});

// The readme is the deliverable the user asked for by name, so its existence
// and its agreement with the migration are both asserted rather than assumed.
test('the readme documents this migration accurately', () => {
  const readme = fs.readFileSync(
    path.join(__dirname, '../migrations/test-user-readme.md'), 'utf8');
  assert.match(readme, /testplayer/);
  assert.match(readme, /SEED_TEST_USER/);
  assert.match(readme, new RegExp(MIGRATION.replace(/\./g, '\\.')),
    'the readme must name the migration file it describes, so a rename cannot orphan it');
  assert.match(readme, /Testwarrior/);
  // The security warning is the reason the account is safe to commit. If it is
  // ever edited out, that is worth failing over.
  assert.match(readme, /reachable from the internet/i);
});

test('down removes the account', () => {
  const { sql } = emitted(mig.down);
  assert.match(sql, /DELETE FROM users/i);
  assert.match(sql, /'testplayer'/);
});

// down() is NOT flag-gated on purpose: an environment that seeded the account
// and then unset the flag must still be able to roll it back.
test('down runs regardless of the flag', () => {
  withFlag(undefined, () => {
    const { pgm } = emitted(mig.down);
    assert.ok(pgm.order.length > 0,
      'down must clean up even once the flag is gone, or the account is unremovable by migration');
  });
});
