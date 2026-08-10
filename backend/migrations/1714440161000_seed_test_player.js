exports.shorthands = undefined;

// A player account for manual testing, with credentials documented in
// test-user-readme.md alongside this file.
//
// GATED, AND THE GATE IS THE POINT. The password below is committed to the
// repository. On any environment that does not set SEED_TEST_USER=1 this
// migration emits nothing at all, so a published password can never be a live
// login. This is the same shape as the admin seed in 1714440025000, which
// creates nothing when ADMIN_USERNAME/ADMIN_PASSWORD are unset -- no default
// credentials, ever.
//
// The comparison is against the exact string '1', not truthiness: an operator
// turning this off writes SEED_TEST_USER=0 or =false, and both are truthy
// strings in Node.
//
// The account gets ONE character rather than none, so the login-resume path is
// testable the moment the migration runs, and seven free slots so creation and
// deletion are testable too.
//
// Numbered 1714440161000, not the plan's 1714440094000: a parallel branch has
// applied 1714440150000 through 152000 to the shared dev database, and this has
// to sort above 1714440160000 (character_visited_worlds) to stay in order once
// every branch merges.
const USERNAME = 'testplayer';
const PASSWORD = 'testplayer-dev-only';

exports.up = (pgm) => {
  if (process.env.SEED_TEST_USER !== '1') return;

  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync(PASSWORD, 12);

  pgm.sql(`INSERT INTO users (username, password_hash, role)
           VALUES ('${USERNAME}', '${hash}', 'player')
           ON CONFLICT (username) DO NOTHING`);

  // Guarded by the join rather than by a subquery: if the Warrior class is
  // somehow missing, this inserts nothing rather than failing the whole
  // migration on a NULL foreign key.
  pgm.sql(`INSERT INTO characters (user_id, slot, name, entity_type_id)
           SELECT u.id, 1, 'Testwarrior', e.id
             FROM users u, entity_types e
            WHERE u.username = '${USERNAME}' AND e.name = 'Warrior'
           ON CONFLICT (user_id, slot) DO NOTHING`);
};

// NOT flag-gated. An environment that seeded the account and later unset the
// flag must still be able to roll it back; a gated down() would leave the
// account unremovable by migration.
exports.down = (pgm) => {
  // The character and all its state cascade away with the account.
  pgm.sql(`DELETE FROM users WHERE username = '${USERNAME}'`);
};

exports.USERNAME = USERNAME;
